import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { executablePath } from '../helpers/browser.js';
import { startTestServer } from '../helpers/server.js';
import { createApiClient, key, setClock } from '../helpers/client.js';
import { addDaysLocal } from '../../server/time.js';

describe.skipIf(!executablePath)('场地管理员操作', () => {
  let server, browser, page, sys, manager, student, today;

  async function client(name) {
    const api = createApiClient(server.base);
    await api.login(name);
    return api;
  }

  async function login(name) {
    await page.goto(server.base);
    await page.locator('#login-username').fill(name);
    await page.locator('#login-password').fill('123456');
    await page.locator('#login-password').press('Enter');
    await page.getByRole('tab', {name: '座位与设施'}).waitFor();
    await page.locator('table.data').first().waitFor();
  }

  const tab = name => page.getByRole('tab', {name, exact: true}).click();
  const field = (label, control) => page.locator('.field').filter({has: page.getByText(label, {exact: true})}).locator(control);

  beforeAll(async () => { browser = await chromium.launch({executablePath, headless: true}); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    server = await startTestServer({env: {TICK_INTERVAL_MS: '60000'}});
    page = await browser.newPage();
    page.setDefaultTimeout(8000);
    [sys, manager, student] = await Promise.all(['s1', 'm1', 'u01'].map(client));
    today = (await sys.get('/system/clock')).json.nowText.slice(0, 10);
  });
  afterEach(async () => { await page?.close(); await server?.close(); });

  it('使用中座位清场后可提交；修改方案必须重新预览和确认', async () => {
    const day = addDaysLocal(today, 1);
    await setClock(sys, today + ' 08:00');
    const booked = await student.post('/reservations', {
      roomId: 'R1', seatId: 'R1-A01', date: day, start: '10:00', end: '11:00',
    }, {key: key()});
    expect(booked.status).toBe(201);
    const reservation = '/reservations/' + booked.json.reservation.id;
    await setClock(sys, day + ' 10:01');
    const code = (await manager.get('/admin/seats/R1-A01/qr')).json.text;
    expect((await student.post(reservation + '/checkin', {code}, {key: key()})).status).toBe(200);

    await login('m1');
    await tab('停用管理');
    await field('目标座位', 'select').selectOption('R1-A01');
    await field('结束时间', 'input').fill(day + 'T11:00');
    const reason = field('停用原因', 'input');
    const preview = page.getByRole('button', {name: '预览影响'});
    const clearance = page.getByRole('checkbox', {name: /现场已清空/});
    const confirm = page.getByRole('button', {name: '确认停用'});
    await reason.fill('椅脚检修');
    await preview.click();
    await clearance.waitFor();
    expect(await confirm.isEnabled()).toBe(false);
    await clearance.check();
    expect(await confirm.isEnabled()).toBe(true);
    await reason.fill('更换破损座椅');
    expect(await confirm.isVisible()).toBe(false);
    await preview.click();
    await clearance.waitFor();
    expect(await clearance.isChecked()).toBe(false);
    await clearance.check();
    const posted = page.waitForResponse(r => r.url().endsWith('/api/admin/suspensions') && r.request().method() === 'POST');
    await confirm.click();
    expect((await posted).status()).toBe(201);
    const final = (await student.get(reservation)).json.reservation;
    expect(final).toMatchObject({status: 'aborted', waiver: true, endReason: 'venue_suspension'});
  });
});
