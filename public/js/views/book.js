import { setContent, roomText } from '../util.js';
import { api, newKey, qs, ApiError } from '../api.js';
import { store, beijingDate, now, dateLabel, weekdayLabel, beijingTime } from '../state.js';
import {
  h, icon, toast, emptyState, openModal, durationText, inputField, requiredMark, timeRangeText,
} from '../util.js';
import { createSeatMap, seatMapLegend } from '../seatmap.js';

const state = {
  context: null,
  roomDetail: null,
  availability: null,
  filters: null,
  selectedSeat: null,
  agreed: false,
  busy: false,
  queryAt: null,
  bookingKey: null,
  dirty: false,
};

const pad = (n) => String(n).padStart(2, '0');
const minOf = (hhmm) => {
  const [hh, mm] = String(hhmm || '').split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};
const timeOf = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function defaultTimes(plan, date) {
  const today = beijingDate(now());
  const planStart = plan?.start ? minOf(plan.start) : 8 * 60;
  const planEnd = plan?.end ? minOf(plan.end) : 22 * 60;
  if (date === today) {
    const current = minOf(beijingTime(now()));
    let start = Math.ceil((current + 1) / 30) * 30;
    if (start < planStart) start = planStart;
    if (start + 30 > planEnd) return null;
    let end = Math.min(start + 60, planEnd);
    return { start: timeOf(start), end: timeOf(end) };
  }
  return { start: timeOf(Math.max(planStart, 8 * 60)), end: timeOf(Math.min(Math.max(planStart, 8 * 60) + 60, planEnd)) };
}

async function loadRoomDetail(roomId) {
  try {
    state.roomDetail = await api.get(`/rooms/${roomId}`);
  } catch {
    state.roomDetail = null;
  }
}

