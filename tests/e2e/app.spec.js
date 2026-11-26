import { executablePath } from '../helpers/browser.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { startTestServer } from '../helpers/server.js';

let server;
let browser;

beforeAll(async () => {
  if (!executablePath) return;
  server = await startTestServer({ env: { TICK_INTERVAL_MS: '60000' } });
  browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function newPage(viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('favicon')) consoleErrors.push(text);
  });
  return { page, pageErrors, consoleErrors };
}

async function loginAs(page, base, index) {
  await page.goto(base);
  await page.locator('.auth-showcase').waitFor({ state: 'visible' });
  await page.locator('.demo-btns button').nth(index).click();
  await page.locator('.nav a').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function expectHeading(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('h1')?.textContent?.includes(expected),
    text,
    { timeout: 15000 },
  );
}

async function clickNav(page, label) {
  await page.locator('.nav a').filter({ hasText: label }).first().click();
  await expectHeading(page, label === '违约与限制' ? '违约与限制' : label);
}

describe.skipIf(!executablePath)('浏览器端到端冒烟（桌面与 390px 移动宽度）', () => {
  it('学生端各页面可加载且无脚本错误', async () => {
    const { page, pageErrors, consoleErrors } = await newPage();
    await loginAs(page, server.base, 0);
    await expectHeading(page, '预约座位');
    await page.waitForSelector('.floor-wrap, .empty');
    for (const label of ['我的预约', '到座导航', '投诉与申诉', '通知', '违约与限制', '个人资料']) {
      await clickNav(page, label);
    }
    // 返回预约页并验证座位图交互区域
    await clickNav(page, '预约座位');
    await page.waitForSelector('.seat, .empty', { timeout: 15000 });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  it('学生可通过界面完成预约并查看到座路线', async () => {
    const { page, pageErrors, consoleErrors } = await newPage();
    await loginAs(page, server.base, 0);
    await expectHeading(page, '预约座位');
    await page.waitForSelector('.toolbar-card select', { timeout: 15000 });
    // 选择明天的日期（索引 1），让开放时段完整可预约
    await page.locator('.toolbar-card select').nth(1).selectOption({ index: 1 });
    const setValue = async (locator, value) => {
      await locator.evaluate((el, next) => {
        el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    };
    const timeInputs = page.locator('.toolbar-card input[type="time"]');
    await setValue(timeInputs.nth(0), '08:00');
    await setValue(timeInputs.nth(1), '09:00');
    await page.getByRole('button', { name: /查询座位/ }).click();
    await page.waitForSelector('.seat', { timeout: 15000 });
    await page.locator('.seat').filter({ hasText: 'A01' }).first().click();
    await page.waitForFunction(() => document.querySelector('.selected-seat strong')?.textContent === 'A01');
    await page.getByText('请先勾选预约规则确认项。').waitFor();
    expect(await page.getByRole('button', { name: '确认预约' }).isEnabled()).toBe(false);
    await page.locator('aside .check input[type="checkbox"]').check();
    await page.getByRole('button', { name: '确认预约' }).click();
    await page.getByRole('heading', { name: '预约成功' }).waitFor({ timeout: 15000 });
    expect(await page.locator('.modal').getByText('规则版本').count()).toBe(0);
    await page.getByRole('button', { name: '查看我的预约' }).click();
    await expectHeading(page, '我的预约');
    await page.getByText('A01').first().waitFor({ timeout: 15000 });
    await clickNav(page, '到座导航');
    await expectHeading(page, '到座导航');
    await page.waitForSelector('.route-map svg', { timeout: 15000 });
    await page.getByText('从西入口进入自习室').waitFor({ timeout: 15000 });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  it('场地管理员页面可加载并显示统计快照', async () => {
    const { page, pageErrors, consoleErrors } = await newPage();
    await loginAs(page, server.base, 1);
    await expectHeading(page, '场地管理');
    await page.waitForSelector('.subtabs');
    await page.locator('.subtabs button').filter({ hasText: '评价管理' }).click();
    await page.waitForTimeout(600);
    await clickNav(page, '违约与限制');
    await page.waitForSelector('.subtabs');
    await clickNav(page, '投诉处理');
    await expectHeading(page, '投诉处理');
    const complaintActions = await page.locator('.page-head .head-actions > *').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().top));
    expect(complaintActions).toHaveLength(2);
    expect(Math.abs(complaintActions[0] - complaintActions[1])).toBeLessThan(10);
    await clickNav(page, '数据统计');
    await expectHeading(page, '数据统计');
    await page.waitForSelector('.metric .value', { timeout: 15000 });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  it('场地管理员可登记没有关联预约编号的现场事件', async () => {
    const { page, pageErrors, consoleErrors } = await newPage();
    await loginAs(page, server.base, 1);
    await clickNav(page, '违约与限制');
    await page.locator('.subtabs button').filter({ hasText: '手动登记' }).click();
    await page.getByPlaceholder('输入学号、账号或姓名，例如 U01').fill('U02');
    const studentButton = page.getByRole('button', { name: /U02/i }).first();
    await studentButton.waitFor({ timeout: 10000 });
    await studentButton.click();
    await page.locator('textarea[rows="4"]').fill('现场登记：多次提醒后仍在安静区大声通话，管理员现场核实并拍照留证。');
    // 关联预约编号保持为空，验证无预约编号的现场事件也能登记
    await page.getByRole('button', { name: '登记待复核事件' }).click();
    await page.locator('.toast').filter({ hasText: '待复核事件已登记' }).waitFor({ timeout: 10000 });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  it('系统管理员页面可加载账号、规则与审计', async () => {
    const { page, pageErrors, consoleErrors } = await newPage();
    await loginAs(page, server.base, 3);
    await expectHeading(page, '系统管理');
    await page.waitForSelector('table.data', { timeout: 15000 });
    for (const tab of ['规则版本', '审计记录', '通知投递', '演示时钟']) {
      await page.locator('.subtabs button').filter({ hasText: tab }).click();
      await expectHeading(page, '系统管理');
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  it('390px 宽度下不产生页面级横向滚动', async () => {
    const { page, pageErrors } = await newPage({ width: 390, height: 844 });
    await loginAs(page, server.base, 0);
    await expectHeading(page, '预约座位');
    await page.waitForSelector('.floor-wrap, .empty');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await clickNav(page, '我的预约');
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow2).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
    await page.close();
  });
});

describe.skipIf(!!executablePath)('浏览器端到端冒烟', () => {
  it('未找到 Chrome/Edge，跳过浏览器测试', () => {
    expect(true).toBe(true);
  });
});
