import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, setClock } from '../../helpers/client.js';
import { addDaysLocal, at } from '../../../server/time.js';

let server;
let db;
let s1;
let m1;
let yesterday;

beforeAll(async () => {
  server = await startTestServer({ env: { TICK_INTERVAL_MS: '60000' } });
  s1 = createApiClient(server.base);
  await s1.login('s1');
  const clock = (await s1.get('/system/clock')).json;
  const today = clock.nowText.slice(0, 10);
  yesterday = addDaysLocal(today, -1);
  await setClock(s1, `${today} 15:00`);

  db = new DatabaseSync(server.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const createdAt = at(yesterday, '08:00');
  const insert = (sql, ...params) => db.prepare(sql).run(...params);
  insert(
    `INSERT INTO rooms (id, name, building, floor, description, archived, created_at)
     VALUES ('R11', '生命周期样例室', '测试楼', '三层', '验证归档期间的分母。', 0, ?)`,
    createdAt,
  );
  for (const code of ['S01', 'S02']) {
    insert(
      'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, 0, 0, ?)',
      `R11-${code}`, 'R11', code, createdAt,
    );
    insert(
      `INSERT INTO seat_status_history (seat_id, room_id, status, changed_at, actor_id, reason)
       VALUES (?, 'R11', 'active', ?, 'M1', '测试初始生效')`,
      `R11-${code}`, createdAt,
    );
  }
  for (const date of [yesterday, today]) {
    insert(
      `INSERT INTO open_plans (room_id, date, start_min, end_min, version, note, created_by, created_at)
       VALUES ('R11', ?, 480, 600, 1, '生命周期计划', 'M1', ?)`,
      date, createdAt,
    );
  }
  insert(
    `INSERT INTO reservations
      (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline,
       released_at, ended_at, end_reason, first_checkin_at, first_checkin_method, checkout_at)
     VALUES ('RSV-L1', 'U01', 'R11', 'R11-S01', ?, ?, 'completed', 'RV-1', ?, ?, ?, ?, 'self_checkout', ?, 'self_qr', ?)`,
    at(yesterday, '08:00'), at(yesterday, '09:00'), at(yesterday, '08:00'), at(yesterday, '08:15'),
    at(yesterday, '09:00'), at(yesterday, '09:00'), at(yesterday, '08:00'), at(yesterday, '09:00'),
  );
  insert(
    `INSERT INTO usage_segments (reservation_id, seat_id, start_ts, end_ts, close_reason)
     VALUES ('RSV-L1', 'R11-S01', ?, ?, 'checkout')`,
    at(yesterday, '08:00'), at(yesterday, '09:00'),
  );
  insert(
    'INSERT INTO room_grants (user_id, room_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    'M1', 'R11', 'S1', createdAt,
  );
  m1 = createApiClient(server.base);
  await m1.login('m1');
});

afterAll(async () => {
  try { db?.close(); } catch { /* ignore */ }
  await server?.close();
});

describe('座位生命周期', () => {
  it('归档期间的日期按实际生效分钟计', async () => {
    const before = (await m1.get(`/admin/stats?roomId=R11&date=${yesterday}`)).json;
    expect(before.metrics.availableSeatMinutes).toBe(240);
    expect(before.metrics.usageRate).toBe(25);

    const today = addDaysLocal(yesterday, 1);
    await setClock(s1, `${yesterday} 09:00`);
    expect((await m1.patch('/admin/seats/R11-S02', { archived: true, reason: '测试中途归档' })).status).toBe(200);
    await setClock(s1, `${today} 15:00`);

    const during = (await m1.get(`/admin/stats?roomId=R11&date=${yesterday}`)).json;
    expect(during.metrics.availableSeatMinutes).toBe(180);
    expect(during.metrics.usageMinutes).toBe(60);
    expect(during.metrics.usageRate).toBe(33.3);
    expect(during.metrics.seatsCount).toBe(2);

    const todayDuring = (await m1.get(`/admin/stats?roomId=R11&date=${today}`)).json;
    expect(todayDuring.metrics.availableSeatMinutes).toBe(120);
    expect(todayDuring.metrics.seatsCount).toBe(1);

    expect((await m1.patch('/admin/seats/R11-S02', { archived: false, reason: '测试恢复' })).status).toBe(200);
    expect((await m1.post('/admin/seats', { roomId: 'R11', code: 'S03' })).status).toBe(200);

    const restored = (await m1.get(`/admin/stats?roomId=R11&date=${yesterday}`)).json;
    expect(restored.metrics.availableSeatMinutes).toBe(180);
    expect(restored.metrics.usageRate).toBe(33.3);
    const todayAfter = (await m1.get(`/admin/stats?roomId=R11&date=${today}`)).json;
    expect(todayAfter.metrics.availableSeatMinutes).toBe(120);
  });
});
