import { all, get } from '../db.js';
import { now } from '../clock.js';
import { forbidden, badRequest } from '../errors.js';
import { fmt, parseDate, addDaysLocal, parseTime, unionLengthClipped } from '../time.js';
import { requireRoom } from './shared.js';

const MINUTE = 60000;

function adminRooms(admin) {
  if (admin.role === 'venue_admin') {
    return all(
      `SELECT * FROM rooms WHERE archived = 0 AND id IN (${admin.grants.length ? admin.grants.map(() => '?').join(',') : "''"}) ORDER BY id`,
      ...admin.grants,
    );
  }
  if (admin.role === 'sys_admin' && admin.canStats) {
    return all('SELECT * FROM rooms WHERE archived = 0 ORDER BY id');
  }
  throw forbidden('没有统计查询权限');
}

function assertStatsRoom(admin, roomId) {
  const room = requireRoom(roomId);
  if (admin.role === 'venue_admin' && !admin.grants.includes(room.id)) throw forbidden('无权查看该场地的统计');
  if (admin.role === 'sys_admin' && !admin.canStats) throw forbidden('没有统计查询权限');
  if (admin.role !== 'venue_admin' && admin.role !== 'sys_admin') throw forbidden('没有统计查询权限');
  return room;
}

/**
 * 把一座座位的生命周期记录还原成生效区间 [start, end)。
 * 没有生命周期记录的旧数据按座位创建时间起算；当前已归档但缺少归档时刻的，
 * 视为创建即归档，不把来源不明的座位计入历史分母。
 */
function seatActiveIntervals(seat, history, snapshot) {
  const intervals = [];
  let start = seat.created_at;
  let active = true;
  for (const event of history) {
    const at = event.changed_at;
    if (event.status === 'archived') {
      if (active) {
        if (at > start) intervals.push([start, at]);
        active = false;
      }
    } else if (!active) {
      start = at;
      active = true;
    }
  }
  if (!history.length) {
    if (!seat.archived) {
      intervals.push([start, Infinity]);
    } else if (seat.archived_at != null && seat.archived_at > start) {
      // 只有归档时刻明确时才补出生效区间；否则视为创建即归档，避免无来源数据被计入历史。
      intervals.push([start, seat.archived_at]);
    }
    return intervals;
  }
  if (seat.archived) {
    if (active) {
      const end = seat.archived_at ?? snapshot;
      if (end > start) intervals.push([start, end]);
    }
  } else if (!active) {
    const restart = seat.archived_at ?? snapshot;
    if (restart > start) intervals.push([restart, Infinity]);
  } else {
    intervals.push([start, Infinity]);
  }
  return intervals;
}

function suspensionIntervals(seatIds, lo, hi) {
  if (!seatIds.length) return new Map();
  const rows = all(
    `SELECT * FROM suspensions
      WHERE seat_id IN (${seatIds.map(() => '?').join(',')})
        AND start_ts < ? AND end_ts > ?`,
    ...seatIds,
    hi,
    lo,
  );
  const bySeat = new Map();
  for (const row of rows) {
    const effectiveEnd = row.status === 'restored' && row.restored_at ? Math.min(row.end_ts, row.restored_at) : row.end_ts;
    if (effectiveEnd <= row.start_ts) continue;
    const interval = [Math.max(row.start_ts, lo), Math.min(effectiveEnd, hi)];
    if (interval[1] <= interval[0]) continue;
    if (!bySeat.has(row.seat_id)) bySeat.set(row.seat_id, []);
    bySeat.get(row.seat_id).push(interval);
  }
  return bySeat;
}

/**
 * 事件类指标按“所选统计时段”本身统计，不受开放计划裁剪。
 * 例如 07:30 创建次日预约，查询 07:00—08:00 的创建量时仍应计入。
 */
