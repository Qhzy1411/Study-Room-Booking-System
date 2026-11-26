import express from 'express';
import config from './config.js';
import { get } from './db.js';
import { now } from './clock.js';
import {
  AppError,
  badRequest,
  forbidden,
  tooMany,
  unauthorized,
} from './errors.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  decorateUser,
  requireAuth,
  requireRole,
} from './auth.js';
import { fmt } from './time.js';
import { audit } from './audit.js';
import { idempotent } from './services/idempotency.js';
import { listRooms, roomDetailForStudent, adminRoomDetail, publishPlans, createSeat, archiveSeat, updateFacility, seatQr, listRoomSeatQr } from './services/resources.js';
import { queryAvailability, bookingWindow, getRoomMap } from './services/availability.js';
import {
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
  processDue,
} from './services/reservations.js';
import {
  previewSuspension,
  commitSuspension,
  restoreSuspension,
  listSuspensions,
} from './services/suspensions.js';
import {
  listViolations,
  registerManualViolation,
  decideViolation,
  revokeEffectiveViolation,
  listLimits,
  createLimit,
  revokeLimit,
  listFaults,
  createFault,
} from './services/violations.js';
import {
  submitComplaint,
  listMine as listMyComplaints,
  getComplaintForUser,
  listForAdmin,
  getForAdmin,
  acceptComplaint,
  replyComplaint,
  supplementComplaint,
  closeComplaint,
  siteIssuesForReservation,
} from './services/complaints.js';
import { saveEvaluation, adminListEvaluations, hideEvaluation, roomRatingSummary } from './services/evaluations.js';
import {
  listMine as listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  deliverPending,
  injectDeliveryFailure,
  retryDelivery,
  adminListNotifications,
} from './services/notifications.js';
import { myViolations, myLimits, myOverview, updateProfile } from './services/records.js';
import { statsForRoom } from './services/stats.js';
import { seatCodeValue } from './qr.js';
import {
  searchStudents,
  listUsers,
  createUser,
  updateUser,
  listRuleVersions,
  publishRuleVersion,
  listAudit,
  setDemoClock,
  clockInfo,
} from './services/admin.js';

const router = express.Router();

const route = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.then === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

const roleAdmin = requireRole('venue_admin', 'sys_admin');

function idempotencyKey(req) {
  return req.get('Idempotency-Key') || req.body?.idempotencyKey || req.query?.idempotencyKey || null;
}

function respondIdempotent(req, res, op, payload, fn, statusCode = 200) {
  const result = idempotent({ user: req.user, key: idempotencyKey(req), op, payload }, () => ({
    statusCode,
    body: fn(),
  }));
  res.status(result.statusCode).json({ ...result.body, replayed: result.replayed });
}

function respondMaybeIdempotent(req, res, op, payload, fn, statusCode = 200) {
  const key = idempotencyKey(req);
  if (!key) {
    res.status(statusCode).json(fn());
    return;
  }
  respondIdempotent(req, res, op, payload, fn, statusCode);
}

function currentUserDto(req, userRow = null) {
  const id = userRow?.id || req.user?.id;
  const u = id ? get('SELECT * FROM users WHERE id = ?', id) : null;
  return decorateUser(u);
}

/* ------------------------------ 系统与认证 ------------------------------ */

router.get('/health', (req, res) => {
  res.json({ ok: true, time: fmt(now()), demoMode: clockInfo().demoMode });
});

router.get('/system/clock', (req, res) => {
  res.json({ ...clockInfo(), serverStartedAt: fmt(now()) });
});

const loginAttempts = new Map();
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX = 10;

function loginThrottleKey(req, username) {
  return `${req.ip}:${String(username || '').toLowerCase()}`;
}

