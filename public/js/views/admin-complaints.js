import { setContent, roomText } from '../util.js';
import { api, ApiError } from '../api.js';
import { h, icon, toast, emptyState, plainBadge, inputField, timeRangeText } from '../util.js';

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
      toast('投诉已受理');
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
      toast('答复已提交');
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
    if (!rows.length) return emptyState('没有符合条件的投诉');
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
        emptyState('请选择一条投诉')));
    }
    const c = state.detail;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '投诉详情'),
          h('p', { class: 'card-sub' }, `${c.roomName} · ${c.typeLabel} · ${c.userName}`),
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
          c.reservation ? h('dd', {}, `${c.reservation.seatCode} 座位 · ${timeRangeText(c.reservation.startText, c.reservation.endText)}`) : null,
          c.violationId ? h('dt', {}, '关联违规') : null,
          c.violationId ? h('dd', {}, c.violationId) : null,
          c.accusedName ? h('dt', {}, '回避') : null,
          c.accusedName ? h('dd', {}, `${c.accusedName} 不能处理本投诉`) : null,
        ),
        h('div', { class: 'notice', style: { whiteSpace: 'pre-wrap' } }, c.description),
        h('div', {},
          h('h3', { style: { marginBottom: '10px' } }, '处理记录'),
          h('ul', { class: 'timeline' }, c.events.map((event) => h('li', { class: event.kind === 'reply' ? 'tone-success' : '' },
            h('div', { class: 'strong' }, `${event.authorName} · ${event.kind === 'submit' ? '提交' : event.kind === 'accept' ? '受理' : event.kind === 'reply' ? '答复' : event.kind === 'supplement' ? '补充材料' : '关闭'}`),
            event.kind !== 'submit' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, event.body) : null,
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
            inputField('答复及依据', h('textarea', {
              rows: 4, maxlength: 2000, value: state.reply,
              placeholder: '填写核实结果、处理依据和必要的纠正措施。',
              on: { input: (event) => { state.reply = event.target.value; } },
            })),
            c.isOccupancy ? h('label', { class: 'check' },
              h('input', {
                type: 'checkbox', checked: state.occupancyUnfounded, disabled: state.busy,
                on: { change: (event) => { state.occupancyUnfounded = event.target.checked; } },
              }),
              h('span', { class: 'text' }, '核实占座不属实，结束签到保护'),
            ) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', type: 'button', disabled: state.busy, on: { click: reply } }, state.busy ? '提交中…' : '提交答复'),
            ),
          )
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
