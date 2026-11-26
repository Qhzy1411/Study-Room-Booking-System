import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u01;
let u02;
let m1;
let date;

async function quotaOf(client, start = '10:00', end = '11:00') {
  const response = await client.get(
    `/availability?roomId=R1&date=${date}&start=${start}&end=${end}`,
  );
  expect(response.status).toBe(200);
  return response.json.quota;
}

async function book(client, { seatId, start, end }) {
  return client.post('/reservations', { roomId: 'R1', seatId, date, start, end }, { key: key() });
}

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
});

afterAll(async () => {
  await server?.close();
});

describe('每日累计时长额度按实际占用计算（缺陷 10）', () => {
  it('提前取消四小时预约后返还时长，可再预约一小时', async () => {
    const first = await book(u01, { seatId: 'R1-A01', start: '10:00', end: '14:00' });
    expect(first.status).toBe(201);
    expect(first.json.quota.usedMinutes).toBe(240);
    expect(first.json.quota.limitMinutes).toBe(240);

    const cancel = await u01.post(`/reservations/${first.json.reservation.id}/cancel`, {}, { key: key() });
    expect(cancel.status).toBe(200);
    expect(cancel.json.reservation.status).toBe('cancelled');

    const afterCancel = await quotaOf(u01);
    expect(afterCancel.usedMinutes).toBe(0);
    expect(afterCancel.remainingMinutes).toBe(240);

    const rebook = await book(u01, { seatId: 'R1-A02', start: '10:00', end: '11:00' });
    expect(rebook.status).toBe(201);
    expect(rebook.json.quota.usedMinutes).toBe(60);
  });

  it('提前签退按实际使用分钟数扣减，而不是整段预约时长', async () => {
    const first = await book(u02, { seatId: 'R1-A03', start: '13:00', end: '17:00' });
    expect(first.status).toBe(201);
    expect(first.json.quota.usedMinutes).toBe(240);

    await setClock(s1, `${date} 13:00`);
    const qr = await m1.get('/admin/seats/R1-A03/qr');
    expect(qr.status).toBe(200);
    const checkin = await u02.post(`/reservations/${first.json.reservation.id}/checkin`, {
      code: qr.json.text,
    }, { key: key() });
    expect(checkin.status).toBe(200);

    await setClock(s1, `${date} 13:30`);
    const checkout = await u02.post(`/reservations/${first.json.reservation.id}/checkout`, {}, { key: key() });
    expect(checkout.status).toBe(200);
    expect(checkout.json.reservation.endReason).toBe('self_checkout');

    const afterCheckout = await quotaOf(u02);
    expect(afterCheckout.usedMinutes).toBe(30);
    expect(afterCheckout.remainingMinutes).toBe(210);

    const rebook = await book(u02, { seatId: 'R1-A04', start: '14:00', end: '15:00' });
    expect(rebook.status).toBe(201);
    expect(rebook.json.quota.usedMinutes).toBe(90);
  });

  it('每日累计时长上限可通过规则版本调整', async () => {
    const published = await s1.post('/admin/rules', {
      advanceDays: 7,
      checkinGraceMin: 15,
      awayMinutes: 15,
      minMinutes: 30,
      dailyCount: 4,
      dailyMinutes: 90,
      note: '回归测试：将每日累计时长上限调整为 90 分钟',
    });
    expect(published.status).toBe(201);
    expect(published.json.rule.dailyMinutes).toBe(90);

    // U01 当天已占用 60 分钟，再预约 60 分钟会超过调整后的 90 分钟上限
    const blocked = await book(u01, { seatId: 'R1-A06', start: '14:00', end: '15:00' });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.message).toContain('90 分钟');
  });
});