router.post('/auth/login', route((req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) throw badRequest('请输入账号和密码');
  const key = loginThrottleKey(req, username);
  const entry = loginAttempts.get(key);
  const ts = Date.now();
  if (entry && entry.resetAt > ts && entry.count >= LOGIN_MAX) {
    throw tooMany('登录失败次数过多，请 10 分钟后再试');
  }
  const user = get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const next = entry && entry.resetAt > ts ? entry : { count: 0, resetAt: ts + LOGIN_WINDOW };
    next.count += 1;
    loginAttempts.set(key, next);
    if (user) {
      audit({
        actor: { id: user.id, role: user.role },
        action: 'auth.login',
        objectType: 'session',
        objectId: user.id,
        result: 'failed',
        reason: '密码错误',
      });
    }
    throw unauthorized('账号或密码不正确');
  }
  if (!user.enabled) throw forbidden('该账号已被停用，请联系系统管理员');
  loginAttempts.delete(key);
  const token = createSession(user.id);
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: config.sessionTtlMs,
    path: '/',
  });
  audit({
    actor: { id: user.id, role: user.role },
    action: 'auth.login',
    objectType: 'session',
    objectId: user.id,
    result: 'success',
    reason: '登录成功',
  });
  res.json({ user: currentUserDto(req, user), clock: clockInfo() });
}));

router.post('/auth/logout', route((req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  res.clearCookie(config.cookieName, { path: '/' });
  res.json({ ok: true });
}));

router.get('/auth/session', (req, res) => {
  res.json({ user: req.user ? currentUserDto(req) : null, clock: clockInfo() });
});

router.get('/auth/me', requireAuth, route((req, res) => {
  res.json({ user: currentUserDto(req), clock: clockInfo() });
}));

/* ------------------------------ 资源与查询 ------------------------------ */

router.get('/rooms', requireAuth, route((req, res) => {
  res.json({ rooms: listRooms(req.user) });
}));

router.get('/rooms/:roomId', requireAuth, route((req, res) => {
  res.json(roomDetailForStudent(req.params.roomId));
}));

router.get('/rooms/:roomId/map', requireAuth, route((req, res) => {
  const map = getRoomMap(req.params.roomId);
  res.json({ map });
}));

router.get('/rooms/:roomId/evaluations', requireAuth, route((req, res) => {
  // 默认只公开房间聚合评分与数量，不返回个人评价正文或使用者身份
  res.json({ summary: roomRatingSummary(req.params.roomId) });
}));

router.get('/booking/context', requireAuth, route((req, res) => {
  const window = bookingWindow();
  res.json({
    rooms: listRooms(req.user),
    dates: window.dates,
    rule: window.rule,
    clock: clockInfo(),
    today: window.today,
  });
}));

router.get('/availability', requireAuth, route((req, res) => {
  const data = queryAvailability(req.user, {
    roomId: req.query.roomId,
    date: req.query.date,
    start: req.query.start,
    end: req.query.end,
    needPower: req.query.needPower === 'true' || req.query.needPower === '1',
    entrance: req.query.entrance,
    preference: req.query.preference,
  });
  res.json(data);
}));

/* ------------------------------ 学生预约 ------------------------------ */

router.post('/reservations', requireAuth, requireRole('student'), route((req, res) => {
  const payload = {
    roomId: String(req.body.roomId || ''),
    seatId: String(req.body.seatId || ''),
    date: String(req.body.date || ''),
    start: String(req.body.start || ''),
    end: String(req.body.end || ''),
    needPower: !!req.body.needPower,
  };
  respondIdempotent(req, res, 'reservation.create', payload, () => createReservation(req.user, payload), 201);
}));

router.get('/reservations/mine', requireAuth, route((req, res) => {
  processDue();
  res.json({
    reservations: listMine(req.user, {
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
    }),
  });
}));

router.get('/reservations/active', requireAuth, route((req, res) => {
  res.json({ reservations: myActiveReservations(req.user) });
}));

