import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { bookingContext, createApiClient, key, setClock } from '../../helpers/client.js';

let server;
let student;
let other;
let manager;
let systemAdmin;
let date;

beforeAll(async () => {
  server = await startTestServer();
  [student, other, manager, systemAdmin] = ['u01', 'u02', 'm1', 's1'].map(() => createApiClient(server.base));
  await Promise.all([student.login('u01'), other.login('u02'), manager.login('m1'), systemAdmin.login('s1')]);
  date = (await bookingContext(student)).dates[1].date;
});

afterAll(async () => {
  await server?.close();
});

async function book(client, seat, start, end, needPower = false) {
  const response = await client.post('/reservations', {
    roomId: 'R1', seatId: `R1-${seat}`, date, start, end, needPower,
  }, { key: key() });
  expect(response.status).toBe(201);
  return response.json.reservation;
}

it('换座后释放旧座；停用旧座只取消旧座上的新预约', async () => {
  await setClock(systemAdmin, `${date} 08:00`);
  const original = await book(student, 'A01', '10:00', '11:00');
  const report = await student.post(`/reservations/${original.id}/site-issues`, {
    type: 'facility', description: '座椅损坏',
  }, { key: key() });
  expect(report.status).toBe(201);
  const swapped = await student.post(`/reservations/${original.id}/swap`, {
    targetSeatId: 'R1-A04', expectedVersion: original.version,
  }, { key: key() });
  expect(swapped.status).toBe(200);
  const replacement = await book(other, 'A01', '10:00', '11:00');

  const period = { seatId: 'R1-A01', startAt: `${date} 10:00`, endAt: `${date} 11:00`, reason: '检修' };
  const preview = await manager.post('/admin/suspensions/preview', period);
  expect(preview.status).toBe(200);
  expect(preview.json.affected.map((row) => row.id)).toEqual([replacement.id]);
  const suspension = await manager.post('/admin/suspensions', {
    ...period, impactHash: preview.json.impactHash,
  }, { key: key() });
  expect(suspension.status).toBe(201);
  expect(suspension.json.affected).toEqual([replacement.id]);
  const current = await student.get(`/reservations/${original.id}`);
  expect(current.json.reservation).toMatchObject({ id: original.id, seatCode: 'A04', status: 'pending' });
});

it('换座继承预约的插座要求，直接提交也不能选故障座位', async () => {
  const original = await book(student, 'A05', '11:00', '12:00', true);
  expect(original.needPower).toBe(true);
  const report = await student.post(`/reservations/${original.id}/site-issues`, {
    type: 'facility', description: '座椅损坏',
  }, { key: key() });
  expect(report.status).toBe(201);
  const result = await student.get(`/reservations/${original.id}/swap-candidates?needPower=false`);
  expect(result.status).toBe(200);
  expect(result.json.candidates.map((seat) => seat.seatCode)).toContain('A07');
  expect(result.json.candidates.every((seat) => seat.power === 'normal')).toBe(true);
  const rejected = await student.post(`/reservations/${original.id}/swap`, {
    targetSeatId: 'R1-A06', needPower: false, expectedVersion: original.version,
  }, { key: key() });
  expect(rejected.status).toBe(422);
  const current = await student.get(`/reservations/${original.id}`);
  expect(current.json.reservation).toMatchObject({ seatCode: 'A05', needPower: true });
});