function eventCounts(roomId, from, to) {
  if (!(to > from)) {
    return {
      createdCount: 0,
      checkinCount: 0,
      noShowCount: 0,
      effectiveViolationCount: 0,
      cancelledBySelf: 0,
      cancelledByVenue: 0,
    };
  }
  const createdCount = get(
    'SELECT COUNT(*) AS n FROM reservations WHERE room_id = ? AND created_at >= ? AND created_at < ?',
    roomId,
    from,
    to,
  ).n;
  const checkinCount = get(
    `SELECT COUNT(*) AS n FROM checkins c JOIN reservations r ON r.id = c.reservation_id
      WHERE r.room_id = ? AND c.at_ts >= ? AND c.at_ts < ?`,
    roomId,
    from,
    to,
  ).n;
  const noShowCount = get(
    `SELECT COUNT(*) AS n FROM violations
      WHERE room_id = ? AND type = 'no_show' AND occurred_at >= ? AND occurred_at < ?`,
    roomId,
    from,
    to,
  ).n;
  const effectiveViolationCount = get(
    `SELECT COUNT(*) AS n FROM violations
      WHERE room_id = ? AND status = 'effective' AND occurred_at >= ? AND occurred_at < ?`,
    roomId,
    from,
    to,
  ).n;
  const cancelledBySelf = get(
    `SELECT COUNT(*) AS n FROM reservations
      WHERE room_id = ? AND status = 'cancelled' AND waived = 0 AND released_at >= ? AND released_at < ?`,
    roomId,
    from,
    to,
  ).n;
  const cancelledByVenue = get(
    `SELECT COUNT(*) AS n FROM reservations
      WHERE room_id = ? AND waived = 1 AND released_at >= ? AND released_at < ?`,
    roomId,
    from,
    to,
  ).n;
  return { createdCount, checkinCount, noShowCount, effectiveViolationCount, cancelledBySelf, cancelledByVenue };
}

function dayMetrics(roomId, date, { windowStart = null, windowEnd = null, snapshot = now() } = {}) {
  const plan = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', roomId, date);
  const base = {
    date,
    hasPlan: !!plan,
    plan: plan
      ? {
          start: `${String(Math.floor(plan.start_min / 60)).padStart(2, '0')}:${String(plan.start_min % 60).padStart(2, '0')}`,
          end: `${String(Math.floor(plan.end_min / 60)).padStart(2, '0')}:${String(plan.end_min % 60).padStart(2, '0')}`,
          version: plan.version,
        }
      : null,
    availableSeatMinutes: 0,
    usageMinutes: 0,
    usageRate: null,
    createdCount: 0,
    checkinCount: 0,
    noShowCount: 0,
    effectiveViolationCount: 0,
    cancelledBySelf: 0,
    cancelledByVenue: 0,
    seatsCount: 0,
    window: null,
    rating: { count: 0, average: null },
  };
  if (!plan) return base;
  const dayStart = parseDate(date);
  const planStart = dayStart + plan.start_min * MINUTE;
  const planEnd = dayStart + plan.end_min * MINUTE;
  const requestedStart = windowStart ?? planStart;
  const requestedEnd = windowEnd ?? planEnd;
  const counts = eventCounts(roomId, requestedStart, Math.min(requestedEnd, snapshot));
  base.window = {
    start: requestedStart,
    end: requestedEnd,
    startText: fmt(requestedStart),
    endText: fmt(requestedEnd),
  };
  Object.assign(base, counts);

  const winStart = Math.max(planStart, requestedStart);
  const winEnd = Math.min(planEnd, requestedEnd);
  const effEnd = Math.min(winEnd, snapshot);
  if (effEnd <= winStart) return base;

  // 历史分母必须使用“统计时段内实际生效”的座位，而不是查询时的在册座位：
  // 事后归档会缩小分母、恢复或新增会放大分母，都会让无变化的历史使用分钟算出不同比率。
  const seats = all('SELECT * FROM seats WHERE room_id = ?', roomId);
  const seatIds = seats.map((s) => s.id);
  const histories = seatIds.length
    ? all(
        `SELECT * FROM seat_status_history
          WHERE seat_id IN (${seatIds.map(() => '?').join(',')})
          ORDER BY seat_id, changed_at, id`,
        ...seatIds,
      )
    : [];
  const historyBySeat = new Map();
  for (const event of histories) {
    if (!historyBySeat.has(event.seat_id)) historyBySeat.set(event.seat_id, []);
    historyBySeat.get(event.seat_id).push(event);
  }
  const activeBySeat = new Map();
  let available = 0;
  let seatsCount = 0;
  for (const seat of seats) {
    const intervals = seatActiveIntervals(seat, historyBySeat.get(seat.id) || [], snapshot);
    activeBySeat.set(seat.id, intervals);
    const activeMinutes = unionLengthClipped(intervals, winStart, effEnd);
    if (activeMinutes > 0) {
      available += activeMinutes;
      seatsCount += 1;
    }
  }
  const suspensions = suspensionIntervals(seatIds, winStart, effEnd);
  for (const [seatId, suspended] of suspensions) {
    const overlaps = [];
    for (const [activeStart, activeEnd] of activeBySeat.get(seatId) || []) {
      for (const [suspendStart, suspendEnd] of suspended) {
        const start = Math.max(activeStart, suspendStart);
        const end = Math.min(activeEnd, suspendEnd);
        if (end > start) overlaps.push([start, end]);
      }
    }
    available -= unionLengthClipped(overlaps, winStart, effEnd);
  }

  const usageRows = all(
    `SELECT u.start_ts, u.end_ts, r.end_ts AS reservation_end
       FROM usage_segments u
       JOIN reservations r ON r.id = u.reservation_id
      WHERE r.room_id = ? AND u.start_ts < ? AND COALESCE(u.end_ts, ?) > ?`,
    roomId,
    effEnd,
    snapshot,
    winStart,
  );
  let usage = 0;
  for (const row of usageRows) {
    const end = Math.min(row.end_ts ?? snapshot, row.reservation_end, effEnd);
    const start = Math.max(row.start_ts, winStart);
    if (end > start) usage += end - start;
  }

  const rating = get(
    'SELECT COUNT(*) AS count, AVG(rating) AS average FROM evaluations WHERE room_id = ?',
    roomId,
  );

  const availableMinutes = Math.round(available / MINUTE);
  const usageMinutes = Math.round(usage / MINUTE);
  return {
    ...base,
    seatsCount,
    availableSeatMinutes: availableMinutes,
    usageMinutes,
    usageRate: availableMinutes > 0 ? Math.round((usageMinutes / availableMinutes) * 1000) / 10 : null,
    rating: {
      count: rating?.count || 0,
      average: rating?.average != null ? Math.round(rating.average * 10) / 10 : null,
    },
  };
}

