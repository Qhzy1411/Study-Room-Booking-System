import { all, get, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../audit.js';
import { fmt, dateStr, parseDate, parseTime, addDaysLocal, MINUTE } from '../time.js';
import { requireRoom, requireSeat } from './shared.js';
import { roomRatingSummary } from './evaluations.js';
import { seatQrSvg } from '../qr.js';
import { buildLayout } from '../roommap.js';

function planDto(plan) {
  if (!plan) return null;
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return {
    date: plan.date,
    start: hhmm(plan.start_min),
    end: hhmm(plan.end_min),
    version: plan.version,
    note: plan.note,
    createdAtText: fmt(plan.created_at),
  };
}

/** 记录座位生效/归档时刻，供历史统计按当时生效的座位集合计算分母。 */
function recordSeatStatus(seatId, roomId, status, atTs, actorId, reason) {
  run(
    `INSERT INTO seat_status_history (seat_id, room_id, status, changed_at, actor_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    seatId,
    roomId,
    status,
    atTs,
    actorId,
    reason,
  );
}

function listRooms(user) {
  const rooms = all('SELECT * FROM rooms WHERE archived = 0 ORDER BY id');
  return rooms.map((room) => {
    const rating = roomRatingSummary(room.id);
    const today = dateStr(now());
    const plan = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', room.id, today);
    return {
      id: room.id,
      name: room.name,
      building: room.building,
      floor: room.floor,
      location: `${room.building} · ${room.floor}`,
      description: room.description,
      rating,
      todayPlan: planDto(plan),
      granted: user.role === 'venue_admin' ? user.grants.includes(room.id) : undefined,
    };
  });
}

function roomDetailForStudent(roomId) {
  const room = requireRoom(roomId);
  const mapRow = get('SELECT * FROM room_maps WHERE room_id = ?', roomId);
  const seats = all('SELECT * FROM seats WHERE room_id = ? AND archived = 0 ORDER BY code', roomId);
  const ts = now();
  const plans = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysLocal(dateStr(ts), i);
    plans.push(planDto(get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', roomId, date)) || { date, closed: true });
  }
  return {
    room: {
      id: room.id,
      name: room.name,
      building: room.building,
      floor: room.floor,
      description: room.description,
    },
    map: mapRow ? JSON.parse(mapRow.data) : null,
    seats: seats.map((s) => ({
      id: s.id,
      code: s.code,
      nearWindow: !!s.near_window,
      power: get('SELECT status FROM facilities WHERE seat_id = ? AND kind = ?', s.id, 'power')?.status || 'normal',
    })),
    plans,
    rating: roomRatingSummary(roomId),
  };
}

function adminRoomDetail(admin, roomId, planMonth = dateStr(now()).slice(0, 7)) {
  const room = requireRoom(roomId);
  if (!admin.grants.includes(roomId)) throw forbidden('无权查看该场地');
  if (typeof planMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(planMonth)) {
    throw badRequest('排班月份须为有效的 YYYY-MM');
  }
  const ts = now();
  const seats = all('SELECT * FROM seats WHERE room_id = ? ORDER BY code', roomId).map((seat) => {
    const power = get('SELECT * FROM facilities WHERE seat_id = ? AND kind = ?', seat.id, 'power');
    const current = get(
      `SELECT r.* FROM reservation_segments s JOIN reservations r ON r.id = s.reservation_id
        WHERE s.seat_id = ? AND s.closed_reason IS NULL AND r.status IN ('pending','using','away') AND s.start_ts <= ? AND s.end_ts > ?
        ORDER BY s.start_ts LIMIT 1`,
      seat.id,
      ts,
      ts,
    );
    const upcoming = get(
      `SELECT COUNT(*) AS n FROM reservation_segments s JOIN reservations r ON r.id = s.reservation_id
        WHERE s.seat_id = ? AND s.closed_reason IS NULL AND r.status IN ('pending','using','away') AND s.end_ts > ?`,
      seat.id,
      ts,
    ).n;
    return {
      id: seat.id,
      code: seat.code,
      nearWindow: !!seat.near_window,
      archived: !!seat.archived,
      power: power
        ? { status: power.status, note: power.note, updatedAt: power.updated_at, updatedAtText: fmt(power.updated_at) }
        : { status: 'normal', note: null },
      current: current
        ? {
            reservationId: current.id,
            status: current.status,
            startText: fmt(current.start_ts),
            endText: fmt(current.end_ts),
          }
        : null,
      upcomingCount: upcoming,
    };
  });
  // ISO 日期按字典序排列，每月最多读取 31 条；查询可利用场地、日期联合索引。
  const plans = all(
    'SELECT * FROM open_plans WHERE room_id = ? AND date BETWEEN ? AND ? ORDER BY date',
    roomId, `${planMonth}-01`, `${planMonth}-31`,
  ).map(planDto);
  const suspensions = all(
    `SELECT s.*, st.code AS seat_code FROM suspensions s JOIN seats st ON st.id = s.seat_id
      WHERE s.room_id = ? ORDER BY s.start_ts DESC LIMIT 60`,
    roomId,
  ).map((s) => ({
    id: s.id,
    seatCode: s.seat_code,
    startText: fmt(s.start_ts),
    endText: fmt(s.end_ts),
    reason: s.reason,
    status: s.status,
    restoredAt: s.restored_at,
  }));
  return {
    room: {
      id: room.id,
      name: room.name,
      building: room.building,
      floor: room.floor,
      description: room.description,
    },
    seats,
    plans,
    suspensions,
    rating: roomRatingSummary(roomId),
    mapAvailable: !!get('SELECT 1 FROM room_maps WHERE room_id = ?', roomId),
  };
}

function publishPlans(admin, payload) {
  return tx(() => {
    const room = requireRoom(payload.roomId);
    if (!admin.grants.includes(room.id)) throw forbidden('无权维护该场地的开放计划');
    const from = String(payload.dateFrom || '');
    const to = String(payload.dateTo || from);
    const fromTs = parseDate(from);
    const toTs = parseDate(to);
    if (fromTs == null || toTs == null) throw badRequest('开放计划日期格式不正确');
    if (toTs < fromTs) throw badRequest('结束日期不能早于开始日期');
    const days = Math.round((toTs - fromTs) / (24 * 60 * MINUTE)) + 1;
    if (days > 31) throw unprocessable('一次最多发布 31 天的开放计划');
    const startMin = parseTime(payload.start);
    const endMin = parseTime(payload.end);
    if (startMin == null || endMin == null) throw badRequest('开放时段格式不正确');
    if (endMin <= startMin) throw unprocessable('开放结束时间必须晚于开始时间');
    if (endMin - startMin < 30) throw unprocessable('开放时段过短');
    const ts = now();
    const version =
      (get('SELECT MAX(version) AS v FROM open_plans WHERE room_id = ?', room.id)?.v || 0) + 1;
    const results = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDaysLocal(from, i);
      const dayStart = parseDate(date);
      const newStart = dayStart + startMin * MINUTE;
      const newEnd = dayStart + endMin * MINUTE;
      // BR-05：缩短开放计划若影响已有有效预约，拒绝直接保存
      const conflictRows = all(
        `SELECT * FROM reservations
          WHERE room_id = ? AND status IN ('pending','using','away')
            AND start_ts < ? AND end_ts > ?
            AND (start_ts < ? OR end_ts > ?)`,
        room.id,
        dayStart + 24 * 60 * MINUTE,
        dayStart,
        newStart,
        newEnd,
      );
      if (conflictRows.length) {
        throw conflict(
          `${date} 的开放计划缩短会影响 ${conflictRows.length} 条有效预约，请先通过停用流程处理`,
        );
      }
      const before = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', room.id, date);
      run(
        `INSERT INTO open_plans (room_id, date, start_min, end_min, version, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, date) DO UPDATE SET
           start_min = excluded.start_min, end_min = excluded.end_min, version = excluded.version,
           note = excluded.note, created_by = excluded.created_by, created_at = excluded.created_at`,
        room.id,
        date,
        startMin,
        endMin,
        version,
        payload.note || null,
        admin.id,
        ts,
      );
      run(
        `INSERT INTO open_plan_history (room_id, date, start_min, end_min, version, action, note, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        room.id,
        date,
        startMin,
        endMin,
        version,
        before ? 'update' : 'publish',
        payload.note || null,
        admin.id,
        ts,
      );
      audit({
        actor: admin,
        action: 'openplan.publish',
        objectType: 'open_plan',
        objectId: `${room.id}:${date}`,
        before: before ? { start: before.start_min, end: before.end_min, version: before.version } : null,
        after: { start: startMin, end: endMin, version },
        reason: payload.note || '管理员发布开放计划',
      });
      results.push({ date, start: payload.start, end: payload.end, version, action: before ? 'update' : 'publish' });
    }
    return { roomId: room.id, version, plans: results };
  });
}

