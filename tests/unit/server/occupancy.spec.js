import { afterEach, beforeEach, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { bookingContext, createApiClient, key, setClock } from '../../helpers/client.js';

let server;
let student;
let other;
let manager;
let systemAdmin;
let date;

beforeEach(async () => {
  server = await startTestServer();
  [student, other, manager, systemAdmin] = ['u01', 'u02', 'm1', 's1'].map(() => createApiClient(server.base));
  await Promise.all([student.login('u01'), other.login('u02'), manager.login('m1'), systemAdmin.login('s1')]);
  date = (await bookingContext(student)).dates[1].date;
  await at('08:00');
});

afterEach(async () => {
  await server?.close();
});

const at = (time) => setClock(systemAdmin, `${date} ${time}`);

async function book(client, start = '10:00', end = '11:00') {
  const result = await client.post('/reservations', {
    roomId: 'R1', seatId: 'R1-A01', date, start, end,
  }, { key: key() });
  expect(result.status).toBe(201);
  return result.json.reservation;
}

async function reportAndAccept(reservation) {
  await at('10:02');
  const { status, json } = await student.post(`/reservations/${reservation.id}/site-issues`, {
    type: 'service', isOccupancy: true, description: '预约的座位被占用',
  }, { key: key() });
  expect(status).toBe(201);
  expect(json.complaint.isOccupancy).toBe(true);
  const id = json.complaint.id;
  await at('10:05');
  const accepted = await manager.post(`/admin/complaints/${id}/accept`);
  expect(accepted.status).toBe(200);
  expect(accepted.json.complaint.status).toBe('processing');
  return id;
}

async function current(id) {
  return (await student.get(`/reservations/${id}`)).json.reservation;
}

async function violations(id) {
  return (await student.get('/me/violations')).json.violations.filter((v) => v.reservationId === id);
}

async function reject(id) {
  const reply = await manager.post(`/admin/complaints/${id}/reply`, {
    body: '现场核实，座位未被占用。', occupancyUnfounded: true,
  });
  expect(reply.status).toBe(200);
}

it('占座受理后仍可在原截止之后换座并签到', async () => {
  const original = await book(student);
  await reportAndAccept(original);
  await at('10:16');
  await systemAdmin.post('/admin/tick');
  expect(await current(original.id)).toMatchObject({ status: 'pending', checkinDeadlineText: `${date} 10:35` });
  expect(await violations(original.id)).toEqual([]);
  const candidates = await student.get(`/reservations/${original.id}/swap-candidates`);
  expect(candidates.status).toBe(200);
  expect(candidates.json.candidates.map((seat) => seat.seatCode)).toContain('A04');
  const swapped = await student.post(`/reservations/${original.id}/swap`, {
    targetSeatId: 'R1-A04', expectedVersion: original.version,
  }, { key: key() });
  expect(swapped.status).toBe(200);
  const { json: { text: code } } = await manager.get('/admin/seats/R1-A04/qr');
  const checkedIn = await student.post(`/reservations/${original.id}/checkin`, { code }, { key: key() });
  expect(checkedIn.status).toBe(200);
  expect(checkedIn.json.reservation).toMatchObject({ status: 'using', seatCode: 'A04' });
});

it('核实不属实且已过原签到截止时，立即记一笔待复核爽约', async () => {
  const original = await book(student);
  const id = await reportAndAccept(original);
  await at('10:16');
  await reject(id);
  await systemAdmin.post('/admin/tick');
  expect(await current(original.id)).toMatchObject({ status: 'no_show', checkinProtectedUntil: null });
  expect(await violations(original.id)).toMatchObject([{ type: 'no_show', status: 'pending' }]);
});

it('保护到期先免罚释放，之后核实不属实不会影响他人的预约', async () => {
  const original = await book(student);
  const id = await reportAndAccept(original);
  await at('10:35');
  await systemAdmin.post('/admin/tick');
  const expired = await current(original.id);
  expect(expired).toMatchObject({ status: 'cancelled', waiver: true });
  expect(expired.releasedAt).toBe(expired.checkinProtectedUntil);
  expect(await violations(original.id)).toEqual([]);
  const replacement = await book(other, '10:45', '11:15');

  await at('10:40');
  await reject(id);
  expect(await current(original.id)).toMatchObject({ status: 'no_show', releasedAt: expired.releasedAt });
  expect(await violations(original.id)).toMatchObject([{ type: 'no_show', status: 'pending' }]);
  expect((await other.get(`/reservations/${replacement.id}`)).json.reservation.status).toBe('pending');
});

it('签到保护不会延长原预约结束时间', async () => {
  const original = await book(student, '10:00', '10:30');
  await reportAndAccept(original);
  expect(await current(original.id)).toMatchObject({ status: 'pending', checkinDeadlineText: `${date} 10:30` });
  await at('10:30');
  expect(await current(original.id)).toMatchObject({ status: 'cancelled', waiver: true });
  expect(await violations(original.id)).toEqual([]);
});
