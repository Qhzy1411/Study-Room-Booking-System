import crypto from 'node:crypto';
import { all, get, nextId, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest, forbidden, notFound, unprocessable, conflict } from '../errors.js';
import { audit } from '../audit.js';
import { fmt } from '../time.js';
import { requireRoom, notify, reservationDto } from './shared.js';
import { parseDateTime } from './suspensions.js';

function canReview(admin, roomId) {
  if (!admin) return false;
  if (admin.role === 'venue_admin') return admin.grants.includes(roomId);
  if (admin.role === 'sys_admin') return !!admin.canReview;
  return false;
}

function violationDto(row) {
  const user = get('SELECT id, display_name FROM users WHERE id = ?', row.user_id);
  const room = get('SELECT id, name FROM rooms WHERE id = ?', row.room_id);
  const reservation = row.reservation_id ? get('SELECT * FROM reservations WHERE id = ?', row.reservation_id) : null;
  const limits = all(
    `SELECT l.* FROM limits l JOIN limit_basis b ON b.limit_id = l.id WHERE b.violation_id = ?`,
    row.id,
  ).map((l) => ({ id: l.id, start: fmt(l.start_ts), end: fmt(l.end_ts), revokedAt: l.revoked_at }));
  return {
    id: row.id,
    userId: row.user_id,
    userName: user?.display_name || row.user_id,
    roomId: row.room_id,
    roomName: room?.name || row.room_id,
    reservationId: row.reservation_id,
    reservation: reservation ? reservationDto(reservation) : null,
    occurredAt: row.occurred_at,
    occurredAtText: fmt(row.occurred_at),
    type: row.type,
    material: row.material,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    ruleVersionId: row.rule_version_id,
    limits,
  };
}

function listViolations(admin, { roomId, status, userId } = {}) {
  const conditions = [];
  const params = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (roomId) {
    requireRoom(roomId);
    if (!canReview(admin, roomId)) throw forbidden('无权查看该场地的违规记录');
    conditions.push('room_id = ?');
    params.push(roomId);
  } else if (admin.role === 'venue_admin') {
    if (!admin.grants.length) return [];
    conditions.push(`room_id IN (${admin.grants.map(() => '?').join(',')})`);
    params.push(...admin.grants);
  } else if (admin.role !== 'sys_admin') {
    throw forbidden('无权查看');
  }
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return all(`SELECT * FROM violations ${where} ORDER BY created_at DESC LIMIT 300`, ...params).map(violationDto);
}

