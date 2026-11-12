// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { h, escapeHtml, statusBadge, durationText, formatPercent, emptyState } from '../../../public/js/util.js';
import { beijingDate, beijingTime, beijingDateTime, addDays, dateLabel, weekdayLabel } from '../../../public/js/state.js';
import { qs } from '../../../public/js/api.js';
import { createSeatMap, createRouteMap } from '../../../public/js/seatmap.js';
import { barChart, lineChart } from '../../../public/js/charts.js';

describe('前端通用工具', () => {
  it('安全构造 DOM 并转义文本', () => {
    const el = h('div', { class: 'demo' }, h('strong', {}, '座位'), ' A01 <b>');
    expect(el.className).toBe('demo');
    expect(el.querySelector('strong').textContent).toBe('座位');
    expect(el.textContent).toContain('A01 <b>');
    expect(el.querySelector('b')).toBeNull();
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });

  it('状态、时长与百分比显示一致', () => {
    expect(statusBadge('pending').textContent).toBe('待签到');
    expect(statusBadge('no_show').textContent).toBe('已违约');
    expect(statusBadge('aborted').className).toContain('red');
    expect(durationText(90)).toBe('1 小时 30 分钟');
    expect(durationText(30)).toBe('30 分钟');
    expect(formatPercent(42.9)).toBe('42.9%');
    expect(formatPercent(null)).toBe('—');
    expect(emptyState('空状态').textContent).toContain('空状态');
  });

  it('查询字符串跳过空值并编码', () => {
    expect(qs({ a: 1, b: '', c: null, d: '中文' })).toBe('?a=1&d=%E4%B8%AD%E6%96%87');
    expect(qs({})).toBe('');
  });

  it('北京时间格式与日期换算', () => {
    const ts = Date.UTC(2026, 10, 6, 5, 5, 9);
    expect(beijingDate(ts)).toBe('2026-11-06');
    expect(beijingTime(ts)).toBe('13:05');
    expect(beijingTime(ts, true)).toBe('13:05:09');
    expect(beijingDateTime(ts)).toBe('2026-11-06 13:05:09');
    expect(addDays('2026-11-06', 3)).toBe('2026-11-09');
    expect(dateLabel('2026-11-06')).toBe('11 月 6 日');
    expect(['周一', '周二', '周三', '周四', '周五', '周六', '周日']).toContain(weekdayLabel('2026-11-06'));
  });
});

describe('座位图与图表渲染', () => {
  const map = {
    viewBox: [0, 0, 800, 660],
    walls: { x: 40, y: 40, width: 720, height: 580 },
    corridors: [{ id: 'top', width: 30, points: [[60, 100], [740, 100]] }],
    entrances: [{ id: 'W', label: '西入口', point: [60, 330], outside: [16, 330] }],
    seats: {
      A01: { code: 'A01', x: 100, y: 180, side: 'top', access: [100, 100], seatEdge: [100, 145] },
      A02: { code: 'A02', x: 200, y: 180, side: 'top', access: [200, 100], seatEdge: [200, 145] },
    },
    desks: [],
    obstacles: [],
    windows: [],
    labels: [],
  };

  it('座位状态使用颜色、文字与禁用属性共同表达', () => {
    let selected = null;
    const el = createSeatMap({
      map,
      seats: [
        { code: 'A01', state: 'available', power: 'normal' },
        { code: 'A02', state: 'occupied', power: 'normal', reason: '该时段已不可预约' },
      ],
      selectedCode: null,
      onSelect: (seat) => { selected = seat; },
    });
    const buttons = el.querySelectorAll('.seat');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-disabled')).toBeNull();
    expect(buttons[0].textContent).toContain('可预约');
    expect(buttons[1].disabled).toBe(true);
    expect(buttons[1].textContent).toContain('已预约');
    buttons[0].click();
    expect(selected.code).toBe('A01');
  });

  it('路线图包含路径折线与起终点标记', () => {
    const el = createRouteMap({
      map,
      route: {
        entranceLabel: '西入口',
        path: [[16, 330], [60, 330], [60, 100], [100, 100], [100, 145]],
        distanceMeters: 12.3,
      },
      targetSeatCode: 'A01',
    });
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(el.querySelectorAll('polyline').length).toBeGreaterThanOrEqual(1);
    expect(el.textContent).toContain('始');
    expect(el.textContent).toContain('终');
    expect(el.textContent).toContain('A01');
    expect(svg.getAttribute('aria-label')).toContain('A01');
  });

  it('柱状图与折线图处理空值与百分数', () => {
    const bars = barChart({
      items: [
        { label: 'R1', value: 42.9, display: '42.9%' },
        { label: 'R2', value: null, display: '—' },
      ],
    });
    expect(bars.querySelectorAll('rect').length).toBe(1);
    expect(bars.textContent).toContain('42.9%');
    expect(bars.textContent).toContain('—');

    const line = lineChart({
      points: [
        { label: '11-01', value: 20, display: '20%' },
        { label: '11-02', value: 30, display: '30%' },
        { label: '11-03', value: null, display: '—' },
        { label: '11-04', value: 45, display: '45%' },
        { label: '11-05', value: 50, display: '50%' },
      ],
    });
    expect(line.querySelectorAll('polyline').length).toBe(2);
    expect(line.textContent).toContain('45%');
  });
});