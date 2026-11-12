import { get, run, tx } from '../db.js';
import { badRequest, conflict } from '../errors.js';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashPayload(payload) {
  return stable(payload);
}

/**
 * 幂等执行：同用户、同操作键、同载荷重复提交返回首次业务结果；同键不同载荷拒绝。
 * 业务写入与幂等结果在同一事务内提交（BR-13）。
 * fn 返回 { statusCode, body }。
 */
function idempotent({ user, key, op, payload }, fn) {
  if (!key || !String(key).trim()) throw badRequest('缺少操作键（Idempotency-Key）');
  const normalized = String(key).trim();
  if (normalized.length > 100) throw badRequest('操作键过长');
  const fingerprint = hashPayload(payload);
  return tx(() => {
    const existing = get('SELECT * FROM idempotency WHERE user_id = ? AND key = ?', user.id, normalized);
    if (existing) {
      if (existing.op !== op || existing.payload_hash !== fingerprint) {
        throw conflict('同一操作键不能用于不同的请求，请刷新后重试');
      }
      const stored = JSON.parse(existing.response_json);
      if (stored && stored.body !== undefined) {
        return { replayed: true, statusCode: stored.statusCode ?? existing.status_code, body: stored.body };
      }
      return { replayed: true, statusCode: existing.status_code, body: stored };
    }
    const result = fn();
    const statusCode = result.statusCode ?? 200;
    const body = result.body ?? result;
    run(
      'INSERT INTO idempotency (user_id, key, op, payload_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id,
      normalized,
      op,
      fingerprint,
      statusCode,
      JSON.stringify({ statusCode, body }),
      Date.now(),
    );
    return { replayed: false, statusCode, body };
  });
}

export { idempotent, hashPayload };