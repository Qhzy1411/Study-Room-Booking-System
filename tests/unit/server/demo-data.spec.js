import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { bookingContext, createApiClient, key, setClock } from '../../helpers/client.js';
import { addDaysLocal } from '../../../server/time.js';

let server;
let sys;
let student;
let today;

beforeAll(async () => {
  server = await startTestServer();
  sys = createApiClient(server.base);
  student = createApiClient(server.base);
  await sys.login('s1');
  await student.login('u01');
  ({ today } = await bookingContext(student));
});

afterAll(async () => { await server?.close(); });

it.each([['R1', 'm1'], ['R2', 'm2']])('%s 初始化当天包含其他学生的预约', async (roomId, username) => {
  const manager = createApiClient(server.base);
  await manager.login(username);
  const response = await manager.get(`/admin/reservations?roomId=${roomId}&date=${today}`);
  expect(response.status).toBe(200);
  const { reservations } = response.json;
  expect(reservations).toHaveLength(3);
  expect(new Set(reservations.map(booking => booking.userId)).size).toBe(3);

  for (const booking of reservations) {
    expect(booking.userId).toMatch(/^U0[4-9]$/);
    const available = await student.get(`/availability?roomId=${roomId}&date=${today}&start=${booking.startTime}&end=${booking.endTime}`);
    const seat = available.json.seats.find(seat => seat.id === booking.seatId);
    expect(seat.state).toBe(booking.status === 'completed' ? 'available' : 'occupied');
  }
});

it('时钟跳到远处日期后补齐前六天和预约窗口，并保留已有计划与预约', async () => {
  const past = addDaysLocal(today, -120);
  const future = addDaysLocal(today, 120);
  const lastDate = addDaysLocal(future, 6);
  const firstDate = addDaysLocal(future, -6);
  const manager = createApiClient(server.base);
  await manager.login('m1');
  for (const date of [firstDate, lastDate]) {
    const published = await manager.post('/admin/rooms/R1/plans', {
      dateFrom: date, start: '11:00', end: '18:00', note: '临时排班',
    });
    expect(published.status).toBe(200);
  }

  const availability = (roomId, date) => student.get(`/availability?roomId=${roomId}&date=${date}&start=11:00&end=12:00`);
  const planFor = async (roomId, date) => (await availability(roomId, date)).json.openPlan;
  const existingPlans = await Promise.all([firstDate, lastDate].map(date => planFor('R1', date)));
  for (const plan of existingPlans) {
    expect(plan).toMatchObject({ start: '11:00', end: '18:00', note: '临时排班' });
  }

  expect((await availability('R2', past)).json.open).toBe(false);
  await setClock(sys, `${past} 08:00`);
  expect(await planFor('R2', addDaysLocal(past, -6))).toMatchObject({ start: '09:00', end: '21:00' });

  await setClock(sys, `${future} 08:00`);
  const context = await bookingContext(student);
  expect(context.today).toBe(future);
  expect(context.dates.at(-1).date).toBe(lastDate);
  expect(await planFor('R1', future)).toMatchObject({ start: '08:00', end: '22:00' });
  expect(await Promise.all([firstDate, lastDate].map(date => planFor('R1', date)))).toEqual(existingPlans);
  const precedingDates = Array.from({ length: 6 }, (_, i) => addDaysLocal(firstDate, i));
  const precedingPlans = await Promise.all(precedingDates.map(date => planFor('R2', date)));
  expect(precedingPlans.map(plan => plan?.date)).toEqual(precedingDates);
  expect(await planFor('R2', addDaysLocal(firstDate, -1))).toBeNull();

  const booked = await student.post('/reservations', {
    roomId: 'R2', seatId: 'R2-B01', date: lastDate, start: '11:00', end: '12:00',
  }, { key: key() });
  expect(booked.status).toBe(201);
  await setClock(sys, `${past} 08:00`);
  await setClock(sys, `${future} 08:00`);
  const { json } = await availability('R2', lastDate);
  expect(json.seats.find(seat => seat.id === 'R2-B01').state).toBe('occupied');
});

it('增大可提前预约天数后，新窗口的最后一天也有演示排班', async () => {
  const future = addDaysLocal(today, 240);
  await setClock(sys, `${future} 08:00`);
  const updated = await sys.post('/admin/rules', {
    advanceDays: 14, checkinGraceMin: 15, awayMinutes: 15,
    minMinutes: 30, dailyCount: 4, dailyMinutes: 240,
  });
  expect(updated.status).toBe(201);

  const { dates } = await bookingContext(student);
  const lastDate = dates.at(-1).date;
  expect(lastDate).toBe(addDaysLocal(future, 13));
  const available = await student.get(`/availability?roomId=R2&date=${lastDate}&start=11:00&end=12:00`);
  expect(available.json.recommendations.length).toBeGreaterThan(0);
});

it.each(['R1', 'R2'])('%s 的七天历史使用率均来自实际使用分段且逐日不同', async (roomId) => {
  await setClock(sys, `${today} 08:00`);
  const yesterday = addDaysLocal(today, -1);
  const response = await sys.get(`/admin/stats?roomId=${roomId}&date=${yesterday}`);
  expect(response.status).toBe(200);

  const { trend } = response.json;
  expect(trend).toHaveLength(7);
  for (const day of trend) {
    expect(day.availableSeatMinutes).toBeGreaterThan(0);
    expect(day.usageMinutes).toBeGreaterThan(0);
    expect(day.usageRate).toBeCloseTo(day.usageMinutes / day.availableSeatMinutes * 100, 1);
  }
  expect(new Set(trend.map(day => day.usageRate)).size).toBe(7);
});