router.get('/reservations/:id/desk-code', requireAuth, route((req, res) => {
  const reservation = get('SELECT * FROM reservations WHERE id = ?', req.params.id);
  if (!reservation) throw new AppError(404, 'not_found', '预约不存在');
  if (reservation.user_id !== req.user.id) throw forbidden('只能查看本人预约');
  const seat = get('SELECT * FROM seats WHERE id = ?', reservation.seat_id);
  res.json({
    reservationId: reservation.id,
    seatCode: seat.code,
    code: seatCodeValue(reservation.room_id, seat.code),
    note: '该码与座位桌面张贴的二维码内容一致，用于相机不可用或无障碍签到时的手动输入；静态码不代表持续在座。',
  });
}));

router.get('/reservations/:id', requireAuth, route((req, res) => {
  const admin = req.user.role !== 'student';
  res.json({ reservation: getReservation(req.user, req.params.id, { admin }) });
}));

router.post('/reservations/:id/cancel', requireAuth, route((req, res) => {
  respondMaybeIdempotent(req, res, 'reservation.cancel', { id: req.params.id }, () => cancelReservation(req.user, req.params.id));
}));

router.post('/reservations/:id/checkin', requireAuth, route((req, res) => {
  const payload = { code: String(req.body?.code || '').trim() };
  respondMaybeIdempotent(req, res, 'reservation.checkin', { id: req.params.id, ...payload }, () =>
    performCheckin(req.user, req.params.id, payload),
  );
}));

router.post('/reservations/:id/checkout', requireAuth, route((req, res) => {
  respondMaybeIdempotent(req, res, 'reservation.checkout', { id: req.params.id }, () =>
    checkoutReservation(req.user, req.params.id),
  );
}));

router.post('/reservations/:id/away', requireAuth, route((req, res) => {
  respondMaybeIdempotent(req, res, 'reservation.away', { id: req.params.id }, () => startAway(req.user, req.params.id));
}));

router.post('/reservations/:id/return', requireAuth, route((req, res) => {
  respondMaybeIdempotent(req, res, 'reservation.return', { id: req.params.id }, () =>
    returnFromAway(req.user, req.params.id),
  );
}));

router.get('/reservations/:id/route', requireAuth, route((req, res) => {
  res.json(routeFor(req.user, req.params.id, req.query.entrance));
}));

router.get('/reservations/:id/swap-candidates', requireAuth, route((req, res) => {
  res.json(
    swapCandidates(req.user, req.params.id, {
      needPower: req.query.needPower === 'true' || req.query.needPower === '1',
    }),
  );
}));

router.post('/reservations/:id/swap', requireAuth, route((req, res) => {
  const payload = {
    targetSeatId: String(req.body?.targetSeatId || ''),
    needPower: !!req.body?.needPower,
    preference: req.body?.preference || 'near',
    expectedVersion: req.body?.expectedVersion ?? null,
  };
  respondIdempotent(req, res, 'reservation.swap', { id: req.params.id, ...payload }, () =>
    swapSeat(req.user, req.params.id, payload),
  );
}));

router.post('/reservations/:id/evaluation', requireAuth, requireRole('student'), route((req, res) => {
  res.json(saveEvaluation(req.user, req.params.id, { rating: req.body?.rating, content: req.body?.content }));
}));

router.get('/reservations/:id/site-issues', requireAuth, route((req, res) => {
  res.json({ issues: siteIssuesForReservation(req.user, req.params.id) });
}));

router.post('/reservations/:id/site-issues', requireAuth, requireRole('student'), route((req, res) => {
  const reservation = get('SELECT * FROM reservations WHERE id = ?', req.params.id);
  if (!reservation) throw new AppError(404, 'not_found', '预约不存在');
  if (reservation.user_id !== req.user.id) throw forbidden('只能为本人预约报告问题');
  const payload = {
    roomId: reservation.room_id,
    type: req.body?.type || 'facility',
    description: String(req.body?.description || ''),
    reservationId: reservation.id,
    isSite: true,
    ...(req.body?.isOccupancy === true ? { isOccupancy: true } : {}),
  };
  respondIdempotent(req, res, 'complaint.site_issue', { id: reservation.id, ...payload }, () =>
    submitComplaint(req.user, payload),
    201,
  );
}));

