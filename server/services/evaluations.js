import { all, get, nextId, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../audit.js';
import { fmt } from '../time.js';
import { requireRoom } from './shared.js';

function roomRatingSummary(roomId) {
  const row = get(
    `SELECT COUNT(*) AS count, AVG(rating) AS average FROM evaluations WHERE room_id = ?`,
    roomId,
  );
  return {
    count: row?.count || 0,
    average: row?.average != null ? Math.round(row.average * 10) / 10 : null,
  };
}

function evaluationDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    reservationId: row.reservation_id,
    roomId: row.room_id,
    rating: row.rating,
    content: row.content,
    visibility: row.visibility,
    hiddenReason: row.hidden_reason,
    createdAt: row.created_at,
    createdAtText: fmt(row.created_at),
    updatedAt: row.updated_at,
    history: all(
      `SELECT h.*, u.display_name AS actor_name FROM evaluation_history h
         LEFT JOIN users u ON u.id = h.actor_id
        WHERE h.evaluation_id = ? ORDER BY h.id`,
      row.id,
    ).map((h) => ({
      rating: h.rating,
      content: h.content,
      visibility: h.visibility,
      action: h.action,
      actorName: h.actor_name || '系统',
      createdAtText: fmt(h.created_at),
    })),
  };
}

function saveEvaluation(user, reservationId, { rating, content }) {
  return tx(() => {
    const reservation = get('SELECT * FROM reservations WHERE id = ?', reservationId);
    if (!reservation) throw notFound('预约不存在');
    if (reservation.user_id !== user.id) throw forbidden('只能评价本人的预约');
    if (reservation.status !== 'completed') throw unprocessable('只有已完成的预约可以评价');
    if (!reservation.first_checkin_at) throw unprocessable('只有已签到并完成的预约可以评价');
    const score = Number(rating);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw badRequest('评分必须为 1—5 的整数');
    const text = String(content || '').trim();
    if (text.length > 500) throw badRequest('评价文字不能超过 500 字');
    const ts = now();
    const existing = get('SELECT * FROM evaluations WHERE reservation_id = ?', reservationId);
    let id;
    if (existing) {
      id = existing.id;
      run(
        `UPDATE evaluations SET rating = ?, content = ?, updated_at = ? WHERE id = ?`,
        score,
        text,
        ts,
        id,
      );
      run(
        `INSERT INTO evaluation_history (evaluation_id, rating, content, visibility, action, actor_id, created_at)
         VALUES (?, ?, ?, ?, 'update', ?, ?)`,
        id,
        score,
        text,
        existing.visibility,
        user.id,
        ts,
      );
      audit({
        actor: user,
        action: 'evaluation.update',
        objectType: 'evaluation',
        objectId: id,
        before: { rating: existing.rating, content: existing.content },
        after: { rating: score, content: text },
        reason: '学生修改评价',
      });
    } else {
      id = nextId('EV', 'evaluation', 4);
      run(
        `INSERT INTO evaluations (id, reservation_id, user_id, room_id, rating, content, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'visible', ?, ?)`,
        id,
        reservationId,
        user.id,
        reservation.room_id,
        score,
        text,
        ts,
        ts,
      );
      run(
        `INSERT INTO evaluation_history (evaluation_id, rating, content, visibility, action, actor_id, created_at)
         VALUES (?, ?, ?, 'visible', 'create', ?, ?)`,
        id,
        score,
        text,
        user.id,
        ts,
      );
      audit({
        actor: user,
        action: 'evaluation.create',
        objectType: 'evaluation',
        objectId: id,
        after: { reservationId, rating: score, content: text },
        reason: '学生对已完成预约评价',
      });
    }
    return {
      evaluation: evaluationDto(get('SELECT * FROM evaluations WHERE id = ?', id)),
      roomSummary: roomRatingSummary(reservation.room_id),
    };
  });
}

function listRoomEvaluations(roomId, { limit = 50 } = {}) {
  requireRoom(roomId);
  // 仅返回房间聚合信息；个人评价正文与身份不通过此接口公开
  return roomRatingSummary(roomId);
}

function hideEvaluation(admin, id, { reason, hidden = true }) {
  return tx(() => {
    const row = get('SELECT * FROM evaluations WHERE id = ?', id);
    if (!row) throw notFound('评价不存在');
    if (!admin.grants.includes(row.room_id)) throw forbidden('只能管理被授权场地的评价');
    const note = String(reason || '').trim();
    if (!note) throw badRequest('隐藏或恢复评价文字须填写理由');
    const visibility = hidden ? 'hidden' : 'visible';
    if (row.visibility === visibility) return { evaluation: evaluationDto(row) };
    run(
      `UPDATE evaluations SET visibility = ?, hidden_reason = ?, hidden_by = ?, updated_at = ? WHERE id = ?`,
      visibility,
      hidden ? note : null,
      hidden ? admin.id : null,
      now(),
      id,
    );
    run(
      `INSERT INTO evaluation_history (evaluation_id, rating, content, visibility, action, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      row.rating,
      row.content,
      visibility,
      hidden ? 'hide' : 'unhide',
      admin.id,
      now(),
    );
    audit({
      actor: admin,
      action: hidden ? 'evaluation.hide' : 'evaluation.unhide',
      objectType: 'evaluation',
      objectId: id,
      before: { visibility: row.visibility },
      after: { visibility },
      reason: note,
    });
    return { evaluation: evaluationDto(get('SELECT * FROM evaluations WHERE id = ?', id)) };
  });
}

function adminListEvaluations(admin, { roomId } = {}) {
  const rooms = roomId ? [roomId] : admin.grants;
  if (!rooms.length) return [];
  if (roomId && !admin.grants.includes(roomId)) throw forbidden('无权查看该场地评价');
  return all(
    `SELECT * FROM evaluations WHERE room_id IN (${rooms.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 200`,
    ...rooms,
  ).map((e) => {
    const dto = evaluationDto(e);
    const user = get('SELECT display_name FROM users WHERE id = ?', e.user_id);
    const room = get('SELECT name FROM rooms WHERE id = ?', e.room_id);
    const reservation = get('SELECT id, start_ts, end_ts FROM reservations WHERE id = ?', e.reservation_id);
    return {
      ...dto,
      userName: user?.display_name,
      roomName: room?.name,
      reservationText: reservation ? `${fmt(reservation.start_ts)}—${fmt(reservation.end_ts)}` : null,
    };
  });
}

export { saveEvaluation, roomRatingSummary, hideEvaluation, adminListEvaluations, listRoomEvaluations, evaluationDto };