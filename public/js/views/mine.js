import { setContent, violationTypeLabel } from '../util.js';
import { api, newKey, ApiError } from '../api.js';
import {
  h, icon, toast, emptyState, openModal, confirmDialog, promptDialog,
  statusBadge, durationText, plainBadge,
} from '../util.js';
import { openScanDialog } from '../scan.js';

const state = {
  overview: null,
  reservations: [],
  tab: 'active',
  statusFilter: 'all',
  from: '',
  to: '',
  busy: false,
};

const END_REASON = {
  self_checkout: '本人主动签退',
  expired: '预约到期由系统结束',
  away_timeout: '暂离超时异常关闭',
  venue_suspension: '场地停用关闭',
  no_show: '签到截止未签到',
};

function statusOptions() {
  return [
    ['all', '全部'],
    ['completed', '已完成'],
    ['cancelled', '已取消'],
    ['no_show', '已违约'],
    ['aborted', '异常关闭'],
  ];
}

export async function renderMine(container, { navigate }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);

  async function load() {
    state.busy = true;
    renderAll();
    try {
      const [overview, mine] = await Promise.all([
        api.get('/me/overview'),
        api.get('/reservations/mine'),
      ]);
      if (disposed) return;
      state.overview = overview;
      state.reservations = mine.reservations;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载预约失败', 'error');
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  function timeWindowText(r) {
    return `${r.startText} — ${r.endText}`;
  }

  function activeActions(r) {
    const actions = [];
    actions.push(h('button', { class: 'btn sm', type: 'button', on: { click: () => openDetail(r.id) } }, icon('eye'), '详情'));
    actions.push(h('button', {
      class: 'btn sm', type: 'button',
      on: { click: () => openGuide(r.id) },
    }, icon('compass'), '到座导航'));
    if (r.status === 'pending') {
      actions.push(h('button', {
        class: 'btn sm primary', type: 'button',
        on: { click: () => openScanDialog({ reservation: r, onSuccess: load }) },
      }, icon('scan'), '扫码签到'));
      actions.push(h('button', {
        class: 'btn sm', type: 'button',
        on: { click: () => openProblemDialog(r) },
      }, icon('wrench'), '座位遇到问题'));
      actions.push(h('button', {
        class: 'btn sm danger', type: 'button',
        on: { click: () => cancelReservation(r) },
      }, '取消预约'));
    }
    if (r.status === 'using' || r.status === 'away') {
      actions.push(h('button', {
        class: 'btn sm', type: 'button',
        on: { click: () => openProblemDialog(r) },
      }, icon('wrench'), '座位遇到问题'));
    }
    if (r.status === 'using') {
      actions.push(h('button', {
        class: 'btn sm', type: 'button',
        on: { click: () => act(`/reservations/${r.id}/away`, '已登记暂离，请留意最晚返回时间') },
      }, icon('pause'), '暂离'));
    }
    if (r.status === 'away') {
      actions.push(h('button', {
        class: 'btn sm primary', type: 'button',
        on: { click: () => act(`/reservations/${r.id}/return`, '已返回座位，继续使用中') },
      }, icon('play'), '返回座位'));
    }
    if (r.status === 'using' || r.status === 'away') {
      actions.push(h('button', {
        class: 'btn sm', type: 'button',
        on: { click: () => checkout(r) },
      }, icon('stop'), '签退'));
    }
    return actions;
  }

  function openGuide(reservationId) {
    sessionStorage.setItem('srb.guideReservation', reservationId);
    navigate('/guide');
  }

  async function act(path, successMessage) {
    try {
      await api.post(path, {}, { idempotencyKey: newKey() });
      toast(successMessage);
      await load();
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    }
  }

  async function cancelReservation(r) {
    const ok = await confirmDialog({
      title: '取消预约',
      message: `将取消 ${r.seatCode} 座位（${timeWindowText(r)}）的预约。取消后不可再次签到，本人取消不返还当日次数与时长额度。`,
      confirmText: '确认取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/reservations/${r.id}/cancel`, {}, { idempotencyKey: newKey() });
      toast('预约已取消，保留时段已释放');
      await load();
    } catch (error) {
      toast(error.message || '取消失败', 'error');
    }
  }

  async function checkout(r) {
    const ok = await confirmDialog({
      title: '签退',
      message: `确认结束 ${r.seatCode} 的使用并释放剩余时段？签退后不可恢复。`,
      confirmText: '确认签退',
    });
    if (!ok) return;
    try {
      await api.post(`/reservations/${r.id}/checkout`, {}, { idempotencyKey: newKey() });
      toast('已签退，预约完成');
      await load();
    } catch (error) {
      toast(error.message || '签退失败', 'error');
    }
  }

  async function openDetail(id) {
    let detail;
    try {
      detail = (await api.get(`/reservations/${id}`)).reservation;
    } catch (error) {
      toast(error.message || '无法加载详情', 'error');
      return;
    }
    const events = [];
    events.push({ at: detail.createdAtText, text: '创建预约', tone: '' });
    if (detail.checkin) {
      events.push({ at: detail.checkin.atText || '', text: `签到（${detail.checkin.method === 'admin_assist' ? '管理员现场辅助' : '扫描桌面码'}）`, tone: 'tone-success' });
    }
    for (const away of detail.aways) {
      events.push({ at: away.startText, text: `发起暂离，最晚返回 ${away.deadlineText}`, tone: 'tone-warn' });
      if (away.returnedAt) events.push({ at: away.closedText || '', text: '返回座位', tone: 'tone-success' });
      else if (away.closeReason === 'timeout') events.push({ at: '', text: '暂离超时，座位释放', tone: 'tone-danger' });
    }
    if (detail.endedAt) {
      events.push({ at: detail.endedAtText || '', text: END_REASON[detail.endReason] || '预约结束', tone: detail.status === 'completed' ? 'tone-success' : 'tone-danger' });
    }
    const dialog = openModal({
      title: '预约详情',
      wide: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'row between' },
          h('div', { class: 'row' }, statusBadge(detail.status), detail.waiver ? h('span', { class: 'badge amber plain' }, '场地免责') : null),
          h('span', { class: 'muted small' }, `创建于 ${detail.createdAtText}`),
        ),
        h('dl', { class: 'kv' },
          h('dt', {}, '自习室'), h('dd', {}, `${detail.roomName}（${detail.roomLocation}）`),
          h('dt', {}, '座位'), h('dd', {}, detail.seatCode),
          h('dt', {}, '时段'), h('dd', {}, `${detail.startText} — ${detail.endText}`),
          h('dt', {}, '时长'), h('dd', {}, durationText(Math.round((detail.end - detail.start) / 60000))),
          h('dt', {}, '签到截止'), h('dd', {}, detail.checkinDeadlineText),
          detail.releasedAt ? h('dt', {}, '释放时刻') : null,
          detail.releasedAt ? h('dd', {}, detail.releasedAtText || '—') : null,
        ),
        detail.segments.length > 1
          ? h('div', {},
            h('h3', { style: { marginBottom: '8px' } }, '座位保留分段'),
            h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
              h('thead', {}, h('tr', {}, h('th', {}, '座位'), h('th', {}, '开始'), h('th', {}, '结束'), h('th', {}, '关闭原因'))),
              h('tbody', {}, detail.segments.map((s) => h('tr', {},
                h('td', {}, s.seatCode), h('td', {}, s.startText), h('td', {}, s.endText), h('td', {}, s.closedReason || '—'),
              ))),
            )),
          )
          : null,
        detail.usage.length
          ? h('div', {},
            h('h3', { style: { marginBottom: '8px' } }, '登记使用分段'),
            h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
              h('thead', {}, h('tr', {}, h('th', {}, '座位'), h('th', {}, '签到'), h('th', {}, '结束'), h('th', {}, '关闭原因'))),
              h('tbody', {}, detail.usage.map((u) => h('tr', {},
                h('td', {}, u.seatCode), h('td', {}, u.startText), h('td', {}, u.endText || '进行中'), h('td', {}, u.closeReason || '—'),
              ))),
            )),
          )
          : null,
        detail.changes.length
          ? h('div', {},
            h('h3', { style: { marginBottom: '8px' } }, '换座记录'),
            h('ul', { class: 'timeline' }, detail.changes.map((c) => h('li', {}, h('div', {}, `${c.atText} 由 ${c.fromSeatCode} 换至 ${c.toSeatCode}`)))),
          )
          : null,
        h('div', {},
          h('h3', { style: { marginBottom: '8px' } }, '状态时间线'),
          h('ul', { class: 'timeline' }, events.map((event) => h('li', { class: event.tone },
            h('div', {}, event.text), event.at ? h('div', { class: 't' }, event.at) : null,
          ))),
        ),
        detail.violations.length
          ? h('div', { class: 'notice warn' },
            `关联违规记录：${detail.violations.map((v) => `${violationTypeLabel(v.type)} · ${v.occurredAtText}（${v.status === 'pending' ? '待复核' : v.status === 'effective' ? '已生效' : '已撤销'}）`).join('、')}。可在“违约与限制”查看并申诉。`)
          : null,
        detail.siteIssues.length
          ? h('div', { class: 'notice' },
            `现场问题：${detail.siteIssues.map((c) => `${c.createdAtText}（${c.statusLabel}）`).join('、')}。换座不关闭原问题。`)
          : null,
        detail.evaluation
          ? h('div', { class: 'notice success' },
            `评价：${detail.evaluation.rating} 分${detail.evaluation.content ? ` · ${detail.evaluation.content}` : ''}${detail.evaluation.visibility === 'hidden' ? '（文字已被管理员隐藏，评分仍计入）' : ''}`)
          : null,
      ),
      footer: [
        ['pending', 'using', 'away'].includes(detail.status)
          ? h('button', { class: 'btn', type: 'button', on: { click: () => openGuide(detail.id) } }, '查看到座路线')
          : null,
        h('button', { class: 'btn primary', type: 'button', on: { click: () => dialog.close() } }, '关闭'),
      ],
    });
  }

  function evaluationDialog(reservation) {
    let rating = 5;
    let existing = null;
    const text = h('textarea', { maxlength: 500, placeholder: '可描述环境、设施与使用体验（最多 500 字）' });
    const stars = h('div', { class: 'row', role: 'radiogroup', 'aria-label': '评分' });
    const error = h('p', { hidden: true, style: { color: 'var(--danger)', fontSize: '13px' } });
    const info = h('p', { class: 'notice', hidden: true });
    const renderStars = () => {
      stars.replaceChildren(...[1, 2, 3, 4, 5].map((value) => h('button', {
        type: 'button', class: `chip ${rating === value ? 'active' : ''}`,
        'aria-pressed': rating === value ? 'true' : 'false',
        style: { minWidth: '52px' },
        on: { click: () => { rating = value; renderStars(); } },
      }, `${value} 分`)));
    };
    renderStars();
    const save = h('button', { class: 'btn primary', type: 'button' }, '保存评价');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api.post(`/reservations/${reservation.id}/evaluation`, { rating, content: text.value.trim() });
        toast(existing ? '评价已更新，修改历史已保留' : '评价已提交');
        dialog.close();
        await load();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message || '保存失败';
        save.disabled = false;
      }
    });
    const dialog = openModal({
      title: '评价本次使用',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, `${reservation.roomName} ${reservation.seatCode} · ${timeWindowText(reservation)}`),
        h('div', { class: 'field' }, h('label', {}, '评分'), stars),
        h('div', { class: 'field' }, h('label', {}, '体验描述（可选）'), text),
        info,
        error,
      ),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', on: { click: () => dialog.close() } }, '取消'),
        save,
      ],
    });
    api.get(`/reservations/${reservation.id}`).then((data) => {
      existing = data.reservation.evaluation;
      if (existing) {
        rating = existing.rating;
        text.value = existing.content || '';
        renderStars();
        info.hidden = false;
        info.textContent = '本预约已有评价，保存将更新同一条评价并保留修改历史。';
      }
    }).catch(() => {});
  }

  async function openProblemDialog(reservation) {
    let needPower = reservation.needPower;
    let siteIssueKey = null;
    const swapKeys = new Map();
    const type = h('select', {},
      h('option', { value: '服务问题' }, '座位被他人占用'),
      h('option', { value: '设施问题' }, '设施故障或无法使用'),
      h('option', { value: '其他' }, '其他现场情况'),
    );
    const description = h('textarea', { maxlength: 500, placeholder: '说明现场情况、发生时间及对使用的影响。' });
    const submitBtn = h('button', { class: 'btn primary', type: 'button' }, '提交现场问题');
    const progress = h('div', { class: 'stack' });
    const candidateBox = h('div', { class: 'stack' });
    const powerCheck = h('input', { type: 'checkbox', checked: needPower, disabled: needPower });
    const error = h('p', { style: { color: 'var(--danger)', fontSize: '13px' } });

    async function refreshProgress() {
      progress.replaceChildren(h('p', { class: 'muted small' }, '加载处理进度…'));
      candidateBox.replaceChildren();
      try {
        const data = await api.get(`/reservations/${reservation.id}/site-issues`);
        if (!data.issues.length) {
          progress.replaceChildren(h('p', { class: 'small muted' }, '尚未提交现场问题。提交后管理员核实处理；换座不会自动关闭问题。'));
        } else {
          progress.replaceChildren(
            h('h3', {}, '处理进度'),
            ...data.issues.map((issue) => h('div', { class: 'record' },
              h('div', { class: 'record-top' },
                h('div', { class: 'record-title' }, h('strong', {}, `现场问题 · ${issue.createdAtText}`), h('span', { class: `badge ${issue.status === 'answered' ? 'green' : issue.status === 'closed' ? 'gray' : 'blue'}` }, issue.statusLabel), plainBadge(issue.typeLabel, 'gray')),
                h('span', { class: 'record-sub' }, issue.createdAtText),
              ),
              h('div', { class: 'record-note' }, issue.description),
              issue.isOccupancy && issue.reservation?.status === 'pending' && issue.reservation.checkinProtectedUntil
                ? h('p', { class: 'small' }, `签到保护至 ${issue.reservation.checkinDeadlineText}`)
                : null,
              issue.events.length > 0
                ? h('ul', { class: 'timeline' }, issue.events.map((event) => h('li', {},
                  h('div', {}, `${event.authorName} · ${event.kind === 'submit' ? '提交' : event.kind === 'accept' ? '受理' : event.kind === 'reply' ? '答复' : event.kind === 'supplement' ? '补充材料' : '关闭'}`),
                  h('div', { class: 'record-sub' }, event.body),
                  h('div', { class: 't' }, event.createdAtText),
                )))
                : null,
              issue.status === 'answered'
                ? h('div', { class: 'row' },
                  h('button', { class: 'btn sm', type: 'button', on: { click: async () => {
                    const body = await promptDialog({ title: '补充材料', label: '补充说明', message: '补充后投诉回到处理中，原答复保留。', required: true });
                    if (!body) return;
                    try { await api.post(`/complaints/${issue.id}/supplement`, { body }); toast('补充材料已提交'); refreshProgress(); } catch (e) { toast(e.message, 'error'); }
                  } } }, '补充材料'),
                  h('button', { class: 'btn sm', type: 'button', on: { click: async () => {
                    const ok = await confirmDialog({ title: '确认关闭', message: '确认现场问题已经解决并关闭？关闭后原记录仍保留。', confirmText: '确认关闭' });
                    if (!ok) return;
                    try { await api.post(`/complaints/${issue.id}/close`, {}); toast('问题已关闭'); refreshProgress(); } catch (e) { toast(e.message, 'error'); }
                  } } }, '确认已解决'),
                )
                : null,
            )),
          );
        }
        await refreshCandidates();
      } catch (err) {
        progress.replaceChildren(h('p', { class: 'small danger-text' }, err.message || '无法加载处理进度'));
      }
    }

    async function refreshCandidates() {
      if (reservation.status !== 'pending' && reservation.status !== 'using') {
        candidateBox.replaceChildren(h('p', { class: 'small muted' }, '暂离中或终态预约不能换座。'));
        return;
      }
      candidateBox.replaceChildren(h('p', { class: 'muted small' }, '正在查询同房间替代座位…'));
      try {
        const data = await api.get(`/reservations/${reservation.id}/swap-candidates?needPower=${needPower ? 'true' : 'false'}`);
        const heading = h('div', { class: 'row between' },
          h('h3', {}, '替代座位'),
          h('label', { class: 'check' }, powerCheck, h('span', { class: 'text' }, '必须插座正常')),
        );
        if (!data.candidates.length) {
          candidateBox.replaceChildren(
            heading,
            h('p', { class: 'small muted' }, data.emptyReason || '暂无可换座位。'),
          );
          return;
        }
        candidateBox.replaceChildren(
          heading,
          h('p', { class: 'small muted' }, `剩余时段 ${data.remaining.startText} — ${data.remaining.endText}；换座保留结束时间与签到截止，不新增额度。`),
          h('div', { class: 'recommend-list' },
            data.candidates.map((candidate) => h('div', { class: 'recommend' },
              h('div', { class: 'top' },
                h('div', { class: 'row', style: { gap: '6px' } },
                  h('span', { class: 'name' }, candidate.seatCode),
                  candidate.nearWindow ? plainBadge('靠窗', 'green') : null,
                  plainBadge(candidate.power === 'normal' ? '插座正常' : '插座故障', candidate.power === 'normal' ? 'gray' : 'amber'),
                  candidate.distanceMeters != null ? plainBadge(`距入口 ${candidate.distanceMeters} 米`, 'blue') : null,
                ),
                h('button', { class: 'btn sm primary', type: 'button', on: { click: () => confirmSwap(candidate) } }, '换到此座位'),
              ),
              h('div', { class: 'reasons' }, candidate.reasons.join(' · ')),
            )),
          ),
        );
      } catch (err) {
        candidateBox.replaceChildren(h('p', { class: 'small danger-text' }, err.message || '查询候选失败'));
      }
    }

    async function confirmSwap(candidate) {
      const ok = await confirmDialog({
        title: '确认换座',
        message: `将当前预约的剩余时段换至 ${candidate.seatCode}。换座失败时保留原座位；原现场问题继续由管理员处理。`,
        confirmText: '确认换座',
      });
      if (!ok) return;
      try {
        const swapKey = swapKeys.get(candidate.seatId) || newKey();
        swapKeys.set(candidate.seatId, swapKey);
        const result = await api.post(
          `/reservations/${reservation.id}/swap`,
          { targetSeatId: candidate.seatId, needPower, expectedVersion: reservation.version },
          { idempotencyKey: swapKey },
        );
        swapKeys.delete(candidate.seatId);
        toast(`换座成功，新座位 ${result.reservation.seatCode}`);
        dialog.close();
        await load();
      } catch (err) {
        if (err.status !== 0) swapKeys.delete(candidate.seatId);
        error.textContent = err.status === 0 ? `${err.message}；网络恢复后可重试，系统会按原操作键返回同一结果。` : (err.message || '换座失败');
      }
    }

    powerCheck.addEventListener('change', () => { needPower = powerCheck.checked; refreshCandidates(); });
    submitBtn.addEventListener('click', async () => {
      if (!description.value.trim()) {
        error.textContent = '请填写现场情况说明';
        return;
      }
      submitBtn.disabled = true;
      try {
        const apiKey = siteIssueKey || newKey();
        siteIssueKey = apiKey;
        await api.post(
          `/reservations/${reservation.id}/site-issues`,
          {
            type: type.value === '设施问题' ? 'facility' : 'service',
            isOccupancy: type.value === '服务问题',
            description: description.value.trim(),
          },
          { idempotencyKey: apiKey },
        );
        siteIssueKey = null;
        toast('现场问题已提交，可在本窗口查看处理进度');
        description.value = '';
        await refreshProgress();
      } catch (err) {
        if (err.status !== 0) siteIssueKey = null;
        error.textContent = err.status === 0 ? `${err.message}；可重试，系统不会重复创建问题。` : (err.message || '提交失败');
      } finally {
        submitBtn.disabled = false;
      }
    });

    const dialog = openModal({
      title: '座位遇到问题',
      wide: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'notice' },
          `${reservation.roomName} ${reservation.seatCode} · ${timeWindowText(reservation)}。报告问题不会处罚他人，也不会自动改变座位状态；管理员将现场核实。`),
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', {}, '问题类型'), type),
          h('div', { class: 'field span-2' }, h('label', {}, '现场情况'), description),
        ),
        h('div', { class: 'row' }, submitBtn, error),
        progress,
        candidateBox,
      ),
      footer: [h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, '关闭')],
    });
    refreshProgress();
  }

  function renderRestriction() {
    const restriction = state.overview?.restriction;
    if (!restriction) return null;
    return h('div', { class: 'notice danger' },
      h('strong', {}, '当前预约限制：'),
      `${restriction.start} 至 ${restriction.end}，范围 ${restriction.scope === 'ALL' ? '全部场地' : restriction.scope}。理由：${restriction.reason}。`,
    );
  }

  function renderActive() {
    const active = state.overview?.active || [];
    if (!active.length) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState('没有进行中的预约', '选择座位并提交预约后，可在此签到、暂离、签退或取消。',
          h('button', { class: 'btn primary', type: 'button', on: { click: () => navigate('/book') } }, '去预约座位')),
      ));
    }
    return h('div', { class: 'list' }, active.map((r) => h('article', { class: `record ${r.status === 'using' || r.status === 'away' ? 'active-record' : ''}` },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, `${r.roomName} · ${r.seatCode}`),
          statusBadge(r.status),
          r.waiver ? plainBadge('场地免责', 'amber') : null,
        ),
      ),
      h('div', { class: 'meta' },
        h('span', {}, `时段 ${r.startText} — ${r.endText}`),
        h('span', {}, `签到截止 ${r.checkinDeadlineText}`),
                r.status === 'pending' ? h('span', {}, '请在签到截止前扫码签到') : null,
        r.status === 'away' ? h('span', {}, '暂离中，请在保留截止前返回') : null,
      ),
      h('div', { class: 'record-actions' }, activeActions(r)),
    )));
  }

  function filteredHistory() {
    return state.reservations.filter((r) => {
      if (['pending', 'using', 'away'].includes(r.status)) return false;
      if (state.statusFilter !== 'all' && r.status !== state.statusFilter) return false;
      if (state.from && r.date < state.from) return false;
      if (state.to && r.date > state.to) return false;
      return true;
    });
  }

  function renderHistory() {
    const rows = filteredHistory();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, `历史记录（${rows.length}）`),
        h('div', { class: 'row' },
          h('div', { class: 'segmented' }, statusOptions().map(([value, label]) => h('button', {
            type: 'button', 'aria-pressed': state.statusFilter === value ? 'true' : 'false',
            on: { click: () => { state.statusFilter = value; renderAll(); } },
          }, label))),
        ),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'toolbar', style: { marginBottom: '16px' } },
          h('div', { class: 'field' }, h('label', {}, '开始日期'), h('input', {
            type: 'date', value: state.from,
            on: { change: (e) => { state.from = e.target.value; renderAll(); } },
          })),
          h('div', { class: 'field' }, h('label', {}, '结束日期'), h('input', {
            type: 'date', value: state.to,
            on: { change: (e) => { state.to = e.target.value; renderAll(); } },
          })),
        ),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', {}, h('tr', {},
              h('th', {}, '自习室 / 座位'), h('th', {}, '时段'), h('th', {}, '状态'), h('th', {}, '结束方式'), h('th', { class: 'actions-cell' }, '操作'),
            )),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', {}, `${r.roomName} · ${r.seatCode}`),
              h('td', {}, `${r.startText} — ${r.endText}`),
              h('td', {}, statusBadge(r.status)),
              h('td', {}, END_REASON[r.endReason] || r.cancelReason || '—'),
              h('td', { class: 'actions-cell' },
                h('button', { class: 'btn sm', type: 'button', on: { click: () => openDetail(r.id) } }, '详情'),
                r.status === 'completed' && r.firstCheckinAt
                  ? h('button', {
                    class: 'btn sm soft', type: 'button',
                    on: { click: () => evaluationDialog(r) },
                  }, '评价')
                  : null,
              ),
            ))),
          ))
          : emptyState('没有符合条件的历史记录', '调整状态或日期筛选后再试。'),
      ),
    );
  }

  function renderUnpaid() {
    const items = state.overview?.unpaidEvaluation || [];
    if (!items.length) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        emptyState('暂无待评价的预约', '已签到并完成的预约可提交一条评价，修改会保留历史。')));
    }
    return h('div', { class: 'list' }, items.map((r) => h('article', { class: 'record' },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' }, h('strong', {}, `${r.roomName} · ${r.seatCode}`), statusBadge(r.status)),
        h('span', { class: 'record-sub' }, `${r.startText} — ${r.endText}`),
      ),
      h('div', { class: 'record-actions' },
        h('button', { class: 'btn sm primary', type: 'button', on: { click: () => evaluationDialog(r) } }, '评价本次预约'),
        h('button', { class: 'btn sm', type: 'button', on: { click: () => openDetail(r.id) } }, '查看详情'),
      ),
    )));
  }

  function renderAll() {
    if (disposed) return;
    const overview = state.overview;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '我的预约'),
          h('p', {}, '管理本人预约、签到签退、暂离与现场问题。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: load }, disabled: state.busy }, icon('refresh'), '刷新'),
          h('button', { class: 'btn sm primary', type: 'button', on: { click: () => navigate('/book') } }, icon('calendar'), '预约座位'),
        ),
      ),
      renderRestriction(),
      overview
        ? h('div', { class: 'metrics' },
          h('div', { class: 'metric' }, h('div', { class: 'label' }, '进行中'), h('div', { class: 'value' }, overview.active.length), h('div', { class: 'sub' }, '待签到 / 使用中 / 暂离中')),
          h('div', { class: 'metric' }, h('div', { class: 'label' }, '已完成'), h('div', { class: 'value' }, overview.counts.completed), h('div', { class: 'sub' }, '含本人签退与到期结束')),
          h('div', { class: 'metric' }, h('div', { class: 'label' }, '已违约'), h('div', { class: 'value' }, overview.counts.noShow), h('div', { class: 'sub' }, '生成待复核事件')),
          h('div', { class: 'metric' }, h('div', { class: 'label' }, '待评价'), h('div', { class: 'value' }, overview.unpaidEvaluation.length), h('div', { class: 'sub' }, '已签到且已完成')),
        )
        : null,
      h('div', { class: 'segmented' },
        [['active', `进行中（${overview?.active?.length ?? 0}）`], ['history', '历史记录'], ['unpaid', `待评价（${overview?.unpaidEvaluation?.length ?? 0}）`]].map(([value, label]) => h('button', {
          type: 'button',
          'aria-pressed': state.tab === value ? 'true' : 'false',
          on: { click: () => { state.tab = value; renderAll(); } },
        }, label)),
      ),
      !overview && state.busy ? h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载…'))) : null,
      state.tab === 'active' ? renderActive() : state.tab === 'history' ? renderHistory() : renderUnpaid(),
      h('div', { class: 'notice' },
        '签到需在签到窗口内完成。',
        h('button', { class: 'link-btn', type: 'button', on: { click: () => navigate('/records') } }, '查看违约与限制记录 →'),
      ),
    );
  }

  renderAll();
  await load();
  return () => { disposed = true; };
}
