import crypto from 'node:crypto';
import { all, get, nextId, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest, forbidden, notFound, unprocessable, conflict } from '../errors.js';
import { audit } from '../audit.js';
import { fmt, parseDate, parseTime } from '../time.js';
import { processDue } from './reservations.js';
import {
  requireRoom,
  requireSeat,
  notify,
  reservationDto,
} from './shared.js';

function parseDateTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const raw = String(value).trim().replace('T', ' ');
  const m = /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2})(?::\d{2})?$/.exec(raw);
  if (!m) return null;
  const day = parseDate(m[1]);
  const minutes = parseTime(m[2]);
  if (day == null || minutes == null) return null;
  return day + minutes * 60000;
}

function impactHash({ seatId, startTs, endTs, reason, affected, immediate }) {
  const payload = {
    seatId,
    endTs,
    reason,
    affected: affected.map((r) => `${r.id}:${r.status}`).sort(),
    ...(immediate ? {} : { startTs }),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function affectedReservations(seatId, startTs, endTs) {
  return all(
    `SELECT DISTINCT r.*
       FROM reservation_segments s
       JOIN reservations r ON r.id = s.reservation_id
      WHERE s.seat_id = ?
        AND s.closed_reason IS NULL
        AND r.status IN ('pending','using','away')
        AND s.start_ts < ? AND ? < s.end_ts
      ORDER BY r.start_ts`,
    seatId,
    endTs,
    startTs,
  );
}

function buildPreview(admin, payload) {
  const seat = requireSeat(payload.seatId);
  const room = requireRoom(seat.room_id);
  if (!admin.grants.includes(room.id)) throw forbidden('无权操作该场地的座位');
  const startTs = payload.immediate === true ? now() : parseDateTime(payload.startAt);
  const endTs = parseDateTime(payload.endAt);
  const reason = String(payload.reason || '').trim();
  if (startTs == null || endTs == null) throw badRequest('停用开始与结束时间格式不正确');
  if (endTs <= startTs) throw unprocessable('停用结束时间必须晚于开始时间');
  const ts = now();
  if (startTs < ts - 1000) throw unprocessable('停用开始时间不得早于当前时间；如需立即停用请选择“立即开始”');
  if (!reason) throw badRequest('停用原因不能为空');
  const affected = affectedReservations(seat.id, startTs, endTs);
  const activeInInterval = affected.filter((r) => r.status === 'using' || r.status === 'away');
  const immediate = payload.immediate === true || startTs <= ts + 1000;
  if (!immediate && activeInInterval.length) {
    throw conflict(
      '未来停用与正在使用或暂离中的预约相交。请调整开始时间，或执行立即停用并先确认现场清场。',
    );
  }
  return {
    seat,
    room,
    startTs,
    endTs,
    reason,
    immediate,
    affected: affected.map((r) => ({
      ...reservationDto(r, { includeUser: true }),
      plannedAction:
        r.status === 'pending'
          ? '按场地原因取消，免罚并返还当日额度'
          : '立即停用：现场确认清场后异常关闭，免罚',
    })),
    needClearance: activeInInterval.length > 0,
    impactHash: impactHash({ seatId: seat.id, startTs, endTs, reason, affected, immediate }),
  };
}

function previewSuspension(admin, payload) {
  const preview = buildPreview(admin, payload);
  return {
    seat: { id: preview.seat.id, code: preview.seat.code, roomId: preview.room.id },
    startAt: fmt(preview.startTs),
    endAt: fmt(preview.endTs),
    reason: preview.reason,
    immediate: preview.immediate,
    affected: preview.affected,
    needClearance: preview.needClearance,
    impactHash: preview.impactHash,
  };
}

function cancelForVenue(row, ts, suspensionId, admin, kind) {
  if (row.status === 'pending') {
    run(
      `UPDATE reservation_segments SET closed_reason = 'venue_suspension'
        WHERE reservation_id = ? AND closed_reason IS NULL`,
      row.id,
    );
    run(
      `UPDATE reservations
          SET status = 'cancelled', released_at = ?, ended_at = ?, cancel_reason = '场地停用', end_reason = 'venue_suspension', waived = 1, version = version + 1
        WHERE id = ? AND status = 'pending'`,
      ts,
      ts,
      row.id,
    );
    audit({
      actor: admin,
      action: 'reservation.venue_cancel',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: 'pending' },
      after: { status: 'cancelled', waived: true, suspensionId },
      reason: '场地停用免罚取消',
    });
  } else {
    run(
      `UPDATE usage_segments SET end_ts = ?, close_reason = 'venue_suspension'
        WHERE reservation_id = ? AND end_ts IS NULL`,
      ts,
      row.id,
    );
    run(
      `UPDATE away_records SET closed_at = ?, close_reason = 'venue_suspension'
        WHERE reservation_id = ? AND closed_at IS NULL`,
      ts,
      row.id,
    );
    run(
      `UPDATE reservation_segments SET end_ts = MIN(end_ts, ?), closed_reason = 'venue_suspension'
        WHERE reservation_id = ? AND end_ts > ?`,
      ts,
      row.id,
      ts,
    );
    run(
      `UPDATE reservations
          SET status = 'aborted', released_at = ?, ended_at = ?, end_reason = 'venue_suspension', waived = 1, version = version + 1
        WHERE id = ? AND status IN ('using','away')`,
      ts,
      ts,
      row.id,
    );
    audit({
      actor: admin,
      action: 'reservation.venue_close',
      objectType: 'reservation',
      objectId: row.id,
      before: { status: row.status },
      after: { status: 'aborted', waived: true, suspensionId },
      reason: '立即停用，现场确认清场后关闭',
    });
  }
  notify(
    row.user_id,
    `reservation.venue_action:${row.id}`,
    'reservation',
    kind === 'cancelled' ? '预约因场地停用被取消（免罚）' : '预约因场地停用被关闭（免罚）',
    `你在 ${fmt(row.start_ts)}—${fmt(row.end_ts)} 的预约因场地停用${kind === 'cancelled' ? '被取消' : '被异常关闭'}。本次处置免罚，场馆原因不计入当日预约额度。如有疑问可联系场地管理员或提交投诉。`,
  );
}

function commitSuspension(admin, payload) {
  processDue();
  return tx(() => {
    const preview = buildPreview(admin, payload);
    if (payload.impactHash !== preview.impactHash) {
      throw conflict('影响集合已变化，请重新预览后再提交');
    }
    if (preview.needClearance && payload.cleared !== true) {
      throw unprocessable('立即停用正在使用或暂离中的座位，须先确认现场已清场');
    }
    const ts = now();
    const id = nextId('SUS', 'suspension', 4);
    run(
      `INSERT INTO suspensions (id, room_id, seat_id, start_ts, end_ts, reason, status, impact_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id,
      preview.room.id,
      preview.seat.id,
      preview.startTs,
      preview.endTs,
      preview.reason,
      preview.impactHash,
      admin.id,
      ts,
    );
    for (const affected of preview.affected) {
      const row = get('SELECT * FROM reservations WHERE id = ?', affected.id);
      if (row.status === 'pending') cancelForVenue(row, ts, id, admin, 'cancelled');
      else if (row.status === 'using' || row.status === 'away') cancelForVenue(row, ts, id, admin, 'aborted');
    }
    audit({
      actor: admin,
      action: 'suspension.create',
      objectType: 'suspension',
      objectId: id,
      after: {
        seatId: preview.seat.id,
        start: fmt(preview.startTs),
        end: fmt(preview.endTs),
        reason: preview.reason,
        affected: preview.affected.map((r) => r.id),
      },
      reason: preview.reason,
    });
    return {
      suspension: {
        id,
        seatId: preview.seat.id,
        seatCode: preview.seat.code,
        start: preview.startTs,
        end: preview.endTs,
        startText: fmt(preview.startTs),
        endText: fmt(preview.endTs),
        reason: preview.reason,
        status: 'active',
      },
      affected: preview.affected.map((r) => r.id),
    };
  });
}

function restoreSuspension(admin, id, reason) {
  return tx(() => {
    const row = get('SELECT * FROM suspensions WHERE id = ?', id);
    if (!row) throw notFound('停用安排不存在');
    if (!admin.grants.includes(row.room_id)) throw forbidden('无权操作该场地');
    if (row.status === 'restored') throw conflict('该停用安排已经提前恢复');
    run(
      `UPDATE suspensions SET status = 'restored', restored_at = ?, restored_by = ?, restore_reason = ? WHERE id = ?`,
      now(),
      admin.id,
      reason || '管理员提前恢复',
      id,
    );
    audit({
      actor: admin,
      action: 'suspension.restore',
      objectType: 'suspension',
      objectId: id,
      before: { status: 'active' },
      after: { status: 'restored' },
      reason: reason || '管理员提前恢复',
    });
    return { suspension: get('SELECT * FROM suspensions WHERE id = ?', id) };
  });
}

function listSuspensions(roomId, { includeExpired = false } = {}) {
  const ts = now();
  const rows = all(
    `SELECT s.*, st.code AS seat_code FROM suspensions s
       JOIN seats st ON st.id = s.seat_id
      WHERE s.room_id = ? ${includeExpired ? '' : "AND s.status = 'active' AND s.end_ts > ?"}
      ORDER BY s.start_ts DESC LIMIT 200`,
    ...(includeExpired ? [roomId] : [roomId, ts]),
  );
  return rows.map((s) => ({
    id: s.id,
    seatId: s.seat_id,
    seatCode: s.seat_code,
    start: s.start_ts,
    end: s.end_ts,
    startText: fmt(s.start_ts),
    endText: fmt(s.end_ts),
    reason: s.reason,
    status: s.status,
    createdAt: s.created_at,
    restoredAt: s.restored_at,
    restoredBy: s.restored_by,
    restoreReason: s.restore_reason,
    currentlyActive: s.status === 'active' && s.start_ts <= ts && s.end_ts > ts,
  }));
}

export {
  previewSuspension,
  commitSuspension,
  restoreSuspension,
  listSuspensions,
  parseDateTime,
  affectedReservations,
};
