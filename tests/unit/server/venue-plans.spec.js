import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, setClock } from '../../helpers/client.js';
import { addDaysLocal } from '../../../server/time.js';

let server;
let admin;

beforeAll(async () => {
  server = await startTestServer();
  admin = createApiClient(server.base);
  await admin.login('m1');
  const sys = createApiClient(server.base);
  await sys.login('s1');
  await setClock(sys, '2028-03-01 09:00');
  for (const [first, last] of [['2028-01-01','2028-01-31'], ['2028-02-01','2028-02-29'], ['2028-03-01','2028-03-31']]) {
    const response = await admin.post('/admin/rooms/R1/plans', {
      dateFrom: first, dateTo: last, start: '08:00', end: '22:00',
    });
    expect(response.status).toBe(200);
  }
});
afterAll(async () => { await server?.close(); });

it('历史计划超过 60 条时默认列出业务时钟所在月份', async () => {
  const { json } = await admin.get('/admin/rooms/R1');
  expect(json.plans.map(p => p.date)).toEqual(Array.from({length:31}, (_, i) => addDaysLocal('2028-03-01',i)));
});

it('按月份回查闰年二月，未来无计划月份返回空列表', async () => {
  const feb = await admin.get('/admin/rooms/R1?planMonth=2028-02');
  expect(feb.json.plans).toHaveLength(29);
  expect(feb.json.plans.at(-1).date).toBe('2028-02-29');
  expect((await admin.get('/admin/rooms/R1?planMonth=2028-04')).json.plans).toEqual([]);
  expect((await admin.get('/admin/rooms/R1?planMonth=2028-13')).status).toBe(400);
});
