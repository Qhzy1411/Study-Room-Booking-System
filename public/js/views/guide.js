import { setContent } from '../util.js';
import { api, ApiError, qs } from '../api.js';
import { h, icon, toast, emptyState, plainBadge, statusBadge } from '../util.js';
import { createRouteMap } from '../seatmap.js';
import { openScanDialog, openCheckinHelp } from '../scan.js';

export async function renderGuide(container, { navigate, params }) {
  let disposed = false;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  let active = [];
  let selectedId = sessionStorage.getItem('srb.guideReservation') || null;
  sessionStorage.removeItem('srb.guideReservation');
  let entrance = 'W';
  let routeData = null;
  let loading = true;
  let errorMessage = '';

  async function loadActive() {
    try {
      active = (await api.get('/reservations/active')).reservations;
      if (!active.some((r) => r.id === selectedId)) selectedId = active[0]?.id || null;
    } catch (error) {
      toast(error.message || '加载预约失败', 'error');
    }
  }

  async function loadRoute() {
    routeData = null;
    errorMessage = '';
    if (!selectedId) {
      loading = false;
      renderAll();
      return;
    }
    loading = true;
    renderAll();
    try {
      routeData = await api.get(`/reservations/${selectedId}/route${qs({ entrance })}`);
      if (disposed) return;
    } catch (error) {
      if (disposed) return;
      errorMessage = error instanceof ApiError ? error.message : '无法加载路线';
      if (error.status === 409) {
        await loadActive();
      }
    } finally {
      loading = false;
      renderAll();
    }
  }

  function selectedReservation() {
    return active.find((r) => r.id === selectedId) || null;
  }

  function reservationSelector() {
    if (active.length <= 1) return null;
    return h('div', { class: 'field' },
      h('label', {}, '选择预约'),
      h('select', {
        on: { change: (event) => { selectedId = event.target.value; loadRoute(); } },
      }, active.map((r) => h('option', { value: r.id, selected: r.id === selectedId }, `${r.seatCode} 座位 · ${r.startText}—${r.endText}`))),
    );
  }

  function renderFallback() {
    const fallback = routeData?.fallback;
    return h('div', { class: 'stack' },
      h('div', { class: 'notice warn' }, fallback?.text || '暂无法生成到座路线，请向场地服务台求助。'),
      fallback
        ? h('dl', { class: 'kv' },
          h('dt', {}, '建筑'), h('dd', {}, fallback.building || '—'),
          h('dt', {}, '楼层'), h('dd', {}, fallback.floor || '—'),
          h('dt', {}, '房间'), h('dd', {}, fallback.roomName || '—'),
          h('dt', {}, '座位'), h('dd', {}, fallback.seatCode || '—'),
        )
        : null,
    );
  }

  function renderRouteCard() {
    const r = selectedReservation();
    if (!r) return null;
    if (loading) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在计算可通行路线…')));
    }
    if (errorMessage) {
      return h('section', { class: 'card' }, h('div', { class: 'card-body' },
        h('div', { class: 'notice danger' }, errorMessage),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { class: 'btn', type: 'button', on: { click: () => loadRoute() } }, '重试'),
          h('button', { class: 'btn', type: 'button', on: { click: () => navigate('/mine') } }, '返回我的预约'),
        ),
      ));
    }
    if (!routeData) return null;
    if (!routeData.available) {
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '到座路线'), h('span', { class: 'badge amber plain' }, '地图或路线不可用')),
        h('div', { class: 'card-body stack' }, renderFallback()),
      );
    }
    const route = routeData.route;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', {}, `前往 ${route.seatCode} 座位`),
                  ),
        h('div', { class: 'row' },
          h('span', { class: 'badge blue plain' }, `距离约 ${route.distanceMeters} 米`),
        ),
      ),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'route-tools row' },
          h('div', { class: 'field' },
            h('label', {}, '出发入口'),
            h('div', { class: 'segmented' },
              ['W', 'E'].map((id) => h('button', {
                type: 'button', 'aria-pressed': entrance === id ? 'true' : 'false',
                on: { click: () => { entrance = id; loadRoute(); } },
              }, id === 'W' ? '西入口' : '东入口')),
            ),
          ),
          h('button', {
            class: 'btn primary', type: 'button',
            on: { click: () => openScanDialog({ reservation: r, onSuccess: () => { loadActive(); loadRoute(); } }) },
          }, icon('scan'), r.status === 'pending' ? '扫码签到' : '查看签到状态'),
          h('button', { class: 'btn ghost sm', type: 'button', on: { click: openCheckinHelp } }, '签到帮助'),
        ),
        h('div', { class: 'floor-scroll' }, createRouteMap({ map: routeData.map, route, targetSeatCode: route.seatCode })),
        h('div', { class: 'route-summary' },
          h('h3', {}, '行走说明'),
          h('ol', { class: 'steps' }, route.steps.map((step) => h('li', {}, step))),
        ),
      ),
    );
  }

  function renderAside() {
    const r = selectedReservation();
    if (!r) return null;
    return h('aside', { class: 'card sticky' },
      h('div', { class: 'card-head' }, h('h2', {}, '本次预约')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'row between' }, h('strong', { style: { fontSize: '18px' } }, r.seatCode), statusBadge(r.status)),
        h('dl', { class: 'kv' },
          h('dt', {}, '自习室'), h('dd', {}, r.roomName),
          h('dt', {}, '位置'), h('dd', {}, r.roomLocation),
          h('dt', {}, '时段'), h('dd', {}, `${r.startText} — ${r.endText}`),
          h('dt', {}, '签到截止'), h('dd', {}, r.checkinDeadlineText),
        ),
        h('div', { class: 'notice' },
          r.status === 'pending'
            ? '尚未签到。请在签到窗口内扫描桌面二维码。'
            : r.status === 'away'
              ? '当前处于暂离中，请在保留截止前返回座位。'
              : '使用中，可返回“我的预约”签退。'),
        h('div', { class: 'row' },
          h('button', { class: 'btn block', type: 'button', on: { click: () => navigate('/mine') } }, '返回我的预约'),
        ),
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    const r = selectedReservation();
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '到座导航'),
          h('p', {}, '选择入口，前往预约座位。'),
        ),
        h('div', { class: 'head-actions' }),
      ),
      !active.length && !loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' },
          emptyState('当前没有可导航的预约', '待签到、使用中或暂离中的预约可以查看到座路线。',
            h('button', { class: 'btn primary', type: 'button', on: { click: () => navigate('/book') } }, '去预约座位')),
        ))
        : h('div', { class: 'split wide' },
          h('div', { class: 'stack-20' },
            reservationSelector(),
            renderRouteCard(),
          ),
          renderAside(),
        ),
    );
  }

  renderAll();
  await loadActive();
  await loadRoute();
  return () => { disposed = true; };
}