function regenerateRoomMap(admin, room) {
  const codes = all('SELECT code, near_window FROM seats WHERE room_id = ? AND archived = 0 ORDER BY code', room.id);
  const nearWindow = codes.filter((s) => s.near_window).map((s) => s.code);
  const layout = buildLayout(
    codes.map((s) => s.code),
    { nearWindowCodes: nearWindow },
  );
  const existing = get('SELECT * FROM room_maps WHERE room_id = ?', room.id);
  const version = (existing?.version || 0) + 1;
  layout.version = version;
  layout.roomId = room.id;
  run(
    `INSERT INTO room_maps (room_id, version, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET version = excluded.version, data = excluded.data,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    room.id,
    version,
    JSON.stringify(layout),
    now(),
    admin.id,
  );
  audit({
    actor: admin,
    action: 'roommap.regenerate',
    objectType: 'room_map',
    objectId: room.id,
    before: existing ? { version: existing.version } : null,
    after: { version },
    reason: '座位变更后重新生成核对布局',
  });
  return version;
}

function createSeat(admin, payload) {
  return tx(() => {
    const room = requireRoom(payload.roomId);
    if (!admin.grants.includes(room.id)) throw forbidden('无权维护该场地');
    const code = String(payload.code || '').trim().toUpperCase();
    if (!/^[A-Z][0-9]{1,3}$/.test(code)) throw badRequest('座位编号格式应为一个字母加数字，例如 A17');
    if (get('SELECT 1 FROM seats WHERE room_id = ? AND code = ?', room.id, code)) {
      throw conflict('该房间内座位编号已存在');
    }
    const id = `${room.id}-${code}`;
    const ts = now();
    run(
      'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      id,
      room.id,
      code,
      payload.nearWindow ? 1 : 0,
      ts,
    );
    recordSeatStatus(id, room.id, 'active', ts, admin.id, '创建座位');
    run(
      'INSERT INTO facilities (seat_id, kind, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      'power',
      'normal',
      '初始配置：插座正常',
      admin.id,
      ts,
    );
    audit({
      actor: admin,
      action: 'seat.create',
      objectType: 'seat',
      objectId: id,
      after: { roomId: room.id, code },
      reason: '维护座位资源',
    });
    const mapVersion = regenerateRoomMap(admin, room);
    return { seat: { id, code, roomId: room.id }, mapVersion };
  });
}

function archiveSeat(admin, seatId, { reason, archived = true }) {
  return tx(() => {
    const seat = requireSeat(seatId);
    if (!admin.grants.includes(seat.room_id)) throw forbidden('无权维护该场地');
    if (!reason || !String(reason).trim()) throw badRequest('归档座位须填写理由');
    if (seat.archived === (archived ? 1 : 0)) throw conflict('座位归档状态未变化');
    const active = get(
      `SELECT COUNT(*) AS n FROM reservation_segments s JOIN reservations r ON r.id = s.reservation_id
        WHERE s.seat_id = ? AND s.closed_reason IS NULL AND r.status IN ('pending','using','away') AND s.end_ts > ?`,
      seatId,
      now(),
    ).n;
    if (archived && active > 0) {
      throw unprocessable('该座位仍有未结束的预约，请先按停用流程处理受影响预约');
    }
    const ts = now();
    run(
      'UPDATE seats SET archived = ?, archived_at = ? WHERE id = ?',
      archived ? 1 : 0,
      archived ? ts : null,
      seatId,
    );
    recordSeatStatus(seatId, seat.room_id, archived ? 'archived' : 'active', ts, admin.id, String(reason).trim());
    audit({
      actor: admin,
      action: archived ? 'seat.archive' : 'seat.restore',
      objectType: 'seat',
      objectId: seatId,
      before: { archived: !!seat.archived },
      after: { archived: !!archived },
      reason,
    });
    const mapVersion = regenerateRoomMap(admin, requireRoom(seat.room_id));
    return { seat: { id: seatId, archived: !!archived }, mapVersion };
  });
}

function updateFacility(admin, seatId, { kind = 'power', status, note }) {
  return tx(() => {
    const seat = requireSeat(seatId);
    if (!admin.grants.includes(seat.room_id)) throw forbidden('无权维护该场地');
    if (!['normal', 'faulty'].includes(status)) throw badRequest('设施状态不正确');
    if (kind !== 'power') throw badRequest('本期仅支持插座设施状态维护');
    const text = String(note || '').trim();
    if (!text) throw badRequest('须填写现场核实或维修说明');
    const before = get('SELECT * FROM facilities WHERE seat_id = ? AND kind = ?', seatId, kind);
    run(
      `INSERT INTO facilities (seat_id, kind, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(seat_id, kind) DO UPDATE SET status = excluded.status, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      seatId,
      kind,
      status,
      text,
      admin.id,
      now(),
    );
    run(
      'INSERT INTO facility_history (seat_id, kind, status, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      seatId,
      kind,
      status,
      text,
      admin.id,
      now(),
    );
    audit({
      actor: admin,
      action: 'facility.update',
      objectType: 'seat_facility',
      objectId: `${seatId}:${kind}`,
      before: before ? { status: before.status, note: before.note } : null,
      after: { status, note: text },
      reason: text,
    });
    // 修复设施不自动撤销独立停用安排（BR-30）
    return {
      seatId,
      code: seat.code,
      facility: { kind, status, note: text, updatedAt: now() },
      note: status === 'normal' ? '设施已登记为正常；如座位另有停用安排，仍以停用为准。' : '设施故障已登记，将影响选座筛选与推荐。',
    };
  });
}

async function seatQr(admin, seatId) {
  const seat = requireSeat(seatId);
  if (!admin.grants.includes(seat.room_id)) throw forbidden('无权查看该场地座位码');
  const { svg, text } = await seatQrSvg(seat.room_id, seat.code);
  return {
    seat: { id: seat.id, code: seat.code, roomId: seat.room_id },
    svg,
    text,
    hint: '打印后贴在对应座位桌面；学生扫码后系统校验本人预约、座位与签到窗口。',
  };
}

function listRoomSeatQr(admin, roomId) {
  const room = requireRoom(roomId);
  if (!admin.grants.includes(roomId)) throw forbidden('无权查看该场地');
  return {
    room: { id: room.id, name: room.name },
    seats: all('SELECT id, code FROM seats WHERE room_id = ? AND archived = 0 ORDER BY code', roomId),
  };
}

export {
  listRooms,
  roomDetailForStudent,
  adminRoomDetail,
  publishPlans,
  createSeat,
  archiveSeat,
  updateFacility,
  seatQr,
  listRoomSeatQr,
  planDto,
};
