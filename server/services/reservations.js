import { all, get, nextId, run, tx } from '../db.js';
import { now } from '../clock.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from '../errors.js';
import { audit } from '../audit.js';
import {
  dateStr,
  fmt,
  parseDate,
  timeStr,
  addDaysLocal,
  MINUTE,
} from '../time.js';
import {
  requireRoom,
  requireSeat,
  currentRule,
  overlappingSeatReservations,
  overlappingUserReservations,
  suspensionsForSeat,
  facilityOf,
  activeLimit,
  quotaUsage,
  notify,
  toRuleDto,
  reservationDto,
  assertOwnReservation,
  validateIntervalInput,
  isActiveStatus,
} from './shared.js';
import { getRoomMap } from './availability.js';
import { computeRoute } from '../roommap.js';
import { verifySeatCode } from '../qr.js';

const SYSTEM_ACTOR = { id: 'system', role: 'system' };
const ACTIVE = "('pending','using','away')";

function closeRetentionAt(reservationId, ts, reason) {
  run(
    `UPDATE reservation_segments SET end_ts = ?, closed_reason = ?
      WHERE reservation_id = ? AND end_ts > ? AND start_ts < ?`,
    ts,
    reason,
    reservationId,
    ts,
    ts,
  );
  // 预约尚未开始即被取消/释放时，保留计划区间用于历史追溯，不写零长度区间
  run(
    `UPDATE reservation_segments SET closed_reason = ?
      WHERE reservation_id = ? AND closed_reason IS NULL AND start_ts >= ?`,
    reason,
    reservationId,
    ts,
  );
}

function closeOpenUsage(reservationId, ts, reason) {
  run(
    `UPDATE usage_segments SET end_ts = ?, close_reason = ?
      WHERE reservation_id = ? AND end_ts IS NULL`,
    ts,
    reason,
    reservationId,
  );
}

function closeOpenAway(reservationId, ts, reason) {
  run(
    `UPDATE away_records SET closed_at = ?, close_reason = ?
      WHERE reservation_id = ? AND closed_at IS NULL`,
    ts,
    reason,
    reservationId,
  );
}

/** 预约详情（含签到、暂离、使用分段与换座记录） */
function reservationDetail(row, { includeUser = false } = {}) {
  if (!row) return null;
  const dto = reservationDto(row, { includeUser });
  const checkinRow = get('SELECT * FROM checkins WHERE reservation_id = ?', row.id);
  dto.checkin = checkinRow
    ? {
        id: checkinRow.id,
        at: checkinRow.at_ts,
        atText: fmt(checkinRow.at_ts),
        method: checkinRow.method,
        seatId: checkinRow.seat_id,
        seatCode: get('SELECT code FROM seats WHERE id = ?', checkinRow.seat_id)?.code,
        operatorId: checkinRow.operator_id,
        note: checkinRow.note,
      }
    : null;
  dto.aways = all('SELECT * FROM away_records WHERE reservation_id = ? ORDER BY id', row.id).map((a) => ({
    id: a.id,
    start: a.start_ts,
    startText: fmt(a.start_ts),
    deadline: a.deadline_ts,
    deadlineText: fmt(a.deadline_ts),
    returnedAt: a.returned_at,
    returnedText: a.returned_at ? fmt(a.returned_at) : null,
    closedAt: a.closed_at,
    closedText: a.closed_at ? fmt(a.closed_at) : null,
    closeReason: a.close_reason,
  }));
  dto.segments = all('SELECT * FROM reservation_segments WHERE reservation_id = ? ORDER BY id', row.id).map((s) => ({
    seatId: s.seat_id,
    seatCode: get('SELECT code FROM seats WHERE id = ?', s.seat_id)?.code || s.seat_id,
    start: s.start_ts,
    end: s.end_ts,
    startText: fmt(s.start_ts),
    endText: fmt(s.end_ts),
    closedReason: s.closed_reason,
  }));
  dto.usage = all('SELECT * FROM usage_segments WHERE reservation_id = ? ORDER BY id', row.id).map((u) => ({
    seatId: u.seat_id,
    seatCode: get('SELECT code FROM seats WHERE id = ?', u.seat_id)?.code || u.seat_id,
    start: u.start_ts,
    end: u.end_ts,
    startText: fmt(u.start_ts),
    endText: u.end_ts ? fmt(u.end_ts) : null,
    closeReason: u.close_reason,
  }));
  dto.changes = all('SELECT * FROM seat_changes WHERE reservation_id = ? ORDER BY created_at', row.id).map((c) => ({
    id: c.id,
    fromSeatCode: get('SELECT code FROM seats WHERE id = ?', c.from_seat_id)?.code || c.from_seat_id,
    toSeatCode: get('SELECT code FROM seats WHERE id = ?', c.to_seat_id)?.code || c.to_seat_id,
    at: c.at_ts,
    atText: fmt(c.at_ts),
  }));
  const evaluation = get('SELECT * FROM evaluations WHERE reservation_id = ?', row.id);
  dto.evaluation = evaluation
    ? {
        id: evaluation.id,
        rating: evaluation.rating,
        content: evaluation.content,
        visibility: evaluation.visibility,
        createdAt: evaluation.created_at,
        updatedAt: evaluation.updated_at,
      }
    : null;
  dto.violations = all('SELECT * FROM violations WHERE reservation_id = ? ORDER BY created_at', row.id).map((v) => ({
    id: v.id,
    type: v.type,
    status: v.status,
    occurredAt: v.occurred_at,
    occurredAtText: fmt(v.occurred_at),
    reason: v.decision_reason || v.revoke_reason || v.material,
  }));
  dto.siteIssues = all(
    'SELECT * FROM complaints WHERE reservation_id = ? AND is_site = 1 ORDER BY created_at DESC',
    row.id,
  ).map((c) => ({
    id: c.id,
    status: c.status,
    statusLabel: { pending: '待受理', processing: '处理中', answered: '已答复', closed: '已关闭' }[c.status] || c.status,
    createdAt: c.created_at,
    createdAtText: fmt(c.created_at),
  }));
  return dto;
}