export async function renderBook(container, { navigate }) {
  let disposed = false;
  state.context = await api.get('/booking/context');
  const saved = JSON.parse(localStorage.getItem('srb.bookFilters') || 'null');
  const roomId = state.context.rooms.some((r) => r.id === saved?.roomId)
    ? saved.roomId
    : state.context.rooms[0]?.id;
  const date = state.context.dates.some((d) => d.date === saved?.date)
    ? saved.date
    : state.context.dates[0]?.date;
  state.filters = {
    roomId,
    date,
    start: saved?.start || '',
    end: saved?.end || '',
    needPower: saved?.needPower ?? false,
    entrance: saved?.entrance === 'E' ? 'E' : 'W',
    preference: saved?.preference === 'window' ? 'window' : 'near',
  };
  await loadRoomDetail(roomId);
  applyDefaultTimes();

  if (!state.context.rooms.length) {
    container.append(emptyState('暂无可预约自习室', '请联系场地管理员确认开放计划。'));
    return () => { disposed = true; };
  }

  const root = h('div', { class: 'stack-20' });
  container.append(root);

  async function query({ preserveSelection = false } = {}) {
    const { filters } = state;
    if (!filters.start || !filters.end) {
      toast('请选择开始与结束时间', 'warn');
      return;
    }
    if (minOf(filters.end) <= minOf(filters.start)) {
      toast('结束时间必须晚于开始时间', 'warn');
      return;
    }
    localStorage.setItem('srb.bookFilters', JSON.stringify(filters));
    state.busy = true;
    renderAll();
    try {
      const data = await api.get(
        `/availability${qs({
          roomId: filters.roomId,
          date: filters.date,
          start: filters.start,
          end: filters.end,
          needPower: filters.needPower ? 'true' : 'false',
          entrance: filters.entrance,
          preference: filters.preference,
        })}`,
      );
      if (disposed) return;
      state.availability = data;
      state.dirty = false;
      state.queryAt = new Date();
      if (!preserveSelection) state.selectedSeat = null;
      if (state.selectedSeat) {
        const match = data.seats.find((s) => s.id === state.selectedSeat.id);
        if (!match || match.state !== 'available') {
          state.selectedSeat = null;
          toast('所选座位已不可预约，请重新选座', 'warn');
        } else {
          state.selectedSeat = match;
        }
      }
      if (!data.open) {
        // 保持页面可读，显示无开放说明
      }
    } catch (error) {
      if (disposed) return;
      state.availability = null;
      state.selectedSeat = null;
      state.dirty = true;
      toast(error instanceof ApiError ? error.message : '查询失败', 'error');
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  function applyDefaultTimes() {
    const plan = state.roomDetail?.plans?.find((p) => p.date === state.filters.date && !p.closed);
    const defaults = defaultTimes(plan, state.filters.date);
    if (defaults) {
      state.filters.start = defaults.start;
      state.filters.end = defaults.end;
    } else if (!state.filters.start) {
      state.filters.start = plan?.start || '08:00';
      state.filters.end = plan?.end || '22:00';
    }
    const startMin = plan ? minOf(plan.start) : 8 * 60;
    const endMin = plan ? minOf(plan.end) : 22 * 60;
    if (state.filters.start && minOf(state.filters.start) < startMin) state.filters.start = timeOf(startMin);
    if (state.filters.end && minOf(state.filters.end) > endMin) state.filters.end = timeOf(endMin);
    if (state.filters.start && state.filters.end && minOf(state.filters.end) <= minOf(state.filters.start)) {
      state.filters.start = timeOf(startMin);
      state.filters.end = timeOf(Math.min(startMin + 60, endMin));
    }
  }

  function invalidateResults() {
    state.availability = null;
    state.selectedSeat = null;
    state.agreed = false;
    state.dirty = true;
    renderAll();
  }

  function changeRoom(roomIdValue) {
    state.filters.roomId = roomIdValue;
    loadRoomDetail(roomIdValue).then(() => {
      applyDefaultTimes();
      invalidateResults();
    });
  }

  function changeDate(value) {
    state.filters.date = value;
    applyDefaultTimes();
    invalidateResults();
  }

  function selectSeat(seat) {
    state.selectedSeat = seat;
    state.agreed = false;
    renderAll();
  }

  async function submitBooking() {
    const seat = state.selectedSeat;
    if (!seat) return;
    if (!state.agreed) {
      toast('请先阅读并勾选预约规则', 'warn');
      return;
    }
    state.busy = true;
    renderAll();
    try {
      const key = state.bookingKey || (state.bookingKey = newKey());
      const result = await api.post(
        '/reservations',
        {
          roomId: state.filters.roomId,
          seatId: seat.id,
          date: state.filters.date,
          start: state.filters.start,
          end: state.filters.end,
          needPower: state.filters.needPower,
        },
        { idempotencyKey: key },
      );
      state.bookingKey = null;
      const reservation = result.reservation;
      state.selectedSeat = null;
      state.agreed = false;
      const dialog = openModal({
        title: '预约成功',
        body: h('div', { class: 'stack' },
          h('dl', { class: 'kv' },
            h('dt', {}, '预约号'),
            h('dd', {}, reservation.id),
            h('dt', {}, '自习室'),
            h('dd', {}, `${reservation.roomName}（${reservation.roomLocation}）`),
            h('dt', {}, '座位'),
            h('dd', {}, reservation.seatCode),
            h('dt', {}, '时段'),
            h('dd', {}, timeRangeText(reservation.startText, reservation.endText)),
            h('dt', {}, '签到截止'),
            h('dd', {}, reservation.checkinDeadlineText),
            h('dt', {}, '规则版本'),
            h('dd', {}, reservation.ruleVersionId),
          ),
          h('p', { class: 'notice' },
            '到座后扫描桌面二维码签到。',
          ),
        ),
        footer: [
          h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, '继续查看'),
          h('button', { class: 'btn primary', type: 'button', on: { click: () => { dialog.close(); navigate('/mine'); } } }, '查看我的预约'),
        ],
      });
      await query();
    } catch (error) {
      if (error.status !== 0) state.bookingKey = null;
      const message = error.status === 0 ? '预约结果待确认，请在网络恢复后查看“我的预约”。'
        : error instanceof ApiError ? error.message : '预约提交失败';
      toast(message, 'error');
      await query({ preserveSelection: true });
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  function renderFilters() {
    const rooms = state.context.rooms;
    const plan = state.roomDetail?.plans?.find((p) => p.date === state.filters.date && !p.closed);
    return h('section', { class: 'card toolbar-card', 'aria-label': '查询条件' },
      h('div', { class: 'field', style: { minWidth: '200px' } },
        h('label', {}, '自习室'),
        h('select', {
          on: { change: (event) => changeRoom(event.target.value) },
        }, rooms.map((room) => h('option', { value: room.id, selected: room.id === state.filters.roomId }, roomText(room)))),
      ),
      h('div', { class: 'field' },
        h('label', {}, '日期'),
        h('select', {
          on: { change: (event) => changeDate(event.target.value) },
        }, state.context.dates.map((d) => h('option', { value: d.date, selected: d.date === state.filters.date }, `${dateLabel(d.date)} ${weekdayLabel(d.date)}`))),
      ),
      inputField('开始时间', h('input', {
        type: 'time', step: 900, value: state.filters.start, min: plan?.start || '00:00', max: plan?.end || '23:59',
        on: { change: (event) => { state.filters.start = event.target.value; invalidateResults(); } },
      })),
      inputField('结束时间', h('input', {
        type: 'time', step: 900, value: state.filters.end, min: plan?.start || '00:00', max: plan?.end || '23:59',
        on: { change: (event) => { state.filters.end = event.target.value; invalidateResults(); } },
      })),
      h('div', { class: 'field', style: { flex: '0 0 auto' } },
        h('label', {}, '必要条件'),
        h('label', { class: 'check', style: { minHeight: '40px', alignItems: 'center' } },
          h('input', {
            type: 'checkbox', checked: state.filters.needPower,
            on: { change: (event) => { state.filters.needPower = event.target.checked; invalidateResults(); } },
          }),
          h('span', { class: 'text' }, '必须有可用插座'),
        ),
      ),
      h('div', { class: 'field', style: { flex: '0 0 auto' } },
        h('label', {}, '出发入口'),
        h('div', { class: 'segmented' },
          ['W', 'E'].map((id) => h('button', {
            type: 'button', 'aria-pressed': state.filters.entrance === id ? 'true' : 'false',
            on: { click: () => { state.filters.entrance = id; invalidateResults(); } },
          }, id === 'W' ? '西入口' : '东入口')),
        ),
      ),
      h('div', { class: 'field', style: { flex: '0 0 auto' } },
        h('label', {}, '排序偏好'),
        h('div', { class: 'segmented' },
          [['near', '离入口较近'], ['window', '靠窗优先']].map(([id, label]) => h('button', {
            type: 'button', 'aria-pressed': state.filters.preference === id ? 'true' : 'false',
            on: { click: () => { state.filters.preference = id; invalidateResults(); } },
          }, label)),
        ),
      ),
      h('button', {
        class: 'btn primary', type: 'button', disabled: state.busy,
        on: { click: () => query() },
      }, icon('search'), state.busy ? '查询中…' : '查询座位'),
    );
  }

  function renderRoomInfo() {
    const room = state.context.rooms.find((r) => r.id === state.filters.roomId);
    if (!room) return null;
    return h('div', { class: 'hero-strip' },
      h('div', { class: 'hero-icon' }, icon('book')),
      h('div', { class: 'grow' },
        h('div', { style: { fontWeight: '700' } }, roomText(room)),
        h('p', {}, room.description),
      ),
      h('div', { class: 'right small muted' },
        h('div', {}, `评分 ${room.rating?.average ?? '—'} / 5（${room.rating?.count || 0} 条）`),
        h('div', {}, room.todayPlan ? `今日开放 ${room.todayPlan.start}—${room.todayPlan.end}` : '今日无开放计划'),
      ),
    );
  }

  function renderAvailabilityPanel() {
    const data = state.availability;
    if (!data) {
      return h('section', { class: 'card' },
        h('div', { class: 'card-body' }, h('p', { class: 'muted' }, state.busy ? '正在查询可用座位…' : '请查询座位。')),
      );
    }
    const map = state.roomDetail?.map;
    const card = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '座位图'),
          h('p', { class: 'card-sub' }, `查询时间 ${data.queryTimeText}`),
        ),
        seatMapLegend(),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'row', style: { marginBottom: '12px' } },
          h('span', { class: 'badge blue plain' }, `开放时段 ${data.openPlan?.start || '—'}—${data.openPlan?.end || '—'}`),
          h('span', { class: 'badge plain' }, `每日额度 ${data.quota.usedCount}/${data.quota.limitCount} 次 · ${data.quota.usedMinutes}/${data.quota.limitMinutes} 分钟`),
          h('span', { class: 'badge plain' }, `单次至少 ${data.rule.minMinutes} 分钟`),
        ),
        map
          ? h('div', { class: 'floor-scroll' },
            createSeatMap({
              map,
              seats: data.seats,
              selectedCode: state.selectedSeat?.code || null,
              onSelect: selectSeat,
            }),
          )
          : h('div', { class: 'empty' }, h('p', {}, '该场地暂无地图数据')),
        !data.open
          ? h('div', { class: 'notice warn', style: { marginTop: '12px' } }, data.emptyReason || '该日期没有开放计划。')
          : null,
        data.open && !data.recommendations.length
          ? h('div', { class: 'notice warn', style: { marginTop: '12px' } }, data.emptyReason || '没有符合条件的座位。')
          : null,
      ),
    );
    return card;
  }

  function renderRecommendations() {
    const data = state.availability;
    if (!data || !data.recommendations?.length) return null;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, '推荐座位'),
        ),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'recommend-list' },
          data.recommendations.map((seat) => h('div', { class: 'recommend', style: { borderColor: state.selectedSeat?.id === seat.id ? '#b9ccff' : null } },
            h('div', { class: 'top' },
              h('div', { class: 'row', style: { gap: '8px' } },
                h('span', { class: 'rank' }, seat.rank),
                h('span', { class: 'name' }, seat.code),
                seat.nearWindow ? h('span', { class: 'badge green plain' }, '靠窗') : null,
                seat.power === 'normal' ? h('span', { class: 'badge gray plain' }, '插座正常') : h('span', { class: 'badge amber plain' }, '插座故障'),
                seat.distanceMeters != null ? h('span', { class: 'badge blue plain' }, `距入口 ${seat.distanceMeters} 米`) : null,
              ),
              h('button', {
                class: `btn sm ${state.selectedSeat?.id === seat.id ? 'soft' : 'primary'}`, type: 'button',
                on: { click: () => selectSeat(seat) },
              }, state.selectedSeat?.id === seat.id ? '已选择' : '选择'),
            ),
            h('div', { class: 'reasons' }, seat.recommendReason || seat.reasons?.[0] || ''),
          )),
        ),
      ),
    );
  }

  function renderSummary() {
    const data = state.availability;
    const seat = state.selectedSeat;
    const duration = minOf(state.filters.end) - minOf(state.filters.start);
    return h('aside', { class: 'card sticky' },
      h('div', { class: 'card-head' }, h('h2', {}, '预约信息')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'selected-seat' },
          h('strong', {}, seat?.code || '请选择座位'),
          seat ? h('span', { class: 'badge green plain' }, '可预约') : null,
        ),
        seat
          ? h('div', { class: 'row', style: { gap: '6px' } },
            seat.nearWindow ? h('span', { class: 'badge gray plain' }, '靠窗') : null,
            h('span', { class: `badge ${seat.power === 'normal' ? 'gray' : 'amber'} plain` }, seat.power === 'normal' ? '插座正常' : '插座故障'),
            seat.distanceMeters != null ? h('span', { class: 'badge gray plain' }, `距入口 ${seat.distanceMeters} 米`) : null,
          )
          : null,
        h('dl', { class: 'kv' },
          h('dt', {}, '自习室'),
          h('dd', {}, data?.room?.name || '—'),
          h('dt', {}, '日期'),
          h('dd', {}, dateLabel(state.filters.date)),
          h('dt', {}, '时段'),
          h('dd', {}, `${state.filters.start} — ${state.filters.end}`),
          h('dt', {}, '时长'),
          h('dd', {}, durationText(Math.max(0, duration))),
          h('dt', {}, '签到时间'),
          h('dd', {}, `预约开始后 ${data?.rule.checkinGraceMin ?? 15} 分钟内，且须在预约结束前签到`),
        ),
        h('details', { class: 'small' },
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '预约与取消规则'),
          h('ul', { style: { paddingLeft: '18px', color: 'var(--muted)', lineHeight: '1.8' } },
            h('li', {}, `每日最多创建 ${data?.rule.dailyCount ?? 4} 次、累计 ${data?.rule.dailyMinutes ?? 240} 分钟。`),
            h('li', {}, `单次至少 ${data?.rule.minMinutes ?? 30} 分钟，不跨午夜。`),
            h('li', {}, '到座后扫描桌面二维码签到；开始前可取消，取消后返还该预约占用的时长额度。'),
            h('li', {}, '同一座位及本人其他有效预约的时段不能重叠。'),
          ),
        ),
        data?.restricted
          ? h('div', { class: 'notice danger' }, `预约受限（${timeRangeText(data.restriction.start, data.restriction.end)}），暂不能预约。`)
          : null,
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox', checked: state.agreed, required: true,
            on: { change: (event) => { state.agreed = event.target.checked; renderAll(); } },
          }),
          h('span', { class: 'text' }, '我已阅读并同意预约规则', requiredMark()),
        ),
        seat && !state.agreed && data && !data.restricted
          ? h('p', { class: 'small muted' }, '请先勾选预约规则确认项。')
          : null,
        h('button', {
          class: 'btn primary block', type: 'button',
          disabled: state.busy || !seat || !state.agreed || !data || data.restricted,
          on: { click: submitBooking },
        }, state.busy ? '提交中…' : '确认预约'),
      ),
    );
  }

  function renderQueryFeedback() {
    if (state.dirty) {
      return h('div', { class: 'notice warn', role: 'status' }, '查询条件已修改，请点击“查询座位”查看最新结果。');
    }
    const data = state.availability;
    if (!data?.open) return null;
    const available = data.seats.filter((seat) => seat.state === 'available').length;
    return h('div', { class: 'small muted', role: 'status' }, `${available} 个座位可预约`);
  }

  function renderAll() {
    if (disposed) return;
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '预约座位'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: () => navigate('/mine') } }, icon('ticket'), '我的预约'),
        ),
      ),
      renderRoomInfo(),
      renderFilters(),
      renderQueryFeedback(),
      h('div', { class: 'split wide' },
        h('div', { class: 'stack-20' },
          renderRecommendations(),
          renderAvailabilityPanel(),
        ),
        renderSummary(),
      ),
    );
  }

  renderAll();
  await query();
  return () => { disposed = true; };
}
