import { setContent, roomText } from '../util.js';
import { api, ApiError } from '../api.js';
import { h, icon, toast, emptyState, plainBadge } from '../util.js';

const STATUS_TONE = { pending: 'blue', processing: 'amber', answered: 'green', closed: 'gray' };
const TABS = [
  ['all', '全部'],
  ['pending', '待受理'],
  ['processing', '处理中'],
  ['answered', '已答复'],
  ['closed', '已关闭'],
  ['site', '现场问题'],
];

export async function renderAdminComplaints(container, { navigate }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  const state = {
    complaints: [],
    rooms: [],
    roomId: '',
    tab: 'all',
    selectedId: null,
    detail: null,
    loading: true,
    reply: '',
    occupancyUnfounded: false,
    busy: false,
  };

  async function load() {
    state.loading = true;
    renderAll();
    try {
      const [data, rooms] = await Promise.all([
        api.get('/admin/complaints'),
        api.get('/admin/rooms'),
      ]);
      if (disposed) return;
      state.complaints = data.complaints;
      state.rooms = rooms.rooms;
      if (state.selectedId && !state.complaints.some((c) => c.id === state.selectedId)) {
        state.selectedId = null;
        state.detail = null;
      }
      if (state.selectedId) await loadDetail(state.selectedId);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载投诉失败', 'error');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  async function loadDetail(id) {
    try {
      state.detail = (await api.get(`/admin/complaints/${id}`)).complaint;
      state.selectedId = id;
      state.reply = '';
      state.occupancyUnfounded = false;
    } catch (error) {
      toast(error.message || '无法查看该投诉', 'error');
      state.detail = null;
      state.selectedId = null;
    }
  }

  async function accept() {
    if (!state.detail) return;
    state.busy = true;
    renderAll();
    try {
      const result = await api.post(`/admin/complaints/${state.detail.id}/accept`, {});
      state.detail = result.complaint;
      toast('已受理，投诉进入处理中');
      await load();
      await loadDetail(state.detail.id);
    } catch (error) {
      toast(error.message || '受理失败', 'error');
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  async function reply() {
    if (!state.detail) return;
    if (!state.reply.trim()) {
      toast('答复须填写处理结果、依据及必要纠正', 'warn');
      return;
    }
    state.busy = true;
    renderAll();
    try {
      const result = await api.post(`/admin/complaints/${state.detail.id}/reply`, {
        body: state.reply.trim(), occupancyUnfounded: state.occupancyUnfounded,
      });
      state.detail = result.complaint;
      state.reply = '';
      toast('答复已提交，学生将收到站内通知');
      await load();
      await loadDetail(state.detail.id);
    } catch (error) {
      toast(error.message || '答复失败', 'error');
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  function filtered() {
    return state.complaints.filter((c) => {
      if (state.roomId && c.roomId !== state.roomId) return false;
      if (state.tab === 'site') return c.isSite;
      if (state.tab !== 'all') return c.status === state.tab;
      return true;
    });
  }

  function renderList() {
    const rows = filtered();
    if (state.loading) return h('p', { class: 'muted' }, '正在加载…');
    if (!rows.length) return emptyState('没有符合条件的投诉', '切换筛选条件或场地后重试。');
    return h('div', { class: 'list' }, rows.map((c) => h('button', {
      type: 'button', class: 'record', style: {
        textAlign: 'left', cursor: 'pointer',
        borderColor: state.selectedId === c.id ? '#b9ccff' : null,
        background: state.selectedId === c.id ? '#f8faff' : '#fff',
      },
      on: { click: async () => { await loadDetail(c.id); renderAll(); } },
    },
    h('div', { class: 'record-top' },
      h('div', { class: 'record-title' },
        h('strong', {}, `${c.roomName} · ${c.typeLabel}`),
        h('span', { class: `badge ${STATUS_TONE[c.status] || 'gray'}` }, c.statusLabel),
        c.isSite ? plainBadge('现场问题', 'cyan') : null,
        c.seatCode ? plainBadge(`座位 ${c.seatCode}`, 'gray') : null,
      ),
      h('span', { class: 'record-sub' }, c.createdAtText),
    ),
    h('div', { class: 'record-sub' }, `${c.roomName} · ${c.typeLabel} · ${c.userName}`),
    h('div', { class: 'record-sub' }, c.description.length > 70 ? `${c.description.slice(0, 70)}…` : c.description),
    )));
  }

  function renderDetail() {
    if (!state.detail) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState('选择一条投诉', '查看原始说明、处理记录并受理或答复。被投诉人不能处理本人相关投诉。')));
    }
    const c = state.detail;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '投诉详情'),
          h('p', { class: 'card-sub' }, `${c.roomName} · ${c.typeLabel} · ${c.createdAtText} · ${c.userName}`),
        ),
        h('span', { class: `badge ${STATUS_TONE[c.status] || 'gray'}` }, c.statusLabel),
      ),
      h('div', { class: 'card-body stack' },
        h('dl', { class: 'kv' },
          h('dt', {}, '提交时间'), h('dd', {}, c.createdAtText),
          h('dt', {}, '处理人'), h('dd', {}, c.assigneeName || '尚未受理'),
          c.isSite ? h('dt', {}, '现场座位') : null,
          c.isSite ? h('dd', {}, c.seatCode || '—') : null,
          c.reservation ? h('dt', {}, '关联预约') : null,
          c.reservation ? h('dd', {}, `${c.reservation.seatCode} 座位 · ${c.reservation.startText}—${c.reservation.endText}`) : null,
          c.violationId ? h('dt', {}, '关联违规') : null,
          c.violationId ? h('dd', {}, '已关联本人违规记录') : null,
          c.accusedName ? h('dt', {}, '回避') : null,
          c.accusedName ? h('dd', {}, `${c.accusedName} 不能处理本投诉`) : null,
        ),
        h('div', { class: 'notice' }, c.description),
        h('div', {},
          h('h3', { style: { marginBottom: '10px' } }, '处理记录'),
          h('ul', { class: 'timeline' }, c.events.map((event) => h('li', { class: event.kind === 'reply' ? 'tone-success' : '' },
            h('div', { class: 'strong' }, `${event.authorName} · ${event.kind === 'submit' ? '提交' : event.kind === 'accept' ? '受理' : event.kind === 'reply' ? '答复' : event.kind === 'supplement' ? '补充材料' : '关闭'}`),
            h('div', { style: { whiteSpace: 'pre-wrap' } }, event.body),
            h('div', { class: 't' }, event.createdAtText),
          ))),
        ),
        c.status === 'pending'
          ? h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', disabled: state.busy, on: { click: accept } }, '受理投诉'),
          )
          : null,
        c.status === 'processing'
          ? h('div', { class: 'stack' },
            h('div', { class: 'field' },
              h('label', {}, '答复及依据'),
              h('textarea', {
                rows: 4, maxlength: 2000, value: state.reply,
                placeholder: '填写核实结果、处理依据和必要的纠正措施。',
                on: { input: (event) => { state.reply = event.target.value; } },
              }),
            ),
            c.isOccupancy ? h('label', { class: 'check' },
              h('input', {
                type: 'checkbox', checked: state.occupancyUnfounded, disabled: state.busy,
                on: { change: (event) => { state.occupancyUnfounded = event.target.checked; } },
              }),
              h('span', { class: 'text' }, '核实占座不属实，结束签到保护'),
            ) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', type: 'button', disabled: state.busy, on: { click: reply } }, state.busy ? '提交中…' : '提交答复'),
              h('span', { class: 'tiny muted' }, '提交后学生可在已答复状态下补充材料或确认关闭。'),
            ),
          )
          : null,
        c.status === 'answered'
          ? h('div', { class: 'notice success' }, '已答复，等待学生补充材料或确认关闭。')
          : null,
        c.status === 'closed'
          ? h('div', { class: 'notice' }, '该投诉已由学生确认关闭；原记录与答复保留。')
          : null,
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    const roomsOptions = h('select', {
      on: { change: (event) => { state.roomId = event.target.value; renderAll(); } },
    }, h('option', { value: '' }, '全部授权场地'), state.rooms.map((room) => h('option', { value: room.id, selected: room.id === state.roomId }, roomText(room))));
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '投诉处理'),
          h('p', {}, '投诉与现场问题共用待受理 → 处理中 → 已答复 → 已关闭流程；处理人须回避本人相关投诉。'),
        ),
        h('div', { class: 'head-actions' },
          roomsOptions,
          h('button', { class: 'btn sm', type: 'button', on: { click: load } }, icon('refresh'), '刷新'),
        ),
      ),
      h('div', { class: 'subtabs', role: 'tablist' }, TABS.map(([value, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': state.tab === value ? 'true' : 'false',
        on: { click: () => { state.tab = value; renderAll(); } },
      }, label))),
      h('div', { class: 'split equal' },
        h('div', { class: 'stack' },
          h('div', { class: 'row between' },
            h('h2', {}, `投诉列表（${filtered().length}）`),
            h('span', { class: 'small muted' }, '按状态与场地筛选'),
          ),
          renderList(),
        ),
        renderDetail(),
      ),
    );
  }

  renderAll();
  await load();
  if (!state.selectedId && state.complaints.length) {
    await loadDetail(state.complaints[0].id);
    renderAll();
  }
  return () => { disposed = true; };
}
