import { setContent, roomText } from '../util.js';
import { api, ApiError, qs } from '../api.js';
import { store, beijingDate, beijingTime } from '../state.js';
import { h, icon, toast, emptyState, plainBadge, timeRangeText } from '../util.js';
import { barChart, lineChart } from '../charts.js';

const REFRESH_MS = 10000;

export async function renderAdminStats(container, { navigate }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  const state = {
    rooms: [],
    roomId: '',
    date: beijingDate(),
    start: '',
    end: '',
    data: null,
    loading: true,
    error: '',
    lastSuccess: null,
    lastAttempt: null,
    inFlight: false,
    seq: 0,
    skipped: 0,
  };
  let timer = null;

  async function loadRooms() {
    try {
      const data = await api.get('/admin/rooms');
      state.rooms = data.rooms;
      if (!state.rooms.some((r) => r.id === state.roomId)) state.roomId = state.rooms[0]?.id || '';
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '加载场地失败', 'error');
    }
  }

  async function fetchStats({ force = false } = {}) {
    if (!state.roomId) {
      state.loading = false;
      renderAll();
      return;
    }
    if (state.inFlight && !force) {
      state.skipped += 1;
      return;
    }
    const seq = ++state.seq;
    state.inFlight = true;
    state.lastAttempt = new Date();
    if (!state.data) {
      state.loading = true;
      renderAll();
    }
    const params = { roomId: state.roomId, date: state.date };
    if (state.start) params.start = state.start;
    if (state.end) params.end = state.end;
    try {
      const data = await api.get(`/admin/stats${qs(params)}`);
      if (disposed || seq !== state.seq) return;
      state.data = data;
      state.error = '';
      state.lastSuccess = new Date();
    } catch (error) {
      if (disposed || seq !== state.seq) return;
      state.error = error instanceof ApiError ? error.message : '统计更新失败';
    } finally {
      if (seq === state.seq) {
        state.inFlight = false;
        state.loading = false;
        renderAll();
      }
    }
  }

  function changeFilter(patch) {
    Object.assign(state, patch);
    state.data = null;
    state.error = '';
    state.lastSuccess = null;
    state.seq += 1; // 使在途旧响应失效
    state.inFlight = false;
    fetchStats({ force: true });
  }

  function metricCards() {
    const m = state.data.metrics;
    const cards = [
      ['可用座位分钟', m.availableSeatMinutes, '开放分钟 − 停用分钟（按快照前）'],
      ['登记使用分钟', m.usageMinutes, '按使用分段累计，扣除暂离'],
      ['登记使用率', m.usageRate == null ? '—' : `${m.usageRate.toFixed(1)}%`, m.usageRate == null ? '分母为 0，不计算比例' : '使用分钟 ÷ 可用分钟'],
      ['预约创建量', m.createdCount, '按创建时刻统计，含后续取消'],
      ['首次签到量', m.checkinCount, '按签到时刻统计'],
      ['未签到事件量', m.noShowCount, '按签到截止时刻统计'],
      ['净生效违规', m.effectiveViolationCount, '快照时仍生效的记录'],
      ['评价', m.rating.average == null ? '—' : `${m.rating.average} 分`, `${m.rating.count} 条评价`],
    ];
    return h('div', { class: 'metrics' }, cards.map(([label, value, sub]) => h('div', { class: 'metric' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value),
      h('div', { class: 'sub' }, sub),
    )));
  }

  function renderCharts() {
    const data = state.data;
    const barItems = data.rooms.map((room) => ({
      label: room.roomName,
      display: room.hasPlan ? room.displayRate : '—',
      value: room.usageRate,
      color: room.roomId === state.roomId ? '#2457d6' : '#7c9ad6',
    }));
    const linePoints = data.trend.map((point) => ({
      label: point.date.slice(5),
      display: point.displayRate,
      value: point.usageRate,
    }));
    return h('div', { class: 'charts' },
      h('section', { class: 'card chart-card' },
        h('div', { class: 'card-head' }, h('h2', {}, '各自习室登记使用率'), h('span', { class: 'small muted' }, `${data.date} · 同日同时段`)),
        h('div', { class: 'card-body' },
          barChart({ items: barItems, ariaLabel: '各自习室登记使用率柱状图' }),
          h('p', { class: 'chart-tip' }, '“—”表示没有可用座位分钟。'),
        ),
      ),
      h('section', { class: 'card chart-card' },
        h('div', { class: 'card-head' }, h('h2', {}, '登记使用率趋势'), h('span', { class: 'small muted' }, '最近 7 天')),
        h('div', { class: 'card-body' },
          lineChart({ points: linePoints, ariaLabel: '登记使用率 7 日趋势折线图' }),
          h('p', { class: 'chart-tip' }, '按所选场地每天的开放时段计算。'),
        ),
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    const data = state.data;
    const statusText = state.lastSuccess
      ? `上次成功更新 ${beijingTime(state.lastSuccess.getTime(), true)}`
      : '尚未成功更新';
    const roomsOptions = h('select', {
      style: { minWidth: '210px' },
      on: { change: (event) => changeFilter({ roomId: event.target.value }) },
    }, state.rooms.map((room) => h('option', { value: room.id, selected: room.id === state.roomId }, roomText(room))));

    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '数据统计'),
        ),
        h('div', { class: 'head-actions' },
          roomsOptions,
          h('input', {
            type: 'date', value: state.date, style: { width: '150px' },
            on: { change: (event) => changeFilter({ date: event.target.value }) },
          }),
          h('button', { class: 'btn sm', type: 'button', on: { click: () => fetchStats({ force: true }) } }, icon('refresh'), '刷新'),
        ),
      ),
      h('section', { class: 'card toolbar-card' },
        h('div', { class: 'field' }, h('label', {}, '统计开始（可选）'), h('input', {
          type: 'time', value: state.start,
          on: { change: (event) => changeFilter({ start: event.target.value }) },
        })),
        h('div', { class: 'field' }, h('label', {}, '统计结束（可选）'), h('input', {
          type: 'time', value: state.end,
          on: { change: (event) => changeFilter({ end: event.target.value }) },
        })),
        h('div', { class: 'grow small muted', style: { paddingBottom: '10px' } },
          '留空则按开放时段统计。',
        ),
        state.error && data
          ? h('span', { class: 'small danger-text', role: 'status' }, `更新失败：${state.error}（当前为上次数据）`)
          : null,
        h('span', { class: 'small muted', style: { paddingBottom: '10px' } }, statusText),
      ),
      !state.roomId
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState('没有可查询的场地', '请联系系统管理员分配统计范围。')))
        : state.loading && !data
          ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载统计…')))
          : state.error && !data
            ? h('section', { class: 'card' }, h('div', { class: 'card-body' },
              h('div', { class: 'notice danger' }, state.error),
              h('button', { class: 'btn', type: 'button', style: { marginTop: '12px' }, on: { click: () => fetchStats({ force: true }) } }, '重试')))
            : data
              ? h('div', { class: 'stack-20' },
                h('section', { class: 'card' },
                  h('div', { class: 'card-body' },
                    h('div', { class: 'row between' },
                      h('div', {},
                        h('h2', {}, `${data.room.name} · ${data.date}`),
                        h('p', { class: 'card-sub' }, `${data.room.location} · 快照 ${data.snapshotText} · 窗口 ${timeRangeText(data.metrics.window?.startText, data.metrics.window?.endText)}`),
                      ),
                      h('div', { class: 'row' },
                        plainBadge(data.metrics.hasPlan ? `开放 ${data.metrics.plan.start}—${data.metrics.plan.end}` : '当日无开放计划', data.metrics.hasPlan ? 'blue' : 'gray'),
                      ),
                    ),
                  ),
                ),
                metricCards(),
                renderCharts(),
                h('section', { class: 'card' },
                  h('div', { class: 'card-head' },
                    h('h2', {}, '统计口径'),
                  ),
                  h('div', { class: 'card-body' },
                    h('div', { class: 'stack small', style: { color: 'var(--ink-soft)' } },
                      h('p', {}, h('strong', {}, '可用座位分钟：'), data.formulas.available),
                      h('p', {}, h('strong', {}, '登记使用分钟：'), data.formulas.usage),
                      h('p', {}, h('strong', {}, '登记使用率：'), data.formulas.rate),
                      h('p', {}, h('strong', {}, '事件口径：'), data.formulas.counts),
                      h('p', { class: 'muted' }, '当天的使用时长统计截至快照时间。'),
                    ),
                    h('div', { class: 'row', style: { marginTop: '14px' } },
                      h('span', { class: 'badge gray plain' }, `本人取消 ${data.metrics.cancelledBySelf}`),
                      h('span', { class: 'badge amber plain' }, `场地免罚处置 ${data.metrics.cancelledByVenue}`),
                      h('span', { class: 'badge gray plain' }, `座位数 ${data.metrics.seatsCount}`),
                    ),
                  ),
                ),
              )
              : null,
    );
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') fetchStats({ force: true });
  }

  document.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') fetchStats();
  }, REFRESH_MS);

  renderAll();
  await loadRooms();
  await fetchStats({ force: true });
  if (state.error) {
    // 首次失败保留错误提示
  }
  return () => {
    disposed = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