function processReservationDue(row, ts = now()) {
  if (!row) return row;
  if (row.status === 'pending' && ts >= (row.checkin_protected_until ?? row.checkin_deadline)) {
    if (row.checkin_protected_until != null) expireOccupancyProtection(row);
    else markNoShow(row, ts);
    return get('SELECT * FROM reservations WHERE id = ?', row.id);
  }
  if (row.status === 'away') {
    const away = get(
      'SELECT * FROM away_records WHERE reservation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
      row.id,
    );
    if (away && ts >= away.deadline_ts) {
      if (away.deadline_ts < row.end_ts) {
        abortAwayTimeout(row, away, ts);
      } else if (ts >= row.end_ts) {
        completeAtEnd(row, away);
      }
      return get('SELECT * FROM reservations WHERE id = ?', row.id);
    }
  }
  if (row.status === 'using' && ts >= row.end_ts) {
    completeAtEnd(row, null);
    return get('SELECT * FROM reservations WHERE id = ?', row.id);
  }
  if (row.status === 'away' && ts >= row.end_ts) {
    const away = get(
      'SELECT * FROM away_records WHERE reservation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
      row.id,
    );
    completeAtEnd(row, away);
    return get('SELECT * FROM reservations WHERE id = ?', row.id);
  }
  return row;
}

function markNoShow(row, ts, releaseAt = row.checkin_deadline) {
  closeRetentionAt(row.id, releaseAt, 'no_show');
  run(
    `UPDATE reservations SET status = 'no_show', released_at = ?, ended_at = ?, end_reason = 'no_show',
       cancel_reason = NULL, waived = 0, checkin_protected_until = NULL
      WHERE id = ?`,
    releaseAt,
    releaseAt,
    row.id,
  );
  const violationId = nextId('V', 'violation', 4);
  const eventKey = `no_show:${row.id}`;
  run(
    `INSERT INTO violations (id, event_key, user_id, room_id, reservation_id, occurred_at, type, material, status, created_by, created_at, rule_version_id)
     VALUES (?, ?, ?, ?, ?, ?, 'no_show', ?, 'pending', 'system', ?, ?)`,
    violationId,
    eventKey,
    row.user_id,
    row.room_id,
    row.id,
    row.checkin_deadline,
    '签到截止时仍未完成签到，由系统自动记录',
    ts,
    row.rule_version_id,
  );
  audit({
    actor: SYSTEM_ACTOR,
    action: 'reservation.no_show',
    objectType: 'reservation',
    objectId: row.id,
    before: { status: row.status },
    after: { status: 'no_show', violationId },
    reason: '系统判定签到截止',
  });
  notify(
    row.user_id,
    `violation.pending:${violationId}`,
    'violation',
    '系统记录了未签到待复核事件',
    `你在 ${fmt(row.start_ts)} 开始的预约因未在 ${fmt(row.checkin_deadline)} 前签到被记为待复核事件。待复核记录不等同处罚，如有异议可在“投诉与申诉”中说明。`,
  );
}

function expireOccupancyProtection(row) {
  const releaseAt = row.checkin_protected_until;
  const reason = '占座保护期结束，未完成签到';
  closeRetentionAt(row.id, releaseAt, 'occupancy_protection_expired');
  run(
    `UPDATE reservations SET status = 'cancelled', released_at = ?, ended_at = ?,
       cancel_reason = ?, end_reason = 'occupancy_protection_expired', waived = 1, version = version + 1
       WHERE id = ? AND status = 'pending'`,
    releaseAt, releaseAt, reason, row.id,
  );
  audit({
    actor: SYSTEM_ACTOR,
    action: 'reservation.occupancy_protection_expired',
    objectType: 'reservation',
    objectId: row.id,
    before: { status: 'pending' },
    after: { status: 'cancelled', waived: true, complaintId: row.checkin_protection_id },
    reason,
  });
  notify(row.user_id, `reservation.occupancy_expired:${row.id}`, 'reservation', reason, '座位已释放，本次预约免罚取消。');
}

function rejectOccupancyProtection(complaint, ts) {
  const row = get('SELECT * FROM reservations WHERE checkin_protection_id = ?', complaint.id);
  if (row?.checkin_protected_until == null
    || (row.status !== 'pending' && row.end_reason !== 'occupancy_protection_expired')) return;
  if (ts >= row.checkin_deadline) {
    markNoShow(row, ts, Math.min(ts, row.checkin_protected_until));
  } else {
    run('UPDATE reservations SET checkin_protected_until = NULL WHERE id = ?', row.id);
  }
}

