import { all, get, run, tx } from '../db.js';
import { now, offset, isDemo, setNow, syncToRealTime } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../audit.js';
import { fmt, parseDate, parseTime } from '../time.js';
import { hashPassword, destroyUserSessions } from '../auth.js';
import { toRuleDto, currentRule } from './shared.js';

function isSysAdmin(user) {
  return user.role === 'sys_admin';
}

function userDto(row) {
  const grantRows = all(
    `SELECT g.room_id, r.name, r.building, r.floor
       FROM room_grants g LEFT JOIN rooms r ON r.id = g.room_id
      WHERE g.user_id = ? ORDER BY g.room_id`,
    row.id,
  );
  const grants = grantRows.map((g) => g.room_id);
  const grantRooms = grantRows.map((g) => ({
    id: g.room_id,
    name: g.name || g.room_id,
    building: g.building || '',
    floor: g.floor || '',
  }));
  const perms = get('SELECT * FROM business_permissions WHERE user_id = ?', row.id) || {};
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: !!row.enabled,
    notifySite: !!row.notify_site,
    notifyReminder: !!row.notify_reminder,
    grants,
    grantRooms,
    permissions: {
      canReview: !!perms.can_review,
      canStats: !!perms.can_stats,
      canRules: !!perms.can_rules,
      canAudit: !!perms.can_audit,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function searchStudents(admin, query) {
  if (admin.role !== 'venue_admin' && admin.role !== 'sys_admin') throw forbidden('无权查询');
  const q = String(query || '').trim();
  if (q.length < 1) return [];
  const like = `%${q.toLowerCase()}%`;
  return all(
    `SELECT id, username, display_name FROM users
      WHERE role = 'student' AND (LOWER(id) LIKE ? OR username LIKE ? OR display_name LIKE ?)
      ORDER BY id LIMIT 10`,
    like,
    like,
    `%${q}%`,
  ).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }));
}

function listUsers(admin) {
  if (!isSysAdmin(admin)) throw forbidden('只有系统管理员可以维护账号');
  return all('SELECT * FROM users ORDER BY role, id').map(userDto);
}

function countEnabledSysAdmins(excludeUserId = null) {
  return get(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'sys_admin' AND enabled = 1 ${excludeUserId ? 'AND id <> ?' : ''}`,
    ...(excludeUserId ? [excludeUserId] : []),
  ).n;
}

function nextUserId(role) {
  const prefix = role === 'student' ? 'U' : role === 'venue_admin' ? 'M' : 'S';
  const rows = all('SELECT id FROM users WHERE id LIKE ?', `${prefix}%`);
  let max = 0;
  for (const row of rows) {
    const n = Number(String(row.id).slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

function validateRole(role) {
  if (!['student', 'venue_admin', 'sys_admin'].includes(role)) throw badRequest('角色不正确');
}

function normalizeIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((v) => String(v)))];
}

function validateGrants(grants) {
  const ids = normalizeIds(grants);
  for (const id of ids) {
    if (!get('SELECT 1 FROM rooms WHERE id = ?', id)) throw notFound('自习室不存在');
  }
  return ids;
}

function createUser(admin, payload) {
  return tx(() => {
    if (!isSysAdmin(admin)) throw forbidden('只有系统管理员可以维护账号');
    const username = String(payload.username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      throw badRequest('账号须为 3—32 位小写字母、数字或 . _ -');
    }
    if (get('SELECT 1 FROM users WHERE username = ?', username)) throw conflict('账号已存在');
    const displayName = String(payload.displayName || '').trim();
    if (!displayName || displayName.length > 30) throw badRequest('显示名须为 1—30 个字符');
    const password = String(payload.password || '');
    if (password.length < 6) throw badRequest('初始密码至少 6 位');
    validateRole(payload.role);
    const grants = payload.role === 'venue_admin' ? validateGrants(payload.grants || []) : [];
    const id = nextUserId(payload.role);
    const ts = now();
    run(
      `INSERT INTO users (id, username, display_name, password_hash, role, enabled, notify_site, notify_reminder, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
      id,
      username,
      displayName,
      hashPassword(password),
      payload.role,
      ts,
      ts,
    );
    for (const roomId of grants) {
      run(
        'INSERT INTO room_grants (user_id, room_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
        id,
        roomId,
        admin.id,
        ts,
      );
    }
    const p = payload.permissions || {};
    run(
      `INSERT INTO business_permissions (user_id, can_review, can_stats, can_rules, can_audit) VALUES (?, ?, ?, ?, ?)`,
      id,
      p.canReview ? 1 : 0,
      p.canStats ? 1 : 0,
      p.canRules ? 1 : 0,
      p.canAudit ? 1 : 0,
    );
    audit({
      actor: admin,
      action: 'user.create',
      objectType: 'user',
      objectId: id,
      after: { username, role: payload.role, grants, permissions: p },
      reason: '系统管理员创建账号',
    });
    return { user: userDto(get('SELECT * FROM users WHERE id = ?', id)) };
  });
}

