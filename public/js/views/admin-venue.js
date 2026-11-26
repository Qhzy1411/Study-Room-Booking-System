import { setContent, roomText } from '../util.js';
import { api, ApiError, newKey, qs } from '../api.js';
import { beijingDate, beijingTime, now } from '../state.js';
import {
  h, icon, toast, emptyState, openModal, confirmDialog, promptDialog,
  plainBadge, statusBadge, section,
} from '../util.js';

const TABS = [
  ['seats', '座位与设施'],
  ['plans', '开放计划'],
  ['suspension', '停用管理'],
  ['qr', '桌面二维码'],
  ['live', '现场预约'],
  ['reviews', '评价管理'],
];

const timeInput = (ts) => `${beijingDate(ts)}T${beijingTime(ts)}`;

export async function renderAdminVenue(container, { navigate }) {
  function newSuspensionForm() {
    return { seatId: '', immediate: true, startAt: '', endAt: '', reason: '' };
  }
  const state = {
    rooms: [],
    roomId: null,
    tab: 'seats',
    detail: null,
    loading: true,
    planMonth: '',
    liveDate: '',
    liveRows: null,
    qrSheet: null,
    reviews: null,
    preview: null,
    cleared: false,
    includeExpired: false,
    form: newSuspensionForm(),
  };
  let previewSequence = 0;
  function invalidatePreview() {
    previewSequence++;
    state.preview = null;
    state.cleared = false;
  }

  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  state.liveDate = beijingDate();
  state.planMonth = state.liveDate.slice(0, 7);

  async function loadRooms() {
    try {
      const data = await api.get('/admin/rooms');
      state.rooms = data.rooms;
      if (!state.rooms.some((r) => r.id === state.roomId)) state.roomId = state.rooms[0]?.id || null;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载场地失败', 'error');
    }
  }

  let detailRequest = 0;
  let panelRequest = 0;
  let panelError = '';
  async function loadDetail() {
    const request = ++detailRequest;
    invalidatePreview();
    panelRequest++;
    panelError = '';
    if (!state.roomId) {
      state.detail = null;
      state.loading = false;
      renderAll();
      return;
    }
    state.loading = true;
    renderAll();
    try {
      const detail = await api.get(`/admin/rooms/${state.roomId}${qs({ planMonth: state.planMonth })}`);
      if (disposed || request !== detailRequest) return;
      state.detail = detail;
      if (state.detail.seats?.length && !state.form.seatId) state.form.seatId = state.detail.seats[0].id;
      if (!state.form.startAt) state.form.startAt = timeInput(now());
      if (!state.form.endAt) state.form.endAt = timeInput(now() + 2 * 3600 * 1000);
    } catch (error) {
      if (disposed || request !== detailRequest) return;
      toast(error instanceof ApiError ? error.message : '加载场地详情失败', 'error');
      state.detail = null;
    }
    state.loading = false;
    await loadActivePanel();
  }

  async function loadActivePanel() {
    const request = ++panelRequest;
    const roomId = state.roomId;
    panelError = '';
    const panels = {
      live: ['liveRows', () => api.get(`/admin/reservations${qs({ roomId, date: state.liveDate })}`).then(data => data.reservations)],
      qr: ['qrSheet', () => api.get(`/admin/rooms/${roomId}/qr-sheet`)],
      reviews: ['reviews', () => api.get(`/admin/evaluations${qs({ roomId })}`).then(data => data.evaluations)],
    };
    const panel = panels[state.tab];
    if (!panel || !state.detail || state.loading) {
      renderAll();
      return;
    }
    const [field, fetchData] = panel;
    state[field] = null;
    renderAll();
    try {
      const value = await fetchData();
      if (disposed || request !== panelRequest) return;
      state[field] = value;
    } catch (error) {
      if (disposed || request !== panelRequest) return;
      panelError = error.message || '场地数据加载失败';
    }
    renderAll();
  }

  function switchRoom(roomId) {
    state.roomId = roomId;
    state.detail = null;
    state.liveRows = null;
    state.qrSheet = null;
    state.reviews = null;
    state.form = newSuspensionForm();
    loadDetail();
  }

  function setTab(tab) {
    if (state.tab !== tab) invalidatePreview();
    state.tab = tab;
    loadActivePanel();
  }

  function facilityDialog(seat) {
    let status = seat.power.status === 'faulty' ? 'faulty' : 'normal';
    const select = h('select', {
      on: { change: (event) => { status = event.target.value; } },
    },
    h('option', { value: 'normal', selected: status === 'normal' }, '正常'),
    h('option', { value: 'faulty', selected: status === 'faulty' }, '故障'),
    );
    const note = h('textarea', { rows: 3, maxlength: 300, placeholder: '填写现场核实时间、现象或维修结果。' });
    const error = h('p', { style: { color: 'var(--danger)', fontSize: '13px' } });
    const save = h('button', { class: 'btn primary', type: 'button' }, '保存核实结果');
    save.addEventListener('click', async () => {
      if (!note.value.trim()) {
        error.textContent = '须填写现场核实或维修说明';
        return;
      }
      save.disabled = true;
      try {
        await api.patch(`/admin/seats/${seat.id}/facility`, { status, note: note.value.trim() });
        toast(`${seat.code} 设施状态已更新，筛选与推荐将同步变化`);
        dialog.close();
        await loadDetail();
      } catch (err) {
        error.textContent = err.message || '保存失败';
        save.disabled = false;
      }
    });
    const dialog = openModal({
      title: `设施核实 · ${seat.code}`,
      body: h('div', { class: 'stack' },
        h('div', { class: 'notice' }, '设施修复只更新设施状态，不自动撤销另行设置的停用安排。'),
        h('div', { class: 'field' }, h('label', {}, '插座状态'), select),
        h('div', { class: 'field' }, h('label', {}, '核实说明'), note),
        error,
      ),
      footer: [h('button', { class: 'btn ghost', type: 'button', on: { click: () => dialog.close() } }, '取消'), save],
    });
  }

  async function archiveSeat(seat) {
    const archived = !seat.archived;
    const reason = await promptDialog({
      title: archived ? `归档座位 ${seat.code}` : `恢复座位 ${seat.code}`,
      label: '操作理由',
      message: archived ? '归档保留历史引用，不硬删除；仍有未结束预约时系统会拒绝。' : '恢复后重新参与座位查询与推荐。',
      required: true,
      multiline: true,
    });
    if (!reason) return;
    try {
      await api.patch(`/admin/seats/${seat.id}`, { archived, reason });
      toast(archived ? '座位已归档' : '座位已恢复');
      await loadDetail();
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    }
  }

  function renderSeats() {
    const seats = state.detail.seats;
    return h('div', { class: 'stack' },
      section('座位与设施', '设施状态变化同步影响预约筛选与推荐；座位有历史引用时只归档、不删除。'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', {}, '座位'), h('th', {}, '插座'), h('th', {}, '当前占用'), h('th', {}, '未来预约'), h('th', {}, '状态'), h('th', { class: 'actions-cell' }, '操作'),
        )),
        h('tbody', {}, seats.map((seat) => h('tr', {},
          h('td', {}, h('strong', {}, seat.code), seat.nearWindow ? h('span', { class: 'small muted' }, ' · 靠窗') : null),
          h('td', {},
            plainBadge(seat.power.status === 'faulty' ? '故障' : '正常', seat.power.status === 'faulty' ? 'red' : 'green'),
            h('div', { class: 'tiny muted' }, seat.power.note || ''),
          ),
          h('td', {}, seat.current
            ? h('div', { class: 'stack', style: { gap: '2px' } },
              statusBadge(seat.current.status),
              h('span', { class: 'tiny muted' }, `${seat.current.startText}—${seat.current.endText}`))
            : h('span', { class: 'muted' }, '空闲')),
          h('td', {}, seat.upcomingCount ? `${seat.upcomingCount} 条` : '—'),
          h('td', {}, seat.archived ? plainBadge('已归档', 'gray') : plainBadge('启用', 'green')),
          h('td', { class: 'actions-cell' },
            h('button', { class: 'btn sm', type: 'button', on: { click: () => facilityDialog(seat) } }, '核实设施'),
            h('button', { class: 'btn sm ghost', type: 'button', on: { click: () => archiveSeat(seat) } }, seat.archived ? '恢复座位' : '归档座位'),
          ),
        ))),
      )),
      h('p', { class: 'tiny muted' }, '提示：设备故障导致座位不可继续使用时，请改用“停用管理”，先预览受影响预约再处置。'),
    );
  }

  function renderPlans() {
    const plans = state.detail.plans || [];
    const roomId = state.roomId;
    const from = h('input', { type: 'date', value: beijingDate() });
    const to = h('input', { type: 'date', value: beijingDate() });
    const start = h('input', { type: 'time', step: 900, value: '08:00' });
    const end = h('input', { type: 'time', step: 900, value: '22:00' });
    const note = h('input', { type: 'text', maxlength: 120, placeholder: '例如：学期常规开放 / 考试周延长' });
    const error = h('p', { style: { color: 'var(--danger)', fontSize: '13px' } });
    const submit = h('button', { class: 'btn primary', type: 'button' }, '发布开放计划');
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      error.textContent = '';
      try {
        const dateFrom = from.value;
        const result = await api.post(`/admin/rooms/${roomId}/plans`, {
          dateFrom, dateTo: to.value, start: start.value, end: end.value, note: note.value,
        });
        if (disposed || roomId !== state.roomId || state.tab !== 'plans') return;
        state.planMonth = dateFrom.slice(0, 7);
        toast(`已发布 ${result.plans.length} 天开放计划`);
        await loadDetail();
      } catch (err) {
        error.textContent = err.message || '发布失败';
      } finally {
        submit.disabled = false;
      }
    });
    return h('div', { class: 'stack' },
      section('开放计划', '计划按日期版本化；缩短开放时段若影响已有有效预约会被拒绝，请先通过停用流程处理。'),
      h('div', { class: 'card' },
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', {}, '开始日期'), from),
            h('div', { class: 'field' }, h('label', {}, '结束日期'), to),
            h('div', { class: 'field' }, h('label', {}, '开放开始'), start),
            h('div', { class: 'field' }, h('label', {}, '开放结束'), end),
            h('div', { class: 'field span-2' }, h('label', {}, '备注'), note),
          ),
          h('div', { class: 'row' }, submit, error),
        ),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', {}, `已发布计划（${plans.length}）`),
          h('label', { class: 'row' }, '查询月份', h('input', {
            type: 'month', value: state.planMonth,
            on: { change: (event) => {
              state.planMonth = event.target.value || beijingDate().slice(0, 7);
              loadDetail();
            } },
          })),
        ),
        plans.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, '开放时段'), h('th', {}, '备注'))),
            h('tbody', {}, plans.map((plan) => h('tr', {},
              h('td', {}, plan.date),
              h('td', {}, `${plan.start}—${plan.end}`),
              h('td', {}, plan.note || '—'),
            ))),
          ))
          : h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '所选月份暂无已发布计划。')),
      ),
    );
  }

  function renderSuspension() {
    const seats = state.detail.seats.filter((s) => !s.archived);
    if (seats.length && !seats.some((s) => s.id === state.form.seatId)) state.form.seatId = seats[0].id;
    const form = state.form;
    const previewPanel = h('div', { hidden: !state.preview });
    function edit(field, value) {
      if (form[field] === value) return;
      form[field] = value;
      invalidatePreview();
      previewPanel.hidden = true;
    }
    const seatSelect = h('select', {
      on: { change: (event) => { edit('seatId', event.target.value); } },
    }, seats.map((s) => h('option', { value: s.id, selected: s.id === form.seatId }, `${s.code}${s.power.status === 'faulty' ? '（插座故障）' : ''}`)));
    const immediate = h('input', {
      type: 'checkbox', checked: form.immediate,
      on: { change: (event) => { edit('immediate', event.target.checked); renderAll(); } },
    });
    const start = h('input', {
      type: 'datetime-local', value: form.startAt, disabled: form.immediate,
      on: { change: (event) => { edit('startAt', event.target.value); } },
    });
    const end = h('input', {
      type: 'datetime-local', value: form.endAt,
      on: { change: (event) => { edit('endAt', event.target.value); } },
    });
    const reason = h('input', {
      type: 'text', maxlength: 120, value: form.reason, placeholder: '例如：设施检修、插座更换',
      on: { input: (event) => { edit('reason', event.target.value); } },
    });
    const error = h('p', { style: { color: 'var(--danger)', fontSize: '13px' } });
    const clearedCheck = h('input', {
      type: 'checkbox',
      checked: state.cleared,
      on: { change: (event) => { state.cleared = event.target.checked; renderAll(); } },
    });

    const previewBtn = h('button', { class: 'btn', type: 'button' }, '预览影响');
    previewBtn.addEventListener('click', async () => {
      invalidatePreview();
      const sequence = previewSequence;
      previewPanel.hidden = true;
      error.textContent = '';
      try {
        const preview = await api.post('/admin/suspensions/preview', {
          seatId: form.seatId,
          immediate: form.immediate,
          startAt: form.immediate ? null : form.startAt.replace('T', ' '),
          endAt: form.endAt.replace('T', ' '),
          reason: form.reason,
        });
        if (disposed || sequence !== previewSequence) return;
        state.preview = { ...preview, requestKey: newKey() };
        renderAll();
      } catch (err) {
        if (!disposed && sequence === previewSequence) error.textContent = err.message || '预览失败';
      }
    });

    async function commit() {
      if (!preview || preview !== state.preview || preview.submitting) return;
      if (state.preview.needClearance && !state.cleared) {
        toast('请先确认现场已清场', 'warn');
        return;
      }
      preview.submitting = true;
      submit.disabled = true;
      try {
        await api.post('/admin/suspensions', {
          seatId: form.seatId,
          immediate: form.immediate,
          startAt: form.immediate ? null : form.startAt.replace('T', ' '),
          endAt: form.endAt.replace('T', ' '),
          reason: form.reason,
          cleared: state.cleared,
          impactHash: state.preview.impactHash,
        }, { idempotencyKey: preview.requestKey });
        if (disposed || state.preview !== preview) return;
        toast('停用已提交，受影响预约已按规则处置');
        invalidatePreview();
        await loadDetail();
      } catch (err) {
        if (disposed || state.preview !== preview) return;
        if (err.status === 409) {
          toast('影响集合已变化，请重新预览后再提交', 'warn');
          invalidatePreview();
          renderAll();
        } else {
          preview.submitting = false;
          renderAll();
          toast(err.message || '提交失败', 'error');
        }
      }
    }

    const preview = state.preview;
    const submit = h('button', {
      class: 'btn primary', type: 'button',
      disabled: !preview || preview.submitting || (preview.needClearance && !state.cleared),
      on: { click: commit },
    }, '确认停用');
    const suspensions = (state.detail.suspensions || []).filter((s) => state.includeExpired || s.status === 'active');

    if (preview) previewPanel.append(h('div', { class: 'card', style: { background: '#fbfcfe' } },
      h('div', { class: 'card-body stack' },
        h('div', { class: 'row between' },
          h('strong', {}, `影响预览 · ${preview.seat?.code || form.seatId}`),
          h('span', { class: 'small muted' }, `${preview.startAt} — ${preview.endAt}`),
        ),
        preview.affected.length
          ? h('div', { class: 'impact-list' }, preview.affected.map((r) => h('div', { class: `impact-item ${r.status !== 'pending' ? 'danger' : ''}` },
            h('div', { class: 'row between' },
              h('span', { class: 'strong' }, r.userName || r.userId),
              statusBadge(r.status),
            ),
            h('div', { class: 'tiny muted' }, `${r.startText}—${r.endText} · ${r.plannedAction}`),
          )))
          : h('p', { class: 'small muted' }, '该时段没有受影响的预约。'),
        preview.needClearance
          ? h('label', { class: 'check' }, clearedCheck, h('span', { class: 'text' }, '已通知使用者离场，并确认现场已清空'))
          : null,
        h('div', { class: 'row' }, submit),
      ),
    ));

    return h('div', { class: 'stack' },
      section('停用管理', '提交前必须预览影响；立即停用使用中或暂离中的座位需确认现场清场。到达结束时间自动恢复，已取消或关闭的预约不会复活。'),
      h('div', { class: 'card' },
        h('div', { class: 'card-body stack' },
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', {}, '目标座位'), seatSelect),
            h('div', { class: 'field' }, h('label', {}, '停用原因'), reason),
            h('div', { class: 'field' }, h('label', {}, '立即开始'),
              h('label', { class: 'check', style: { minHeight: '40px', alignItems: 'center' } }, immediate, h('span', { class: 'text' }, '立即停用（开始时间取当前业务时间）'))),
            h('div', { class: 'field' }, h('label', {}, '结束时间'), end),
            h('div', { class: 'field' }, h('label', {}, '开始时间'), start),
          ),
          h('div', { class: 'row' }, previewBtn, error),
          previewPanel,
        ),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', {}, '停用安排'),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: state.includeExpired, on: { change: (event) => { state.includeExpired = event.target.checked; renderAll(); } } }),
            h('span', { class: 'text' }, '包含已恢复安排'),
          ),
        ),
        suspensions.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, '座位'), h('th', {}, '时段'), h('th', {}, '原因'), h('th', {}, '状态'), h('th', { class: 'actions-cell' }, '操作'))),
            h('tbody', {}, suspensions.map((s) => h('tr', {},
              h('td', {}, s.seatCode),
              h('td', {}, `${s.startText}—${s.endText}`),
              h('td', {}, s.reason),
              h('td', {}, s.status === 'restored' ? plainBadge('已提前恢复', 'gray') : plainBadge('生效中', 'amber')),
              h('td', { class: 'actions-cell' },
                s.status === 'active'
                  ? h('button', {
                    class: 'btn sm', type: 'button',
                    on: { click: async () => {
                      const reasonText = await promptDialog({ title: `提前恢复 ${s.seatCode}`, label: '恢复理由', required: true, multiline: true });
                      if (!reasonText) return;
                      try {
                        await api.post(`/admin/suspensions/${s.id}/restore`, { reason: reasonText });
                        toast('已提前恢复；原已取消或关闭的预约不会复活');
                        await loadDetail();
                      } catch (err) { toast(err.message, 'error'); }
                    } },
                  }, '提前恢复')
                  : '—',
              ),
            ))),
          ))
          : h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '暂无停用安排。')),
      ),
    );
  }

  function renderQr() {
    if (!state.qrSheet) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载座位二维码…')));
    }
    return h('div', { class: 'stack' },
      section('桌面二维码', '打印后贴在对应座位桌面；学生扫码后系统校验本人预约、目标座位与签到窗口。', h('button', { class: 'btn', type: 'button', on: { click: () => window.print() } }, icon('print'), '打印')),
      h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('div', { class: 'code-list' }, state.qrSheet.seats.map((seat) => h('div', { class: 'qr-item' },
            h('div', { html: seat.svg }),
            h('strong', {}, seat.code),
          ))),
        ),
      ),
      h('p', { class: 'tiny muted' }, '静态二维码仅用于识别场地与座位，不代表持续在座，也不能单独作为防代签证明。'),
    );
  }

  function renderLive() {
    const rows = state.liveRows;
    return h('div', { class: 'stack' },
      section('现场预约', '按授权场地查询当前业务状态与登记使用情况；登记状态不等于实际在座，现场事实由管理员核实。'),
      h('div', { class: 'card toolbar-card' },
        h('div', { class: 'field' }, h('label', {}, '日期'), h('input', {
          type: 'date', value: state.liveDate,
          on: { change: (event) => { state.liveDate = event.target.value; state.liveRows = null; loadActivePanel(); } },
        })),
        h('button', { class: 'btn', type: 'button', on: { click: loadActivePanel } }, icon('refresh'), '刷新'),
      ),
      !rows
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载…')))
        : rows.length
          ? h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, '时段'), h('th', {}, '座位'), h('th', {}, '学生'), h('th', {}, '状态'), h('th', {}, '签到'), h('th', { class: 'actions-cell' }, '操作'))),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', {}, `${r.startTime}—${r.endTime}`),
              h('td', {}, r.seatCode),
              h('td', {}, `${r.userName || r.userId}`),
              h('td', {}, statusBadge(r.status)),
              h('td', {}, r.firstCheckinAtText ? r.firstCheckinAtText.slice(11, 16) : '—'),
              h('td', { class: 'actions-cell' },
                h('button', { class: 'btn sm', type: 'button', on: { click: () => openReservation(r) } }, '详情'),
                r.status === 'pending'
                  ? h('button', { class: 'btn sm primary', type: 'button', on: { click: () => assistCheckin(r) } }, '辅助签到')
                  : null,
              ),
            ))),
          )))
          : h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState('该日期没有预约', '切换日期查看其他记录。'))),
    );
  }

  async function openReservation(row) {
    let detail = row;
    try {
      detail = (await api.get(`/reservations/${row.id}`)).reservation;
    } catch { /* 使用列表数据 */ }
    const dialog = openModal({
      title: '预约详情',
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, statusBadge(detail.status), plainBadge(detail.userName || detail.userId, 'gray')),
        h('dl', { class: 'kv' },
          h('dt', {}, '座位'), h('dd', {}, `${detail.roomName} ${detail.seatCode}`),
          h('dt', {}, '时段'), h('dd', {}, `${detail.startText}—${detail.endText}`),
          h('dt', {}, '签到截止'), h('dd', {}, detail.checkinDeadlineText),
          h('dt', {}, '实际签到'), h('dd', {}, detail.firstCheckinAtText || '未签到'),
          h('dt', {}, '结束方式'), h('dd', {}, detail.endReason || '—'),
        ),
        detail.segments?.length > 1
          ? h('div', {}, h('h3', {}, '保留分段'), h('ul', { class: 'timeline' }, detail.segments.map((s) => h('li', {}, `${s.seatCode} · ${s.startText}—${s.endText}`))))
          : null,
      ),
      footer: [h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, '关闭')],
    });
  }

  async function assistCheckin(row) {
    const note = await promptDialog({
      title: `现场辅助签到 · ${row.seatCode} · ${row.startTime}—${row.endTime}`,
      label: '核实说明',
      message: '请记录核实方式、现场情况与操作人。辅助签到仍需通过签到窗口校验。',
      required: true,
      multiline: true,
    });
    if (!note) return;
    try {
      const result = await api.post(`/admin/reservations/${row.id}/assist-checkin`, { note });
      toast(result.alreadyCheckedIn ? '该预约已签到，无需重复操作' : '辅助签到成功');
      state.liveRows = null;
      await loadActivePanel();
    } catch (error) {
      toast(error.message || '辅助签到失败', 'error');
    }
  }

  function renderReviews() {
    if (!state.reviews) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载评价…')));
    }
    const rows = state.reviews;
    return h('div', { class: 'stack' },
      section('评价管理', '每笔已签到且完成的预约最多一条当前评价；隐藏文字须填写理由，评分仍计入房间聚合。'),
      rows.length
        ? h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, '使用时段'), h('th', {}, '学生'), h('th', {}, '评分'), h('th', {}, '文字'), h('th', {}, '可见性'), h('th', { class: 'actions-cell' }, '操作'))),
          h('tbody', {}, rows.map((row) => h('tr', {},
            h('td', {}, row.reservationText || '—'),
            h('td', {}, row.userName || '—'),
            h('td', {}, `${row.rating} 分`),
            h('td', { style: { maxWidth: '340px', whiteSpace: 'normal' } }, row.content || '—'),
            h('td', {}, row.visibility === 'hidden' ? plainBadge('文字已隐藏', 'amber') : plainBadge('可见', 'green')),
            h('td', { class: 'actions-cell' },
              h('button', {
                class: 'btn sm', type: 'button',
                on: { click: async () => {
                  const hidden = row.visibility !== 'hidden';
                  const reasonText = await promptDialog({
                    title: hidden ? '隐藏评价文字' : '恢复评价文字',
                    label: '处理理由',
                    message: hidden ? '隐藏仅影响文字展示，不改变评分与聚合数量。' : '恢复后文字重新可见，历史记录保留。',
                    required: true,
                    multiline: true,
                  });
                  if (!reasonText) return;
                  try {
                    await api.post(`/admin/evaluations/${row.id}/hide`, { reason: reasonText, hidden });
                    toast(hidden ? '评价文字已隐藏' : '评价文字已恢复');
                    await loadActivePanel();
                  } catch (err) { toast(err.message, 'error'); }
                } },
              }, row.visibility === 'hidden' ? '恢复文字' : '隐藏文字'),
            ),
          ))),
        )))
        : h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState('该场地暂无评价', '已签到且完成的预约可以提交评价。'))),
    );
  }

  function renderAll() {
    if (disposed) return;
    if (!state.rooms.length && !state.loading) {
      setContent(root, h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, '场地管理'), h('p', {}, '当前账号没有可管理的场地。'))),
        h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState('没有场地授权', '请联系系统管理员分配场地范围。'))));
      return;
    }
    const room = state.detail?.room;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '场地管理'),
          h('p', {}, room ? `${room.name} · ${room.building}` : '维护授权场地的座位、设施、开放计划与停用安排。'),
        ),
        h('div', { class: 'head-actions' },
          h('select', {
            style: { minWidth: '200px' },
            on: { change: (event) => { switchRoom(event.target.value); } },
          }, state.rooms.map((r) => h('option', { value: r.id, selected: r.id === state.roomId }, roomText(r)))),
          h('button', { class: 'btn sm', type: 'button', on: { click: () => { state.detail = null; loadDetail(); } } }, icon('refresh'), '刷新'),
        ),
      ),
      h('div', { class: 'subtabs', role: 'tablist' }, TABS.map(([value, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': state.tab === value ? 'true' : 'false',
        on: { click: () => setTab(value) },
      }, label))),
      state.loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载场地信息…')))
        : !state.detail ? emptyState('场地详情加载失败', '请点击刷新重试。')
          : panelError ? h('div', { class: 'notice', role: 'alert' }, panelError,
            h('button', { type: 'button', class: 'btn sm', on: { click: loadActivePanel } }, '重试'))
          : state.tab === 'seats' ? renderSeats()
          : state.tab === 'plans' ? renderPlans()
            : state.tab === 'suspension' ? renderSuspension()
              : state.tab === 'qr' ? renderQr()
                : state.tab === 'live' ? renderLive()
                  : renderReviews(),
    );
  }

  renderAll();
  await loadRooms();
  await loadDetail();
  return () => { disposed = true; };
}
