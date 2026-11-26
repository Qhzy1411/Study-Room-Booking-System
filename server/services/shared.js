import crypto from 'node:crypto';
import { all, get, run } from '../db.js';
import { now } from '../clock.js';
import { forbidden, notFound } from '../errors.js';
import { fmt, addDaysLocal, dateStr, parseDate, parseTime, timeStr, minutes } from '../time.js';

const ACTIVE_STATUSES = ['pending', 'using', 'away'];
const TERMINAL_STATUSES = ['cancelled', 'completed', 'no_show', 'aborted'];

const ACTIVE_SQL = "('pending','using','away')";

function getRoom(roomId) {
  return get('SELECT * FROM rooms WHERE id = ?', roomId);
}

function requireRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) throw notFound('自习室不存在');
  return room;
}

function getSeat(seatId) {
  return get('SELECT * FROM seats WHERE id = ?', seatId);
}

function requireSeat(seatId) {
  const seat = getSeat(seatId);
  if (!seat) throw notFound('座位不存在');
  return seat;
}

function seatIdOf(roomId, code) {
  return `${roomId}-${code}`;
}

function getRuleVersion(id) {
  return get('SELECT * FROM rule_versions WHERE id = ?', id);
}

/** 当前适用于新预约的规则版本（effective_from <= now，取最新） */
function currentRule(ts = now()) {
  return (
    get(
      'SELECT * FROM rule_versions WHERE effective_from <= ? ORDER BY effective_from DESC, created_at DESC LIMIT 1',
      ts,
    ) || get('SELECT * FROM rule_versions ORDER BY created_at ASC LIMIT 1')
  );
}

/** 查找与给定区间重叠的有效座位保留记录 */
function overlappingSeatReservations(seatId, startTs, endTs, excludeId = null) {
  return all(
    `SELECT DISTINCT r.*
       FROM reservation_segments s
       JOIN reservations r ON r.id = s.reservation_id
      WHERE s.seat_id = ?
        AND s.closed_reason IS NULL
        AND r.status IN ${ACTIVE_SQL}
        AND s.start_ts < ? AND ? < s.end_ts
        AND (? IS NULL OR r.id <> ?)`,
    seatId,
    endTs,
    startTs,
    excludeId,
    excludeId,
  );
}

/** 查找与给定区间重叠的用户本人有效保留记录 */
function overlappingUserReservations(userId, startTs, endTs, excludeId = null) {
  return all(
    `SELECT DISTINCT r.*
       FROM reservation_segments s
       JOIN reservations r ON r.id = s.reservation_id
      WHERE r.user_id = ?
        AND s.closed_reason IS NULL
        AND r.status IN ${ACTIVE_SQL}
        AND s.start_ts < ? AND ? < s.end_ts
        AND (? IS NULL OR r.id <> ?)`,
    userId,
    endTs,
    startTs,
    excludeId,
    excludeId,
  );
}

/** 座位在区间内生效的停用安排 */
function suspensionsForSeat(seatId, startTs, endTs) {
  return all(
    `SELECT * FROM suspensions
      WHERE seat_id = ?
        AND status = 'active'
        AND start_ts < ? AND ? < end_ts`,
    seatId,
    endTs,
    startTs,
  );
}

function facilityOf(seatId, kind) {
  return get('SELECT * FROM facilities WHERE seat_id = ? AND kind = ?', seatId, kind);
}

function facilityIsNormal(seatId, kind = 'power') {
  const row = facilityOf(seatId, kind);
  return !!row && row.status === 'normal';
}

/** 用户当前生效的黑名单限制（覆盖目标场地） */
function activeLimit(userId, roomId, ts = now()) {
  return get(
    `SELECT * FROM limits
      WHERE user_id = ?
        AND revoked_at IS NULL
        AND start_ts <= ? AND ? < end_ts
        AND (room_scope = 'ALL' OR room_scope = ?)
      ORDER BY start_ts DESC LIMIT 1`,
    userId,
    ts,
    ts,
    roomId,
  );
}

/** 规则时长额度统计（按预约开始日期归属；场地免责记录不计入） */
function quotaUsage(userId, date, rule) {
  const dayStart = parseDate(date);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const rows = all(
    `SELECT start_ts, end_ts, waived FROM reservations
      WHERE user_id = ? AND start_ts >= ? AND start_ts < ? AND waived = 0`,
    userId,
    dayStart,
    dayEnd,
  );
  const usedCount = rows.length;
  const usedMinutes = rows.reduce((sum, r) => sum + Math.round((r.end_ts - r.start_ts) / 60000), 0);
  return {
    usedCount,
    usedMinutes,
    limitCount: rule.daily_count,
    limitMinutes: rule.daily_minutes,
  };
}

/** 生成幂等载荷摘要 */
function payloadHash(payload) {
  const stable = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
}