function completeAtEnd(row, away) {
  closeOpenUsage(row.id, row.end_ts, 'expired');
  closeOpenAway(row.id, row.end_ts, 'expired');
  closeRetentionAt(row.id, row.end_ts, 'completed');
  run(
    `UPDATE reservations SET status = 'completed', released_at = ?, ended_at = ?, end_reason = 'expired'
      WHERE id = ? AND status IN ('using','away')`,
    row.end_ts,
    row.end_ts,
    row.id,
  );
  audit({
    actor: SYSTEM_ACTOR,
    action: 'reservation.completed',
    objectType: 'reservation',
    objectId: row.id,
    before: { status: row.status },
    after: { status: 'completed', endReason: 'expired' },
    reason: '预约到期由系统结束',
  });
}

function abortAwayTimeout(row, away, ts) {
  const deadline = away.deadline_ts;
  closeOpenAway(row.id, deadline, 'timeout');
  closeOpenUsage(row.id, deadline, 'away_timeout');
  closeRetentionAt(row.id, deadline, 'away_timeout');
  run(
    `UPDATE reservations SET status = 'aborted', released_at = ?, ended_at = ?, end_reason = 'away_timeout'
      WHERE id = ? AND status = 'away'`,
    deadline,
    deadline,
    row.id,
  );
  audit({
    actor: SYSTEM_ACTOR,
    action: 'reservation.away_timeout',
    objectType: 'reservation',
    objectId: row.id,
    before: { status: 'away' },
    after: { status: 'aborted', endReason: 'away_timeout' },
    reason: '暂离超过最晚返回时间',
  });
  notify(
    row.user_id,
    `reservation.aborted:${row.id}`,
    'reservation',
    '暂离超时，座位已释放',
    `你未在 ${fmt(deadline)} 前返回座位，系统已按暂离超时关闭 ${fmt(row.start_ts)}—${fmt(row.end_ts)} 的预约并释放时段。如现场确有特殊情况，可联系场地管理员。`,
  );
}

/** 处理所有到期状态（后台任务与请求补处理共用）。返回处理条数。 */
function processDue(ts = now()) {
  return tx(() => {
    let handled = 0;
    const pendingDue = all(
      `SELECT * FROM reservations WHERE status = 'pending' AND COALESCE(checkin_protected_until, checkin_deadline) <= ?
        ORDER BY COALESCE(checkin_protected_until, checkin_deadline) LIMIT 200`,
      ts,
    );
    for (const row of pendingDue) {
      processReservationDue(row, ts);
      handled += 1;
    }
    const activeDue = all(
      `SELECT * FROM reservations WHERE status IN ('using','away') AND end_ts <= ? ORDER BY end_ts LIMIT 200`,
      ts,
    );
    for (const row of activeDue) {
      if (row.status === 'away') {
        const away = get(
          'SELECT * FROM away_records WHERE reservation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
          row.id,
        );
        if (away && away.deadline_ts < row.end_ts && ts >= away.deadline_ts) {
          abortAwayTimeout(row, away, ts);
          handled += 1;
          continue;
        }
      }
      completeAtEnd(row, null);
      handled += 1;
    }
    const awayDue = all(
      `SELECT r.*, a.deadline_ts FROM reservations r
         JOIN away_records a ON a.reservation_id = r.id AND a.closed_at IS NULL
        WHERE r.status = 'away' AND a.deadline_ts <= ? AND a.deadline_ts < r.end_ts
        ORDER BY a.deadline_ts LIMIT 200`,
      ts,
    );
    for (const row of awayDue) {
      abortAwayTimeout(row, { deadline_ts: row.deadline_ts }, ts);
      handled += 1;
    }
    return handled;
  });
}

function assertBookingWindow(date, startTs, rule, ts) {
  const today = dateStr(ts);
  const lastDate = addDaysLocal(today, rule.advance_days - 1);
  if (date < today) throw unprocessable('不能预约过去的日期');
  if (date > lastDate) throw unprocessable(`本期只能预约 ${today} 至 ${lastDate} 的座位`);
  if (startTs < ts) throw unprocessable('开始时间不能早于提交时刻');
}

