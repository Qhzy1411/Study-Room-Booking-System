import crypto from 'node:crypto';
import config from './config.js';
import { all, get, run } from './db.js';
import { forbidden, unauthorized } from './errors.js';

const SCRYPT_N = 16384;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: SCRYPT_N });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
    tokenHash(token),
    userId,
    t,
    t + config.sessionTtlMs,
    t,
  );
  return token;
}

function destroySession(token) {
  if (!token) return;
  run('DELETE FROM sessions WHERE id = ?', tokenHash(token));
}

function destroyUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function loadSessionUser(token) {
  if (!token) return null;
  const session = get('SELECT * FROM sessions WHERE id = ?', tokenHash(token));
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    run('DELETE FROM sessions WHERE id = ?', session.id);
    return null;
  }
  const user = get('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user) return null;
  return user;
}

function decorateUser(user) {
  if (!user) return null;
  const grantRows = all(
    `SELECT g.room_id, r.name, r.building, r.floor
       FROM room_grants g LEFT JOIN rooms r ON r.id = g.room_id
      WHERE g.user_id = ? ORDER BY g.room_id`,
    user.id,
  );
  const grants = grantRows.map((r) => r.room_id);
  const grantRooms = grantRows.map((r) => ({
    id: r.room_id,
    name: r.name || r.room_id,
    building: r.building || '',
    floor: r.floor || '',
  }));
  const perms = get('SELECT * FROM business_permissions WHERE user_id = ?', user.id) || {};
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    enabled: !!user.enabled,
    notifySite: !!user.notify_site,
    notifyReminder: !!user.notify_reminder,
    grants,
    grantRooms,
    canReview: !!perms.can_review,
    canStats: !!perms.can_stats || user.role === 'venue_admin',
    canRules: !!perms.can_rules,
    canAudit: !!perms.can_audit,
  };
}

/** Express 中间件：解析登录态。未登录不直接拒绝，由各路由决定。 */
function attachUser(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  const raw = loadSessionUser(token);
  req.sessionToken = token;
  if (raw && !raw.enabled) {
    destroySession(token);
    req.user = null;
    req.authError = '账号已被停用，请联系管理员';
    res.clearCookie(config.cookieName);
    return next();
  }
  req.user = decorateUser(raw);
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.authError) return next(unauthorized(req.authError));
    return next(unauthorized());
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('当前角色无权访问该功能'));
    return next();
  };
}

function isRoomGranted(user, roomId) {
  if (!user) return false;
  if (user.role === 'sys_admin') return false; // 系统管理员默认不拥有业务场地权限
  return user.grants.includes(roomId);
}

function assertRoomAccess(user, roomId) {
  if (user.role === 'sys_admin' && user.canReview) {
    // 获得业务复核授权的系统管理员可处理投诉升级，但仍不能直接维护场地资源
    return;
  }
  if (!isRoomGranted(user, roomId)) {
    throw forbidden('无权操作该场地');
  }
}

function requireRoomParam(param = 'roomId') {
  return (req, res, next) => {
    const roomId = req.params[param] || req.body?.roomId || req.query?.roomId;
    if (!roomId) return next(forbidden('缺少场地参数'));
    if (!isRoomGranted(req.user, roomId)) return next(forbidden('无权访问该场地'));
    return next();
  };
}

export {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroyUserSessions,
  parseCookies,
  attachUser,
  requireAuth,
  requireRole,
  isRoomGranted,
  assertRoomAccess,
  requireRoomParam,
  decorateUser,
};