function updateUser(admin, id, payload) {
  return tx(() => {
    if (!isSysAdmin(admin)) throw forbidden('只有系统管理员可以维护账号');
    const row = get('SELECT * FROM users WHERE id = ?', id);
    if (!row) throw notFound('账号不存在');
    const before = userDto(row);
    const ts = now();

    const nextRole = payload.role ?? row.role;
    validateRole(nextRole);
    const nextEnabled = payload.enabled == null ? !!row.enabled : !!payload.enabled;
    const isCurrentlySys = row.role === 'sys_admin' && row.enabled;
    const willRemainSys = nextRole === 'sys_admin' && nextEnabled;
    if (isCurrentlySys && !willRemainSys && countEnabledSysAdmins(id) === 0) {
      throw unprocessable('不能禁用最后一名启用的系统管理员，或移除其系统管理角色');
    }
    if (payload.displayName != null) {
      const name = String(payload.displayName).trim();
      if (!name || name.length > 30) throw badRequest('显示名须为 1—30 个字符');
      run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', name, ts, id);
    }
    if (payload.role != null) run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', nextRole, ts, id);
    if (payload.enabled != null) run('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?', nextEnabled ? 1 : 0, ts, id);
    if (payload.password != null) {
      if (String(payload.password).length < 6) throw badRequest('密码至少 6 位');
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(payload.password), ts, id);
    }
    if (payload.grants != null) {
      const grants = nextRole === 'venue_admin' ? validateGrants(payload.grants) : [];
      run('DELETE FROM room_grants WHERE user_id = ?', id);
      for (const roomId of grants) {
        run(
          'INSERT INTO room_grants (user_id, room_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
          id,
          roomId,
          admin.id,
          ts,
        );
      }
    }
    if (payload.permissions != null) {
      const p = payload.permissions;
      run(
        `INSERT INTO business_permissions (user_id, can_review, can_stats, can_rules, can_audit) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET can_review = excluded.can_review, can_stats = excluded.can_stats,
           can_rules = excluded.can_rules, can_audit = excluded.can_audit`,
        id,
        p.canReview ? 1 : 0,
        p.canStats ? 1 : 0,
        p.canRules ? 1 : 0,
        p.canAudit ? 1 : 0,
      );
    }
    const roleChanged = payload.role != null && payload.role !== row.role;
    const disabled = payload.enabled === false && row.enabled;
    if (roleChanged || disabled) destroyUserSessions(id);
    const after = userDto(get('SELECT * FROM users WHERE id = ?', id));
    audit({
      actor: admin,
      action: 'user.update',
      objectType: 'user',
      objectId: id,
      before: {
        displayName: before.displayName,
        role: before.role,
        enabled: before.enabled,
        grants: before.grants,
        permissions: before.permissions,
      },
      after: {
        displayName: after.displayName,
        role: after.role,
        enabled: after.enabled,
        grants: after.grants,
        permissions: after.permissions,
      },
      reason: payload.reason || '系统管理员调整账号、角色或授权',
    });
    return { user: after };
  });
}

function listRuleVersions(admin) {
  if (!isSysAdmin(admin) && !admin.canRules) throw forbidden('没有规则维护权限');
  return all('SELECT * FROM rule_versions ORDER BY effective_from DESC, created_at DESC').map((r) => ({
    ...toRuleDto(r),
    createdBy: r.created_by,
    createdAtText: fmt(r.created_at),
    current: currentRule(now())?.id === r.id,
  }));
}

