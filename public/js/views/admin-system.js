import { setContent, roomText } from '../util.js';
import { api, ApiError } from '../api.js';
import { applyClock, beijingDate, beijingTime } from '../state.js';
import {
  h, icon, toast, plainBadge, openModal, inputField,
} from '../util.js';

const TABS = [
  ['users', '账号与授权'],
  ['rules', '规则版本'],
  ['audit', '审计记录'],
  ['notifications', '通知投递'],
  ['clock', '演示时钟'],
];

const ROLE_LABEL = { student: '学生', venue_admin: '场地管理员', sys_admin: '系统管理员' };
const PERMISSION_LABEL = {
  canReview: '业务复核（违约、投诉、统计以外的业务处置）',
  canStats: '统计查询',
  canRules: '规则维护（场地管理员）',
  canAudit: '审计读取（业务记录范围）',
};

export async function renderAdminSystem(container) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  const state = {
    tab: 'users',
    users: [],
    rooms: [],
    rules: [],
    audits: [],
    notifications: [],
    clock: null,
    loading: true,
    error: '',
    create: {
      username: '', displayName: '', password: '', role: 'student', grants: new Set(), permissions: {},
    },
    rule: {
      advanceDays: 7, checkinGraceMin: 15, awayMinutes: 15, minMinutes: 30, dailyCount: 4, dailyMinutes: 240, note: '',
    },
    clockAt: '',
    auditAction: '',
  };

  async function loadAll() {
    state.loading = true;
    renderAll();
    try {
      const [users, rooms, rules, audits, notifications, clock] = await Promise.all([
        api.get('/admin/users'),
        api.get('/rooms'),
        api.get('/admin/rules'),
        api.get('/admin/audit?limit=200'),
        api.get('/admin/notifications'),
        api.get('/admin/demo/clock'),
      ]);
      if (disposed) return;
      state.users = users.users;
      state.rooms = rooms.rooms;
      state.rules = rules.rules;
      state.audits = audits.audits;
      state.notifications = notifications.notifications;
      state.clock = clock;
      state.clockAt = `${beijingDate(clock.now)}T${beijingTime(clock.now)}`;
      const current = state.rules.find((r) => r.current);
      if (current) {
        state.rule = {
          advanceDays: current.advanceDays,
          checkinGraceMin: current.checkinGraceMin,
          awayMinutes: current.awayMinutes,
          minMinutes: current.minMinutes,
          dailyCount: current.dailyCount,
          dailyMinutes: current.dailyMinutes,
          note: '',
        };
      }
      state.error = '';
    } catch (error) {
      state.error = error instanceof ApiError ? error.message : '加载系统数据失败';
      toast(state.error, 'error');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function grantOptions(role) {
    return state.rooms.map((room) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: state.create.grants.has(room.id),
        on: { change: (event) => {
          if (event.target.checked) state.create.grants.add(room.id);
          else state.create.grants.delete(room.id);
        } },
      }),
      h('span', { class: 'text' }, roomText(room)),
    ));
  }

  async function createUser() {
    if (!state.create.username.trim() || !state.create.displayName.trim() || !state.create.password) {
      toast('请填写账号、显示名和初始密码', 'warn');
      return;
    }
    try {
      await api.post('/admin/users', {
        username: state.create.username.trim(),
        displayName: state.create.displayName.trim(),
        password: state.create.password,
        role: state.create.role,
        grants: state.create.role === 'venue_admin' ? [...state.create.grants] : [],
        permissions: state.create.permissions,
      });
      toast('账号已创建');
      state.create = { username: '', displayName: '', password: '', role: 'student', grants: new Set(), permissions: {} };
      await loadAll();
    } catch (error) {
      toast(error.message || '创建失败', 'error');
    }
  }

  function editUser(user) {
    let role = user.role;
    let enabled = user.enabled;
    const displayName = h('input', { type: 'text', value: user.displayName, maxlength: 30 });
    const password = h('input', { type: 'password', placeholder: '留空则不修改', autocomplete: 'new-password' });
    const roleSelect = h('select', {
      on: { change: (event) => { role = event.target.value; renderGrants(); } },
    }, Object.entries(ROLE_LABEL).map(([value, label]) => h('option', { value, selected: role === value }, label)));
    const grants = new Set(user.grants);
    const grantsBox = h('div', { class: 'stack', style: { gap: '6px' } });
    function renderGrants() {
      grantsBox.replaceChildren(...state.rooms.map((room) => h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: grants.has(room.id), disabled: role !== 'venue_admin',
          on: { change: (event) => {
            if (event.target.checked) grants.add(room.id);
            else grants.delete(room.id);
          } },
        }),
        h('span', { class: 'text' }, roomText(room)),
      )));
    }
    renderGrants();
    const perms = { ...user.permissions };
    const permsBox = h('div', { class: 'stack', style: { gap: '6px' } }, Object.entries(PERMISSION_LABEL).map(([key, label]) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: !!perms[key],
        on: { change: (event) => { perms[key] = event.target.checked; } },
      }),
      h('span', { class: 'text' }, label),
    )));
    const enabledCheck = h('input', {
      type: 'checkbox', checked: enabled,
      on: { change: (event) => { enabled = event.target.checked; } },
    });
    const error = h('p', { style: { color: 'var(--danger)', fontSize: '13px' } });
    const save = h('button', { class: 'btn primary', type: 'button' }, '保存变更');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api.patch(`/admin/users/${user.id}`, {
          displayName: displayName.value.trim(),
          role,
          enabled,
          grants: role === 'venue_admin' ? [...grants] : [],
          permissions: perms,
          password: password.value ? password.value : undefined,
          reason: '系统管理员维护账号、角色与授权',
        });
        toast('账号与授权已更新');
        dialog.close();
        await loadAll();
      } catch (err) {
        error.textContent = err.message || '保存失败';
        save.disabled = false;
      }
    });
    const dialog = openModal({
      title: `编辑账号 · ${user.username}`,
      wide: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'form-grid' },
          inputField('显示名', displayName),
          h('div', { class: 'field' }, h('label', {}, '角色'), roleSelect),
          h('div', { class: 'field' }, h('label', {}, '重置密码（可选）'), password),
          h('div', { class: 'field' }, h('label', {}, '账号启用'), h('label', { class: 'check' }, enabledCheck, h('span', { class: 'text' }, '启用（禁用后下一次请求即拒绝）'))),
        ),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '场地授权（仅场地管理员）'), grantsBox),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '业务权限'), permsBox),
        h('div', { class: 'notice' }, '更改角色或停用账号后，该用户的现有会话将失效。'),
        error,
      ),
      footer: [h('button', { class: 'btn ghost', type: 'button', on: { click: () => dialog.close() } }, '取消'), save],
    });
  }

  function renderUsers() {
    const createRole = h('select', {
      on: { change: (event) => { state.create.role = event.target.value; renderAll(); } },
    }, Object.entries(ROLE_LABEL).map(([value, label]) => h('option', { value, selected: state.create.role === value }, label)));
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '账号列表')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, '账号'), h('th', {}, '显示名'), h('th', {}, '角色'), h('th', {}, '状态'), h('th', {}, '场地授权'), h('th', {}, '业务权限'), h('th', { class: 'actions-cell' }, '操作'))),
          h('tbody', {}, state.users.map((u) => h('tr', {},
            h('td', { class: 'mono' }, u.username),
            h('td', {}, u.displayName),
            h('td', {}, ROLE_LABEL[u.role] || u.role),
            h('td', {}, u.enabled ? plainBadge('启用', 'green') : plainBadge('停用', 'red')),
            h('td', {}, u.grantRooms?.length ? u.grantRooms.map((room) => room.name).join('、') : '—'),
            h('td', { class: 'tiny' }, Object.entries(u.permissions).filter(([, value]) => value).map(([key]) => PERMISSION_LABEL[key].split('（')[0]).join('、') || '—'),
            h('td', { class: 'actions-cell' }, h('button', { class: 'btn sm', type: 'button', on: { click: () => editUser(u) } }, '编辑')),
          ))),
        )),
      ),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '创建账号')),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            inputField('登录账号', h('input', {
              type: 'text', value: state.create.username, placeholder: '例如 u04',
              on: { input: (event) => { state.create.username = event.target.value; } },
            })),
            inputField('显示名', h('input', {
              type: 'text', value: state.create.displayName,
              on: { input: (event) => { state.create.displayName = event.target.value; } },
            })),
            inputField('初始密码', h('input', {
              type: 'password', value: state.create.password, autocomplete: 'new-password',
              on: { input: (event) => { state.create.password = event.target.value; } },
            })),
            h('div', { class: 'field' }, h('label', {}, '角色'), createRole),
          ),
          state.create.role === 'venue_admin'
            ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, '场地授权'), h('div', { class: 'stack', style: { gap: '6px' } }, grantOptions()))
            : null,
          h('div', { class: 'field' },
            h('span', { class: 'field-label' }, '业务权限（可选）'),
            h('div', { class: 'stack', style: { gap: '6px' } },
              Object.entries(PERMISSION_LABEL).map(([key, label]) => h('label', { class: 'check' },
                h('input', {
                  type: 'checkbox', checked: !!state.create.permissions[key],
                  on: { change: (event) => { state.create.permissions[key] = event.target.checked; } },
                }),
                h('span', { class: 'text' }, label),
              )),
            ),
          ),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', on: { click: createUser } }, icon('plus'), '创建账号'),
          ),
        ),
      ),
    );
  }

  function renderRules() {
    const fields = [
      ['advanceDays', '提前预约天数', 1, 30],
      ['checkinGraceMin', '签到宽限（分钟）', 1, 240],
      ['awayMinutes', '允许暂离（分钟）', 1, 240],
      ['minMinutes', '单次最小时长（分钟）', 5, 480],
      ['dailyCount', '每日创建次数上限', 1, 20],
      ['dailyMinutes', '每日累计时长上限（分钟）', 5, 1440],
    ];
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, '新规则发布后立即用于新预约。'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '已发布版本')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, '生效时间'), h('th', {}, '提前天数'), h('th', {}, '签到宽限'), h('th', {}, '暂离'), h('th', {}, '最小时长'), h('th', {}, '每日次数/时长'), h('th', {}, '状态'))),
          h('tbody', {}, state.rules.map((r) => h('tr', {},
            h('td', {}, r.effectiveFromText),
            h('td', {}, `${r.advanceDays} 天`),
            h('td', {}, `${r.checkinGraceMin} 分钟`),
            h('td', {}, `${r.awayMinutes} 分钟`),
            h('td', {}, `${r.minMinutes} 分钟`),
            h('td', {}, `${r.dailyCount} 次 / ${r.dailyMinutes} 分钟`),
            h('td', {}, r.current ? plainBadge('当前生效', 'green') : plainBadge('历史版本', 'gray')),
          ))),
        )),
      ),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '发布新规则版本')),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid three' },
            fields.map(([key, label, min, max]) => inputField(label, h('input', {
              type: 'number', min, max, value: state.rule[key],
              on: { input: (event) => { state.rule[key] = Number(event.target.value); } },
            }))),
            h('div', { class: 'field span-2' }, h('label', {}, '备注'), h('input', {
              type: 'text', value: state.rule.note, placeholder: '例如：考试周调整签到宽限',
              on: { input: (event) => { state.rule.note = event.target.value; } },
            })),
          ),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', on: { click: async () => {
              try {
                const result = await api.post('/admin/rules', state.rule);
                toast('新规则已发布');
                await loadAll();
              } catch (error) { toast(error.message || '发布失败', 'error'); }
            } } }, '发布规则'),
          ),
        ),
      ),
    );
  }

  function renderAudit() {
    const rows = state.audits.filter((a) => !state.auditAction || a.action.includes(state.auditAction));
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('div', { class: 'field', style: { maxWidth: '280px' } }, h('label', {}, '动作筛选'), h('input', {
          type: 'search', value: state.auditAction, placeholder: '例如 violation / suspension',
          on: { change: (event) => { state.auditAction = event.target.value; renderAll(); } },
        })),
        h('span', { class: 'small muted', style: { paddingTop: '24px' } }, `显示 ${rows.length} 条`),
      ),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '操作人'), h('th', {}, '动作'), h('th', {}, '对象'), h('th', {}, '结果'), h('th', {}, '理由'), h('th', { class: 'actions-cell' }, '详情'))),
        h('tbody', {}, rows.map((a) => h('tr', {},
          h('td', {}, a.createdAtText),
          h('td', {}, a.actorName),
          h('td', { class: 'mono' }, a.action),
          h('td', {}, a.objectType || '—'),
          h('td', {}, a.result === 'success' ? plainBadge('成功', 'green') : plainBadge('失败', 'red')),
          h('td', { style: { maxWidth: '280px', whiteSpace: 'normal' } }, a.reason || '—'),
          h('td', { class: 'actions-cell' }, h('button', { class: 'btn sm', type: 'button', on: { click: () => {
            const dialog = openModal({
              title: '审计详情',
              body: h('div', { class: 'stack' },
                h('dl', { class: 'kv' },
                  h('dt', {}, '操作人'), h('dd', {}, a.actorName),
                  h('dt', {}, '动作'), h('dd', {}, a.action),
                  h('dt', {}, '对象类型'), h('dd', {}, a.objectType || '—'),
                  h('dt', {}, '时间'), h('dd', {}, a.createdAtText),
                  h('dt', {}, '理由'), h('dd', {}, a.reason || '—'),
                ),
              ),
              footer: [h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, '关闭')],
            });
          } } }, '查看')),
        ))),
      )),
    );
  }

  function notificationStatusLabel(status) {
    return status === 'sent' ? ['已送达', 'green'] : status === 'failed' ? ['投递失败', 'red'] : ['待发送', 'amber'];
  }

  function renderNotifications() {
    return h('div', { class: 'stack' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '接收者'), h('th', {}, '标题'), h('th', {}, '状态'), h('th', {}, '尝试'), h('th', {}, '时间'), h('th', {}, '错误'), h('th', { class: 'actions-cell' }, '操作'))),
        h('tbody', {}, state.notifications.map((n) => h('tr', {},
          h('td', {}, n.userName),
          h('td', { style: { maxWidth: '260px', whiteSpace: 'normal' } }, n.title),
          h('td', {}, plainBadge(...notificationStatusLabel(n.status))),
          h('td', {}, n.attempts),
          h('td', {}, n.createdAtText),
          h('td', { style: { maxWidth: '220px', whiteSpace: 'normal' } }, n.lastError || '—'),
          h('td', { class: 'actions-cell' },
            n.status === 'pending'
              ? h('button', { class: 'btn sm', type: 'button', on: { click: async () => {
                try {
                  await api.post(`/admin/notifications/${n.id}/inject-failure`, {});
                  await api.post('/admin/tick', {});
                  toast('已模拟一次投递失败');
                  await loadAll();
                } catch (error) { toast(error.message, 'error'); }
              } } }, '模拟失败')
              : null,
            n.status === 'failed'
              ? h('button', { class: 'btn sm primary', type: 'button', on: { click: async () => {
                try {
                  await api.post(`/admin/notifications/${n.id}/retry`, {});
                  await api.post('/admin/tick', {});
                  toast('已重试投递');
                  await loadAll();
                } catch (error) { toast(error.message, 'error'); }
              } } }, '重试')
              : null,
          ),
        ))),
      )),
    );
  }

  function renderClock() {
    const clock = state.clock;
    return h('div', { class: 'stack' },
      h('div', { class: 'notice warn' }, '调整时间会影响所有用户的预约和签到。演示结束后请同步北京时间。'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '业务时钟'), clock?.demoMode ? plainBadge('演示模式已启用', 'amber') : plainBadge('演示模式关闭', 'gray')),
        h('div', { class: 'card-body stack' },
          h('dl', { class: 'kv' },
            h('dt', {}, '当前业务时间'), h('dd', { class: 'strong' }, clock?.nowText || '—'),
            h('dt', {}, '时间偏移'), h('dd', {}, clock?.usingRealTime ? '与系统时间一致' : `${Math.round((clock?.offsetMs || 0) / 60000)} 分钟`),
          ),
          h('div', { class: 'form-grid' },
            inputField('设置为（北京时间）', h('input', {
              type: 'datetime-local', value: state.clockAt,
              on: { change: (event) => { state.clockAt = event.target.value; } },
            })),
            h('div', { class: 'field', style: { justifyContent: 'end' } },
              h('label', {}, '操作'),
              h('div', { class: 'row' },
                h('button', { class: 'btn primary', type: 'button', on: { click: async () => {
                  try {
                    const result = await api.post('/admin/demo/clock', { at: state.clockAt.replace('T', ' ') });
                    applyClock(result);
                    state.clock = result;
                    toast(`业务时间已设为 ${result.nowText}`);
                    await loadAll();
                  } catch (error) { toast(error.message, 'error'); }
                } } }, '应用演示时间'),
                h('button', { class: 'btn', type: 'button', on: { click: async () => {
                  try {
                    const result = await api.post('/admin/demo/clock', { at: 'now' });
                    applyClock(result);
                    state.clock = result;
                    toast('已同步北京时间');
                    await loadAll();
                  } catch (error) { toast(error.message, 'error'); }
                } } }, '同步北京时间'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '系统管理'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: loadAll } }, icon('refresh'), '刷新'),
        ),
      ),
      h('div', { class: 'subtabs', role: 'tablist' }, TABS.map(([value, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': state.tab === value ? 'true' : 'false',
        on: { click: () => { state.tab = value; renderAll(); } },
      }, label))),
      state.loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载系统数据…')))
        : state.error
          ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'notice danger' }, state.error)))
          : state.tab === 'users' ? renderUsers()
            : state.tab === 'rules' ? renderRules()
              : state.tab === 'audit' ? renderAudit()
                : state.tab === 'notifications' ? renderNotifications()
                  : renderClock(),
    );
  }

  renderAll();
  await loadAll();
  return () => { disposed = true; };
}
