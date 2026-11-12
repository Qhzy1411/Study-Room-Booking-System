import config from './config.js';
import { metaGet, metaSet } from './db.js';

/**
 * 业务时钟。默认等于系统时间；演示模式可由系统管理员设置偏移，
 * 用于演示签到窗口、到期处理等时间相关场景。所有业务判断只读这个时钟。
 */
let offsetMs = Number(metaGet('clock_offset_ms', '0')) || 0;

function now() {
  return Date.now() + offsetMs;
}

function offset() {
  return offsetMs;
}

function setNow(targetTs) {
  offsetMs = targetTs - Date.now();
  metaSet('clock_offset_ms', offsetMs);
}

function syncToRealTime() {
  offsetMs = 0;
  metaSet('clock_offset_ms', 0);
}

function isDemo() {
  return config.demoMode;
}

export { now, offset, setNow, syncToRealTime, isDemo };