/* ------------------------------ 通知、资料与本人记录 ------------------------------ */

router.get('/notifications', requireAuth, route((req, res) => {
  res.json({
    notifications: listNotifications(req.user, { unreadOnly: req.query.unread === 'true' }),
    unread: unreadCount(req.user),
  });
}));

router.get('/notifications/unread-count', requireAuth, route((req, res) => {
  res.json({ unread: unreadCount(req.user) });
}));

router.post('/notifications/read-all', requireAuth, route((req, res) => {
  res.json(markAllRead(req.user));
}));

router.post('/notifications/:id/read', requireAuth, route((req, res) => {
  res.json(markRead(req.user, req.params.id));
}));

router.get('/me', requireAuth, route((req, res) => {
  res.json({ user: currentUserDto(req), clock: clockInfo() });
}));

router.patch('/me', requireAuth, route((req, res) => {
  res.json(updateProfile(req.user, req.body || {}));
}));

router.get('/me/overview', requireAuth, route((req, res) => {
  processDue();
  res.json(myOverview(req.user));
}));

router.get('/me/violations', requireAuth, route((req, res) => {
  res.json({ violations: myViolations(req.user) });
}));

router.get('/me/limits', requireAuth, route((req, res) => {
  res.json({ limits: myLimits(req.user) });
}));

/* ------------------------------ 投诉与申诉 ------------------------------ */

router.post('/complaints', requireAuth, requireRole('student'), route((req, res) => {
  const payload = {
    roomId: String(req.body?.roomId || ''),
    type: req.body?.type,
    description: String(req.body?.description || ''),
    reservationId: req.body?.reservationId || null,
    violationId: req.body?.violationId || null,
  };
  respondIdempotent(req, res, 'complaint.create', payload, () => submitComplaint(req.user, payload), 201);
}));

router.get('/complaints/mine', requireAuth, route((req, res) => {
  res.json({ complaints: listMyComplaints(req.user) });
}));

router.get('/complaints/:id', requireAuth, route((req, res) => {
  res.json({ complaint: getComplaintForUser(req.user, req.params.id) });
}));

router.post('/complaints/:id/supplement', requireAuth, requireRole('student'), route((req, res) => {
  res.json(supplementComplaint(req.user, req.params.id, { body: req.body?.body }));
}));

router.post('/complaints/:id/close', requireAuth, requireRole('student'), route((req, res) => {
  res.json(closeComplaint(req.user, req.params.id));
}));

/* ------------------------------ 管理：场地与资源 ------------------------------ */

router.get('/admin/rooms', requireAuth, roleAdmin, route((req, res) => {
  const rooms = listRooms(req.user);
  if (req.user.role === 'sys_admin') return res.json({ rooms });
  return res.json({ rooms: rooms.filter((r) => req.user.grants.includes(r.id)) });
}));

router.get('/admin/rooms/:roomId', requireAuth, roleAdmin, route((req, res) => {
  res.json(adminRoomDetail(req.user, req.params.roomId, req.query.planMonth));
}));

router.post('/admin/rooms/:roomId/plans', requireAuth, roleAdmin, route((req, res) => {
  const payload = {
    roomId: req.params.roomId,
    dateFrom: req.body?.dateFrom,
    dateTo: req.body?.dateTo,
    start: req.body?.start,
    end: req.body?.end,
    note: req.body?.note,
  };
  res.json(publishPlans(req.user, payload));
}));

router.post('/admin/seats', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    createSeat(req.user, {
      roomId: req.body?.roomId,
      code: req.body?.code,
      nearWindow: !!req.body?.nearWindow,
    }),
  );
}));

router.patch('/admin/seats/:seatId', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    archiveSeat(req.user, req.params.seatId, {
      archived: req.body?.archived !== false,
      reason: req.body?.reason,
    }),
  );
}));

