import { all, get, run, tx } from '../db.js';
import { now } from '../clock.js';
import { badRequest } from '../errors.js';
import { audit } from '../audit.js';
import { fmt } from '../time.js';
import { reservationDto, isActiveStatus } from './shared.js';

function myViolations(user) {
  return all('SELECT * FROM violations WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 200', user.id).map((v) => {
    const room = get('SELECT name FROM rooms WHERE id = ?', v.room_id);
    const reservation = v.reservation_id ? get('SELECT * FROM reservations WHERE id = ?', v.reservation_id) : null;
    return {
      id: v.id,
      roomId: v.room_id,
      roomName: room?.name,
      reservationId: v.reservation_id,
      reservationText: reservation ? `${fmt(reservation.start_ts)}—${fmt(reservation.end_ts)}` : null,
      occurredAt: v.occurred_at,
      occurredAtText: fmt(v.occurred_at),
      type: v.type,
      typeLabel: v.type === 'no_show' ? '未按时签到' : '现场事件',
      material: v.material,
      status: v.status,
      statusLabel: v.status === 'pending' ? '待复核' : v.status === 'effective' ? '已生效' : '已撤销',
      decisionReason: v.decision_reason,
      decidedAtText: v.decided_at ? fmt(v.decided_at) : null,
      revokeReason: v.revoke_reason,
      revokedAtText: v.revoked_at ? fmt(v.revoked_at) : null,
      canAppeal: v.status !== 'revoked',
    };
  });
}

function myLimits(user) {
  const ts = now();
  return all('SELECT * FROM limits WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', user.id).map((l) => {
    const room = l.room_scope === 'ALL' ? null : get('SELECT name FROM rooms WHERE id = ?', l.room_scope);
    const basis = all(
      `SELECT v.* FROM violations v JOIN limit_basis b ON b.violation_id = v.id WHERE b.limit_id = ?`,
      l.id,
    ).map((v) => ({ id: v.id, status: v.status, occurredAtText: fmt(v.occurred_at), typeLabel: v.type === 'no_show' ? '未按时签到' : '现场事件' }));
    return {
      id: l.id,
      roomScope: l.room_scope,
      roomName: room?.name || (l.room_scope === 'ALL' ? '全部场地' : l.room_scope),
      startText: fmt(l.start_ts),
      endText: fmt(l.end_ts),
      start: l.start_ts,
      end: l.end_ts,
      reason: l.reason,
      active: !l.revoked_at && l.start_ts <= ts && ts < l.end_ts,
      expired: !l.revoked_at && l.end_ts <= ts,
      revokedAtText: l.revoked_at ? fmt(l.revoked_at) : null,
      revokeReason: l.revoke_reason,
      basis,
    };
  });
}

function myOverview(user) {
  const ts = now();
  const rows = all('SELECT * FROM reservations WHERE user_id = ? ORDER BY start_ts DESC LIMIT 300', user.id);
  const active = rows.filter((r) => isActiveStatus(r.status)).map((r) => reservationDto(r));
  const upcoming = rows.filter((r) => r.status === 'pending' && r.start_ts > ts).map((r) => reservationDto(r));
  const current = active.find((r) => r.status === 'using' || r.status === 'away') || null;
  const limit = get(
    `SELECT * FROM limits WHERE user_id = ? AND revoked_at IS NULL AND start_ts <= ? AND ? < end_ts
      ORDER BY start_ts DESC LIMIT 1`,
    user.id,
    ts,
    ts,
  );
  return {
    active: active.sort((a, b) => {
      const priority = { using: 0, away: 1, pending: 2 };
      return (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.start - b.start;
    }),
    current,
    upcoming,
    counts: {
      total: rows.length,
      completed: rows.filter((r) => r.status === 'completed').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
      noShow: rows.filter((r) => r.status === 'no_show').length,
    },
    restriction: limit
      ? { id: limit.id, start: fmt(limit.start_ts), end: fmt(limit.end_ts), reason: limit.reason, scope: limit.room_scope }
      : null,
    unpaidEvaluation: rows
      .filter((r) => r.status === 'completed' && r.first_checkin_at)
      .filter((r) => !get('SELECT 1 FROM evaluations WHERE reservation_id = ?', r.id))
      .slice(0, 20)
      .map((r) => reservationDto(r)),
  };
}

const PROFILE_FIELDS = new Set(['displayName', 'notifySite', 'notifyReminder']);

function updateProfile(user, payload) {
  return tx(() => {
    const keys = Object.keys(payload || {});
    const unknown = keys.filter((k) => !PROFILE_FIELDS.has(k));
    if (unknown.length) throw badRequest(`请求包含不允许修改的字段：${unknown.join('、')}`);
    if (!keys.length) throw badRequest('没有需要修改的内容');
    const ts = now();
    const userRow = get('SELECT * FROM users WHERE id = ?', user.id);
    if (!userRow) throw notFound('账号不存在');
    const before = { displayName: userRow.display_name, notifySite: !!userRow.notify_site, notifyReminder: !!userRow.notify_reminder };
    if (payload.displayName !== undefined) {
      const name = String(payload.displayName).trim();
      if (!name || name.length > 30) throw badRequest('显示名须为 1—30 个字符');
      run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', name, ts, user.id);
    }
    if (payload.notifySite !== undefined) {
      run('UPDATE users SET notify_site = ?, updated_at = ? WHERE id = ?', payload.notifySite ? 1 : 0, ts, user.id);
    }
    if (payload.notifyReminder !== undefined) {
      run('UPDATE users SET notify_reminder = ?, updated_at = ? WHERE id = ?', payload.notifyReminder ? 1 : 0, ts, user.id);
    }
    const after = get('SELECT * FROM users WHERE id = ?', user.id);
    audit({
      actor: user,
      action: 'profile.update',
      objectType: 'user',
      objectId: user.id,
      before,
      after: { displayName: after.display_name, notifySite: !!after.notify_site, notifyReminder: !!after.notify_reminder },
      reason: '本人修改允许字段',
    });
    return {
      profile: {
        id: after.id,
        username: after.username,
        displayName: after.display_name,
        notifySite: !!after.notify_site,
        notifyReminder: !!after.notify_reminder,
      },
    };
  });
}

export { myViolations, myLimits, myOverview, updateProfile };