function publishRuleVersion(admin, payload) {
  return tx(() => {
    if (!isSysAdmin(admin) && !admin.canRules) throw forbidden('没有规则维护权限');
    const fields = {
      advance_days: Number(payload.advanceDays),
      checkin_grace_min: Number(payload.checkinGraceMin),
      away_minutes: Number(payload.awayMinutes),
      min_minutes: Number(payload.minMinutes),
      daily_count: Number(payload.dailyCount),
      daily_minutes: Number(payload.dailyMinutes),
    };
    const bounds = {
      advance_days: [1, 30],
      checkin_grace_min: [1, 240],
      away_minutes: [1, 240],
      min_minutes: [5, 480],
      daily_count: [1, 20],
      daily_minutes: [5, 1440],
    };
    for (const [key, [lo, hi]] of Object.entries(bounds)) {
      const value = fields[key];
      if (!Number.isInteger(value) || value < lo || value > hi) {
        throw badRequest(`${key} 须为 ${lo}—${hi} 的整数`);
      }
    }
    if (fields.daily_minutes < fields.min_minutes) throw badRequest('每日累计时长不能小于单次最小时长');
    const ts = now();
    const index = get('SELECT COUNT(*) AS n FROM rule_versions').n + 1;
    const id = `RV-${index}`;
    run(
      `INSERT INTO rule_versions (id, advance_days, checkin_grace_min, away_minutes, min_minutes, daily_count, daily_minutes, effective_from, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fields.advance_days,
      fields.checkin_grace_min,
      fields.away_minutes,
      fields.min_minutes,
      fields.daily_count,
      fields.daily_minutes,
      ts,
      payload.note || null,
      admin.id,
      ts,
    );
    audit({
      actor: admin,
      action: 'rule.publish',
      objectType: 'rule_version',
      objectId: id,
      after: { ...payload },
      reason: payload.note || '发布新规则版本',
    });
    return { rule: toRuleDto(get('SELECT * FROM rule_versions WHERE id = ?', id)) };
  });
}

function listAudit(admin, { limit = 200, action = null, actorId = null } = {}) {
  const conditions = [];
  const params = [];
  if (admin.role === 'venue_admin') {
    conditions.push('actor_id = ?');
    params.push(admin.id);
  } else if (admin.role === 'sys_admin') {
    if (!admin.canAudit) {
      // 系统管理员默认可以查看技术配置变更审计，业务审计需另行授权
      conditions.push("(action LIKE 'user.%' OR action LIKE 'rule.%' OR action LIKE 'roommap.%' OR action LIKE 'seat.%')");
    }
  } else {
    throw forbidden('无权查看审计记录');
  }
  if (action) {
    conditions.push('action LIKE ?');
    params.push(`${action}%`);
  }
  if (actorId) {
    conditions.push('actor_id = ?');
    params.push(actorId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return all(
    `SELECT * FROM audits ${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    Math.min(Number(limit) || 200, 500),
  ).map((a) => {
    const actor = a.actor_id ? get('SELECT display_name FROM users WHERE id = ?', a.actor_id) : null;
    return {
      id: a.id,
      actorId: a.actor_id,
      actorName: actor?.display_name || a.actor_id || '系统',
      actorRole: a.actor_role,
      action: a.action,
      objectType: a.object_type,
      objectId: a.object_id,
      before: a.before_json ? JSON.parse(a.before_json) : null,
      after: a.after_json ? JSON.parse(a.after_json) : null,
      reason: a.reason,
      result: a.result,
      createdAt: a.created_at,
      createdAtText: fmt(a.created_at),
    };
  });
}

function setDemoClock(admin, { at }) {
  if (!isDemo()) throw forbidden('演示时钟未启用');
  if (!isSysAdmin(admin)) throw forbidden('只有系统管理员可以调整演示时钟');
  if (at === 'now' || at == null) {
    syncToRealTime();
    return clockInfo();
  }
  const raw = String(at).trim().replace('T', ' ');
  const m = /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) throw badRequest('时间格式应为 YYYY-MM-DD HH:MM');
  const day = parseDate(m[1]);
  const min = parseTime(m[2]);
  if (day == null || min == null) throw badRequest('时间格式不正确');
  const target = day + min * 60000 + (Number(m[3] || 0) * 1000);
  setNow(target);
  audit({
    actor: admin,
    action: 'demo.clock',
    objectType: 'clock',
    objectId: 'business_clock',
    after: { now: fmt(target) },
    reason: '演示模式调整业务时钟',
  });
  return clockInfo();
}

function clockInfo() {
  return {
    demoMode: isDemo(),
    now: now(),
    nowText: fmt(now()),
    offsetMs: offset(),
    usingRealTime: offset() === 0,
  };
}

export {
  searchStudents,
  listUsers,
  createUser,
  updateUser,
  listRuleVersions,
  publishRuleVersion,
  listAudit,
  setDemoClock,
  clockInfo,
  countEnabledSysAdmins,
  userDto,
};