/** 创建预约（FR-04、FR-05；BR-01—05、13） */
function createReservation(user, payload) {
  processDue();
  return tx(() => {
    const ts = now();
    if (user.role !== 'student') throw forbidden('只有学生账号可以创建预约');
    const room = requireRoom(payload.roomId);
    if (room.archived) throw unprocessable('该自习室已归档，不能预约');
    const seat = requireSeat(payload.seatId);
    if (seat.room_id !== room.id) throw badRequest('座位不属于所选自习室');
    if (seat.archived) throw unprocessable('该座位已归档，不能预约');
    const interval = validateIntervalInput(payload);
    if (interval.error) throw badRequest(interval.error);
    const { startTs, endTs } = interval;
    const date = payload.date;
    const rule = currentRule(ts);

    assertBookingWindow(date, startTs, rule, ts);
    if (endTs - startTs < rule.min_minutes * MINUTE) {
      throw unprocessable(`单次预约不能少于 ${rule.min_minutes} 分钟`);
    }

    const limit = activeLimit(user.id, room.id, ts);
    if (limit) {
      throw unprocessable(
        `你当前处于预约限制期内（${fmt(limit.start_ts)} 至 ${fmt(limit.end_ts)}），限制期间不能创建新预约`,
        { restrictionId: limit.id },
      );
    }

    const plan = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', room.id, date);
    if (!plan) throw unprocessable('该日期自习室没有开放计划');
    const dayStart = parseDate(date);
    const openStart = dayStart + plan.start_min * MINUTE;
    const openEnd = dayStart + plan.end_min * MINUTE;
    if (startTs < openStart || endTs > openEnd) {
      throw unprocessable(`预约时段须完整落在开放时段 ${timeStr(openStart)}—${timeStr(openEnd)} 内`);
    }

    const suspensions = suspensionsForSeat(seat.id, startTs, endTs);
    if (suspensions.length) {
      throw unprocessable(`该座位在此时间段处于停用状态（${suspensions[0].reason}）`);
    }

    if (payload.needPower && facilityOf(seat.id, 'power')?.status !== 'normal') {
      throw unprocessable('该座位的插座处于故障状态，不满足必要条件');
    }

    const userConflicts = overlappingUserReservations(user.id, startTs, endTs);
    if (userConflicts.length) {
      throw conflict('你在此时段已有预约，请选择其他时段', {
        conflicts: userConflicts.map((r) => ({ id: r.id, start: fmt(r.start_ts), end: fmt(r.end_ts) })),
      });
    }

    const seatConflicts = overlappingSeatReservations(seat.id, startTs, endTs);
    if (seatConflicts.length) {
      throw conflict('该座位在所选时段已被预约，请选择其他座位或时段');
    }

    const quota = quotaUsage(user.id, date, rule);
    if (quota.usedCount + 1 > quota.limitCount) {
      throw unprocessable(
        `每日最多创建 ${quota.limitCount} 次预约，你在 ${date} 已创建 ${quota.usedCount} 次`,
      );
    }
    const newMinutes = Math.round((endTs - startTs) / MINUTE);
    if (quota.usedMinutes + newMinutes > quota.limitMinutes) {
      throw unprocessable(
        `每日累计预约时长不能超过 ${quota.limitMinutes} 分钟，你在 ${date} 已累计 ${quota.usedMinutes} 分钟`,
      );
    }

    const id = nextId('RSV', 'reservation', 4);
    const deadline = Math.min(startTs + rule.checkin_grace_min * MINUTE, endTs);
    run(
      `INSERT INTO reservations
        (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline, need_power)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      id,
      user.id,
      room.id,
      seat.id,
      startTs,
      endTs,
      rule.id,
      ts,
      deadline,
      payload.needPower ? 1 : 0,
    );
    run(
      `INSERT INTO reservation_segments (reservation_id, seat_id, start_ts, end_ts, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      seat.id,
      startTs,
      endTs,
      ts,
    );
    audit({
      actor: user,
      action: 'reservation.create',
      objectType: 'reservation',
      objectId: id,
      after: {
        roomId: room.id,
        seatId: seat.id,
        start: fmt(startTs),
        end: fmt(endTs),
        ruleVersion: rule.id,
      },
      reason: '学生提交预约',
    });
    notify(
      user.id,
      `reservation.created:${id}`,
      'reservation',
      '预约已创建',
      `${room.name} ${seat.code}，${fmt(startTs)}—${fmt(endTs)}。请在 ${fmt(deadline)} 前扫描座位桌面二维码签到。`,
    );
    const row = get('SELECT * FROM reservations WHERE id = ?', id);
    return {
      reservation: reservationDetail(row),
      ruleVersion: toRuleDto(rule),
      quota: {
        usedCount: quota.usedCount + 1,
        usedMinutes: quota.usedMinutes + newMinutes,
        limitCount: quota.limitCount,
        limitMinutes: quota.limitMinutes,
      },
    };
  });
}

function listMine(user, { from, to, status } = {}) {
  const conditions = ['user_id = ?'];
  const params = [user.id];
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (from) {
    const tsFrom = parseDate(from);
    if (tsFrom != null) {
      conditions.push('start_ts >= ?');
      params.push(tsFrom);
    }
  }
  if (to) {
    const tsTo = parseDate(to);
    if (tsTo != null) {
      conditions.push('start_ts < ?');
      params.push(tsTo + 24 * 60 * MINUTE);
    }
  }
  return all(
    `SELECT * FROM reservations WHERE ${conditions.join(' AND ')} ORDER BY start_ts DESC LIMIT 200`,
    ...params,
  ).map((r) => reservationDto(r));
}

/** 管理员查询授权场地的预约与现场状态（FR-13） */
function adminListReservations(admin, { roomId, date, status } = {}) {
  const room = requireRoom(roomId);
  if (!admin.grants.includes(room.id)) throw forbidden('无权查看该场地');
  const conditions = ['room_id = ?'];
  const params = [room.id];
  if (date) {
    const day = parseDate(date);
    if (day == null) throw badRequest('日期格式不正确');
    conditions.push('start_ts < ? AND end_ts > ?');
    params.push(day + 24 * 60 * MINUTE, day);
  }
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  return all(
    `SELECT * FROM reservations WHERE ${conditions.join(' AND ')} ORDER BY start_ts LIMIT 300`,
    ...params,
  ).map((r) => reservationDto(r, { includeUser: true }));
}

function myActiveReservations(user) {
  return tx(() => {
    const rows = all(
      `SELECT * FROM reservations WHERE user_id = ? AND status IN ${ACTIVE} ORDER BY start_ts ASC`,
      user.id,
    );
    const out = [];
    for (const row of rows) {
      const processed = processReservationDue(row);
      if (isActiveStatus(processed.status)) out.push(reservationDetail(processed));
    }
    const priority = { using: 0, away: 1, pending: 2 };
    out.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.start - b.start);
    return out;
  });
}

