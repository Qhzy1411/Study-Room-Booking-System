import { setContent, roomText } from '../util.js';
import { api, ApiError, qs } from '../api.js';
import { store, beijingDate, beijingTime, now } from '../state.js';
import {
  h, icon, toast, emptyState, plainBadge, promptDialog, debounce,
} from '../util.js';

const TABS = [
  ['pending', '待复核'],
  ['effective', '已生效'],
  ['all', '全部记录'],
  ['manual', '手动登记'],
  ['faults', '故障登记'],
  ['limits', '预约限制'],
];

const VIOLATION_TONE = { pending: 'amber', effective: 'red', revoked: 'gray' };
const timeInput = (ts) => `${beijingDate(ts)}T${beijingTime(ts)}`;

export async function renderAdminReview(container, { navigate }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  const state = {
    tab: 'pending',
    violations: [],
    limits: [],
    faults: [],
    loading: true,
    roomId: store.user.grants[0] || '',
    rooms: [],
    student: null,
    manual: {
      occurredAt: timeInput(now() - 30 * 60 * 1000),
      type: '现场事件',
      material: '',
      reservationId: '',
    },
    fault: {
      startAt: timeInput(now() - 2 * 3600 * 1000),
      endAt: timeInput(now() - 3600 * 1000),
      description: '',
      function: 'checkin',
    },
    limit: {
      startAt: timeInput(now()),
      endAt: timeInput(now() + 24 * 3600 * 1000),
      reason: '',
      violationIds: new Set(),
    },
  };

  async function load() {
    state.loading = true;
    renderAll();
    try {
      const [v, l, f, rooms] = await Promise.all([
        api.get('/admin/violations'),
        api.get('/admin/limits'),
        api.get('/admin/faults'),
        api.get('/admin/rooms'),
      ]);
      if (disposed) return;
      state.violations = v.violations;
      state.limits = l.limits;
      state.faults = f.faults;
      state.rooms = rooms.rooms;
      if (!state.rooms.some((r) => r.id === state.roomId)) state.roomId = state.rooms[0]?.id || '';
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载失败', 'error');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function roomLabel(roomId) {
    const room = state.rooms.find((r) => r.id === roomId);
    return room ? roomText(room) : roomId;
  }

  function roomSelect() {
    return h('select', {
      on: { change: (event) => { state.roomId = event.target.value; } },
    }, state.rooms.map((room) => h('option', { value: room.id, selected: room.id === state.roomId }, roomLabel(room.id))));
  }

  async function decide(violation, decision) {
    const reason = await promptDialog({
      title: decision === 'effective' ? `确认违规生效 · ${violation.userName} · ${violation.occurredAtText}` : `撤销记录 · ${violation.userName} · ${violation.occurredAtText}`,
      label: decision === 'effective' ? '复核理由与依据' : '撤销理由',
      message: decision === 'effective'
        ? '请核对事件时间、规则版本和证据。生效记录可作为预约限制依据；待复核记录本身不是处罚。'
        : '撤销后不计入有效违规；如限制仅依据该记录设置，将同步解除。历史保留。',
      required: true,
      multiline: true,
    });
    if (!reason) return;
    try {
      const result = await api.post(`/admin/violations/${violation.id}/decide`, { decision, reason });
      toast(decision === 'effective' ? '记录已生效' : `记录已撤销${result.revokedLimits?.length ? '，关联限制已解除' : ''}`);
      await load();
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    }
  }

  async function revokeEffective(violation) {
    const reason = await promptDialog({
      title: `撤销生效记录 · ${violation.userName} · ${violation.occurredAtText}`,
      label: '撤销理由与依据',
      message: '用于申诉成立、故障更正等情况。撤销后同步纠正仅依据该记录的预约限制。',
      required: true,
      multiline: true,
    });
    if (!reason) return;
    try {
      const result = await api.post(`/admin/violations/${violation.id}/revoke`, { reason });
      toast(`记录已撤销${result.revokedLimits?.length ? `，解除限制 ${result.revokedLimits.join('、')}` : ''}`);
      await load();
    } catch (error) {
      toast(error.message || '撤销失败', 'error');
    }
  }

  async function submitManual() {
    if (!state.student) {
      toast('请先查找并选择被登记的学生', 'warn');
      return;
    }
    if (!state.manual.material.trim()) {
      toast('须填写现场事实、时间、地点与证据说明', 'warn');
      return;
    }
    if (!state.roomId) {
      toast('没有可用的场地授权', 'warn');
      return;
    }
    try {
      const result = await api.post('/admin/violations', {
        roomId: state.roomId,
        userId: state.student.id,
        occurredAt: state.manual.occurredAt.replace('T', ' '),
        type: state.manual.type,
        material: state.manual.material.trim(),
        reservationId: state.manual.reservationId?.trim() || null,
      });
      toast(result.duplicated ? '相同事件已登记，返回原记录' : '待复核事件已登记');
      state.manual.material = '';
      state.manual.reservationId = '';
      await load();
      state.tab = 'pending';
      renderAll();
    } catch (error) {
      toast(error.message || '登记失败', 'error');
    }
  }

  async function submitFault() {
    if (!state.roomId) return;
    if (!state.fault.description.trim()) {
      toast('请填写故障影响与核实说明', 'warn');
      return;
    }
    try {
      const result = await api.post('/admin/faults', {
        roomId: state.roomId,
        function: state.fault.function,
        startAt: state.fault.startAt.replace('T', ' '),
        endAt: state.fault.endAt.replace('T', ' '),
        description: state.fault.description.trim(),
      });
      toast(result.revokedViolations?.length
        ? `故障已登记，自动撤销 ${result.revokedViolations.length} 条未签到记录`
        : '故障已登记；该区间暂无需要纠正的未签到记录');
      state.fault.description = '';
      await load();
    } catch (error) {
      toast(error.message || '登记失败', 'error');
    }
  }

  function effectiveViolationsFor(studentId) {
    return state.violations.filter((v) => v.status === 'effective' && v.userId === studentId);
  }

  async function submitLimit() {
    if (!state.student) {
      toast('请先选择学生', 'warn');
      return;
    }
    if (!state.roomId) {
      toast('请选择限制适用的场地', 'warn');
      return;
    }
    if (!state.limit.reason.trim()) {
      toast('请填写限制理由', 'warn');
      return;
    }
    if (!state.limit.violationIds.size) {
      toast('预约限制必须至少关联一条已生效违规记录', 'warn');
      return;
    }
    try {
      const result = await api.post('/admin/limits', {
        userId: state.student.id,
        roomScope: state.roomId,
        startAt: state.limit.startAt.replace('T', ' '),
        endAt: state.limit.endAt.replace('T', ' '),
        reason: state.limit.reason.trim(),
        violationIds: [...state.limit.violationIds],
      });
      toast('预约限制已创建');
      state.limit.reason = '';
      state.limit.violationIds = new Set();
      await load();
    } catch (error) {
      toast(error.message || '创建失败', 'error');
    }
  }

  function studentPicker() {
    const resultsBox = h('div', { class: 'stack', style: { gap: '6px' } });
    const input = h('input', {
      type: 'search', placeholder: '输入学号、账号或姓名，例如 U01',
      on: {
        input: debounce(async (event) => {
          const keyword = event.target.value.trim();
          if (!keyword) {
            resultsBox.replaceChildren();
            return;
          }
          try {
            const data = await api.get(`/admin/students${qs({ q: keyword })}`);
            resultsBox.replaceChildren(...data.students.map((student) => h('button', {
              type: 'button', class: 'btn sm', style: { justifyContent: 'flex-start' },
              on: {
                click: () => {
                  state.student = student;
                  state.limit.violationIds = new Set();
                  renderAll();
                },
              },
            }, `${student.displayName}（${student.username}）`)));
            if (!data.students.length) resultsBox.replaceChildren(h('p', { class: 'small muted' }, '未找到匹配的学生'));
          } catch {
            resultsBox.replaceChildren(h('p', { class: 'small danger-text' }, '查找失败'));
          }
        }, 300),
      },
    });
    return h('div', { class: 'field' },
      h('label', {}, '被登记学生'),
      state.student
        ? h('div', { class: 'row' },
          plainBadge(`${state.student.displayName}（${state.student.username}）`, 'blue'),
          h('button', { class: 'link-btn', type: 'button', on: { click: () => { state.student = null; state.limit.violationIds = new Set(); renderAll(); } } }, '清除'),
        )
        : input,
      state.student ? null : resultsBox,
      h('p', { class: 'field-hint' }, '只可按授权场地登记事实；系统不自动认定违规，需经复核后才生效。'),
    );
  }

  function violationCard(v) {
    return h('article', { class: 'record' },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, `${v.userName} · ${v.type === 'no_show' ? '未按时签到' : '现场事件'}`),
          plainBadge(v.status === 'pending' ? '待复核' : v.status === 'effective' ? '已生效' : '已撤销', VIOLATION_TONE[v.status]),
          plainBadge(v.type === 'no_show' ? '未按时签到' : '现场事件', 'gray'),
        ),
        h('span', { class: 'record-sub' }, v.occurredAtText),
      ),
      h('div', { class: 'meta' },
        h('span', {}, `学生 ${v.userName}（${v.userId}）`),
        h('span', {}, `场地 ${v.roomName}`),
        v.reservation ? h('span', {}, `预约时段 ${v.reservation.startText}—${v.reservation.endText}`) : null,
      ),
      h('div', { class: 'record-note' }, v.material || '—'),
      v.decisionReason ? h('div', { class: 'record-sub' }, `复核：${v.decisionReason}`) : null,
      v.revokeReason ? h('div', { class: 'record-sub' }, `撤销：${v.revokeReason}`) : null,
      v.limits?.length ? h('div', { class: 'record-sub' }, `作为限制依据：${v.limits.map((l) => `${l.start}—${l.end}`).join('、')}`) : null,
      h('div', { class: 'record-actions' },
        v.status === 'pending'
          ? [
            h('button', { class: 'btn sm primary', type: 'button', on: { click: () => decide(v, 'effective') } }, '核对并确认生效'),
            h('button', { class: 'btn sm danger', type: 'button', on: { click: () => decide(v, 'revoked') } }, '撤销（不成立）'),
          ]
          : null,
        v.status === 'effective'
          ? h('button', { class: 'btn sm danger', type: 'button', on: { click: () => revokeEffective(v) } }, '撤销生效记录')
          : null,
        v.status === 'pending'
          ? h('span', { class: 'small muted' }, '不能直接据此加黑名单')
          : null,
      ),
    );
  }

  function limitCard(l) {
    const active = l.active;
    const revoked = !!l.revokedAt;
    return h('article', { class: 'record' },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, `${l.roomName} · 预约限制`),
          plainBadge(revoked ? '已解除' : active ? '生效中' : '未生效/已过期', revoked ? 'gray' : active ? 'red' : 'amber'),
          plainBadge(l.roomName, 'gray'),
        ),
        h('span', { class: 'record-sub' }, `${l.startText} — ${l.endText}`),
      ),
      h('div', { class: 'record-note' }, l.reason),
      h('div', { class: 'record-sub' }, `依据：${l.basis.map((b) => `${b.occurredAtText}（${b.status === 'revoked' ? '已撤销' : '已生效'}）`).join('、')}`),
      l.revokedAt ? h('div', { class: 'record-sub' }, `解除：${l.revokeReason}`) : null,
      h('div', { class: 'record-actions' },
        !revoked
          ? h('button', { class: 'btn sm danger', type: 'button', on: { click: async () => {
            const reason = await promptDialog({ title: '解除预约限制', label: '解除理由', required: true, multiline: true });
            if (!reason) return;
            try { await api.post(`/admin/limits/${l.id}/revoke`, { reason }); toast('限制已解除'); await load(); } catch (err) { toast(err.message, 'error'); }
          } } }, '解除限制')
          : null,
      ),
    );
  }

  function renderPendingTab(status) {
    const rows = status === 'all' ? state.violations : state.violations.filter((v) => v.status === status);
    return rows.length
      ? h('div', { class: 'list' }, rows.map(violationCard))
      : h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState(status === 'pending' ? '没有待复核记录' : '没有相关记录', status === 'pending' ? '到期未签到与现场登记会先进入待复核。' : '')));
  }

  function renderManualTab() {
    const type = h('select', {
      on: { change: (event) => { state.manual.type = event.target.value; } },
    }, ['现场事件', '占用他人座位', '违反安静规定', '其他'].map((t) => h('option', { value: t, selected: state.manual.type === t }, t)));
    const material = h('textarea', {
      rows: 4, maxlength: 1000,
      on: { input: (event) => { state.manual.material = event.target.value; } },
    }, state.manual.material);
    const occurred = h('input', {
      type: 'datetime-local', value: state.manual.occurredAt,
      on: { change: (event) => { state.manual.occurredAt = event.target.value; } },
    });
    const reservationId = h('input', {
      type: 'text', maxlength: 40, placeholder: '选填，例如 RSV-20261126-0001',
      value: state.manual.reservationId,
      on: { input: (event) => { state.manual.reservationId = event.target.value; } },
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, '手动登记只形成待复核事件；须记录事实、时间、地点和证据，不能直接形成处罚或黑名单。重复事件按自然键去重。'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '登记待复核事件')),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', {}, '场地'), roomSelect()),
            studentPicker(),
            h('div', { class: 'field' }, h('label', {}, '事件时间'), occurred),
            h('div', { class: 'field' }, h('label', {}, '事件类型'), type),
            h('div', { class: 'field span-2' }, h('label', {}, '关联预约编号（选填）'), reservationId),
            h('div', { class: 'field span-2' }, h('label', {}, '事实与证据说明'), material),
          ),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', on: { click: submitManual } }, '登记待复核事件'),
            h('span', { class: 'tiny muted' }, '缺少学生、事实或场地信息时拒绝登记。'),
          ),
        ),
      ),
    );
  }

  function renderFaultsTab() {
    const start = h('input', { type: 'datetime-local', value: state.fault.startAt, on: { change: (event) => { state.fault.startAt = event.target.value; } } });
    const end = h('input', { type: 'datetime-local', value: state.fault.endAt, on: { change: (event) => { state.fault.endAt = event.target.value; } } });
    const description = h('textarea', {
      rows: 3, placeholder: '例如：签到服务中断，影响该时段的扫码签到。',
      on: { input: (event) => { state.fault.description = event.target.value; } },
    }, state.fault.description);
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, '登记签到故障后，截止落在故障区间内的未签到记录将自动撤销。'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '故障登记与纠正')),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', {}, '场地'), roomSelect()),
            h('div', { class: 'field' }, h('label', {}, '影响功能'), h('select', {
              on: { change: (event) => { state.fault.function = event.target.value; } },
            }, h('option', { value: 'checkin', selected: state.fault.function === 'checkin' }, '签到功能'), h('option', { value: 'booking', selected: state.fault.function === 'booking' }, '预约功能'))),
            h('div', { class: 'field' }, h('label', {}, '故障开始'), start),
            h('div', { class: 'field' }, h('label', {}, '故障结束'), end),
            h('div', { class: 'field span-2' }, h('label', {}, '核实说明'), description),
          ),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: submitFault } }, '登记已核实故障')),
        ),
      ),
      state.faults.length
        ? h('div', { class: 'list' }, state.faults.map((f) => h('article', { class: 'record' },
          h('div', { class: 'record-top' },
            h('div', { class: 'record-title' }, h('strong', {}, f.function === 'checkin' ? '签到故障' : '预约故障'), plainBadge(f.roomName, 'gray')),
            h('span', { class: 'record-sub' }, `${f.startText} — ${f.endText}`),
          ),
          h('div', { class: 'record-note' }, f.description),
          h('div', { class: 'record-sub' }, `受影响未签到记录：${f.impactedViolations.length ? f.impactedViolations.map((v) => `${v.occurredAtText}（${v.status}）`).join('、') : '无'}`),
        )))
        : null,
    );
  }

  function renderLimitsTab() {
    const effective = state.student ? effectiveViolationsFor(state.student.id) : [];
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, '预约限制须以至少一条已生效违规为依据，写明场地范围、起止与理由；过期自动失效，可提前解除。限制只阻止新预约，不影响取消、签退、查询与申诉。'),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '创建预约限制')),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', {}, '限制场地'), roomSelect()),
            studentPicker(),
            h('div', { class: 'field' }, h('label', {}, '开始时间'), h('input', {
              type: 'datetime-local', value: state.limit.startAt,
              on: { change: (event) => { state.limit.startAt = event.target.value; } },
            })),
            h('div', { class: 'field' }, h('label', {}, '结束时间'), h('input', {
              type: 'datetime-local', value: state.limit.endAt,
              on: { change: (event) => { state.limit.endAt = event.target.value; } },
            })),
            h('div', { class: 'field span-2' }, h('label', {}, '限制理由'), h('input', {
              type: 'text', maxlength: 300, value: state.limit.reason,
              on: { input: (event) => { state.limit.reason = event.target.value; } },
            })),
            h('div', { class: 'field span-2' },
              h('label', {}, '依据（已生效违规）'),
              state.student
                ? (effective.length
                  ? h('div', { class: 'list', style: { gap: '6px' } }, effective.map((v) => h('label', { class: 'check' },
                    h('input', {
                      type: 'checkbox', checked: state.limit.violationIds.has(v.id),
                      on: { change: (event) => {
                        if (event.target.checked) state.limit.violationIds.add(v.id);
                        else state.limit.violationIds.delete(v.id);
                      } },
                    }),
                    h('span', { class: 'text' }, `${v.occurredAtText} · ${v.roomName} · ${v.type === 'no_show' ? '未按时签到' : '现场事件'}`),
                  )))
                  : h('p', { class: 'small muted' }, '该学生暂无可作为依据的已生效违规记录。'))
                : h('p', { class: 'small muted' }, '请先查找并选择学生。'),
            ),
          ),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', on: { click: submitLimit } }, '创建预约限制'),
          ),
        ),
      ),
      state.limits.length
        ? h('div', { class: 'list' }, state.limits.map(limitCard))
        : h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState('暂无预约限制', '限制需由授权管理员依据已生效违规创建。'))),
    );
  }

  const counts = {
    pending: state.violations.filter((v) => v.status === 'pending').length,
    effective: state.violations.filter((v) => v.status === 'effective').length,
    all: state.violations.length,
  };

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '违约与限制'),
          h('p', {}, '待复核事件需核对事实与规则后才生效；限制必须写明依据、范围和期限。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: load } }, icon('refresh'), '刷新'),
        ),
      ),
      h('div', { class: 'subtabs', role: 'tablist' },
        TABS.map(([value, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': state.tab === value ? 'true' : 'false',
          on: { click: () => { state.tab = value; renderAll(); } },
        }, value === 'pending' ? `${label}（${counts.pending}）` : value === 'effective' ? `${label}（${counts.effective}）` : label)),
      ),
      state.loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载…')))
        : state.tab === 'manual' ? renderManualTab()
          : state.tab === 'faults' ? renderFaultsTab()
            : state.tab === 'limits' ? renderLimitsTab()
              : renderPendingTab(state.tab),
    );
  }

  renderAll();
  await load();
  return () => { disposed = true; };
}