function registerManualViolation(admin, payload) {
  return tx(() => {
    const room = requireRoom(payload.roomId);
    if (!canReview(admin, room.id)) throw forbidden('无权登记该场地的违规事件');
    const target = get('SELECT * FROM users WHERE id = ?', payload.userId);
    if (!target) throw notFound('被登记的用户不存在');
    const occurredAt = parseDateTime(payload.occurredAt);
    if (occurredAt == null) throw badRequest('事件时间格式不正确');
    if (occurredAt > now() + 60000) throw unprocessable('事件时间不能晚于当前时间');
    const material = String(payload.material || '').trim();
    if (material.length < 5) throw badRequest('须填写现场事实、时间、地点及证据说明');
    const type = String(payload.type || 'site_event').trim();
    let reservationId = payload.reservationId || null;
    if (reservationId) {
      const reservation = get('SELECT * FROM reservations WHERE id = ?', reservationId);
      if (!reservation) throw notFound('关联预约不存在');
      if (reservation.user_id !== target.id || reservation.room_id !== room.id) {
        throw unprocessable('关联预约不属于该用户或该场地');
      }
    }
    const eventKey = `manual:${target.id}:${room.id}:${occurredAt}:${type}:${crypto
      .createHash('sha1')
      .update(material)
      .digest('hex')
      .slice(0, 12)}`;
    const existing = get('SELECT * FROM violations WHERE event_key = ?', eventKey);
    if (existing) return { violation: violationDto(existing), duplicated: true };
    const id = nextId('V', 'violation', 4);
    run(
      `INSERT INTO violations (id, event_key, user_id, room_id, reservation_id, occurred_at, type, material, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      eventKey,
      target.id,
      room.id,
      reservationId,
      occurredAt,
      type,
      material,
      admin.id,
      now(),
    );
    audit({
      actor: admin,
      action: 'violation.register',
      objectType: 'violation',
      objectId: id,
      after: { userId: target.id, roomId: room.id, occurredAt: fmt(occurredAt), type, reservationId },
      reason: material,
    });
    notify(
      target.id,
      `violation.pending:${id}`,
      'violation',
      '收到一条待复核事件',
      `管理员登记了一条与你在 ${room.name} 使用相关的事件（${fmt(occurredAt)}）。该记录尚在待复核状态，不等同处罚；复核结果可在“我的记录”中查看，如有异议可提交申诉。`,
    );
    return { violation: violationDto(get('SELECT * FROM violations WHERE id = ?', id)), duplicated: false };
  });
}

function reconcileLimitsForViolation(violationId, actor, reason) {
  const limits = all(
    `SELECT DISTINCT l.* FROM limits l JOIN limit_basis b ON b.limit_id = l.id
      WHERE b.violation_id = ? AND l.revoked_at IS NULL`,
    violationId,
  );
  const revoked = [];
  for (const limit of limits) {
    const remaining = get(
      `SELECT COUNT(*) AS n FROM limit_basis b JOIN violations v ON v.id = b.violation_id
        WHERE b.limit_id = ? AND v.status <> 'revoked'`,
      limit.id,
    ).n;
    if (remaining === 0) {
      run(
        'UPDATE limits SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL',
        now(),
        actor.id,
        reason || '关联违规依据全部撤销，限制同步解除',
        limit.id,
      );
      revoked.push(limit.id);
      audit({
        actor,
        action: 'limit.auto_revoke',
        objectType: 'limit',
        objectId: limit.id,
        before: { status: 'active' },
        after: { status: 'revoked' },
        reason: reason || '关联违规依据全部撤销',
      });
      notify(
        limit.user_id,
        `limit.revoked:${limit.id}`,
        'limit',
        '预约限制已解除',
        `${fmt(limit.start_ts)}—${fmt(limit.end_ts)} 的预约限制因所依据的违规记录被撤销而自动解除。`,
      );
    }
  }
  return revoked;
}

function decideViolation(admin, id, { decision, reason, evidence = null }) {
  return tx(() => {
    const row = get('SELECT * FROM violations WHERE id = ?', id);
    if (!row) throw notFound('违规记录不存在');
    if (!canReview(admin, row.room_id)) throw forbidden('无权复核该场地的违规记录');
    if (row.status !== 'pending') throw conflict(`该记录当前状态为 ${row.status}，不能再作待复核裁决`);
    const note = String(reason || '').trim();
    if (!note) throw badRequest('复核须填写理由与依据');
    if (decision !== 'effective' && decision !== 'revoked') throw badRequest('未知的复核结论');
    const ts = now();
    if (decision === 'effective') {
      run(
        `UPDATE violations SET status = 'effective', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ? AND status = 'pending'`,
        admin.id,
        ts,
        note,
        id,
      );
    } else {
      run(
        `UPDATE violations SET status = 'revoked', decided_by = ?, decided_at = ?, decision_reason = ?, revoked_by = ?, revoked_at = ?, revoke_reason = ? WHERE id = ? AND status = 'pending'`,
        admin.id,
        ts,
        note,
        admin.id,
        ts,
        note,
        id,
      );
    }
    audit({
      actor: admin,
      action: decision === 'effective' ? 'violation.confirm' : 'violation.dismiss',
      objectType: 'violation',
      objectId: id,
      before: { status: 'pending' },
      after: { status: decision === 'effective' ? 'effective' : 'revoked', reason: note },
      reason: note,
    });
    notify(
      row.user_id,
      `violation.decided:${id}`,
      'violation',
      decision === 'effective' ? '违规记录已生效' : '违规记录已撤销',
      decision === 'effective'
        ? `你在 ${fmt(row.occurred_at)} 的违规记录经复核后生效。理由：${note}。如你有异议，可在“投诉与申诉”中提交申诉。`
        : `你在 ${fmt(row.occurred_at)} 的违规记录经复核后撤销。理由：${note}。相关限制如仅依据该记录设置，将同步解除。`,
    );
    const revokedLimits = decision === 'revoked' ? reconcileLimitsForViolation(id, admin, note) : [];
    return {
      violation: violationDto(get('SELECT * FROM violations WHERE id = ?', id)),
      revokedLimits,
      evidence,
    };
  });
}

function revokeEffectiveViolation(admin, id, { reason }) {
  return tx(() => {
    const row = get('SELECT * FROM violations WHERE id = ?', id);
    if (!row) throw notFound('违规记录不存在');
    if (!canReview(admin, row.room_id)) throw forbidden('无权复核该场地的违规记录');
    if (row.status !== 'effective') throw conflict(`该记录当前状态为 ${row.status}，不能撤销`);
    const note = String(reason || '').trim();
    if (!note) throw badRequest('撤销须填写理由与依据');
    const ts = now();
    run(
      `UPDATE violations SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ? WHERE id = ? AND status = 'effective'`,
      admin.id,
      ts,
      note,
      id,
    );
    audit({
      actor: admin,
      action: 'violation.revoke',
      objectType: 'violation',
      objectId: id,
      before: { status: 'effective' },
      after: { status: 'revoked', reason: note },
      reason: note,
    });
    notify(
      row.user_id,
      `violation.revoked:${id}`,
      'violation',
      '违规记录已撤销',
      `你在 ${fmt(row.occurred_at)} 的违规记录经复核撤销。理由：${note}。相关限制如仅依据该记录设置，将同步解除。`,
    );
    const revokedLimits = reconcileLimitsForViolation(id, admin, note);
    return { violation: violationDto(get('SELECT * FROM violations WHERE id = ?', id)), revokedLimits };
  });
}

function limitDto(row) {
  const user = get('SELECT display_name FROM users WHERE id = ?', row.user_id);
  const basis = all(
    `SELECT v.* FROM violations v JOIN limit_basis b ON b.violation_id = v.id WHERE b.limit_id = ? ORDER BY v.occurred_at`,
    row.id,
  ).map((v) => ({ id: v.id, status: v.status, occurredAtText: fmt(v.occurred_at), type: v.type }));
  const room = row.room_scope === 'ALL' ? null : get('SELECT name FROM rooms WHERE id = ?', row.room_scope);
  return {
    id: row.id,
    userId: row.user_id,
    userName: user?.display_name || row.user_id,
    roomScope: row.room_scope,
    roomName: room?.name || (row.room_scope === 'ALL' ? '全部场地' : row.room_scope),
    start: row.start_ts,
    end: row.end_ts,
    startText: fmt(row.start_ts),
    endText: fmt(row.end_ts),
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    active: !row.revoked_at && row.start_ts <= now() && now() < row.end_ts,
    basis,
  };
}

function listLimits(admin, { roomId } = {}) {
  let rows;
  if (roomId) {
    requireRoom(roomId);
    if (!admin.grants.includes(roomId) && !(admin.role === 'sys_admin' && admin.canReview)) {
      throw forbidden('无权查看该场地的限制');
    }
    rows = all('SELECT * FROM limits WHERE room_scope = ? OR room_scope = ? ORDER BY created_at DESC LIMIT 200', roomId, 'ALL');
  } else if (admin.role === 'venue_admin') {
    if (!admin.grants.length) return [];
    rows = all(
      `SELECT prio.* FROM limits prio
        WHERE room_scope = 'ALL' OR room_scope IN (${admin.grants.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT 200`,
      ...admin.grants,
    );
  } else if (admin.role === 'sys_admin' && admin.canReview) {
    rows = all('SELECT * FROM limits ORDER BY created_at DESC LIMIT 200');
  } else {
    throw forbidden('无权查看预约限制');
  }
  return rows.map(limitDto);
}

function createLimit(admin, payload) {
  return tx(() => {
    const user = get('SELECT * FROM users WHERE id = ?', payload.userId);
    if (!user) throw notFound('用户不存在');
    const scope = payload.roomScope === 'ALL' ? 'ALL' : payload.roomScope;
    if (scope !== 'ALL') {
      requireRoom(scope);
      if (!admin.grants.includes(scope)) throw forbidden('无权为该场地设置限制');
    } else if (!(admin.role === 'sys_admin' && admin.canReview)) {
      throw forbidden('设置全部场地范围的限制需要业务复核授权');
    }
    const startTs = parseDateTime(payload.startAt);
    const endTs = parseDateTime(payload.endAt);
    if (startTs == null || endTs == null) throw badRequest('限制起止时间格式不正确');
    if (endTs <= startTs) throw unprocessable('限制结束时间必须晚于开始时间');
    const reason = String(payload.reason || '').trim();
    if (!reason) throw badRequest('须填写限制理由');
    const ids = Array.isArray(payload.violationIds) ? payload.violationIds : [];
    if (!ids.length) throw unprocessable('预约限制必须至少关联一条已生效的违规记录');
    const basis = [];
    for (const vid of ids) {
      const v = get('SELECT * FROM violations WHERE id = ?', vid);
      if (!v) throw notFound('所选违规记录不存在');
      if (v.user_id !== user.id) throw unprocessable('违规记录不属于该用户');
      if (v.status !== 'effective') throw unprocessable('所选违规记录尚未生效，不能作为限制依据');
      if (scope !== 'ALL' && v.room_id !== scope) throw unprocessable('违规记录不属于该场地');
      basis.push(v);
    }
    const id = nextId('L', 'limit', 4);
    run(
      `INSERT INTO limits (id, user_id, room_scope, start_ts, end_ts, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      scope,
      startTs,
      endTs,
      reason,
      admin.id,
      now(),
    );
    for (const v of basis) run('INSERT INTO limit_basis (limit_id, violation_id) VALUES (?, ?)', id, v.id);
    audit({
      actor: admin,
      action: 'limit.create',
      objectType: 'limit',
      objectId: id,
      after: { userId: user.id, roomScope: scope, start: fmt(startTs), end: fmt(endTs), basis: ids },
      reason,
    });
    const scopeLabel = scope === 'ALL'
      ? '全部场地'
      : (get('SELECT name FROM rooms WHERE id = ?', scope)?.name || '指定场地');
    notify(
      user.id,
      `limit.created:${id}`,
      'limit',
      '收到预约限制',
      `你的账号在 ${fmt(startTs)} 至 ${fmt(endTs)} 期间被限制创建新预约（范围：${scopeLabel}）。理由：${reason}。既有预约不受影响；如有异议可提交申诉。`,
    );
    return { limit: limitDto(get('SELECT * FROM limits WHERE id = ?', id)) };
  });
}

function revokeLimit(admin, id, { reason }) {
  return tx(() => {
    const row = get('SELECT * FROM limits WHERE id = ?', id);
    if (!row) throw notFound('限制不存在');
    if (row.room_scope !== 'ALL' && !admin.grants.includes(row.room_scope)) {
      if (!(admin.role === 'sys_admin' && admin.canReview)) throw forbidden('无权操作该场地的限制');
    } else if (row.room_scope === 'ALL' && !(admin.role === 'sys_admin' && admin.canReview)) {
      throw forbidden('无权解除全部场地范围的限制');
    }
    if (row.revoked_at) throw conflict('该限制已经解除');
    const note = String(reason || '').trim();
    if (!note) throw badRequest('解除限制须填写理由');
    run('UPDATE limits SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?', now(), admin.id, note, id);
    audit({
      actor: admin,
      action: 'limit.revoke',
      objectType: 'limit',
      objectId: id,
      before: { status: 'active' },
      after: { status: 'revoked', reason: note },
      reason: note,
    });
    notify(
      row.user_id,
      `limit.revoked:${id}`,
      'limit',
      '预约限制已解除',
      `${fmt(row.start_ts)}—${fmt(row.end_ts)} 的预约限制已解除。理由：${note}。`,
    );
    return { limit: limitDto(get('SELECT * FROM limits WHERE id = ?', id)) };
  });
}

function listFaults(admin, { roomId } = {}) {
  let rows;
  if (roomId) {
    if (!admin.grants.includes(roomId) && !(admin.role === 'sys_admin' && admin.canReview)) throw forbidden('无权查看');
    rows = all('SELECT * FROM faults WHERE room_id = ? ORDER BY start_ts DESC LIMIT 200', roomId);
  } else if (admin.role === 'venue_admin') {
    if (!admin.grants.length) return [];
    rows = all(
      `SELECT * FROM faults WHERE room_id IN (${admin.grants.map(() => '?').join(',')}) ORDER BY start_ts DESC LIMIT 200`,
      ...admin.grants,
    );
  } else {
    rows = all('SELECT * FROM faults ORDER BY start_ts DESC LIMIT 200');
  }
  return rows.map((f) => {
    const room = get('SELECT name FROM rooms WHERE id = ?', f.room_id);
    const impacted = all(
      `SELECT v.* FROM violations v JOIN reservations r ON r.id = v.reservation_id
        WHERE v.room_id = ? AND v.type = 'no_show' AND r.checkin_deadline >= ? AND r.checkin_deadline < ?
        ORDER BY r.checkin_deadline`,
      f.room_id,
      f.start_ts,
      f.end_ts,
    );
    return {
      id: f.id,
      roomId: f.room_id,
      roomName: room?.name,
      function: f.function,
      start: f.start_ts,
      end: f.end_ts,
      startText: fmt(f.start_ts),
      endText: fmt(f.end_ts),
      description: f.description,
      verified: !!f.verified,
      verifiedBy: f.verified_by,
      createdAt: f.created_at,
      impactedViolations: impacted.map((v) => ({ id: v.id, status: v.status, userId: v.user_id, occurredAtText: fmt(v.occurred_at) })),
    };
  });
}

function createFault(admin, payload) {
  return tx(() => {
    const room = requireRoom(payload.roomId);
    if (!admin.grants.includes(room.id)) throw forbidden('无权登记该场地的故障');
    const startTs = parseDateTime(payload.startAt);
    const endTs = parseDateTime(payload.endAt);
    if (startTs == null || endTs == null) throw badRequest('故障起止时间格式不正确');
    if (endTs <= startTs) throw unprocessable('故障结束时间必须晚于开始时间');
    const fn = String(payload.function || 'checkin').trim();
    const description = String(payload.description || '').trim();
    if (!description) throw badRequest('须填写故障影响与核实说明');
    const id = nextId('F', 'fault', 4);
    run(
      `INSERT INTO faults (id, room_id, function, start_ts, end_ts, description, verified, verified_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      room.id,
      fn,
      startTs,
      endTs,
      description,
      admin.id,
      now(),
    );
    audit({
      actor: admin,
      action: 'fault.create',
      objectType: 'fault',
      objectId: id,
      after: { roomId: room.id, function: fn, start: fmt(startTs), end: fmt(endTs) },
      reason: description,
    });
    // BR-19：签到截止落在已核实的签到故障区间时，默认撤销该爽约记录并纠正相关限制
    const revoked = [];
    if (fn === 'checkin') {
      const impacted = all(
        `SELECT v.* FROM violations v JOIN reservations r ON r.id = v.reservation_id
          WHERE v.room_id = ? AND v.type = 'no_show'
            AND r.checkin_deadline >= ? AND r.checkin_deadline < ?
            AND v.status IN ('pending','effective')`,
        room.id,
        startTs,
        endTs,
      );
      for (const v of impacted) {
        const reasonText = `签到截止落在已核实的签到故障区间（${fmt(startTs)}—${fmt(endTs)}），依据规则自动撤销`;
        run(
          `UPDATE violations SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?, decision_reason = COALESCE(decision_reason, ?) WHERE id = ?`,
          admin.id,
          now(),
          reasonText,
          reasonText,
          v.id,
        );
        audit({
          actor: admin,
          action: 'violation.fault_revoke',
          objectType: 'violation',
          objectId: v.id,
          before: { status: v.status },
          after: { status: 'revoked', faultId: id },
          reason: reasonText,
        });
        notify(
          v.user_id,
          `violation.fault_revoked:${v.id}`,
          'violation',
          '签到故障导致的违规已撤销',
          `你在 ${fmt(v.occurred_at)} 的违规记录因签到截止处于已核实的系统故障区间，已按规则撤销。相关限制如仅依据该记录设置，将同步解除。`,
        );
        reconcileLimitsForViolation(v.id, admin, reasonText);
        revoked.push(v.id);
      }
    }
    return {
      fault: listFaults(admin, { roomId: room.id }).find((f) => f.id === id),
      revokedViolations: revoked,
    };
  });
}

export {
  canReview,
  listViolations,
  registerManualViolation,
  decideViolation,
  revokeEffectiveViolation,
  listLimits,
  createLimit,
  revokeLimit,
  listFaults,
  createFault,
  limitDto,
  violationDto,
};