function roomSummary(roomId, date, window, snapshot) {
  const room = get('SELECT * FROM rooms WHERE id = ?', roomId);
  const metrics = dayMetrics(roomId, date, { ...window, snapshot });
  return {
    roomId,
    roomName: room?.name || roomId,
    building: room?.building,
    floor: room?.floor,
    hasPlan: metrics.hasPlan,
    plan: metrics.plan,
    seatsCount: metrics.seatsCount,
    availableSeatMinutes: metrics.availableSeatMinutes,
    usageMinutes: metrics.usageMinutes,
    usageRate: metrics.usageRate,
    displayRate: metrics.usageRate == null ? '—' : `${metrics.usageRate.toFixed(1)}%`,
  };
}

function statsForRoom(admin, { roomId, date, start = null, end = null }) {
  const room = assertStatsRoom(admin, roomId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw badRequest('日期格式不正确');
  const ts = now();
  const dayStart = parseDate(date);
  if (dayStart == null) throw badRequest('日期格式不正确');
  let windowStart = null;
  let windowEnd = null;
  if (start) {
    const min = parseTime(start);
    if (min == null) throw badRequest('统计开始时间格式不正确');
    windowStart = dayStart + min * MINUTE;
  }
  if (end) {
    const min = parseTime(end);
    if (min == null) throw badRequest('统计结束时间格式不正确');
    windowEnd = dayStart + min * MINUTE;
  }
  if (windowStart != null && windowEnd != null && windowEnd <= windowStart) {
    throw badRequest('统计结束时间必须晚于开始时间');
  }
  const metrics = dayMetrics(roomId, date, { windowStart, windowEnd, snapshot: ts });
  // 卡片与柱状图必须使用同一日期和所选时段，否则“同日同时段”的柱形会按全天开放时间计算。
  const rooms = adminRooms(admin).map((r) => roomSummary(r.id, date, { windowStart, windowEnd }, ts));
  const trend = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = addDaysLocal(date, -i);
    const m = dayMetrics(roomId, d, { snapshot: ts });
    trend.push({
      date: d,
      availableSeatMinutes: m.availableSeatMinutes,
      usageMinutes: m.usageMinutes,
      usageRate: m.usageRate,
      displayRate: m.usageRate == null ? '—' : `${m.usageRate.toFixed(1)}%`,
      hasPlan: m.hasPlan,
    });
  }
  return {
    room: {
      id: room.id,
      name: room.name,
      building: room.building,
      floor: room.floor,
      location: `${room.building} · ${room.floor}`,
    },
    date,
    snapshot: ts,
    snapshotText: fmt(ts),
    metrics,
    rooms,
    trend,
    formulas: {
      available: '逐座位按创建至归档（含恢复）的生效区间，计算统计时段内、快照时刻之前的开放分钟，扣除停用分钟后求和；重叠停用只扣一次。',
      usage: '逐预约按使用分段计算签到至签退、到期或异常关闭的时长；换座分段不重复计入；扣除暂离时长。',
      rate: '登记使用分钟 ÷ 可用座位分钟 × 100%，保留一位小数；分母为 0 时显示“—”。',
      counts: '预约创建量、首次签到量、未签到事件、取消量均按所选统计时段内的事件发生时刻统计，不受开放时段裁剪；净生效违规按事件发生日及快照时有效结论统计。',
    },
  };
}

export { statsForRoom, dayMetrics, adminRooms, assertStatsRoom };