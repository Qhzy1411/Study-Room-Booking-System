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

  async function loginBothRooms() {
    const created = await sys.post('/admin/users', {
      username: 'bothrooms', displayName: '两馆值班员', password: '123456',
      role: 'venue_admin', grants: ['R1', 'R2'],
    });
    expect(created.status).toBe(201);
    await login('bothrooms');
    return client('bothrooms');
  }

  const room = () => page.locator('.head-actions select');
  it('从二层切到三层时，二维码、现场预约及评价无需重开标签', async () => {
    const both = await loginBothRooms();
    const qr = (await both.get('/admin/rooms/R2/qr-sheet')).json.seats;
    const live = (await both.get('/admin/reservations?roomId=R2&date=' + today)).json.reservations;
    const reviews = (await both.get('/admin/evaluations?roomId=R2')).json.evaluations;

    for (const [label, path] of [['桌面二维码','/admin/rooms/R2/qr-sheet'], ['现场预约','/admin/reservations'], ['评价管理','/admin/evaluations']]) {
      await tab('座位与设施');
      await room().selectOption('R1');
      await page.locator('table.data').waitFor();
      await tab(label);
      await page.locator(label === '桌面二维码' ? '.qr-item' : 'table.data, .empty').first().waitFor();
      const loaded = page.waitForResponse(r => {
        const url = new URL(r.url());
        return url.pathname === '/api' + path && (label === '桌面二维码' || url.searchParams.get('roomId') === 'R2');
      });
      await room().selectOption('R2');
      expect((await loaded).status()).toBe(200);
      if (label === '桌面二维码') {
        await page.locator('.qr-item').first().waitFor();
        expect(await page.locator('.qr-item strong').allTextContents()).toEqual(qr.map(s => s.code));
      } else {
        const data = label === '现场预约' ? live : reviews;
        await page.locator(data.length ? 'table.data tbody tr' : '.empty').first().waitFor();
        expect(await page.locator('table.data tbody tr').count()).toBe(data.length);
        if (data.length) expect(await page.locator('tbody tr').first().innerText()).toContain(
          label === '现场预约' ? data[0].seatCode : data[0].content || '—',
        );
      }
    }
  });

  it.each(['详情', '评价'])('%s旧请求较晚返回时，仍保留当前楼层', async (kind) => {
    await loginBothRooms();
    const oldRequest = kind === '详情' ? '**/api/admin/rooms/R1?*' : '**/api/admin/evaluations?roomId=R1';
    let release, signalStart;
    const hold = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { signalStart = resolve; });
    await page.route(oldRequest, async route => {
      const response = await route.fetch();
      signalStart();
      await hold;
      await route.fulfill({response});
    }, {times: 1});
    try {
      if (kind === '详情') await page.locator('.head-actions').getByRole('button', {name:'刷新'}).click();
      else await tab('评价管理');
      await started;
      await room().selectOption('R2');
      const ready = kind === '详情' ? page.locator('table.data tbody tr').first() : page.locator('table.data tbody tr, .empty').first();
      await ready.waitFor();
      const read = () => page.locator('.page-head p, table.data tbody, .empty').allTextContents();
      const correct = await read();
      const done = page.waitForResponse(r => r.url().includes(kind === '详情' ? '/admin/rooms/R1?' : '/admin/evaluations?roomId=R1'));
      release();
      await (await done).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await read()).toEqual(correct);
      expect(await room().inputValue()).toBe('R2');
    } finally { release(); }
  });
});
