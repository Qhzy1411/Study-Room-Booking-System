import { randomUUID } from 'node:crypto';

/** 带有独立 Cookie 会话的 API 客户端 */
export function createApiClient(base) {
  let cookie = '';

  async function request(method, path, body, { headers = {}, key = null, signal = null } = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    if (setCookies.length) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    let json = null;
    const text = await response.text();
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: response.status, json, headers: response.headers };
  }

  return {
    request,
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body = {}, options) => request('POST', path, body, options),
    patch: (path, body = {}, options) => request('PATCH', path, body, options),
    async login(username, password = '123456') {
      const response = await request('POST', '/auth/login', { username, password });
      if (response.status !== 200) {
        throw new Error(`登录 ${username} 失败：${response.status} ${response.json?.error?.message || ''}`);
      }
      return response.json.user;
    },
    cookie: () => cookie,
  };
}

export function key() {
  return randomUUID();
}

/** 设置演示时钟（需要系统管理员客户端） */
export async function setClock(sysClient, at) {
  const response = await sysClient.post('/admin/demo/clock', { at });
  if (response.status !== 200) throw new Error(`设置演示时钟失败：${response.json?.error?.message}`);
  return response.json;
}

/** 读取业务上下文的默认日期与规则 */
export async function bookingContext(client) {
  const response = await client.get('/booking/context');
  if (response.status !== 200) throw new Error('无法读取预约上下文');
  return response.json;
}