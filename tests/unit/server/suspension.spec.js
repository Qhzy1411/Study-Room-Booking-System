import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u01;
let u02;
let u03;
let m1;
let m2;
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
  return (await m1.get(`/admin/seats/${seatId}/qr`)).json.text;
}

async function checkin(client, reservation, seatId) {
  const code = await seatCode(seatId);
  const response = await client.post(`/reservations/${reservation.id}/checkin`, { code }, { key: key() });
  expect(response.status).toBe(200);
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
  m2 = createApiClient(server.base);
  await m2.login('m2');
  const clock = (await s1.get('/system/clock')).json;
  const today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 08:00`);
  date = (await bookingContext(u01)).dates[1].date;

  reservations.u01 = await book(u01, 'R1-A01', '10:00', '12:00');
  reservations.u02 = await book(u02, 'R1-A02', '10:00', '12:00');
  reservations.u03 = await book(u03, 'R1-A03', '10:00', '12:00');
});

afterAll(async () => {
  await server?.close();
});

describe('停用与恢复（AC-13—15、BR-11）', () => {
  it('立即停用使用中座位须确认现场清场，提交后免罚关闭', async () => {
    await setClock(s1, `${date} 10:00`);
    await checkin(u03, reservations.u03, 'R1-A03');

    const preview = await m1.post('/admin/suspensions/preview', {
      seatId: 'R1-A03', immediate: true, endAt: `${date} 12:00`, reason: '插座检修',
    });
    expect(preview.status).toBe(200);
    expect(preview.json.needClearance).toBe(true);
    expect(preview.json.affected.map((r) => r.id)).toContain(reservations.u03.id);

    const withoutClearance = await m1.post('/admin/suspensions', {
      seatId: 'R1-A03', immediate: true, endAt: `${date} 12:00`, reason: '插座检修',
      impactHash: preview.json.impactHash, cleared: false,
    }, { key: key() });
    expect(withoutClearance.status).toBe(422);

    const commit = await m1.post('/admin/suspensions', {
      seatId: 'R1-A03', immediate: true, endAt: `${date} 12:00`, reason: '插座检修',
      impactHash: preview.json.impactHash, cleared: true,
    }, { key: key() });
    expect(commit.status).toBe(201);
    expect(commit.json.affected).toContain(reservations.u03.id);

    const detail = await u03.get(`/reservations/${reservations.u03.id}`);
    expect(detail.json.reservation.status).toBe('aborted');
    expect(detail.json.reservation.waiver).toBe(true);
    expect(detail.json.reservation.endReason).toBe('venue_suspension');

    const notifications = (await u03.get('/notifications')).json.notifications;
    expect(notifications.some((n) => n.title.includes('场地停用'))).toBe(true);
  });

  it('未来停用与使用中预约相交时拒绝', async () => {
    await setClock(s1, `${date} 10:05`);
    await checkin(u02, reservations.u02, 'R1-A02');
    const preview = await m1.post('/admin/suspensions/preview', {
      seatId: 'R1-A02', immediate: false, startAt: `${date} 11:00`, endAt: `${date} 12:00`, reason: '检修',
    });
    expect(preview.status).toBe(409);
    expect(preview.json.error.message).toContain('正在使用');
  });

  it('待签到预约按场地原因免罚取消，恢复后座位可再次预约', async () => {
    const preview = await m1.post('/admin/suspensions/preview', {
      seatId: 'R1-A01', immediate: true, endAt: `${date} 11:00`, reason: '线路检修',
    });
    expect(preview.status).toBe(200);
    expect(preview.json.needClearance).toBe(false);
    expect(preview.json.affected.map((r) => r.id)).toContain(reservations.u01.id);

    const commit = await m1.post('/admin/suspensions', {
      seatId: 'R1-A01', immediate: true, endAt: `${date} 11:00`, reason: '线路检修',
      impactHash: preview.json.impactHash, cleared: false,
    }, { key: key() });
    expect(commit.status).toBe(201);
    const detail = await u01.get(`/reservations/${reservations.u01.id}`);
    expect(detail.json.reservation.status).toBe('cancelled');
    expect(detail.json.reservation.waiver).toBe(true);
    expect(detail.json.reservation.cancelReason).toBe('场地停用');

    const restore = await m1.post(`/admin/suspensions/${commit.json.suspension.id}/restore`, { reason: '检修完成' });
    expect(restore.status).toBe(200);

    const availability = await u01.get(
      `/availability?roomId=R1&date=${date}&start=10:00&end=11:00&needPower=false&entrance=W&preference=near`,
    );
    const seat = availability.json.seats.find((s) => s.code === 'A01');
    expect(seat.state).toBe('available');
    const original = await u01.get(`/reservations/${reservations.u01.id}`);
    expect(original.json.reservation.status).toBe('cancelled');
  });

  it('跨场地管理员操作被拒绝', async () => {
    const response = await m2.post('/admin/suspensions/preview', {
      seatId: 'R1-A04', immediate: true, endAt: `${date} 12:00`, reason: '越权尝试',
    });
    expect(response.status).toBe(403);
  });

  it('影响集合或时段变更后提交返回 409，必须重新预览', async () => {
    const preview = await m1.post('/admin/suspensions/preview', {
      seatId: 'R1-A05', immediate: false, startAt: `${date} 13:00`, endAt: `${date} 14:00`, reason: '检修',
    });
    expect(preview.status).toBe(200);
    const commit = await m1.post('/admin/suspensions', {
      seatId: 'R1-A05', immediate: false, startAt: `${date} 13:00`, endAt: `${date} 15:00`, reason: '检修',
      impactHash: preview.json.impactHash,
    }, { key: key() });
    expect(commit.status).toBe(409);
    expect(commit.json.error.message).toContain('重新预览');
  });

  it('停用期间座位不可预约', async () => {
    const preview = await m1.post('/admin/suspensions/preview', {
      seatId: 'R1-A05', immediate: false, startAt: `${date} 13:00`, endAt: `${date} 14:00`, reason: '检修',
    });
    const commit = await m1.post('/admin/suspensions', {
      seatId: 'R1-A05', immediate: false, startAt: `${date} 13:00`, endAt: `${date} 14:00`, reason: '检修',
      impactHash: preview.json.impactHash,
    }, { key: key() });
    expect(commit.status).toBe(201);
    const availability = await u01.get(
      `/availability?roomId=R1&date=${date}&start=13:00&end=14:00&needPower=false&entrance=W&preference=near`,
    );
    expect(availability.json.seats.find((s) => s.code === 'A05').state).toBe('suspended');
  });
});