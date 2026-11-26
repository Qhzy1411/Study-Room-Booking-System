import { setContent } from '../util.js';
import { api, ApiError } from '../api.js';
import { h, icon, toast, emptyState, plainBadge, timeRangeText } from '../util.js';

const VIOLATION_TONE = { pending: 'amber', effective: 'red', revoked: 'gray' };

export async function renderRecords(container, { navigate }) {
  let disposed = false;
  let violations = [];
  let limits = [];
  let tab = 'violations';
  let loading = true;
  const root = h('div', { class: 'stack-20' });
  container.append(root);

  async function load() {
    loading = true;
    renderAll();
    try {
      const [v, l] = await Promise.all([api.get('/me/violations'), api.get('/me/limits')]);
      if (disposed) return;
      violations = v.violations;
      limits = l.limits;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载记录失败', 'error');
    } finally {
      loading = false;
      renderAll();
    }
  }

  function appeal(violation) {
    sessionStorage.setItem('srb.appealViolation', violation.id);
    navigate('/feedback?type=appeal');
  }

  function violationCard(v) {
    return h('article', { class: `record ${v.status === 'pending' ? 'active-record' : ''}` },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, `${v.roomName || ''} · ${v.typeLabel}`.replace(/^ · /, '')),
          plainBadge(v.statusLabel, VIOLATION_TONE[v.status] || 'gray'),
          plainBadge(v.typeLabel, 'gray'),
        ),
        h('span', { class: 'record-sub' }, v.occurredAtText),
      ),
      h('div', { class: 'meta' },
        h('span', {}, `场地 ${v.roomName}`),
        v.reservationText ? h('span', {}, `关联预约 ${v.reservationText}`) : null,
      ),
      v.material ? h('div', { class: 'record-note' }, v.material) : null,
      v.decisionReason
        ? h('div', { class: 'record-sub' }, `复核理由：${v.decisionReason}${v.decidedAtText ? `（${v.decidedAtText}）` : ''}`)
        : null,
      v.revokeReason
        ? h('div', { class: 'record-sub' }, `撤销理由：${v.revokeReason}${v.revokedAtText ? `（${v.revokedAtText}）` : ''}`)
        : null,
      h('div', { class: 'record-actions' },
        v.canAppeal
          ? h('button', { class: 'btn sm soft', type: 'button', on: { click: () => appeal(v) } }, icon('chat'), '对记录提出申诉')
          : h('span', { class: 'small muted' }, '该记录已撤销'),
        v.status === 'pending' ? h('span', { class: 'small muted' }, '待复核记录不等同处罚，管理员核实后才会生效。') : null,
      ),
    );
  }

  function limitCard(l) {
    const state = l.revokedAtText ? ['已解除', 'gray'] : l.active ? ['生效中', 'red'] : l.expired ? ['已到期', 'gray'] : ['未生效', 'amber'];
    return h('article', { class: `record ${l.active ? 'active-record' : ''}` },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, `${l.roomName} · 预约限制`),
          plainBadge(state[0], state[1]),
          plainBadge(l.roomName, 'gray'),
        ),
        h('span', { class: 'record-sub' }, timeRangeText(l.startText, l.endText)),
      ),
      h('div', { class: 'record-note' }, l.reason),
      h('div', { class: 'record-sub' },
        '依据违规：',
        l.basis.length
          ? l.basis.map((b) => `${b.typeLabel} · ${b.occurredAtText}（${b.status === 'revoked' ? '已撤销' : b.status === 'effective' ? '已生效' : '待复核'}）`).join('；')
          : '—',
      ),
      l.revokedAtText
        ? h('div', { class: 'record-sub' }, `解除时间：${l.revokedAtText}${l.revokeReason ? `；理由：${l.revokeReason}` : ''}`)
        : null,
      l.active
        ? h('div', { class: 'notice warn' }, '限制期间不能创建新预约。')
        : null,
    );
  }

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '违约与限制'),
          h('p', {}, '查看违约记录、复核结论与预约限制。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: load } }, icon('refresh'), '刷新'),
          h('button', { class: 'btn sm primary', type: 'button', on: { click: () => navigate('/feedback') } }, icon('chat'), '发起投诉或申诉'),
        ),
      ),
      h('div', { class: 'row between' },
        h('div', { class: 'segmented' },
          [['violations', `违约记录（${violations.length}）`], ['limits', `预约限制（${limits.length}）`]].map(([value, label]) => h('button', {
            type: 'button', 'aria-pressed': tab === value ? 'true' : 'false',
            on: { click: () => { tab = value; renderAll(); } },
          }, label)),
        ),
      ),
      loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载记录…')))
        : tab === 'violations'
          ? (violations.length
            ? h('div', { class: 'list' }, violations.map(violationCard))
            : h('section', { class: 'card' }, h('div', { class: 'card-body' },
              emptyState('没有违约记录', '签到截止未签到会生成待复核事件；现场登记也会先进入待复核，不会直接形成处罚。'))))
          : (limits.length
            ? h('div', { class: 'list' }, limits.map(limitCard))
            : h('section', { class: 'card' }, h('div', { class: 'card-body' },
              emptyState('没有预约限制', '限制须以至少一条已生效违规为依据，并写明场地范围、起止时间与理由。')))),
      h('div', { class: 'notice' },
        '待复核记录不等同处罚。',
      ),
    );
  }

  renderAll();
  await load();
  return () => { disposed = true; };
}
