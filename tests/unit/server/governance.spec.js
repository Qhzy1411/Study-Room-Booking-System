import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../../helpers/server.js';
import { createApiClient, key, setClock, bookingContext } from '../../helpers/client.js';

let server;
let s1;
let u02;
let u03;
let m1;
let today;
let date;

beforeAll(async () => {
  server = await startTestServer({ env: { TICK_INTERVAL_MS: '60000' } });
  s1 = createApiClient(server.base);
  await s1.login('s1');
  u02 = createApiClient(server.base);
  await u02.login('u02');
  u03 = createApiClient(server.base);
  await u03.login('u03');
  m1 = createApiClient(server.base);
  await m1.login('m1');
  const clock = (await s1.get('/system/clock')).json;
  today = clock.nowText.slice(0, 10);
  await setClock(s1, `${today} 09:00`);
  date = (await bookingContext(u02)).dates[1].date;
});

afterAll(async () => {
  await server?.close();
});

describe('违规复核、限制与投诉（AC-20、AC-22、AC-26—28）', () => {
  let violationId;
  let limitId;

  it('手动登记进入待复核；重复事件按自然键去重', async () => {
    const payload = {
      roomId: 'R1',
      userId: 'U02',
      occurredAt: `${today} 08:30`,
      type: '现场事件',
      material: '现场登记：多次提醒后仍在安静区大声通话，管理员现场核实。',
    };
    const first = await m1.post('/admin/violations', payload);
    expect(first.status).toBe(200);
    expect(first.json.violation.status).toBe('pending');
    violationId = first.json.violation.id;
    const duplicate = await m1.post('/admin/violations', payload);
    expect(duplicate.status).toBe(200);
    expect(duplicate.json.duplicated).toBe(true);
    expect(duplicate.json.violation.id).toBe(violationId);
  });

  it('待复核记录不能作为限制依据；复核生效后可创建限制', async () => {
    const beforeDecision = await m1.post('/admin/limits', {
      userId: 'U02', roomScope: 'R1',
      startAt: `${today} 09:00`, endAt: `${date} 23:00`,
      reason: '测试限制', violationIds: [violationId],
    });
    expect(beforeDecision.status).toBe(422);

    const decide = await m1.post(`/admin/violations/${violationId}/decide`, {
      decision: 'effective', reason: '现场照片与巡查记录一致，事实成立。',
    });
    expect(decide.status).toBe(200);
    expect(decide.json.violation.status).toBe('effective');

    const limit = await m1.post('/admin/limits', {
      userId: 'U02', roomScope: 'R1',
      startAt: `${today} 09:00`, endAt: `${date} 23:00`,
      reason: '依据已生效违规设置预约限制', violationIds: [violationId],
    });
    expect(limit.status).toBe(200);
    limitId = limit.json.limit.id;
    expect(limit.json.limit.basis).toHaveLength(1);
  });

  it('限制期间拒绝新预约，但不阻止查询与提交投诉', async () => {
    const booking = await u02.post('/reservations', {
      roomId: 'R1', seatId: 'R1-A01', date, start: '10:00', end: '11:00',
    }, { key: key() });
    expect(booking.status).toBe(422);
    expect(booking.json.error.message).toContain('限制');
    const complaint = await u02.post('/complaints', {
      roomId: 'R1', type: 'service', description: '限制期间的投诉仍应受理，用于验证不阻断查询与反馈。',
    }, { key: key() });
    expect(complaint.status).toBe(201);
    const mine = await u02.get('/complaints/mine');
    expect(mine.status).toBe(200);
  });

  it('撤销唯一依据后关联限制自动解除', async () => {
    const revoke = await m1.post(`/admin/violations/${violationId}/revoke`, {
      reason: '申诉补充材料说明当时为紧急通话，经复核撤销。',
    });
    expect(revoke.status).toBe(200);
    expect(revoke.json.revokedLimits).toContain(limitId);
    const limits = (await u02.get('/me/limits')).json.limits;
    const limit = limits.find((l) => l.id === limitId);
    expect(limit.revokedAtText).toBeTruthy();

    const booking = await u02.post('/reservations', {
      roomId: 'R1', seatId: 'R1-A01', date, start: '10:00', end: '11:00',
    }, { key: key() });
    expect(booking.status).toBe(201);
  });

  it('投诉闭环：受理 → 答复 → 补充 → 再答复 → 本校学生确认关闭', async () => {
    const submit = await u02.post('/complaints', {
      roomId: 'R1', type: 'facility', description: '饮水机无法出水，影响使用。',
    }, { key: key() });
    expect(submit.status).toBe(201);
    const id = submit.json.complaint.id;
    expect(submit.json.complaint.status).toBe('pending');

    const accept = await m1.post(`/admin/complaints/${id}/accept`, {});
    expect(accept.status).toBe(200);
    expect(accept.json.complaint.status).toBe('processing');

    const reply = await m1.post(`/admin/complaints/${id}/reply`, { body: '已联系维修，预计今日修复。' });
    expect(reply.status).toBe(200);
    expect(reply.json.complaint.status).toBe('answered');

    const supplement = await u02.post(`/complaints/${id}/supplement`, { body: '补充：旁边的插座也无法使用。' });
    expect(supplement.status).toBe(200);
    expect(supplement.json.complaint.status).toBe('processing');
    expect(supplement.json.complaint.events.filter((e) => e.kind === 'reply')).toHaveLength(1);

    const replyAgain = await m1.post(`/admin/complaints/${id}/reply`, { body: '插座已更换，饮水机已修复。' });
    expect(replyAgain.status).toBe(200);
    expect(replyAgain.json.complaint.status).toBe('answered');
    expect(replyAgain.json.complaint.events.filter((e) => e.kind === 'reply')).toHaveLength(2);

    const close = await u02.post(`/complaints/${id}/close`, {});
    expect(close.status).toBe(200);
    expect(close.json.complaint.status).toBe('closed');
    const history = (await u02.get('/complaints/mine')).json.complaints;
    expect(history.find((c) => c.id === id).status).toBe('closed');
  });

  it('评价隐藏仅影响文字，评分与聚合数量不变；公开接口只返回聚合', async () => {
    const list = await m1.get('/admin/evaluations?roomId=R1');
    expect(list.status).toBe(200);
    expect(list.json.evaluations.length).toBeGreaterThan(0);
    const evaluation = list.json.evaluations.find((e) => e.visibility === 'visible');
    expect(evaluation).toBeTruthy();
    const before = (await u02.get('/rooms/R1')).json.rating;

    const hide = await m1.post(`/admin/evaluations/${evaluation.id}/hide`, {
      reason: '文字包含不当内容，按规则隐藏。',
      hidden: true,
    });
    expect(hide.status).toBe(200);
    expect(hide.json.evaluation.visibility).toBe('hidden');
    expect(hide.json.evaluation.rating).toBe(evaluation.rating);
    expect((await u02.get('/admin/evaluations?roomId=R1')).status).toBe(403);

    const after = (await u02.get('/rooms/R1')).json.rating;
    expect(after.count).toBe(before.count);
    expect(after.average).toBe(before.average);
    const publicView = await u02.get('/rooms/R1/evaluations');
    expect(publicView.status).toBe(200);
    expect(publicView.json.summary.average).toBe(before.average);
    expect(publicView.json.evaluations).toBeUndefined();
  });

  it('非收件人不能读取或标记他人通知；投递失败可重试且不重复', async () => {
    const mine = (await u02.get('/notifications')).json.notifications;
    const target = mine.find((n) => n.status === 'pending');
    expect(target).toBeTruthy();

    const forbiddenRead = await u03.post(`/notifications/${target.id}/read`, {});
    expect(forbiddenRead.status).toBe(403);

    const inject = await s1.post(`/admin/notifications/${target.id}/inject-failure`, {});
    expect(inject.status).toBe(200);
    await s1.post('/admin/tick', {});
    let failed = (await s1.get('/admin/notifications?status=failed')).json.notifications;
    expect(failed.some((n) => n.id === target.id)).toBe(true);

    const retry = await s1.post(`/admin/notifications/${target.id}/retry`, {});
    expect(retry.status).toBe(200);
    await s1.post('/admin/tick', {});
    const sent = (await s1.get('/admin/notifications?status=sent')).json.notifications;
    expect(sent.some((n) => n.id === target.id)).toBe(true);
    const all = (await s1.get('/admin/notifications')).json.notifications;
    expect(all.filter((n) => n.id === target.id)).toHaveLength(1);
  });

  it('场地管理员不能查看未授权场地记录', async () => {
    const response = await m1.get('/admin/violations?roomId=R2');
    expect(response.status).toBe(403);
  });
});