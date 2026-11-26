import { all, get, nextId, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../audit.js';
import { fmt, MINUTE } from '../time.js';
import { requireRoom, requireSeat, notify, reservationDto, isActiveStatus } from './shared.js';
import { rejectOccupancyProtection } from './reservations.js';

const TYPE_LABELS = {
  facility: '设施问题',
  service: '服务问题',
  appeal: '违约申诉',
};

const STATUS_LABELS = {
  pending: '待受理',
  processing: '处理中',
  answered: '已答复',
  closed: '已关闭',
};

function complaintEvents(complaintId) {
  return all(
    `SELECT e.*, u.display_name AS author_name FROM complaint_events e
       LEFT JOIN users u ON u.id = e.author_id
      WHERE e.complaint_id = ? ORDER BY e.id`,
    complaintId,
  ).map((e) => ({
    id: e.id,
    kind: e.kind,
    authorId: e.author_id,
    authorName: e.author_name || '系统',
    body: e.body,
    createdAt: e.created_at,
    createdAtText: fmt(e.created_at),
  }));
}

function complaintDto(row, { withEvents = true } = {}) {
  const user = get('SELECT id, display_name FROM users WHERE id = ?', row.user_id);
  const room = get('SELECT id, name FROM rooms WHERE id = ?', row.room_id);
  const seat = row.seat_id ? get('SELECT id, code FROM seats WHERE id = ?', row.seat_id) : null;
  const reservation = row.reservation_id ? get('SELECT * FROM reservations WHERE id = ?', row.reservation_id) : null;
  const assignee = row.assignee_id ? get('SELECT display_name FROM users WHERE id = ?', row.assignee_id) : null;
  const accused = row.accused_id ? get('SELECT display_name FROM users WHERE id = ?', row.accused_id) : null;
  return {
    id: row.id,
    userId: row.user_id,
    userName: user?.display_name || row.user_id,
    roomId: row.room_id,
    roomName: room?.name || row.room_id,
    type: row.type,
    typeLabel: row.is_occupancy ? '座位被占用' : TYPE_LABELS[row.type] || row.type,
    description: row.description,
    reservationId: row.reservation_id,
    reservation: reservation ? reservationDto(reservation) : null,
    violationId: row.violation_id,
    isSite: !!row.is_site,
    isOccupancy: !!row.is_occupancy,
    seatId: row.seat_id,
    seatCode: seat?.code || null,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    assigneeId: row.assignee_id,
    assigneeName: assignee?.display_name || null,
    accusedId: row.accused_id,
    accusedName: accused?.display_name || null,
    createdAt: row.created_at,
    createdAtText: fmt(row.created_at),
    acceptedAt: row.accepted_at,
    repliedAt: row.replied_at,
    closedAt: row.closed_at,
    events: withEvents ? complaintEvents(row.id) : undefined,
  };
}

function canHandleComplaint(admin, complaint) {
  if (admin.role === 'sys_admin') return !!admin.canReview;
  if (admin.role !== 'venue_admin') return false;
  return admin.grants.includes(complaint.room_id);
}

function assertNotAccused(admin, complaint) {
  if (complaint.accused_id && complaint.accused_id === admin.id) {
    throw forbidden('你与该投诉存在回避关系，不能处理该投诉');
  }
}

function submitComplaint(user, payload) {
  return tx(() => {
    if (user.role !== 'student') throw forbidden('只有学生账号可以提交投诉');
    const room = requireRoom(payload.roomId);
    const type = payload.type;
    if (!TYPE_LABELS[type]) throw badRequest('投诉类型不正确');
    const description = String(payload.description || '').trim();
    if (!description) throw badRequest('请填写问题说明');
    if (description.length > 2000) throw badRequest('问题说明过长');

    let reservation = null;
    let seat = null;
    if (payload.reservationId) {
      reservation = get('SELECT * FROM reservations WHERE id = ?', payload.reservationId);
      if (!reservation) throw notFound('关联预约不存在');
      if (reservation.user_id !== user.id) throw forbidden('不能为他人的预约提交投诉');
      if (reservation.room_id !== room.id) throw unprocessable('预约不属于所选自习室');
    }
    if (payload.isSite) {
      if (!reservation) throw unprocessable('现场问题必须关联本人当前预约');
      if (!isActiveStatus(reservation.status)) throw unprocessable('预约已结束，不能提交现场问题');
      seat = requireSeat(reservation.seat_id);
    }

    let violation = null;
    let accusedId = null;
    if (payload.violationId) {
      violation = get('SELECT * FROM violations WHERE id = ?', payload.violationId);
      if (!violation) throw notFound('关联违规记录不存在');
      if (violation.user_id !== user.id) throw forbidden('只能对本人违规记录申诉');
      if (violation.room_id !== room.id) {
        throw unprocessable('关联违规记录不属于所选自习室');
      }
      accusedId = violation.decided_by || violation.created_by || null;
      if (accusedId) {
        const accusedUser = get('SELECT role FROM users WHERE id = ?', accusedId);
        if (!accusedUser || accusedUser.role !== 'venue_admin') accusedId = null;
      }
    }

    const ts = now();
    const id = nextId('C', 'complaint', 4);
    run(
      `INSERT INTO complaints (id, user_id, room_id, type, description, reservation_id, violation_id, is_site, is_occupancy, seat_id, status, accused_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      user.id,
      room.id,
      type,
      description,
      reservation?.id || null,
      violation?.id || null,
      payload.isSite ? 1 : 0,
      payload.isSite && payload.isOccupancy && type === 'service' ? 1 : 0,
      seat?.id || null,
      accusedId,
      ts,
    );
    run(
      'INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      'submit',
      user.id,
      description,
      ts,
    );
    audit({
      actor: user,
      action: payload.isSite ? 'complaint.site_issue' : 'complaint.create',
      objectType: 'complaint',
      objectId: id,
      after: { roomId: room.id, type, reservationId: reservation?.id || null, seatId: seat?.id || null },
      reason: description.slice(0, 200),
    });
    return { complaint: complaintDto(get('SELECT * FROM complaints WHERE id = ?', id)) };
  });
}

function listMine(user) {
  return all('SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', user.id).map((c) =>
    complaintDto(c, { withEvents: false }),
  );
}

function getComplaintForUser(user, id) {
  const row = get('SELECT * FROM complaints WHERE id = ?', id);
  if (!row) throw notFound('投诉不存在');
  if (row.user_id !== user.id) throw forbidden('只能查看本人的投诉');
  return complaintDto(row);
}

function listForAdmin(admin, { roomId, status, isSite } = {}) {
  const conditions = [];
  const params = [];
  if (roomId) {
    requireRoom(roomId);
    if (!admin.grants.includes(roomId) && !(admin.role === 'sys_admin' && admin.canReview)) {
      throw forbidden('无权查看该场地的投诉');
    }
    conditions.push('room_id = ?');
    params.push(roomId);
  } else if (admin.role === 'venue_admin') {
    if (!admin.grants.length) return [];
    conditions.push(`room_id IN (${admin.grants.map(() => '?').join(',')})`);
    params.push(...admin.grants);
  } else if (!(admin.role === 'sys_admin' && admin.canReview)) {
    throw forbidden('无权查看投诉');
  }
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (isSite != null) {
    conditions.push('is_site = ?');
    params.push(isSite ? 1 : 0);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return all(`SELECT * FROM complaints ${where} ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'answered' THEN 2 ELSE 3 END,
      created_at DESC LIMIT 300`, ...params).map((c) => complaintDto(c, { withEvents: false }));
}

function getForAdmin(admin, id) {
  const row = get('SELECT * FROM complaints WHERE id = ?', id);
  if (!row) throw notFound('投诉不存在');
  if (!canHandleComplaint(admin, row)) throw forbidden('无权查看该投诉');
  assertNotAccused(admin, row);
  return complaintDto(row);
}

function acceptComplaint(admin, id) {
  return tx(() => {
    const row = get('SELECT * FROM complaints WHERE id = ?', id);
    if (!row) throw notFound('投诉不存在');
    if (!canHandleComplaint(admin, row)) throw forbidden('无权受理该投诉');
    assertNotAccused(admin, row);
    if (row.status !== 'pending') throw conflict(`该投诉当前状态为 ${STATUS_LABELS[row.status]}，不能受理`);
    const ts = now();
    run(
      `UPDATE complaints SET status = 'processing', assignee_id = ?, accepted_at = ? WHERE id = ? AND status = 'pending'`,
      admin.id,
      ts,
      id,
    );
    if (row.is_occupancy) {
      const reservation = get('SELECT * FROM reservations WHERE id = ?', row.reservation_id);
      if (reservation?.status === 'pending' && reservation.seat_id === row.seat_id
        && !reservation.checkin_protection_id && ts < reservation.checkin_deadline) {
        const until = Math.min(ts + 30 * MINUTE, reservation.end_ts);
        if (until > reservation.checkin_deadline) {
          run('UPDATE reservations SET checkin_protection_id = ?, checkin_protected_until = ? WHERE id = ?',
            id, until, reservation.id);
          notify(row.user_id, `complaint.occupancy_protected:${id}`, 'complaint',
            '座位占用报告已受理', `预约保留至 ${fmt(until)}，请在此之前签到或换座后签到。`);
        }
      }
    }
    run(
      'INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      'accept',
      admin.id,
      '已受理，开始核实',
      ts,
    );
    audit({
      actor: admin,
      action: 'complaint.accept',
      objectType: 'complaint',
      objectId: id,
      before: { status: 'pending' },
      after: { status: 'processing', assigneeId: admin.id },
      reason: '管理员受理投诉',
    });
    return { complaint: complaintDto(get('SELECT * FROM complaints WHERE id = ?', id)) };
  });
}

function replyComplaint(admin, id, { body, occupancyUnfounded = false }) {
  return tx(() => {
    const row = get('SELECT * FROM complaints WHERE id = ?', id);
    if (!row) throw notFound('投诉不存在');
    if (!canHandleComplaint(admin, row)) throw forbidden('无权处理该投诉');
    assertNotAccused(admin, row);
    if (row.status !== 'processing') throw conflict(`该投诉当前状态为 ${STATUS_LABELS[row.status]}，不能答复`);
    const text = String(body || '').trim();
    if (!text) throw badRequest('答复须填写处理结果、依据及必要纠正');
    if (occupancyUnfounded && !row.is_occupancy) throw badRequest('仅占座报告可标记为核实不属实');
    const ts = now();
    run(
      `UPDATE complaints SET status = 'answered', replied_at = ?, assignee_id = COALESCE(assignee_id, ?) WHERE id = ? AND status = 'processing'`,
      ts,
      admin.id,
      id,
    );
    run(
      'INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      'reply',
      admin.id,
      text,
      ts,
    );
    audit({
      actor: admin,
      action: 'complaint.reply',
      objectType: 'complaint',
      objectId: id,
      before: { status: 'processing' },
      after: { status: 'answered', ...(row.is_occupancy ? { occupancyUnfounded } : {}) },
      reason: text.slice(0, 200),
    });
    if (occupancyUnfounded) rejectOccupancyProtection(row, ts);
    notify(
      row.user_id,
      `complaint.answered:${id}:${row.replied_at || 0}`,
      'complaint',
      '投诉已答复',
      `你的${TYPE_LABELS[row.type]}投诉（${fmt(row.created_at)}）已有答复：${text}。如仍有问题，可补充材料；确认解决后可关闭投诉。`,
    );
    return { complaint: complaintDto(get('SELECT * FROM complaints WHERE id = ?', id)) };
  });
}

function supplementComplaint(user, id, { body }) {
  return tx(() => {
    const row = get('SELECT * FROM complaints WHERE id = ?', id);
    if (!row) throw notFound('投诉不存在');
    if (row.user_id !== user.id) throw forbidden('只能补充本人的投诉');
    if (row.status !== 'answered') throw conflict('只有已答复的投诉可以补充材料');
    const text = String(body || '').trim();
    if (!text) throw badRequest('请填写补充说明');
    const ts = now();
    run(`UPDATE complaints SET status = 'processing' WHERE id = ? AND status = 'answered'`, id);
    run(
      'INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      'supplement',
      user.id,
      text,
      ts,
    );
    audit({
      actor: user,
      action: 'complaint.supplement',
      objectType: 'complaint',
      objectId: id,
      before: { status: 'answered' },
      after: { status: 'processing' },
      reason: text.slice(0, 200),
    });
    if (row.assignee_id) {
      notify(
        row.assignee_id,
        `complaint.supplement:${id}:${ts}`,
        'complaint',
        '投诉收到补充材料',
        `学生补充了材料（${fmt(ts)}），投诉已回到处理中，请继续核实并答复。`,
      );
    }
    return { complaint: complaintDto(get('SELECT * FROM complaints WHERE id = ?', id)) };
  });
}

function closeComplaint(user, id) {
  return tx(() => {
    const row = get('SELECT * FROM complaints WHERE id = ?', id);
    if (!row) throw notFound('投诉不存在');
    if (row.user_id !== user.id) throw forbidden('只能关闭本人的投诉');
    if (row.status === 'closed') return { complaint: complaintDto(row) };
    if (row.status !== 'answered') throw conflict('只有已答复的投诉可以由本人确认关闭');
    const ts = now();
    run(`UPDATE complaints SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'answered'`, ts, id);
    run(
      'INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      'close',
      user.id,
      '本人确认问题已解决并关闭',
      ts,
    );
    audit({
      actor: user,
      action: 'complaint.close',
      objectType: 'complaint',
      objectId: id,
      before: { status: 'answered' },
      after: { status: 'closed' },
      reason: '本人确认关闭',
    });
    return { complaint: complaintDto(get('SELECT * FROM complaints WHERE id = ?', id)) };
  });
}

/** 预约详情中“座位遇到问题”的进度查询 */
function siteIssuesForReservation(user, reservationId) {
  const rows = all(
    'SELECT * FROM complaints WHERE reservation_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20',
    reservationId,
    user.id,
  );
  return rows.map((c) => complaintDto(c));
}

export {
  TYPE_LABELS,
  STATUS_LABELS,
  submitComplaint,
  listMine,
  getComplaintForUser,
  listForAdmin,
  getForAdmin,
  acceptComplaint,
  replyComplaint,
  supplementComplaint,
  closeComplaint,
  siteIssuesForReservation,
};