router.patch('/admin/seats/:seatId/facility', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    updateFacility(req.user, req.params.seatId, {
      status: req.body?.status,
      note: req.body?.note,
      kind: req.body?.kind || 'power',
    }),
  );
}));

router.get('/admin/seats/:seatId/qr', requireAuth, roleAdmin, route(async (req, res) => {
  res.json(await seatQr(req.user, req.params.seatId));
}));

router.get('/admin/rooms/:roomId/qr-sheet', requireAuth, roleAdmin, route(async (req, res) => {
  const sheet = listRoomSeatQr(req.user, req.params.roomId);
  const codes = [];
  for (const seat of sheet.seats) {
    const qr = await seatQr(req.user, seat.id);
    codes.push({ seatId: seat.id, code: seat.code, svg: qr.svg, text: qr.text });
  }
  res.json({ room: sheet.room, seats: codes });
}));

router.get('/admin/suspensions', requireAuth, roleAdmin, route((req, res) => {
  res.json({
    suspensions: listSuspensions(req.query.roomId, { includeExpired: req.query.includeExpired === 'true' }),
  });
}));

router.post('/admin/suspensions/preview', requireAuth, roleAdmin, route((req, res) => {
  res.json(previewSuspension(req.user, req.body || {}));
}));

router.post('/admin/suspensions', requireAuth, roleAdmin, route((req, res) => {
  const payload = {
    seatId: req.body?.seatId,
    startAt: req.body?.startAt,
    endAt: req.body?.endAt,
    reason: req.body?.reason,
    immediate: !!req.body?.immediate,
    cleared: !!req.body?.cleared,
    impactHash: req.body?.impactHash,
  };
  respondIdempotent(req, res, 'suspension.create', payload, () => commitSuspension(req.user, payload), 201);
}));

router.post('/admin/suspensions/:id/restore', requireAuth, roleAdmin, route((req, res) => {
  res.json(restoreSuspension(req.user, req.params.id, req.body?.reason));
}));

router.get('/admin/reservations', requireAuth, roleAdmin, route((req, res) => {
  res.json({
    reservations: adminListReservations(req.user, {
      roomId: req.query.roomId,
      date: req.query.date,
      status: req.query.status,
    }),
  });
}));

router.post('/admin/reservations/:id/assist-checkin', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    adminAssistCheckin(req.user, req.params.id, {
      note: req.body?.note,
      seatId: req.body?.seatId,
    }),
  );
}));

/* ------------------------------ 管理：违约、限制与故障 ------------------------------ */

router.get('/admin/violations', requireAuth, roleAdmin, route((req, res) => {
  res.json({
    violations: listViolations(req.user, {
      roomId: req.query.roomId,
      status: req.query.status,
      userId: req.query.userId,
    }),
  });
}));

router.post('/admin/violations', requireAuth, roleAdmin, route((req, res) => {
  res.json(registerManualViolation(req.user, req.body || {}));
}));

router.post('/admin/violations/:id/decide', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    decideViolation(req.user, req.params.id, {
      decision: req.body?.decision,
      reason: req.body?.reason,
      evidence: req.body?.evidence,
    }),
  );
}));

router.post('/admin/violations/:id/revoke', requireAuth, roleAdmin, route((req, res) => {
  res.json(revokeEffectiveViolation(req.user, req.params.id, { reason: req.body?.reason }));
}));

router.get('/admin/limits', requireAuth, roleAdmin, route((req, res) => {
  res.json({ limits: listLimits(req.user, { roomId: req.query.roomId }) });
}));

router.post('/admin/limits', requireAuth, roleAdmin, route((req, res) => {
  res.json(createLimit(req.user, req.body || {}));
}));

router.post('/admin/limits/:id/revoke', requireAuth, roleAdmin, route((req, res) => {
  res.json(revokeLimit(req.user, req.params.id, { reason: req.body?.reason }));
}));

