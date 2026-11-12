import { run } from './db.js';
import { now } from './clock.js';

/**
 * 审计写入。BR-12：审计与业务在同一事务内提交；审计写入失败则业务失败。
 */
function audit({ actor, action, objectType, objectId, before = null, after = null, reason = null, result = 'success' }) {
  run(
    `INSERT INTO audits (actor_id, actor_role, action, object_type, object_id, before_json, after_json, reason, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actor?.id ?? null,
    actor?.role ?? null,
    action,
    objectType ?? null,
    objectId == null ? null : String(objectId),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason,
    result,
    now(),
  );
}

export { audit };