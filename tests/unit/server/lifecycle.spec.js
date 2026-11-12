import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u01;
let u02;
let u03;
let m1;
let date;
const reservations = {};

async function book(client, seatId, start, end) {
  const response = await client.post('/reservations', {
    roomId: 'R1', seatId, date, start, end,
  }, { key: key() });
  expect(response.status).toBe(201);
  return response.json.reservation;
}

async function seatCode(seatId) {
  const response = await m1.get(`/admin/seats/${seatId}/qr`);
  expect(response.status).toBe(200);
  return response.json.text;
}

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
  m1 = createApiClient(server.base);
  await m1.login('m1');
  const clock = (await s1.get('/system/clock')).json;
  const today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 08:00`);
  const context = await bookingContext(u01);
  date = context.dates[1].date;

  reservations.r01 = await book(u01, 'R1-A01', '10:00', '12:00');
  reservations.u02 = await book(u02, 'R1-A02', '11:00', '12:00');
  reservations.noShow = await book(u03, 'R1-A03', '13:00', '14:00');
  reservations.deadlineEqual = await book(u03, 'R1-A04', '14:00', '15:00');
  reservations.cancelBefore = await book(u02, 'R1-A05', '15:00', '16:00');
  reservations.cancelAtStart = await book(u02, 'R1-A06', '16:00', '17:00');
});

afterAll(async () => {
  await server?.close();
});

describe('签到、暂离、签退与到期（AC-05—08、AC-10—12、AC-19）', () => {
  it('过早签到拒绝，状态保持待签到', async () => {
    await setClock(s1, `${date} 09:59`);
    const code = await seatCode('R1-A01');
    const response = await u01.post(`/reservations/${reservations.r01.id}/checkin`, { code }, { key: key() });
    expect(response.status).toBe(422);
    expect(response.json.error.message).toContain('尚未开始');
    const detail = await u01.get(`/reservations/${reservations.r01.id}`);
    expect(detail.json.reservation.status).toBe('pending');
  });

  it('扫描其他座位的有效码拒绝，并提示正确目标', async () => {
    await setClock(s1, `${date} 10:00`);
    const otherCode = await seatCode('R1-A02');
    const response = await u01.post(`/reservations/${reservations.r01.id}/checkin`, { code: otherCode }, { key: key() });
    expect(response.status).toBe(422);
    expect(response.json.error.message).toContain('A02');
    expect(response.json.error.message).toContain('A01');
  });

  it('本人座位码签到成功；重复请求返回原结果', async () => {
    const code = await seatCode('R1-A01');
    const k = key();
    const first = await u01.post(`/reservations/${reservations.r01.id}/checkin`, { code }, { key: k });
    expect(first.status).toBe(200);
    expect(first.json.reservation.status).toBe('using');
    expect(first.json.checkin.seatCode).toBe('A01');
    const replay = await u01.post(`/reservations/${reservations.r01.id}/checkin`, { code }, { key: k });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    const repeatNewKey = await u01.post(`/reservations/${reservations.r01.id}/checkin`, { code }, { key: key() });
    expect(repeatNewKey.status).toBe(200);
    expect(repeatNewKey.json.alreadyCheckedIn).toBe(true);
  });

  it('暂离与返回；超过最晚返回时间后异常关闭', async () => {
    await setClock(s1, `${date} 10:20`);
    const away = await u01.post(`/reservations/${reservations.r01.id}/away`, {}, { key: key() });
    expect(away.status).toBe(200);
    expect(away.json.away.deadlineText).toBe(`${date} 10:35`);
    expect(away.json.reservation.status).toBe('away');

    await setClock(s1, `${date} 10:30`);
    const back = await u01.post(`/reservations/${reservations.r01.id}/return`, {}, { key: key() });
    expect(back.status).toBe(200);
    expect(back.json.reservation.status).toBe('using');

    await setClock(s1, `${date} 10:40`);
    const awayAgain = await u01.post(`/reservations/${reservations.r01.id}/away`, {}, { key: key() });
    expect(awayAgain.status).toBe(200);
    expect(awayAgain.json.away.deadlineText).toBe(`${date} 10:55`);

    await setClock(s1, `${date} 10:56`);
    const lateReturn = await u01.post(`/reservations/${reservations.r01.id}/return`, {}, { key: key() });
    expect(lateReturn.status).toBe(409);
    const detail = await u01.get(`/reservations/${reservations.r01.id}`);
    expect(detail.json.reservation.status).toBe('aborted');
    expect(detail.json.reservation.endReason).toBe('away_timeout');
  });

  it('签退释放剩余时段，其他学生可预约刚释放的时间', async () => {
    await setClock(s1, `${date} 11:05`);
    const code = await seatCode('R1-A02');
    const checkin = await u02.post(`/reservations/${reservations.u02.id}/checkin`, { code }, { key: key() });
    expect(checkin.status).toBe(200);
    await setClock(s1, `${date} 11:30`);
    const checkout = await u02.post(`/reservations/${reservations.u02.id}/checkout`, {}, { key: key() });
    expect(checkout.status).toBe(200);
    expect(checkout.json.reservation.status).toBe('completed');
    expect(checkout.json.reservation.endReason).toBe('self_checkout');

    const rebook = await u03.post('/reservations', {
      roomId: 'R1', seatId: 'R1-A02', date, start: '11:35', end: '12:05',
    }, { key: key() });
    expect(rebook.status).toBe(201);
  });

  it('签到截止未签到转为已爽约，并只生成一条待复核记录', async () => {
    await setClock(s1, `${date} 13:20`);
    const code = await seatCode('R1-A03');
    const response = await u03.post(`/reservations/${reservations.noShow.id}/checkin`, { code }, { key: key() });
    expect(response.status).toBe(409);
    const detail = await u03.get(`/reservations/${reservations.noShow.id}`);
    expect(detail.json.reservation.status).toBe('no_show');

    const violations = (await u03.get('/me/violations')).json.violations
      .filter((v) => v.reservationId === reservations.noShow.id);
    expect(violations).toHaveLength(1);
    expect(violations[0].status).toBe('pending');
  });

  it('签到故障登记自动撤销截止落在故障区间的爽约记录', async () => {
    const fault = await m1.post('/admin/faults', {
      roomId: 'R1',
      function: 'checkin',
      startAt: `${date} 13:10`,
      endAt: `${date} 13:20`,
      description: '签到服务短时中断，经现场核实。',
    });
    expect(fault.status).toBe(200);
    expect(fault.json.revokedViolations.length).toBeGreaterThanOrEqual(1);
    const violations = (await u03.get('/me/violations')).json.violations
      .filter((v) => v.reservationId === reservations.noShow.id);
    expect(violations[0].status).toBe('revoked');
  });

  it('恰好在签到截止时刻拒绝签到并转为爽约', async () => {
    await setClock(s1, `${date} 14:15:00`);
    const code = await seatCode('R1-A04');
    const response = await u03.post(`/reservations/${reservations.deadlineEqual.id}/checkin`, { code }, { key: key() });
    expect(response.status).toBe(409);
    const detail = await u03.get(`/reservations/${reservations.deadlineEqual.id}`);
    expect(detail.json.reservation.status).toBe('no_show');
  });

  it('开始前可取消；到达开始时刻后取消被拒绝', async () => {
    await setClock(s1, `${date} 14:59:59`);
    const cancelBefore = await u02.post(`/reservations/${reservations.cancelBefore.id}/cancel`, {}, { key: key() });
    expect(cancelBefore.status).toBe(200);
    expect(cancelBefore.json.reservation.status).toBe('cancelled');

    await setClock(s1, `${date} 16:00:00`);
    const cancelAtStart = await u02.post(`/reservations/${reservations.cancelAtStart.id}/cancel`, {}, { key: key() });
    expect(cancelAtStart.status).toBe(422);
    expect(cancelAtStart.json.error.message).toContain('已经开始');
  });
});