router.get('/admin/faults', requireAuth, roleAdmin, route((req, res) => {
  res.json({ faults: listFaults(req.user, { roomId: req.query.roomId }) });
}));

router.post('/admin/faults', requireAuth, roleAdmin, route((req, res) => {
  res.json(createFault(req.user, req.body || {}));
}));

/* ------------------------------ 管理：投诉、评价 ------------------------------ */

router.get('/admin/complaints', requireAuth, roleAdmin, route((req, res) => {
  res.json({
    complaints: listForAdmin(req.user, {
      roomId: req.query.roomId,
      status: req.query.status,
      isSite: req.query.isSite === 'true' ? true : req.query.isSite === 'false' ? false : null,
    }),
  });
}));

router.get('/admin/complaints/:id', requireAuth, roleAdmin, route((req, res) => {
  res.json({ complaint: getForAdmin(req.user, req.params.id) });
}));

router.post('/admin/complaints/:id/accept', requireAuth, roleAdmin, route((req, res) => {
  res.json(acceptComplaint(req.user, req.params.id));
}));

router.post('/admin/complaints/:id/reply', requireAuth, roleAdmin, route((req, res) => {
  res.json(replyComplaint(req.user, req.params.id, {
    body: req.body?.body, occupancyUnfounded: req.body?.occupancyUnfounded === true,
  }));
}));

router.get('/admin/evaluations', requireAuth, roleAdmin, route((req, res) => {
  res.json({ evaluations: adminListEvaluations(req.user, { roomId: req.query.roomId }) });
}));

router.post('/admin/evaluations/:id/hide', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    hideEvaluation(req.user, req.params.id, {
      reason: req.body?.reason,
      hidden: req.body?.hidden !== false,
    }),
  );
}));

/* ------------------------------ 管理：统计 ------------------------------ */

router.get('/admin/stats', requireAuth, roleAdmin, route((req, res) => {
  res.json(
    statsForRoom(req.user, {
      roomId: req.query.roomId,
      date: req.query.date,
      start: req.query.start || null,
      end: req.query.end || null,
    }),
  );
}));

/* ------------------------------ 管理：账号、规则、审计、演示 ------------------------------ */

router.get('/admin/students', requireAuth, roleAdmin, route((req, res) => {
  res.json({ students: searchStudents(req.user, req.query.q) });
}));

router.get('/admin/users', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json({ users: listUsers(req.user) });
}));

router.post('/admin/users', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.status(201).json(createUser(req.user, req.body || {}));
}));

router.patch('/admin/users/:id', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json(updateUser(req.user, req.params.id, req.body || {}));
}));

router.get('/admin/rules', requireAuth, roleAdmin, route((req, res) => {
  res.json({ rules: listRuleVersions(req.user) });
}));

router.post('/admin/rules', requireAuth, roleAdmin, route((req, res) => {
  res.status(201).json(publishRuleVersion(req.user, req.body || {}));
}));

router.get('/admin/audit', requireAuth, roleAdmin, route((req, res) => {
  res.json({
    audits: listAudit(req.user, {
      limit: req.query.limit,
      action: req.query.action,
      actorId: req.query.actorId,
    }),
  });
}));

router.get('/admin/demo/clock', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json(clockInfo());
}));

router.post('/admin/demo/clock', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json(setDemoClock(req.user, { at: req.body?.at }));
}));

router.get('/admin/notifications', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json({ notifications: adminListNotifications(req.user, { status: req.query.status }) });
}));

router.post('/admin/notifications/:id/inject-failure', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json(injectDeliveryFailure(req.params.id, req.body?.message));
}));

router.post('/admin/notifications/:id/retry', requireAuth, requireRole('sys_admin'), route((req, res) => {
  res.json(retryDelivery(req.params.id));
}));

router.post('/admin/tick', requireAuth, requireRole('sys_admin'), route((req, res) => {
  const handled = processDue();
  const delivery = deliverPending();
  res.json({ handled, delivery, clock: clockInfo() });
}));

export default router;
