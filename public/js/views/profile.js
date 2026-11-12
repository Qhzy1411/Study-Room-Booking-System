import { setContent } from '../util.js';
import { api, ApiError } from '../api.js';
import { store, applyClock } from '../state.js';
import { h, icon, toast, plainBadge } from '../util.js';

const ROLE_LABEL = { student: '学生', venue_admin: '场地管理员', sys_admin: '系统管理员' };

function grantsText(user) {
  if (user?.grantRooms?.length) return user.grantRooms.map((room) => room.name).join('、');
  return (user?.grants || []).join('、');
}

export async function renderProfile(container, { navigate }) {
  let disposed = false;
  let me = null;
  let busy = false;
  let errorMessage = '';
  const root = h('div', { class: 'stack-20' });
  container.append(root);

  const form = { displayName: '', notifySite: true, notifyReminder: true };

  async function load() {
    try {
      const data = await api.get('/me');
      if (disposed) return;
      me = data.user;
      applyClock(data.clock);
      form.displayName = me.displayName;
      form.notifySite = me.notifySite;
      form.notifyReminder = me.notifyReminder;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载资料失败', 'error');
    }
    renderAll();
  }

  async function save() {
    if (!form.displayName.trim()) {
      errorMessage = '显示名不能为空';
      renderAll();
      return;
    }
    busy = true;
    errorMessage = '';
    renderAll();
    try {
      const result = await api.patch('/me', {
        displayName: form.displayName.trim(),
        notifySite: form.notifySite,
        notifyReminder: form.notifyReminder,
      });
      me = { ...me, ...result.profile };
      store.user = { ...store.user, displayName: result.profile.displayName, notifySite: result.profile.notifySite, notifyReminder: result.profile.notifyReminder };
      window.dispatchEvent(new CustomEvent('srb:user'));
      toast('资料已保存；账号身份与权限未改变');
    } catch (error) {
      errorMessage = error instanceof ApiError ? error.message : '保存失败';
    } finally {
      busy = false;
      renderAll();
    }
  }

  function permissionLine() {
    if (!me) return null;
    const items = [];
    items.push(plainBadge(ROLE_LABEL[me.role] || me.role, 'blue'));
    if (me.role === 'venue_admin') {
      items.push(plainBadge(me.grants.length ? `授权场地 ${grantsText(me)}` : '暂无场地授权', me.grants.length ? 'gray' : 'amber'));
    }
    if (me.role === 'sys_admin') {
      if (me.canRules) items.push(plainBadge('规则维护', 'gray'));
      if (me.canAudit) items.push(plainBadge('审计读取', 'gray'));
      if (me.canReview) items.push(plainBadge('业务复核', 'gray'));
      if (me.canStats) items.push(plainBadge('统计查询', 'gray'));
      if (!me.canRules && !me.canAudit && !me.canReview && !me.canStats) items.push(plainBadge('默认仅技术配置', 'gray'));
    }
    return items;
  }

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '个人资料'),
          h('p', {}, '修改显示名与通知偏好。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: () => navigate('/records') } }, icon('history'), '违约与限制'),
        ),
      ),
      !me
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载资料…')))
        : h('div', { class: 'split equal' },
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', {}, '基本资料')),
            h('div', { class: 'card-body stack' },
              h('div', { class: 'selected-seat' },
                h('strong', {}, me.displayName),
                plainBadge('账号启用', 'green'),
              ),
              h('div', { class: 'row', style: { gap: '6px' } }, permissionLine()),
              h('div', { class: 'divider' }),
              h('div', { class: 'field' },
                h('label', { for: 'profile-name' }, '显示名'),
                h('input', {
                  id: 'profile-name', type: 'text', maxlength: 30, value: form.displayName,
                  on: { input: (event) => { form.displayName = event.target.value; } },
                }),
                h('p', { class: 'field-hint' }, '用于页面展示。'),
              ),
              h('div', { class: 'field' },
                h('span', { class: 'field-label' }, '通知偏好'),
                h('label', { class: 'check' },
                  h('input', {
                    type: 'checkbox', checked: form.notifySite,
                    on: { change: (event) => { form.notifySite = event.target.checked; } },
                  }),
                  h('span', { class: 'text' }, '接收站内业务通知（预约、停用、复核、投诉答复）'),
                ),
                h('label', { class: 'check' },
                  h('input', {
                    type: 'checkbox', checked: form.notifyReminder,
                    on: { change: (event) => { form.notifyReminder = event.target.checked; } },
                  }),
                  h('span', { class: 'text' }, '预约开始前 30 分钟发送站内提醒'),
                ),
                h('p', { class: 'field-hint' }, '业务结果仍可在本人记录中查询。'),
              ),
              errorMessage ? h('p', { style: { color: 'var(--danger)', fontSize: '13px' } }, errorMessage) : null,
              h('button', { class: 'btn primary', type: 'button', disabled: busy, on: { click: save } }, busy ? '保存中…' : '保存资料'),
            ),
          ),
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', {}, '账号信息')),
            h('div', { class: 'card-body stack' },
              h('dl', { class: 'kv' },
                h('dt', {}, '账号'), h('dd', { class: 'mono' }, me.username),
                h('dt', {}, '角色'), h('dd', {}, ROLE_LABEL[me.role] || me.role),
                h('dt', {}, '账号状态'), h('dd', {}, me.enabled ? '启用' : '停用'),
                me.role === 'venue_admin' ? h('dt', {}, '场地授权') : null,
                me.role === 'venue_admin' ? h('dd', {}, me.grants.length ? grantsText(me) : '暂无') : null,
              ),
              h('div', { class: 'notice' },
                '账号与权限由管理员维护。',
              ),
            ),
          ),
        ),
    );
  }

  renderAll();
  await load();
  return () => { disposed = true; };
}