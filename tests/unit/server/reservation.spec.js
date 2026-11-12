import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u01;
let u02;
let u03;
let date;
let reservationId;

beforeAll(async () => {
  server = await startTestServer();
  s1 = createApiClient(server.base);
  await s1.login('s1');
  u01 = createApiClient(server.base);
  await u01.login('u01');
  u02 = createApiClient(server.base);
  await u02.login('u02');
  u03 = createApiClient(server.base);
  await u03.login('u03');
  const clock = (await s1.get('/system/clock')).json;
  const today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 08:00`);
  const context = await bookingContext(u01);
  date = context.dates[1].date;
});

afterAll(async () => {
  await server?.close();
});

function book(client, { seatId, start, end, needPower = false, idempotencyKey = key() }) {
  return client.post('/reservations', {
    roomId: 'R1', seatId, date, start, end, needPower,
  }, { key: idempotencyKey });
}

describe('预约查询与创建（AC-01、AC-02、AC-03、AC-04、AC-17）', () => {
  it('按必要条件筛选并给出可解释推荐，不泄露他人身份', async () => {
    const response = await u01.get(
      `/availability?roomId=R1&date=${date}&start=10:00&end=11:00&needPower=true&entrance=W&preference=near`,
    );
    expect(response.status).toBe(200);
    const data = response.json;
    expect(data.open).toBe(true);
    expect(data.seats).toHaveLength(16);
    expect(data.recommendations.length).toBeGreaterThan(0);
    expect(data.recommendations.length).toBeLessThanOrEqual(3);
    for (const seat of data.recommendations) {
      expect(seat.state).toBe('available');
      expect(seat.power).toBe('normal');
      expect(seat.recommendReason).toBeTruthy();
    }
    expect(data.seats.find((s) => s.code === 'A06').state).toBe('facility');
    expect(JSON.stringify(data)).not.toMatch(/"(userName|userId|displayName|username)"/);
  });

  it('正常创建预约，返回唯一编号、待签到状态与规则版本', async () => {
    const response = await book(u01, { seatId: 'R1-A01', start: '10:00', end: '11:00', needPower: true });
    expect(response.status).toBe(201);
    reservationId = response.json.reservation.id;
    expect(reservationId).toMatch(/^RSV-/);
    expect(response.json.reservation.status).toBe('pending');
    expect(response.json.reservation.checkinDeadlineText).toBe(`${date} 10:15`);
    expect(response.json.reservation.ruleVersionId).toBe('RV-1');
    expect(response.json.replayed).toBe(false);
  });

  it('同键同载荷返回原结果，同键换载荷拒绝', async () => {
    const k = key();
    const first = await book(u01, { seatId: 'R1-A02', start: '13:00', end: '14:00', idempotencyKey: k });
    expect(first.status).toBe(201);
    const replay = await book(u01, { seatId: 'R1-A02', start: '13:00', end: '14:00', idempotencyKey: k });
    expect(replay.status).toBe(201);
    expect(replay.json.replayed).toBe(true);
    expect(replay.json.reservation.id).toBe(first.json.reservation.id);
    const changed = await book(u01, { seatId: 'R1-A02', start: '13:30', end: '14:30', idempotencyKey: k });
    expect(changed.status).toBe(409);
    // 清理，避免影响后续额度
    await u01.post(`/reservations/${first.json.reservation.id}/cancel`, {}, { key: key() });
  });

  it('同座位重叠拒绝，相邻允许', async () => {
    const overlap = await book(u02, { seatId: 'R1-A01', start: '10:30', end: '11:30' });
    expect(overlap.status).toBe(409);
    const adjacent = await book(u02, { seatId: 'R1-A01', start: '11:00', end: '12:00' });
    expect(adjacent.status).toBe(201);
  });

  it('同一用户跨座重叠拒绝', async () => {
    const response = await book(u01, { seatId: 'R1-A02', start: '10:30', end: '11:30' });
    expect(response.status).toBe(409);
    expect(response.json.error.message).toContain('同一用户');
  });

  it('取消立即释放时段，另一方可在重叠段预约', async () => {
    const cancel = await u01.post(`/reservations/${reservationId}/cancel`, {}, { key: key() });
    expect(cancel.status).toBe(200);
    expect(cancel.json.reservation.status).toBe('cancelled');
    const rebook = await book(u02, { seatId: 'R1-A01', start: '10:00', end: '11:00' });
    expect(rebook.status).toBe(201);
  });

  it('每日次数与时长上限生效，本人取消不返还额度', async () => {
    const slots = [
      ['R1-A05', '08:00', '09:00'],
      ['R1-A07', '09:00', '10:00'],
      ['R1-A08', '10:00', '11:00'],
      ['R1-A09', '11:00', '12:00'],
    ];
    const created = [];
    for (const [seatId, start, end] of slots) {
      const response = await book(u03, { seatId, start, end });
      expect(response.status).toBe(201);
      created.push(response.json.reservation.id);
    }
    const fifth = await book(u03, { seatId: 'R1-A12', start: '12:00', end: '13:00' });
    expect(fifth.status).toBe(422);
    expect(fifth.json.error.message).toContain('每日最多创建');
    const cancel = await u03.post(`/reservations/${created[0]}/cancel`, {}, { key: key() });
    expect(cancel.status).toBe(200);
    const retry = await book(u03, { seatId: 'R1-A12', start: '12:00', end: '13:00' });
    expect(retry.status).toBe(422);
    expect(retry.json.error.message).toContain('每日最多创建');
  });
});