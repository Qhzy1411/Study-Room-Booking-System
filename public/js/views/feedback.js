import { setContent } from '../util.js';
import { api, newKey, ApiError } from '../api.js';
import { h, icon, toast, emptyState, plainBadge, promptDialog, confirmDialog, roomText, inputField, timeRangeText } from '../util.js';

const STATUS_TONE = { pending: 'blue', processing: 'amber', answered: 'green', closed: 'gray' };

export async function renderFeedback(container, { navigate, params }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  let rooms = [];
  let complaints = [];
  let selectedId = params?.get('complaint') || null;
  let complaintDetail = null;
  let violations = [];
  let myReservations = [];
  let busy = false;
  let composing = true;
  let submitKey = null;
  const prefilledViolationId = sessionStorage.getItem('srb.appealViolation') || '';
  sessionStorage.removeItem('srb.appealViolation');

  const form = {
    type: params?.get('type') === 'appeal' ? 'appeal' : 'facility',
    roomId: '',
    reservationId: '',
    violationId: prefilledViolationId,
    description: '',
  };

  async function loadAll() {
    try {
      const [roomData, mine, violationData, reservationData] = await Promise.all([
        api.get('/rooms'),
        api.get('/complaints/mine'),
        api.get('/me/violations'),
        api.get('/reservations/mine'),
      ]);
      if (disposed) return;
      rooms = roomData.rooms;
      complaints = mine.complaints;
      violations = violationData.violations;
      myReservations = reservationData.reservations;
      if (!form.roomId) form.roomId = rooms[0]?.id || '';
      if (form.type === 'appeal' && form.violationId) {
        const violation = violations.find((v) => v.id === form.violationId);
        if (violation) form.roomId = violation.roomId;
      }
      if (selectedId) {
        await loadDetail(selectedId);
      }
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载投诉记录失败', 'error');
    }
    renderAll();
  }

  async function loadDetail(id) {
    try {
      complaintDetail = (await api.get(`/complaints/${id}`)).complaint;
      selectedId = id;
      composing = false;
    } catch (error) {
      toast(error.message || '无法加载投诉详情', 'error');
      complaintDetail = null;
      selectedId = null;
    }
  }

  function violationOptions() {
    return violations.filter((v) => v.status !== 'revoked');
  }

  function reservationOptions() {
    return myReservations.filter((r) => ['pending', 'using', 'away', 'completed'].includes(r.status)).slice(0, 40);
  }

  function selectedViolation() {
    return violations.find((v) => v.id === form.violationId) || null;
  }

  function onTypeChange(value) {
    form.type = value;
    if (value === 'appeal' && form.violationId) {
      const v = selectedViolation();
      if (v) form.roomId = v.roomId;
    }
    renderAll();
  }

  function onViolationChange(value) {
    form.violationId = value;
    const v = selectedViolation();
    if (v) form.roomId = v.roomId;
    renderAll();
  }

  async function submitComplaint() {
    if (!form.description.trim()) {
      toast('请填写问题说明', 'warn');
      return;
    }
    if (!form.roomId) {
      toast('请选择场地', 'warn');
      return;
    }
    if (form.type === 'appeal' && !form.violationId) {
      toast('违约申诉需要选择关联的违规记录', 'warn');
      return;
    }
    busy = true;
    renderAll();
    try {
      const requestKey = submitKey || newKey();
      submitKey = requestKey;
      const result = await api.post(
        '/complaints',
        {
          roomId: form.roomId,
          type: form.type,
          description: form.description.trim(),
          reservationId: form.reservationId || null,
          violationId: form.violationId || null,
        },
        { idempotencyKey: requestKey },
      );
      submitKey = null;
      toast('投诉已提交');
      form.description = '';
      form.reservationId = '';
      form.violationId = '';
      selectedId = result.complaint.id;
      complaintDetail = result.complaint;
      composing = false;
      await loadAll();
      await loadDetail(selectedId);
    } catch (error) {
      if (error.status !== 0) submitKey = null;
      toast(error instanceof ApiError ? (error.status === 0 ? `${error.message}；网络恢复后可重试，系统不会重复创建投诉。` : error.message) : '提交失败', 'error');
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function supplement() {
    const body = await promptDialog({
      title: '补充材料',
      label: '补充说明',
      message: '补充后投诉回到处理中，管理员此前的答复会保留。',
      required: true,
    });
    if (!body) return;
    try {
      const result = await api.post(`/complaints/${complaintDetail.id}/supplement`, { body });
      complaintDetail = result.complaint;
      toast('补充材料已提交');
      await loadAll();
      await loadDetail(selectedId);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function closeComplaint() {
    const ok = await confirmDialog({
      title: '确认关闭投诉',
      message: '确认问题已经解决并关闭投诉？原记录、答复与补充材料仍会保留，关闭后可就其他问题新建投诉。',
      confirmText: '确认关闭',
    });
    if (!ok) return;
    try {
      const result = await api.post(`/complaints/${complaintDetail.id}/close`, {});
      complaintDetail = result.complaint;
      toast('投诉已关闭');
      await loadAll();
      await loadDetail(selectedId);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function newComplaint() {
    composing = true;
    complaintDetail = null;
    selectedId = null;
    renderAll();
  }

  function renderForm() {
    const appeal = form.type === 'appeal';
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '提交投诉或申诉'),
          h('p', { class: 'card-sub' }, '提交后类型与说明不可修改。'),
        ),
      ),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' },
            h('label', {}, '问题类型'),
            h('select', {
              on: { change: (event) => onTypeChange(event.target.value) },
            },
            h('option', { value: 'facility', selected: form.type === 'facility' }, '设施问题'),
            h('option', { value: 'service', selected: form.type === 'service' }, '服务问题'),
            h('option', { value: 'appeal', selected: form.type === 'appeal' }, '违约申诉'),
            ),
          ),
          inputField('相关场地', h('select', {
            on: { change: (event) => { form.roomId = event.target.value; } },
          }, rooms.map((room) => h('option', { value: room.id, selected: room.id === form.roomId }, roomText(room))))),
          appeal
            ? h('div', { class: 'field span-2' },
              inputField('关联违规记录', h('select', {
                on: { change: (event) => onViolationChange(event.target.value) },
              },
              h('option', { value: '' }, '请选择需要申诉的违规记录'),
              violationOptions().map((v) => h('option', { value: v.id, selected: v.id === form.violationId }, `${v.occurredAtText} · ${v.typeLabel} · ${v.statusLabel}`)),
              )),
              h('p', { class: 'field-hint' }, '只可对本人记录申诉；已撤销的记录无需申诉。'),
            )
            : h('div', { class: 'field span-2' },
              h('label', {}, '关联预约（可选）'),
              h('select', {
                on: { change: (event) => { form.reservationId = event.target.value; } },
              },
              h('option', { value: '' }, '不关联预约'),
              reservationOptions().map((r) => h('option', { value: r.id, selected: r.id === form.reservationId }, `${r.roomName} ${r.seatCode} · ${timeRangeText(r.startText, r.endText)}`)),
              ),
            ),
          inputField('问题说明', h('textarea', {
            maxlength: 2000,
            placeholder: '请说明发生时间、地点、现场情况以及需要解决的问题。',
            on: { input: (event) => { form.description = event.target.value; } },
          }, form.description), { wide: true }),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', disabled: busy, on: { click: submitComplaint } }, busy ? '提交中…' : '提交投诉'),
          h('button', { class: 'btn ghost', type: 'button', on: { click: () => { form.description = ''; form.reservationId = ''; form.violationId = ''; renderAll(); } } }, '清空'),
        ),
        
      ),
    );
  }

  function renderDetail() {
    if (!complaintDetail) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState('尚未选择投诉', '从左侧列表选择一条记录查看处理进度与答复。')));
    }
    const c = complaintDetail;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '投诉详情'),
          h('p', { class: 'card-sub' }, `${c.roomName} · ${c.typeLabel} · ${c.createdAtText}${c.seatCode ? ` · 座位 ${c.seatCode}` : ''}`),
        ),
        h('span', { class: `badge ${STATUS_TONE[c.status] || 'gray'}` }, c.statusLabel),
      ),
      h('div', { class: 'card-body stack' },
        h('dl', { class: 'kv' },
          h('dt', {}, '提交时间'), h('dd', {}, c.createdAtText),
          h('dt', {}, '处理人'), h('dd', {}, c.assigneeName || '尚未受理'),
          c.reservation ? h('dt', {}, '关联预约') : null,
          c.reservation ? h('dd', {}, `${c.reservation.seatCode} 座位 · ${timeRangeText(c.reservation.startText, c.reservation.endText)}`) : null,
          c.violationId ? h('dt', {}, '关联违规') : null,
          c.violationId ? h('dd', {}, '已关联本人违规记录') : null,
          c.accusedName ? h('dt', {}, '回避关系') : null,
          c.accusedName ? h('dd', {}, `${c.accusedName}（被投诉/原处理人，不能处理本投诉）`) : null,
        ),
        h('div', { class: 'notice' }, c.description),
        h('div', {},
          h('h3', { style: { marginBottom: '10px' } }, '处理记录'),
          h('ul', { class: 'timeline' }, c.events.map((event) => h('li', { class: event.kind === 'reply' ? 'tone-success' : event.kind === 'supplement' ? 'tone-warn' : '' },
            h('div', { class: 'strong' }, `${event.authorName} · ${event.kind === 'submit' ? '提交投诉' : event.kind === 'accept' ? '受理' : event.kind === 'reply' ? '答复' : event.kind === 'supplement' ? '补充材料' : '确认关闭'}`),
            h('div', { style: { whiteSpace: 'pre-wrap' } }, event.body),
            h('div', { class: 't' }, event.createdAtText),
          ))),
        ),
        c.status === 'answered'
          ? h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', on: { click: supplement } }, '补充材料'),
            h('button', { class: 'btn primary', type: 'button', on: { click: closeComplaint } }, '确认问题已解决'),
          )
          : null,
        c.status === 'closed'
          ? h('p', { class: 'small muted' }, '该投诉已关闭。')
          : null,
        c.status === 'pending' || c.status === 'processing'
          ? null
          : null,
      ),
    );
  }

  function renderHistory() {
    if (!complaints.length) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState('尚无投诉记录', '提交投诉后可以在这里查看状态与历次答复。')));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `投诉记录（${complaints.length}）`)),
      h('div', { class: 'card-body' },
        h('div', { class: 'list' }, complaints.map((c) => h('button', {
          type: 'button',
          class: 'record',
          style: {
            textAlign: 'left', cursor: 'pointer',
            borderColor: selectedId === c.id ? '#b9ccff' : null,
            background: selectedId === c.id ? '#f8faff' : '#fff',
          },
          on: { click: async () => { await loadDetail(c.id); renderAll(); } },
        },
        h('div', { class: 'record-top' },
          h('div', { class: 'record-title' },
            h('strong', {}, `${c.roomName} · ${c.typeLabel}`),
            h('span', { class: `badge ${STATUS_TONE[c.status] || 'gray'}` }, c.statusLabel),
            c.isSite ? plainBadge('现场问题', 'cyan') : null,
          ),
          h('span', { class: 'record-sub' }, c.createdAtText),
        ),
        h('div', { class: 'record-sub' }, c.createdAtText),
        h('div', { class: 'record-sub' }, c.description.length > 70 ? `${c.description.slice(0, 70)}…` : c.description),
        ))),
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '投诉与申诉'),
          h('p', {}, '提交设施、服务或违约申诉，并查看处理进度。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn primary', type: 'button', on: { click: newComplaint } }, icon('plus'), '发起新投诉'),
          h('button', { class: 'btn sm', type: 'button', on: { click: () => navigate('/mine') } }, '我的预约'),
        ),
      ),
      h('div', { class: 'split equal' },
        h('div', { class: 'stack-20' },
          composing ? renderForm() : null,
          renderHistory(),
        ),
        renderDetail(),
      ),
      h('div', { class: 'notice' },
        '投诉状态：待受理 → 处理中 → 已答复 → 已关闭。',
      ),
    );
  }

  renderAll();
  await loadAll();
  if (!selectedId && complaints.length) {
    await loadDetail(complaints[0].id);
    renderAll();
  }
  return () => { disposed = true; };
}
