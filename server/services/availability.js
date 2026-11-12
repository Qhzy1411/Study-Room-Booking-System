import { all, get } from '../db.js';
import { now } from '../clock.js';
import { badRequest } from '../errors.js';
import { dateStr, fmt, parseDate, addDaysLocal, parseTime } from '../time.js';
import {
  requireRoom,
  currentRule,
  overlappingSeatReservations,
  suspensionsForSeat,
  facilityOf,
  activeLimit,
  quotaUsage,
  toRuleDto,
  validateIntervalInput,
} from './shared.js';
import { computeRoute } from '../roommap.js';

function getRoomMap(roomId) {
  const row = get('SELECT * FROM room_maps WHERE room_id = ?', roomId);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function openPlanFor(roomId, date) {
  return get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', roomId, date);
}

function planDto(plan) {
  if (!plan) return null;
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return {
    date: plan.date,
    start: hhmm(plan.start_min),
    end: hhmm(plan.end_min),
    version: plan.version,
    note: plan.note,
  };
}

function suspensionSummary(rows) {
  if (!rows.length) return null;
  return {
    count: rows.length,
    reason: rows[0].reason,
    start: fmt(rows[0].start_ts),
    end: fmt(rows[0].end_ts),
  };
}

/**
 * 座位查询与推荐（FR-02、FR-03、FR-26）。
 * 必要条件先过滤；偏好只影响合格候选排序；无结果时不自动放宽。
 */
function queryAvailability(user, params) {
  const roomId = params.roomId || params.room;
  const room = requireRoom(roomId);
  const interval = validateIntervalInput(params);
  if (interval.error) throw badRequest(interval.error);
  const { startTs, endTs } = interval;
  const date = params.date;
  const needPower = params.needPower === true || params.needPower === '1' || params.needPower === 'true';
  const entrance = params.entrance === 'E' ? 'E' : 'W';
  const preference = params.preference === 'window' ? 'window' : 'near';
  const ts = now();
  const rule = currentRule(ts);
  const map = getRoomMap(roomId);
  const plan = openPlanFor(roomId, date);

  const limit = activeLimit(user.id, roomId, ts);
  const quota = quotaUsage(user.id, date, rule);

  const base = {
    room: {
      id: room.id,
      name: room.name,
      building: room.building,
      floor: room.floor,
      description: room.description,
    },
    date,
    start: params.start,
    end: params.end,
    interval: { start: startTs, end: endTs, startText: fmt(startTs), endText: fmt(endTs) },
    queryTime: ts,
    queryTimeText: fmt(ts),
    dataUpdatedAt: map ? get('SELECT updated_at FROM room_maps WHERE room_id = ?', roomId)?.updated_at : null,
    mapVersion: map?.version ?? null,
    mapAvailable: !!map,
    open: !!plan,
    openPlan: planDto(plan),
    rule: toRuleDto(rule),
    quota: {
      ...quota,
      remainingCount: Math.max(0, quota.limitCount - quota.usedCount),
      remainingMinutes: Math.max(0, quota.limitMinutes - quota.usedMinutes),
    },
    restricted: !!limit,
    restriction: limit
      ? {
          id: limit.id,
          start: fmt(limit.start_ts),
          end: fmt(limit.end_ts),
          reason: limit.reason,
          scope: limit.room_scope === 'ALL' ? '全部场地' : limit.room_scope,
        }
      : null,
    needPower,
    entrance,
    preference,
    seats: [],
    recommendations: [],
    emptyReason: null,
  };

  const seats = all('SELECT * FROM seats WHERE room_id = ? AND archived = 0 ORDER BY code', roomId);
  const durations = {
    startMin: parseTime(params.start),
    endMin: parseTime(params.end),
  };

  const routeCache = new Map();
  const distanceFor = (code) => {
    if (!map) return null;
    if (routeCache.has(code)) return routeCache.get(code);
    const route = computeRoute(map, code, entrance);
    const distance = route?.available ? route.distanceMeters : null;
    routeCache.set(code, distance);
    return distance;
  };

  const candidates = [];
  for (const seat of seats) {
    const layout = map?.seats?.[seat.code] || null;
    const entry = {
      id: seat.id,
      code: seat.code,
      nearWindow: !!seat.near_window,
      x: layout?.x ?? null,
      y: layout?.y ?? null,
      side: layout?.side ?? null,
      power: facilityOf(seat.id, 'power')?.status || 'normal',
      state: 'available',
      reason: null,
      distanceMeters: null,
    };

    if (!plan) {
      entry.state = 'closed';
      entry.reason = '当日无开放计划';
      base.seats.push(entry);
      continue;
    }

    entry.distanceMeters = distanceFor(seat.code);

    if (startTs < plan.start_min * 60000 + parseDate(date) || endTs > parseDate(date) + plan.end_min * 60000) {
      entry.state = 'closed';
      entry.reason = `不在开放时段 ${planDto(plan).start}—${planDto(plan).end} 内`;
      base.seats.push(entry);
      continue;
    }

    const suspensions = suspensionsForSeat(seat.id, startTs, endTs);
    if (suspensions.length) {
      entry.state = 'suspended';
      entry.reason = `停用：${suspensions[0].reason}`;
      base.seats.push(entry);
      continue;
    }

    const occupied = overlappingSeatReservations(seat.id, startTs, endTs);
    if (occupied.length) {
      entry.state = 'occupied';
      entry.reason = '该时段已不可预约';
      base.seats.push(entry);
      continue;
    }

    if (needPower && entry.power !== 'normal') {
      entry.state = 'facility';
      entry.reason = '插座故障，不满足必要条件';
      base.seats.push(entry);
      continue;
    }

    const reasons = [];
    reasons.push(`覆盖 ${params.start}—${params.end} 完整时段`);
    reasons.push(`开放计划 ${planDto(plan).start}—${planDto(plan).end}`);
    reasons.push(entry.power === 'normal' ? '插座状态正常' : '该座位插座故障');
    if (entry.nearWindow) reasons.push('靠窗座位');
    if (entry.distanceMeters != null) {
      reasons.push(`距${entrance === 'W' ? '西' : '东'}入口约 ${entry.distanceMeters} 米`);
    }
    entry.reasons = reasons;
    candidates.push(entry);
    base.seats.push(entry);
  }

  if (!plan) {
    base.emptyReason = '所选日期该自习室没有开放计划，请选择其他日期或场地。';
    return base;
  }
  if (!candidates.length) {
    const reasons = [];
    if (needPower && base.seats.every((s) => s.power !== 'normal' || s.state === 'facility')) {
      reasons.push('没有同时满足插座条件的空闲座位');
    }
    if (base.seats.some((s) => s.state === 'suspended')) reasons.push('部分座位处于停用状态');
    if (base.seats.some((s) => s.state === 'occupied')) reasons.push('部分座位在该时段已被预约');
    base.emptyReason = reasons.length ? reasons.join('；') : '该时段没有可预约座位。';
    return base;
  }

  const scored = candidates.map((seat) => {
    let primary;
    if (preference === 'window') {
      primary = seat.nearWindow ? 0 : 1;
    } else {
      primary = seat.distanceMeters == null ? Number.POSITIVE_INFINITY : seat.distanceMeters;
    }
    return { ...seat, score: [primary, seat.code] };
  });
  scored.sort((a, b) => {
    if (a.score[0] !== b.score[0]) {
      if (a.score[0] === Number.POSITIVE_INFINITY) return 1;
      if (b.score[0] === Number.POSITIVE_INFINITY) return -1;
      return a.score[0] - b.score[0];
    }
    return a.score[1].localeCompare(b.score[1], 'zh-CN');
  });

  const recommended = scored.slice(0, 3).map((seat, index) => ({
    ...seat,
    rank: index + 1,
    recommendReason:
      preference === 'window'
        ? (seat.nearWindow ? '靠窗优先' : '非靠窗')
        : (seat.distanceMeters != null ? `距${entrance === 'W' ? '西' : '东'}入口约 ${seat.distanceMeters} 米` : ''),
  }));

  base.recommendations = recommended;
  return base;
}

/** 预约页的日期范围（当日及未来 advanceDays-1 个当地日期） */
function bookingWindow(ts = now()) {
  const rule = currentRule(ts);
  const dates = [];
  const today = dateStr(ts);
  for (let i = 0; i < rule.advance_days; i += 1) {
    dates.push({ date: addDaysLocal(today, i) });
  }
  return { today, dates, rule: toRuleDto(rule) };
}

export { queryAvailability, getRoomMap, openPlanFor, planDto, bookingWindow };