/** 写入站内通知（同一接收者同一事件只生成一条）；投递由后台任务完成 */
function notify(userId, eventKey, eventType, title, body, { siteEnabled = true } = {}) {
  if (!siteEnabled) return null;
  const pref = get('SELECT notify_site FROM users WHERE id = ?', userId);
  if (pref && !pref.notify_site) return null;
  const id = `N-${crypto.randomBytes(6).toString('hex')}`;
  const exists = get('SELECT id FROM notifications WHERE user_id = ? AND event_key = ?', userId, eventKey);
  if (exists) return exists.id;
  run(
    `INSERT INTO notifications (id, user_id, event_key, event_type, title, body, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    id,
    userId,
    eventKey,
    eventType,
    title,
    body,
    now(),
  );
  return id;
}

function userNotifyEnabled(userId) {
  const user = get('SELECT notify_site FROM users WHERE id = ?', userId);
  return !user || !!user.notify_site;
}

function toRuleDto(rule) {
  if (!rule) return null;
  return {
    id: rule.id,
    advanceDays: rule.advance_days,
    checkinGraceMin: rule.checkin_grace_min,
    awayMinutes: rule.away_minutes,
    minMinutes: rule.min_minutes,
    dailyCount: rule.daily_count,
    dailyMinutes: rule.daily_minutes,
    effectiveFrom: rule.effective_from,
    effectiveFromText: fmt(rule.effective_from),
    note: rule.note,
  };
}

function reservationDto(row, { includeUser = false, includeRoom = false } = {}) {
  if (!row) return null;
  const seat = getSeat(row.seat_id);
  const room = getRoom(row.room_id);
  const user = includeUser ? get('SELECT id, display_name FROM users WHERE id = ?', row.user_id) : null;
  return {
    id: row.id,
    userId: row.user_id,
    userName: user?.display_name,
    roomId: row.room_id,
    roomName: room?.name,
    roomLocation: room ? room.building : null,
    seatId: row.seat_id,
    seatCode: seat?.code || row.seat_id.split('-').pop(),
    status: row.status,
    start: row.start_ts,
    end: row.end_ts,
    startText: fmt(row.start_ts),
    endText: fmt(row.end_ts),
    date: dateStr(row.start_ts),
    startTime: timeStr(row.start_ts),
    endTime: timeStr(row.end_ts),
    checkinDeadline: row.checkin_deadline,
    needPower: !!row.need_power,
    checkinDeadlineText: fmt(row.checkin_deadline),
    createdAt: row.created_at,
    createdAtText: fmt(row.created_at),
    releasedAt: row.released_at,
    releasedAtText: row.released_at ? fmt(row.released_at) : null,
    endedAt: row.ended_at,
    endedAtText: row.ended_at ? fmt(row.ended_at) : null,
    endReason: row.end_reason,
    cancelReason: row.cancel_reason,
    waiver: !!row.waived,
    firstCheckinAt: row.first_checkin_at,
    firstCheckinAtText: row.first_checkin_at ? fmt(row.first_checkin_at) : null,
    firstCheckinMethod: row.first_checkin_method,
    checkoutAt: row.checkout_at,
    checkoutAtText: row.checkout_at ? fmt(row.checkout_at) : null,
    ruleVersionId: row.rule_version_id,
    version: row.version,
    swapCount: row.swap_count,
  };
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function assertOwnReservation(user, reservation) {
  if (!reservation) throw notFound('预约不存在');
  if (reservation.user_id !== user.id) throw forbidden('只能操作本人的预约');
  return reservation;
}

function localDateAdd(date, delta) {
  return addDaysLocal(date, delta);
}

function validateIntervalInput({ date, start, end }) {
  const dateTs = parseDate(date);
  const startMin = parseTime(start);
  const endMin = parseTime(end);
  if (dateTs == null) return { error: '日期格式不正确' };
  if (startMin == null || endMin == null) return { error: '时间格式不正确' };
  if (endMin <= startMin) return { error: '结束时间必须晚于开始时间，且本期不支持跨午夜预约' };
  const startTs = dateTs + startMin * 60000;
  const endTs = dateTs + endMin * 60000;
  return { dateTs, startMin, endMin, startTs, endTs };
}

export {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  ACTIVE_SQL,
  getRoom,
  requireRoom,
  getSeat,
  requireSeat,
  seatIdOf,
  getRuleVersion,
  currentRule,
  overlappingSeatReservations,
  overlappingUserReservations,
  suspensionsForSeat,
  facilityOf,
  facilityIsNormal,
  activeLimit,
  quotaUsage,
  payloadHash,
  notify,
  userNotifyEnabled,
  toRuleDto,
  reservationDto,
  isActiveStatus,
  assertOwnReservation,
  localDateAdd,
  validateIntervalInput,
  minutes,
};
