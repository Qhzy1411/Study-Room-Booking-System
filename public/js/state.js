import { api } from './api.js';

export const store = {
  user: null,
  skewMs: 0,
  demoMode: false,
  unread: 0,
  clockSource: null,
};

export function setUser(user) {
  store.user = user;
}

export function isAdmin() {
  return store.user && (store.user.role === 'venue_admin' || store.user.role === 'sys_admin');
}

export function isVenueAdmin() {
  return store.user?.role === 'venue_admin';
}

export function isSysAdmin() {
  return store.user?.role === 'sys_admin';
}

export function applyClock(clock) {
  if (!clock) return;
  store.skewMs = Number(clock.now || 0) - Date.now();
  store.demoMode = !!clock.demoMode;
}

export function now() {
  return Date.now() + store.skewMs;
}

export function beijingParts(ts = now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function beijingDate(ts = now()) {
  const p = beijingParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function beijingTime(ts = now(), withSeconds = false) {
  const p = beijingParts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}${withSeconds ? `:${pad(p.second)}` : ''}`;
}

export function beijingDateTime(ts = now()) {
  return `${beijingDate(ts)} ${beijingTime(ts, true)}`;
}

export function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function dateLabel(date) {
  const [, month, day] = String(date).split('-');
  return `${Number(month)} 月 ${Number(day)} 日`;
}

export function weekdayLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
}

export async function refreshUnread() {
  if (!store.user) return 0;
  try {
    const data = await api.get('/notifications/unread-count');
    store.unread = data.unread || 0;
    window.dispatchEvent(new CustomEvent('srb:unread', { detail: store.unread }));
  } catch {
    /* 通知计数失败不阻断页面 */
  }
  return store.unread;
}

export async function refreshClock() {
  try {
    const clock = await api.get('/system/clock');
    applyClock(clock);
    return clock;
  } catch {
    return null;
  }
}

export function startTicker(callback, intervalMs = 1000) {
  const timer = setInterval(callback, intervalMs);
  callback();
  return () => clearInterval(timer);
}