import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u01;
let u02;
let m1;
let date;
let reservation;

beforeAll(async () => {
  server = await startTestServer({ env: { TICK_INTERVAL_MS: '60000' } });
  s1 = createApiClient(server.base);
  await s1.login('s1');
  u01 = createApiClient(server.base);
  await u01.login('u01');
  u02 = createApiClient(server.base);
  await u02.login('u02');
  m1 = createApiClient(server.base);
  await m1.login('m1');
  const clock = (await s1.get('/system/clock')).json;
  const today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 08:00`);
  date = (await bookingContext(u01)).dates[1].date;
  const response = await u01.post('/reservations', {
    roomId: 'R1', seatId: 'R1-A01', date, start: '10:00', end: '11:00',
  }, { key: key() });
  expect(response.status).toBe(201);
  reservation = response.json.reservation;
});

afterAll(async () => {
  await server?.close();
});

describe('身份、权限与字段边界（AC-09、AC-24、UC-09）', () => {
  it('未登录访问受保护接口返回 401', async () => {
    const anonymous = createApiClient(server.base);
    expect((await anonymous.get('/reservations/mine')).status).toBe(401);
    expect((await anonymous.get('/admin/users')).status).toBe(401);
    expect((await anonymous.get('/me')).status).toBe(401);
  });

  it('其他学生无法读取、取消、签到或签退本人预约', async () => {
    const read = await u02.get(`/reservations/${reservation.id}`);
    expect(read.status).toBe(403);
    const cancel = await u02.post(`/reservations/${reservation.id}/cancel`, {}, { key: key() });
    expect(cancel.status).toBe(403);
    const checkin = await u02.post(`/reservations/${reservation.id}/checkin`, { code: 'x' }, { key: key() });
    expect(checkin.status).toBe(403);
    const checkout = await u02.post(`/reservations/${reservation.id}/checkout`, {}, { key: key() });
    expect(checkout.status).toBe(403);
    const owner = await u01.get(`/reservations/${reservation.id}`);
    expect(owner.json.reservation.status).toBe('pending');
  });

  it('资料修改夹带角色字段时整体拒绝，数据保持不变', async () => {
    const original = (await u01.get('/me')).json.user.displayName;
    const injected = await u01.patch('/me', { displayName: '被篡改的名字', role: 'sys_admin' });
    expect(injected.status).toBe(400);
    const me = await u01.get('/me');
    expect(me.json.user.displayName).toBe(original);
    expect(me.json.user.role).toBe('student');

    const allowed = await u01.patch('/me', { displayName: '临时昵称' });
    expect(allowed.status).toBe(200);
    expect((await u01.get('/me')).json.user.displayName).toBe('临时昵称');
  });

  it('账号禁用后旧会话的下一次请求即被拒绝', async () => {
    const disable = await s1.patch('/admin/users/U02', { enabled: false, reason: '安全测试：临时停用' });
    expect(disable.status).toBe(200);
    const next = await u02.get('/reservations/mine');
    expect(next.status).toBe(401);

    const enable = await s1.patch('/admin/users/U02', { enabled: true, reason: '安全测试：恢复启用' });
    expect(enable.status).toBe(200);
    const relogin = createApiClient(server.base);
    await relogin.login('u02');
    expect((await relogin.get('/reservations/mine')).status).toBe(200);
  });

  it('收回场地授权后旧会话立即失去该场地权限', async () => {
    const removeGrant = await s1.patch('/admin/users/M1', { grants: [], reason: '安全测试：收回 R1 授权' });
    expect(removeGrant.status).toBe(200);
    const denied = await m1.get('/admin/rooms/R1');
    expect(denied.status).toBe(403);
    const restore = await s1.patch('/admin/users/M1', { grants: ['R1'], reason: '安全测试：恢复 R1 授权' });
    expect(restore.status).toBe(200);
    expect((await m1.get('/admin/rooms/R1')).status).toBe(200);
  });

  it('不能禁用最后一名启用的系统管理员或移除其角色', async () => {
    const disable = await s1.patch('/admin/users/S1', { enabled: false });
    expect(disable.status).toBe(422);
    const changeRole = await s1.patch('/admin/users/S1', { role: 'venue_admin' });
    expect(changeRole.status).toBe(422);
    expect((await s1.get('/admin/users')).json.users.find((u) => u.id === 'S1').role).toBe('sys_admin');
  });

  it('发布新规则版本后，新预约使用新版本，旧预约保留原版本', async () => {
    const publish = await s1.post('/admin/rules', {
      advanceDays: 7,
      checkinGraceMin: 20,
      awayMinutes: 15,
      minMinutes: 30,
      dailyCount: 4,
      dailyMinutes: 240,
      note: '测试：签到宽限调整为 20 分钟',
    });
    expect(publish.status).toBe(201);
    const newVersion = publish.json.rule.id;
    const u03 = createApiClient(server.base);
    await u03.login('u03');
    const created = await u03.post('/reservations', {
      roomId: 'R1', seatId: 'R1-A02', date, start: '12:00', end: '13:00',
    }, { key: key() });
    expect(created.status).toBe(201);
    expect(created.json.reservation.ruleVersionId).toBe(newVersion);
    const old = await u01.get(`/reservations/${reservation.id}`);
    expect(old.json.reservation.ruleVersionId).toBe('RV-1');
  });
});