function getReservation(user, id, { admin = false } = {}) {
  processDue();
  const row = get('SELECT * FROM reservations WHERE id = ?', id);
  if (!row) throw notFound('预约不存在');
  if (!admin) {
    if (row.user_id !== user.id) throw forbidden('只能查看本人的预约');
  } else if (user.role === 'venue_admin') {
    if (!user.grants.includes(row.room_id)) throw forbidden('无权查看该场地的预约');
  } else if (user.role === 'sys_admin') {
    if (!user.canReview && !user.canAudit) throw forbidden('系统管理员查看业务预约明细需要业务或审计授权');
  } else {
    throw forbidden('无权查看');
  }
  return reservationDetail(row, { includeUser: admin });
}

function cancelReservation(user, id) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    assertOwnReservation(user, row);
    row = processReservationDue(row);
    if (row.status !== 'pending') {
      throw conflict(
        row.status === 'cancelled' ? '该预约已经取消' : `当前状态（${row.status}）不能取消`,
      );
    }
    if (now() >= row.start_ts) {
      throw unprocessable('预约已开始，无法取消');
    }
    const ts = now();
    closeRetentionAt(row.id, ts, 'cancelled');
    run(
      `UPDATE reservations SET status = 'cancelled', released_at = ?, ended_at = ?, cancel_reason = '本人取消', version = version + 1
        WHERE id = ? AND status = 'pending'`,
      ts,
      ts,
      row.id,
    );
    audit({
      actor: user,
      action: 'reservation.cancel',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: 'pending' },
      after: { status: 'cancelled', cancelReason: '本人取消', releasedAt: fmt(ts) },
      reason: '学生提前取消预约',
    });
    return { reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)) };
  });
}

function scanCodeMatches(code, seat) {
  const parsed = verifySeatCode(code);
  if (!parsed.valid) return { valid: false };
  const valid = parsed.roomId === seat.room_id && parsed.seatCode === seat.code;
  return { valid, roomId: parsed.roomId, seatCode: parsed.seatCode };
}

