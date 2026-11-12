import { describe, it, expect } from 'vitest';
import {
  at, parseDate, parseTime, dateStr, timeStr, fmt, addDaysLocal,
  overlaps, unionLength, unionLengthClipped, minutes,
} from '../../../server/time.js';

describe('北京时间与区间工具', () => {
  it('解析日期和时刻，并按半开区间生成时间戳', () => {
    const day = parseDate('2026-11-06');
    expect(day).not.toBeNull();
    expect(at('2026-11-06', '14:00')).toBe(day + 14 * 60 * 60000);
    expect(parseTime('14:00')).toBe(840);
    expect(parseTime('23:59')).toBe(1439);
    expect(parseTime('24:00')).toBeNull();
    expect(parseDate('2026-02-30')).toBeNull();
  });

  it('显示北京时间日期与时间', () => {
    const ts = at('2026-11-06', '13:05');
    expect(dateStr(ts)).toBe('2026-11-06');
    expect(timeStr(ts)).toBe('13:05');
    expect(fmt(ts)).toBe('2026-11-06 13:05');
    expect(addDaysLocal('2026-11-06', 1)).toBe('2026-11-07');
  });

  it('重叠判定：相邻允许，部分交叠、包含与相同均重叠', () => {
    const t = (time) => at('2026-11-06', time);
    expect(overlaps(t('14:00'), t('15:00'), t('15:00'), t('16:00'))).toBe(false);
    expect(overlaps(t('14:00'), t('15:00'), t('14:30'), t('15:30'))).toBe(true);
    expect(overlaps(t('14:00'), t('15:00'), t('14:10'), t('14:20'))).toBe(true);
    expect(overlaps(t('14:00'), t('15:00'), t('14:00'), t('15:00'))).toBe(true);
  });

  it('区间并集只计算一次重叠部分', () => {
    const base = parseDate('2026-11-06');
    const m = (n) => base + n * 60000;
    expect(unionLength([[m(0), m(30)], [m(10), m(40)], [m(60), m(90)]])).toBe(70 * 60000);
    expect(unionLengthClipped([[m(0), m(30)], [m(10), m(40)]], m(5), m(35))).toBe(30 * 60000);
    expect(minutes(90 * 60000)).toBe(90);
  });
});