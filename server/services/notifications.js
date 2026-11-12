import { all, get, metaGet, metaSet, run, tx } from '../db.js';
import { notify } from './shared.js';
import { now } from '../clock.js';
import { forbidden, notFound, badRequest } from '../errors.js';
import { fmt } from '../time.js';

function listMine(user, { unreadOnly = false, limit = 100 } = {}) {
  const rows = all(
    `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT ?`,
    user.id,
    Math.min(Number(limit) || 100, 200),
  );
  return rows.map((n) => ({
    id: n.id,
    eventType: n.event_type,
    title: n.title,
    body: n.body,
    status: n.status,
    statusLabel: n.status === 'sent' ? '已送达' : n.status === 'failed' ? '投递失败' : '待发送',
    attempts: n.attempts,
    lastError: n.last_error,
    createdAt: n.created_at,
    createdAtText: fmt(n.created_at),
    sentAt: n.sent_at,
    read: !!n.read_at,
    readAt: n.read_at,
  }));
}

function unreadCount(user) {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n;
}

function markRead(user, id) {
  const row = get('SELECT * FROM notifications WHERE id = ?', id);
  if (!row) throw notFound('通知不存在');
  if (row.user_id !== user.id) throw forbidden('只能查看本人的通知');
  if (!row.read_at) run('UPDATE notifications SET read_at = ? WHERE id = ?', now(), id);
  return { ok: true };
}

function markAllRead(user) {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), user.id);
  return { ok: true };
}

/**
 * 站内投递：处理待发送通知。发送失败不回滚业务，可在通知记录中查看并重试（BR-24）。
 * 演示/测试可通过 injectDeliveryFailure 注入一次失败。
 */
function deliverPending({ limit = 50 } = {}) {
  return tx(() => {
    const rows = all(
      `SELECT * FROM notifications WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
      limit,
    );
    let sent = 0;
    for (const row of rows) {
      const forced = metaGet(`notify_fail:${row.id}`);
      if (forced) {
        metaSet(`notify_fail:${row.id}`, '');
        run(
          `UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
          String(forced) || '模拟投递失败',
          row.id,
        );
        continue;
      }
      run(
        `UPDATE notifications SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?`,
        now(),
        row.id,
      );
      sent += 1;
    }
    return { processed: rows.length, sent };
  });
}

/** 演示/测试：让下一次投递失败一次（用于验收 AC-28） */
function injectDeliveryFailure(notificationId, message = '模拟站内信投递失败') {
  const row = get('SELECT * FROM notifications WHERE id = ?', notificationId);
  if (!row) throw notFound('通知不存在');
  if (row.status === 'sent') throw badRequest('该通知已经送达，无法模拟失败');
  metaSet(`notify_fail:${row.id}`, message);
  return { ok: true, notificationId };
}

function retryDelivery(notificationId) {
  const row = get('SELECT * FROM notifications WHERE id = ?', notificationId);
  if (!row) throw notFound('通知不存在');
  if (row.status !== 'failed') throw badRequest('只有投递失败的通知可以重试');
  run(`UPDATE notifications SET status = 'pending' WHERE id = ?`, notificationId);
  return { ok: true };
}

/** 管理员查看通知投递状态（仅演示/验收用途，限系统管理员） */
function adminListNotifications(admin, { status = null, limit = 100 } = {}) {
  if (admin.role !== 'sys_admin') throw forbidden('只有系统管理员可以查看全局投递记录');
  const rows = all(
    `SELECT n.*, u.display_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id
      ${status && status !== 'all' ? 'WHERE n.status = ?' : ''}
      ORDER BY n.created_at DESC LIMIT ?`,
    ...(status && status !== 'all' ? [status, limit] : [limit]),
  );
  return rows.map((n) => ({
    id: n.id,
    userName: n.display_name,
    title: n.title,
    status: n.status,
    attempts: n.attempts,
    lastError: n.last_error,
    createdAtText: fmt(n.created_at),
    sentAt: n.sent_at,
  }));
}

/** 预约开始前 30 分钟发送提醒（受用户“预约提醒”偏好控制，事件键去重） */
function sendDueReminders(ts = now()) {
  return tx(() => {
    const rows = all(
      `SELECT r.* FROM reservations r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
          AND r.start_ts > ? AND r.start_ts <= ?
          AND u.enabled = 1 AND u.notify_reminder = 1
        ORDER BY r.start_ts LIMIT 50`,
      ts,
      ts + 30 * 60 * 1000,
    );
    for (const row of rows) {
      const room = get('SELECT name FROM rooms WHERE id = ?', row.room_id);
      const seat = get('SELECT code FROM seats WHERE id = ?', row.seat_id);
      notify(
        row.user_id,
        `reservation.reminder:${row.id}`,
        'reservation',
        '预约即将开始',
        `你在 ${room?.name || ''} ${seat?.code || ''} 的预约将于 ${fmt(row.start_ts)} 开始，请在 ${fmt(row.checkin_deadline)} 前签到。`,
      );
    }
    return rows.length;
  });
}

export {
  sendDueReminders,
  listMine,
  unreadCount,
  markRead,
  markAllRead,
  deliverPending,
  injectDeliveryFailure,
  retryDelivery,
  adminListNotifications,
};