function performCheckin(user, id, { code = null, method = 'self_qr', note = null, assistedSeatId = null } = {}) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    if (!row) throw notFound('预约不存在');
    if (method === 'self_qr' && row.user_id !== user.id) throw forbidden('只能为本人预约签到');
    row = processReservationDue(row);
    if (row.status === 'using' || row.status === 'away') {
      const checkin = get('SELECT * FROM checkins WHERE reservation_id = ?', row.id);
      return {
        alreadyCheckedIn: true,
        message: '本次预约已完成签到，无需重复扫描',
        checkin: checkin
          ? {
              at: checkin.at_ts,
              atText: fmt(checkin.at_ts),
              method: checkin.method,
              seatCode: get('SELECT code FROM seats WHERE id = ?', checkin.seat_id)?.code,
            }
          : null,
        reservation: reservationDetail(row),
      };
    }
    if (row.status === 'no_show') {
      throw conflict(`预约已按爽约处理（签到截止 ${fmt(row.checkin_deadline)}），不能签到`);
    }
    if (row.status !== 'pending') {
      throw conflict(`当前预约状态为 ${row.status}，不能签到`);
    }
    const ts = now();
    if (ts < row.start_ts) {
      throw unprocessable(`预约尚未开始，签到从 ${timeStr(row.start_ts)} 开始`, {
        startText: fmt(row.start_ts),
      });
    }
    const deadline = row.checkin_protected_until ?? row.checkin_deadline;
    if (ts >= deadline) {
      throw unprocessable(`已超过签到截止时间 ${fmt(deadline)}，不能签到`);
    }
    const seat = requireSeat(row.seat_id);
    if (method === 'self_qr') {
      const match = scanCodeMatches(code, seat);
      if (!match.valid) {
        const wrongSeat = match.roomId === seat.room_id && match.seatCode && match.seatCode !== seat.code;
        throw unprocessable(
          wrongSeat
            ? `扫描到的是 ${match.seatCode}，与本次预约座位 ${seat.code} 不符。请前往 ${seat.code} 后重新扫描`
            : '二维码无效，请确认扫描的是座位桌面二维码',
          wrongSeat ? { targetSeatCode: seat.code, scannedSeatCode: match.seatCode } : null,
        );
      }
    } else if (method === 'admin_assist') {
      if (assistedSeatId && assistedSeatId !== row.seat_id) {
        throw unprocessable('辅助签到识别的座位与预约不一致');
      }
      if (!note || !String(note).trim()) throw badRequest('现场辅助签到须记录核实说明');
    } else {
      throw badRequest('未知的签到方式');
    }

    run(
      `INSERT INTO checkins (reservation_id, at_ts, method, seat_id, operator_id, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      ts,
      method,
      row.seat_id,
      user.id,
      note,
    );
    run(
      `UPDATE reservations SET status = 'using', first_checkin_at = ?, first_checkin_method = ?, version = version + 1
        WHERE id = ? AND status = 'pending'`,
      ts,
      method,
      row.id,
    );
    run(
      `INSERT INTO usage_segments (reservation_id, seat_id, start_ts) VALUES (?, ?, ?)`,
      row.id,
      row.seat_id,
      ts,
    );
    audit({
      actor: user,
      action: method === 'admin_assist' ? 'reservation.checkin_assist' : 'reservation.checkin',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: 'pending' },
      after: { status: 'using', at: fmt(ts), seatId: row.seat_id, method, note },
      reason: method === 'admin_assist' ? '管理员现场辅助签到' : '扫描桌面二维码签到',
    });
    return {
      alreadyCheckedIn: false,
      message: '签到成功',
      checkin: { at: ts, atText: fmt(ts), method, seatCode: seat.code },
      reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)),
    };
  });
}

function adminAssistCheckin(admin, id, { note, seatId }) {
  const row = get('SELECT * FROM reservations WHERE id = ?', id);
  if (!row) throw notFound('预约不存在');
  if (!admin.grants.includes(row.room_id)) throw forbidden('无权在该场地辅助签到');
  return performCheckin(admin, id, { method: 'admin_assist', note, assistedSeatId: seatId });
}

function checkoutReservation(user, id) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    assertOwnReservation(user, row);
    row = processReservationDue(row);
    if (row.status !== 'using' && row.status !== 'away') {
      throw conflict(`当前状态（${row.status}）不能签退`);
    }
    const ts = Math.min(now(), row.end_ts);
    closeOpenAway(row.id, ts, 'checkout');
    closeOpenUsage(row.id, ts, 'checkout');
    closeRetentionAt(row.id, ts, 'completed');
    run(
      `UPDATE reservations SET status = 'completed', checkout_at = ?, ended_at = ?, released_at = ?, end_reason = 'self_checkout', version = version + 1
        WHERE id = ? AND status IN ('using','away')`,
      ts,
      ts,
      ts,
      row.id,
    );
    audit({
      actor: user,
      action: 'reservation.checkout',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: row.status },
      after: { status: 'completed', endReason: 'self_checkout', at: fmt(ts) },
      reason: '学生主动签退',
    });
    return { reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)) };
  });
}

function startAway(user, id) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    assertOwnReservation(user, row);
    row = processReservationDue(row);
    if (row.status !== 'using') throw conflict(`当前状态（${row.status}）不能发起暂离`);
    const ts = now();
    if (ts >= row.end_ts) throw unprocessable('预约已到期，不能暂离');
    const open = get(
      'SELECT * FROM away_records WHERE reservation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
      row.id,
    );
    if (open) throw conflict('当前已有未结束的暂离记录');
    const rule = get('SELECT * FROM rule_versions WHERE id = ?', row.rule_version_id);
    const deadline = Math.min(ts + rule.away_minutes * MINUTE, row.end_ts);
    run(
      'INSERT INTO away_records (reservation_id, start_ts, deadline_ts) VALUES (?, ?, ?)',
      row.id,
      ts,
      deadline,
    );
    closeOpenUsage(row.id, ts, 'away');
    run(`UPDATE reservations SET status = 'away', version = version + 1 WHERE id = ? AND status = 'using'`, row.id);
    audit({
      actor: user,
      action: 'reservation.away',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: 'using' },
      after: { status: 'away', deadline: fmt(deadline) },
      reason: '学生发起暂离',
    });
    return {
      away: { start: ts, startText: fmt(ts), deadline, deadlineText: fmt(deadline) },
      reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)),
    };
  });
}

function returnFromAway(user, id) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    assertOwnReservation(user, row);
    row = processReservationDue(row);
    if (row.status !== 'away') throw conflict(`当前状态（${row.status}）不能返回座位`);
    const away = get(
      'SELECT * FROM away_records WHERE reservation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
      row.id,
    );
    if (!away) throw conflict('没有进行中的暂离记录');
    const ts = now();
    if (ts >= away.deadline_ts) throw unprocessable('已超过最晚返回时间，座位已按暂离超时处理');
    run('UPDATE away_records SET returned_at = ?, closed_at = ?, close_reason = ? WHERE id = ?', ts, ts, 'returned', away.id);
    run(`UPDATE reservations SET status = 'using', version = version + 1 WHERE id = ? AND status = 'away'`, row.id);
    run('INSERT INTO usage_segments (reservation_id, seat_id, start_ts) VALUES (?, ?, ?)', row.id, row.seat_id, ts);
    audit({
      actor: user,
      action: 'reservation.return',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: 'away' },
      after: { status: 'using', at: fmt(ts) },
      reason: '学生在保留截止前返回',
    });
    return {
      reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)),
    };
  });
}

function routeFor(user, id, entranceId = 'W') {
  processDue();
  const row = get('SELECT * FROM reservations WHERE id = ?', id);
  assertOwnReservation(user, row);
  if (!isActiveStatus(row.status)) throw conflict('该预约已结束，无法查看到座路线');
  const room = requireRoom(row.room_id);
  const seat = requireSeat(row.seat_id);
  const mapRow = get('SELECT * FROM room_maps WHERE room_id = ?', room.id);
  if (!mapRow) {
    return {
      available: false,
      fallback: {
        roomName: room.name,
        building: room.building,
        floor: room.floor,
        seatCode: seat.code,
        text: `地图暂不可用。请前往${room.building}${room.floor}的${room.name}，寻找 ${seat.code} 座位；如找不到，请向场地服务台求助。`,
      },
      reservation: reservationDetail(row),
    };
  }
  const map = JSON.parse(mapRow.data);
  const route = computeRoute(map, seat.code, entranceId === 'E' ? 'E' : 'W');
  if (!route || !route.available) {
    return {
      available: false,
      fallback: {
        roomName: room.name,
        building: room.building,
        floor: room.floor,
        seatCode: seat.code,
        text: `未找到从入口到 ${seat.code} 的可通行路线。请向场地服务台求助，或选择其他入口。`,
      },
      reservation: reservationDetail(row),
    };
  }
  run(
    'INSERT INTO route_views (reservation_id, user_id, entrance_id, map_version, distance_m, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    row.id,
    user.id,
    route.entranceId,
    route.mapVersion,
    route.distanceMeters,
    now(),
  );
  return {
    available: true,
    route,
    map,
    target: { seatCode: seat.code, seatId: seat.id, roomId: room.id, roomName: room.name },
    reservation: reservationDetail(row),
  };
}

/** 现场问题未关闭时，报告者本人的原座位不进入替代候选（BR-30） */
function seatsWithOpenSiteIssue(userId, roomId) {
  return all(
    `SELECT DISTINCT seat_id FROM complaints
      WHERE user_id = ? AND room_id = ? AND is_site = 1 AND status <> 'closed' AND seat_id IS NOT NULL`,
    userId,
    roomId,
  ).map((r) => r.seat_id);
}

function remainingInterval(row, ts) {
  if (row.status === 'pending') {
    const start = Math.max(ts, row.start_ts);
    return { start, end: row.end_ts, kind: 'pending' };
  }
  if (row.status === 'using') return { start: ts, end: row.end_ts, kind: 'using' };
  return null;
}

function swapCandidates(user, id, { needPower = false } = {}) {
  processDue();
  const row = get('SELECT * FROM reservations WHERE id = ?', id);
  assertOwnReservation(user, row);
  const processed = processReservationDue(row);
  const requiresPower = !!processed.need_power || needPower;
  if (processed.status === 'away') throw conflict('暂离中不能换座，请先返回座位');
  if (processed.status !== 'pending' && processed.status !== 'using') {
    throw conflict('只有待签到或使用中的有效预约可以申请换座');
  }
  const ts = now();
  const remaining = remainingInterval(processed, ts);
  if (!remaining || remaining.end <= remaining.start) throw conflict('预约剩余时段不足，不能换座');
  const room = requireRoom(row.room_id);
  const currentSeat = requireSeat(row.seat_id);
  const plan = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', room.id, dateStr(remaining.start));
  const excluded = new Set(seatsWithOpenSiteIssue(user.id, room.id));
  const mapRow = get('SELECT * FROM room_maps WHERE room_id = ?', room.id);
  const map = mapRow ? JSON.parse(mapRow.data) : null;

  const candidates = [];
  for (const seat of all('SELECT * FROM seats WHERE room_id = ? AND archived = 0 ORDER BY code', room.id)) {
    if (seat.id === row.seat_id) continue;
    if (excluded.has(seat.id)) continue;
    if (suspensionsForSeat(seat.id, remaining.start, remaining.end).length) continue;
    if (overlappingSeatReservations(seat.id, remaining.start, remaining.end, row.id).length) continue;
    if (overlappingUserReservations(user.id, remaining.start, remaining.end, row.id).length) continue;
    if (requiresPower && facilityOf(seat.id, 'power')?.status !== 'normal') continue;
    if (plan) {
      const dayStart = parseDate(dateStr(remaining.start));
      if (remaining.end > dayStart + plan.end_min * MINUTE || remaining.start < dayStart + plan.start_min * MINUTE) continue;
    } else {
      continue;
    }
    const route = map ? computeRoute(map, seat.code, 'W') : null;
    candidates.push({
      seatId: seat.id,
      seatCode: seat.code,
      nearWindow: !!seat.near_window,
      power: facilityOf(seat.id, 'power')?.status || 'normal',
      distanceMeters: route?.available ? route.distanceMeters : null,
      reasons: [
        `覆盖剩余时段 ${timeStr(remaining.start)}—${timeStr(remaining.end)}`,
        facilityOf(seat.id, 'power')?.status === 'normal' ? '插座正常' : '插座故障',
        ...(excluded.has(currentSeat.id) ? ['原座位存在未关闭的现场问题，已排除'] : []),
      ],
    });
  }
  return {
    reservationId: row.id,
    currentSeatCode: currentSeat.code,
    status: processed.status,
    remaining: {
      start: remaining.start,
      startText: fmt(remaining.start),
      end: remaining.end,
      endText: fmt(remaining.end),
    },
    candidates,
    emptyReason: candidates.length ? null : '同房间暂时没有符合条件的替代座位',
  };
}

function swapSeat(user, id, { targetSeatId, needPower = false, preference = 'near', expectedVersion = null }) {
  processDue();
  return tx(() => {
    let row = get('SELECT * FROM reservations WHERE id = ?', id);
    assertOwnReservation(user, row);
    row = processReservationDue(row);
    if (expectedVersion != null && Number(expectedVersion) !== row.version) {
      throw conflict('预约信息已发生变化，请刷新后重新确认换座');
    }
    if (row.status === 'away') throw conflict('暂离中不能换座，请先返回座位');
    if (row.status !== 'pending' && row.status !== 'using') {
      throw conflict('只有待签到或使用中的有效预约可以换座');
    }
    const ts = now();
    const remaining = remainingInterval(row, ts);
    if (!remaining || remaining.end <= remaining.start) throw conflict('预约剩余时段不足，不能换座');
    const target = requireSeat(targetSeatId);
    if (target.room_id !== row.room_id) throw unprocessable('换座仅限同一自习室');
    if (target.id === row.seat_id) throw badRequest('目标座位与当前座位相同');
    if (target.archived) throw unprocessable('目标座位已归档');
    const plan = get('SELECT * FROM open_plans WHERE room_id = ? AND date = ?', row.room_id, dateStr(remaining.start));
    const dayStart = parseDate(dateStr(remaining.start));
    if (!plan || remaining.start < dayStart + plan.start_min * MINUTE || remaining.end > dayStart + plan.end_min * MINUTE) {
      throw unprocessable('剩余时段不在开放计划内，不能换座');
    }
    if (suspensionsForSeat(target.id, remaining.start, remaining.end).length) {
      throw conflict('目标座位在剩余时段处于停用状态');
    }
    const requiresPower = !!row.need_power || needPower;
    if (facilityOf(target.id, 'power')?.status !== 'normal' && requiresPower) {
      throw unprocessable('目标座位插座故障，不满足必要条件');
    }
    if (overlappingSeatReservations(target.id, remaining.start, remaining.end, row.id).length) {
      throw conflict('目标座位已被其他预约占用，请重新选择');
    }
    if (overlappingUserReservations(user.id, remaining.start, remaining.end, row.id).length) {
      throw conflict('你在剩余时段已有其他有效预约，不能换到该座位');
    }
    if (seatsWithOpenSiteIssue(user.id, row.room_id).includes(target.id)) {
      throw unprocessable('目标座位与尚未关闭的现场问题关联，暂不能选择');
    }

    const switchAt = remaining.start;
    closeRetentionAt(row.id, switchAt, 'seat_change');
    run(
      'INSERT INTO reservation_segments (reservation_id, seat_id, start_ts, end_ts, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id,
      target.id,
      switchAt,
      row.end_ts,
      ts,
    );
    if (row.status === 'using') {
      closeOpenUsage(row.id, switchAt, 'seat_change');
      run('INSERT INTO usage_segments (reservation_id, seat_id, start_ts) VALUES (?, ?, ?)', row.id, target.id, switchAt);
    }
    run(
      `UPDATE reservations SET seat_id = ?, swap_count = swap_count + 1, version = version + 1 WHERE id = ?`,
      target.id,
      row.id,
    );
    const changeId = nextId('SC', 'seat_change', 4);
    run(
      `INSERT INTO seat_changes (id, reservation_id, from_seat_id, to_seat_id, at_ts, need_power, preference, operator_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      changeId,
      row.id,
      row.seat_id,
      target.id,
      switchAt,
      requiresPower ? 1 : 0,
      preference,
      user.id,
      ts,
    );
    audit({
      actor: user,
      action: 'reservation.seat_change',
      objectType: 'reservation',
      objectId: row.id,
      before: { seatId: row.seat_id, version: row.version },
      after: { seatId: target.id, at: fmt(switchAt), changeId },
      reason: '本人确认现场换座',
    });
    notify(
      user.id,
      `reservation.seat_changed:${row.id}:${row.swap_count + 1}`,
      'reservation',
      '换座已生效',
      `预约已从 ${get('SELECT code FROM seats WHERE id = ?', row.seat_id)?.code || ''} 换至 ${target.code}，结束时间与签到截止不变。请重新查看到座路线。`,
    );
    return {
      reservation: reservationDetail(get('SELECT * FROM reservations WHERE id = ?', row.id)),
      changeId,
    };
  });
}

export {
  processDue,
  rejectOccupancyProtection,
  processReservationDue,
  createReservation,
  listMine,
  adminListReservations,
  myActiveReservations,
  getReservation,
  cancelReservation,
  performCheckin,
  adminAssistCheckin,
  checkoutReservation,
  startAway,
  returnFromAway,
  routeFor,
  swapCandidates,
  swapSeat,
  reservationDetail,
  seatsWithOpenSiteIssue,
};
