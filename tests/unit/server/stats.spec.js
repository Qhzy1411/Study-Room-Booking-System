import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock } from '../../helpers/client.js';
import { addDaysLocal, at } from '../../../server/time.js';

let server;
let db;
let s1;
let m9;
let today;

beforeAll(async () => {
  server = await startTestServer({ env: { TICK_INTERVAL_MS: '60000' } });
  s1 = createApiClient(server.base);
  await s1.login('s1');
  const clock = (await s1.get('/system/clock')).json;
  today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 15:00`);

  db = new DatabaseSync(server.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const created = at(today, '08:00');
  const insert = (sql, ...params) => db.prepare(sql).run(...params);

  insert(
    `INSERT INTO rooms (id, name, building, floor, description, archived, created_at)
     VALUES ('R9', '统计验收样例室', '测试楼', '一层', '四座，各开放 60 分钟；A03 位置停用 30 分钟。', 0, ?)`,
    created,
  );
  for (const code of ['S01', 'S02', 'S03', 'S04']) {
    insert(
      'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, 0, 0, ?)',
      `R9-${code}`, 'R9', code, created,
    );
  }
  insert(
    `INSERT INTO open_plans (room_id, date, start_min, end_min, version, note, created_by, created_at)
     VALUES ('R9', ?, 840, 900, 1, '统计验收计划', 'M1', ?)`,
    today, created,
  );
  insert(
    `INSERT INTO suspensions (id, room_id, seat_id, start_ts, end_ts, reason, status, impact_hash, created_by, created_at)
     VALUES ('SUS-STAT', 'R9', 'R9-S01', ?, ?, '统计样例停用', 'active', 'stat', 'M1', ?)`,
    at(today, '14:30'), at(today, '15:00'), created,
  );
  insert(
    `INSERT INTO reservations
      (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline,
       released_at, ended_at, end_reason, first_checkin_at, first_checkin_method, checkout_at)
     VALUES ('RSV-T1', 'U01', 'R9', 'R9-S01', ?, ?, 'completed', 'RV-1', ?, ?, ?, ?, 'self_checkout', ?, 'self_qr', ?)`,
    at(today, '14:00'), at(today, '15:00'), at(today, '14:00'), at(today, '14:15'),
    at(today, '15:00'), at(today, '15:00'), at(today, '14:00'), at(today, '15:00'),
  );
  insert(
    `INSERT INTO reservations
      (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline,
       released_at, ended_at, end_reason, first_checkin_at, first_checkin_method, checkout_at)
     VALUES ('RSV-T2', 'U02', 'R9', 'R9-S02', ?, ?, 'completed', 'RV-1', ?, ?, ?, ?, 'self_checkout', ?, 'self_qr', ?)`,
    at(today, '14:00'), at(today, '14:30'), at(today, '14:00'), at(today, '14:15'),
    at(today, '14:30'), at(today, '14:30'), at(today, '14:00'), at(today, '14:30'),
  );
  insert(
    `INSERT INTO usage_segments (reservation_id, seat_id, start_ts, end_ts, close_reason)
     VALUES ('RSV-T1', 'R9-S01', ?, ?, 'checkout')`,
    at(today, '14:00'), at(today, '15:00'),
  );
  insert(
    `INSERT INTO usage_segments (reservation_id, seat_id, start_ts, end_ts, close_reason)
     VALUES ('RSV-T2', 'R9-S02', ?, ?, 'checkout')`,
    at(today, '14:00'), at(today, '14:30'),
  );

  insert(
    `INSERT INTO rooms (id, name, building, floor, description, archived, created_at)
     VALUES ('R10', '无开放日期样例室', '测试楼', '二层', '用于验证分母为 0 的显示。', 0, ?)`,
    created,
  );
  insert(
    'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, 0, 0, ?)',
    'R10-S01', 'R10', 'S01', created,
  );

  const createAdmin = await s1.post('/admin/users', {
    username: 'stats_m9',
    displayName: '统计验收管理员',
    password: '123456',
    role: 'venue_admin',
    grants: ['R9', 'R10'],
  });
  expect(createAdmin.status).toBe(201);
  m9 = createApiClient(server.base);
  await m9.login('stats_m9');
});

afterAll(async () => {
  try { db?.close(); } catch { /* ignore */ }
  await server?.close();
});

describe('统计口径（AC-16、BR-16、4.3）', () => {
  it('可用座位分钟 210、登记使用分钟 90、使用率 42.9%，并与图表同一快照', async () => {
    const response = await m9.get(`/admin/stats?roomId=R9&date=${today}&start=14:00&end=15:00`);
    expect(response.status).toBe(200);
    const data = response.json;
    expect(data.metrics.hasPlan).toBe(true);
    expect(data.metrics.availableSeatMinutes).toBe(210);
    expect(data.metrics.usageMinutes).toBe(90);
    expect(data.metrics.usageRate).toBe(42.9);
    expect(data.snapshotText).toBe(`${today} 15:00`);
    expect(data.metrics.window.startText).toBe(`${today} 14:00`);
    expect(data.metrics.window.endText).toBe(`${today} 15:00`);
    const roomBar = data.rooms.find((r) => r.roomId === 'R9');
    expect(roomBar.availableSeatMinutes).toBe(210);
    expect(roomBar.usageMinutes).toBe(90);
    expect(roomBar.displayRate).toBe('42.9%');
    expect(data.trend).toHaveLength(7);
  });

  it('柱状图与统计卡片使用同一所选时段', async () => {
    const response = await m9.get(`/admin/stats?roomId=R9&date=${today}&start=14:00&end=14:30`);
    expect(response.status).toBe(200);
    const data = response.json;
    expect(data.metrics.availableSeatMinutes).toBe(120);
    expect(data.metrics.usageMinutes).toBe(60);
    expect(data.metrics.usageRate).toBe(50);

    const row = data.rooms.find((r) => r.roomId === 'R9');
    expect(row.availableSeatMinutes).toBe(data.metrics.availableSeatMinutes);
    expect(row.usageMinutes).toBe(data.metrics.usageMinutes);
    expect(row.usageRate).toBe(data.metrics.usageRate);
    expect(row.displayRate).toBe('50.0%');
  });

  it('无开放计划时分母为 0，使用率显示“—”', async () => {
    const response = await m9.get(`/admin/stats?roomId=R10&date=${today}`);
    expect(response.status).toBe(200);
    const data = response.json;
    expect(data.metrics.hasPlan).toBe(false);
    expect(data.metrics.availableSeatMinutes).toBe(0);
    expect(data.metrics.usageRate).toBeNull();
    const row = data.rooms.find((r) => r.roomId === 'R10');
    expect(row.displayRate).toBe('—');
  });

  it('拥有统计权限的系统管理员可查询，未授权的新系统管理员被拒绝', async () => {
    const allowed = await s1.get(`/admin/stats?roomId=R9&date=${today}`);
    expect(allowed.status).toBe(200);

    const created = await s1.post('/admin/users', {
      username: 'sys_audit_only',
      displayName: '未授权技术管理员',
      password: '123456',
      role: 'sys_admin',
    });
    expect(created.status).toBe(201);
    const plain = createApiClient(server.base);
    await plain.login('sys_audit_only');
    const denied = await plain.get(`/admin/stats?roomId=R9&date=${today}`);
    expect(denied.status).toBe(403);
  });

  it('未授权场地管理员被拒绝', async () => {
    const m1 = createApiClient(server.base);
    await m1.login('m1');
    const response = await m1.get(`/admin/stats?roomId=R9&date=${today}`);
    expect(response.status).toBe(403);
  });

  it('次日归档、恢复或新增座位，不改变历史日期的可用座位分钟与使用率', async () => {
    const m1 = createApiClient(server.base);
    await m1.login('m1');
    const historicalDate = addDaysLocal(today, -1);
    const statsUrl = `/admin/stats?roomId=R1&date=${historicalDate}`;

    const before = (await m1.get(statsUrl)).json;
    expect(before.metrics.hasPlan).toBe(true);
    expect(before.metrics.seatsCount).toBe(16);

    const archived = await m1.patch('/admin/seats/R1-A16', { archived: true, reason: '回归用例：次日归档座位' });
    expect(archived.status).toBe(200);
    const afterArchive = (await m1.get(statsUrl)).json;
    expect(afterArchive.metrics.availableSeatMinutes).toBe(before.metrics.availableSeatMinutes);
    expect(afterArchive.metrics.usageMinutes).toBe(before.metrics.usageMinutes);
    expect(afterArchive.metrics.usageRate).toBe(before.metrics.usageRate);
    expect(afterArchive.metrics.seatsCount).toBe(before.metrics.seatsCount);

    const restored = await m1.patch('/admin/seats/R1-A16', { archived: false, reason: '回归用例：恢复座位' });
    expect(restored.status).toBe(200);
    const added = await m1.post('/admin/seats', { roomId: 'R1', code: 'A17' });
    expect(added.status).toBe(200);

    const afterAdd = (await m1.get(statsUrl)).json;
    expect(afterAdd.metrics.availableSeatMinutes).toBe(before.metrics.availableSeatMinutes);
    expect(afterAdd.metrics.usageMinutes).toBe(before.metrics.usageMinutes);
    expect(afterAdd.metrics.usageRate).toBe(before.metrics.usageRate);
    expect(afterAdd.metrics.seatsCount).toBe(before.metrics.seatsCount);
  });

  it('开馆前创建的次日预约计入创建当天的预约创建量', async () => {
    const m1 = createApiClient(server.base);
    await m1.login('m1');
    const u01 = createApiClient(server.base);
    await u01.login('u01');
    const tomorrow = addDaysLocal(today, 1);

    await setClock(s1, `${today} 07:30`);
    const booked = await u01.post(
      '/reservations',
      { roomId: 'R1', seatId: 'R1-A14', date: tomorrow, start: '09:00', end: '10:00' },
      { key: key() },
    );
    expect(booked.status).toBe(201);
    await setClock(s1, `${today} 15:00`);

    const response = await m1.get(`/admin/stats?roomId=R1&date=${today}&start=07:00&end=08:00`);
    expect(response.status).toBe(200);
    const data = response.json;
    expect(data.metrics.createdCount).toBe(1);
    expect(data.metrics.availableSeatMinutes).toBe(0);
    expect(data.metrics.usageMinutes).toBe(0);
    expect(data.metrics.usageRate).toBeNull();
    expect(data.metrics.window.startText).toBe(`${today} 07:00`);
    expect(data.metrics.window.endText).toBe(`${today} 08:00`);
  });
});