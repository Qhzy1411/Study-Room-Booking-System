/**
 * 时间工具：业务时间统一使用 Asia/Shanghai（UTC+8，无夏令时）。
 * 数据库存储 epoch milliseconds；对用户展示时再转换为本地时间。
 */
const OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 将 epoch 毫秒转换为北京时间各字段 */
function parts(ts) {
  const d = new Date(ts + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** 北京时间日期字符串 YYYY-MM-DD */
function dateStr(ts) {
  const p = parts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 北京时间时间字符串 HH:MM */
function timeStr(ts) {
  const p = parts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function timeStrSec(ts) {
  const p = parts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** YYYY-MM-DD HH:MM */
function fmt(ts) {
  return `${dateStr(ts)} ${timeStr(ts)}`;
}

function fmtSec(ts) {
  return `${dateStr(ts)} ${timeStrSec(ts)}`;
}

/** 解析 YYYY-MM-DD，返回该日期 00:00 北京时间的 epoch */
function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d) - OFFSET_MS;
  // 校验非法日期（如 2 月 30 日）
  const back = dateStr(ts);
  if (back !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return ts;
}

/** 解析 HH:MM，返回从 00:00 起的分钟数 */
function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** date + HH:MM → epoch */
function at(date, hhmm) {
  const dayTs = parseDate(date);
  const minutes = parseTime(hhmm);
  if (dayTs == null || minutes == null) return null;
  return dayTs + minutes * MINUTE;
}

function startOfLocalDate(ts) {
  return parseDate(dateStr(ts));
}

function addDaysLocal(date, days) {
  const base = parseDate(date);
  if (base == null) return null;
  return dateStr(base + days * DAY);
}

/** 两个半开区间是否重叠 [aStart,aEnd) × [bStart,bEnd) */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** 求区间集合的并集长度（毫秒） */
function unionLength(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return 0;
  let total = 0;
  let [cs, ce] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    if (s > ce) {
      total += ce - cs;
      cs = s;
      ce = e;
    } else if (e > ce) {
      ce = e;
    }
  }
  total += ce - cs;
  return total;
}

/** 求区间集合裁剪到 [lo,hi) 后的并集长度 */
function unionLengthClipped(intervals, lo, hi) {
  return unionLength(
    intervals
      .map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)])
      .filter(([s, e]) => e > s),
  );
}

function minutes(ms) {
  return Math.round(ms / MINUTE);
}

export {
  OFFSET_MS,
  MINUTE,
  HOUR,
  DAY,
  parts,
  dateStr,
  timeStr,
  timeStrSec,
  fmt,
  fmtSec,
  parseDate,
  parseTime,
  at,
  startOfLocalDate,
  addDaysLocal,
  overlaps,
  unionLength,
  unionLengthClipped,
  minutes,
};