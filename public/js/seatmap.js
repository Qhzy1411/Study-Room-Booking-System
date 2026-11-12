import { h, escapeHtml } from './util.js';

const num = (value) => Number(value) || 0;

function viewSize(map) {
  const vb = map.viewBox || [0, 0, 800, 660];
  if (vb.length >= 4) return [num(vb[2]) || 800, num(vb[3]) || 660];
  return [num(vb[0]) || 800, num(vb[1]) || 660];
}

function floorMarkup(map) {
  const parts = [];
  const walls = map.walls || { x: 40, y: 40, width: 720, height: 580 };
  parts.push(`<rect x="${num(walls.x)}" y="${num(walls.y)}" width="${num(walls.width)}" height="${num(walls.height)}" rx="10" fill="#ffffff" stroke="#cbd5e3" stroke-width="2.5"/>`);
  for (const windowLine of map.windows || []) {
    parts.push(`<line x1="${num(windowLine.x1)}" y1="${num(windowLine.y1)}" x2="${num(windowLine.x2)}" y2="${num(windowLine.y2)}" stroke="#dbe9f6" stroke-width="7" stroke-linecap="round"/>`);
    parts.push(`<line x1="${num(windowLine.x1)}" y1="${num(windowLine.y1)}" x2="${num(windowLine.x2)}" y2="${num(windowLine.y2)}" stroke="#8cb9dc" stroke-width="1.6" stroke-dasharray="10 5"/>`);
  }
  for (const corridor of map.corridors || []) {
    const points = (corridor.points || []).map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
    parts.push(`<polyline points="${points}" fill="none" stroke="#eef2f8" stroke-width="${num(corridor.width) || 30}" stroke-linecap="round" stroke-linejoin="round"/>`);
    parts.push(`<polyline points="${points}" fill="none" stroke="#dce4ef" stroke-width="1.2" stroke-dasharray="5 6"/>`);
  }
  for (const obstacle of map.obstacles || []) {
    parts.push(`<rect x="${num(obstacle.x)}" y="${num(obstacle.y)}" width="${num(obstacle.width)}" height="${num(obstacle.height)}" rx="6" fill="#f3f5f9" stroke="#dbe2ec"/>`);
    if (obstacle.label) {
      parts.push(`<text x="${num(obstacle.x) + num(obstacle.width) / 2}" y="${num(obstacle.y) + num(obstacle.height) / 2 + 5}" text-anchor="middle" font-size="13" fill="#9aa5b8">${escapeHtml(obstacle.label)}</text>`);
    }
  }
  for (const desk of map.desks || []) {
    parts.push(`<rect x="${num(desk.x)}" y="${num(desk.y)}" width="${num(desk.width)}" height="${num(desk.height)}" rx="4" fill="#e7ecf5" stroke="#ccd7e6"/>`);
  }
  // 入口门洞与标识
  for (const entrance of map.entrances || []) {
    const [x, y] = entrance.point || [60, 330];
    const isWest = entrance.id === 'W';
    parts.push(`<line x1="${x}" y1="${y - 32}" x2="${x}" y2="${y + 32}" stroke="#ffffff" stroke-width="7"/>`);
    parts.push(`<line x1="${x}" y1="${y - 32}" x2="${x}" y2="${y + 32}" stroke="#b9c6d8" stroke-width="1.5" stroke-dasharray="4 4"/>`);
    const labelX = isWest ? x + 16 : x - 16;
    parts.push(`<text x="${labelX}" y="${y - 22}" text-anchor="${isWest ? 'start' : 'end'}" font-size="12.5" font-weight="600" fill="#5d6b80">${escapeHtml(entrance.label)}</text>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="#2457d6" opacity=".75"/>`);
    parts.push(`<line x1="${x}" y1="${y}" x2="${isWest ? x - 26 : x + 26}" y2="${y}" stroke="#2457d6" stroke-width="2" marker-end="url(#ent-arrow)"/>`);
  }
  for (const label of map.labels || []) {
    parts.push(`<text x="${num(label.x)}" y="${num(label.y)}" text-anchor="middle" font-size="12" fill="#a3adbd">${escapeHtml(label.text)}</text>`);
  }
  parts.push(`<rect x="${num(walls.x)}" y="${num(walls.y)}" width="${num(walls.width)}" height="${num(walls.height)}" rx="10" fill="none" stroke="#cbd5e3" stroke-width="2.5"/>`);
  return parts.join('');
}

function floorSvg(map, className = 'floor') {
  const [w, hh] = viewSize(map);
  return `<svg class="${className}" viewBox="0 0 ${w} ${hh}" aria-hidden="true" role="presentation">
    <defs><marker id="ent-arrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto"><path d="M0 0l5 3-5 3z" fill="#2457d6"/></marker></defs>
    ${floorMarkup(map)}
  </svg>`;
}

const STATE_LABEL = {
  available: '可预约',
  occupied: '已预约',
  suspended: '停用',
  facility: '插座故障',
  closed: '未开放',
};

/**
 * 座位图：SVG 底图 + 绝对定位按钮。座位状态同时用颜色、纹理和文字表达。
 */
export function createSeatMap({ map, seats, selectedCode = null, onSelect = null }) {
  const [w, hh] = viewSize(map);
  const wrap = h('div', { class: 'floor-wrap' });
  wrap.innerHTML = floorSvg(map);
  for (const seat of seats) {
    const layout = map.seats?.[seat.code] || (seat.x != null ? seat : null);
    if (!layout || layout.x == null) continue;
    const state = seat.state || 'available';
    const selectable = state === 'available';
    const label = STATE_LABEL[state] || state;
    const button = h(
      'button',
      {
        type: 'button',
        class: `seat state-${state} ${selectedCode === seat.code ? 'is-selected' : ''}`,
        style: {
          left: `${(num(layout.x) / w) * 100}%`,
          top: `${(num(layout.y) / hh) * 100}%`,
        },
        disabled: !selectable && selectedCode !== seat.code,
        'aria-pressed': selectedCode === seat.code ? 'true' : 'false',
        'aria-label': `${seat.code}，${label}${seat.reason ? `，${seat.reason}` : ''}`,
        title: `${seat.code} · ${label}${seat.reason ? `（${seat.reason}）` : ''}${seat.power === 'faulty' ? ' · 插座故障' : ''}`,
        on: selectable && onSelect ? { click: () => onSelect(seat) } : undefined,
      },
      h('strong', {}, seat.code),
      h('small', {}, label),
    );
    wrap.append(button);
  }
  return wrap;
}

/** 到座路线图 */
export function createRouteMap({ map, route, targetSeatCode }) {
  const [w, hh] = viewSize(map);
  const seat = map.seats?.[targetSeatCode];
  const pointList = (route.path || []).map(([x, y]) => `${num(x).toFixed(1)},${num(y).toFixed(1)}`).join(' ');
  const start = route.path?.[0];
  const end = route.path?.[route.path.length - 1];
  const highlight = seat
    ? `<rect x="${num(seat.x) - 42}" y="${num(seat.y) - 32}" width="84" height="64" rx="12" fill="rgba(36,87,214,.08)" stroke="#2457d6" stroke-width="2" stroke-dasharray="6 4"/>`
    : '';
  const svg = `<svg viewBox="0 0 ${w} ${hh}" role="img" aria-label="从${escapeHtml(route.entranceLabel || '入口')}前往 ${escapeHtml(targetSeatCode)} 座位的路线" style="width:100%;height:auto;display:block">
    ${floorMarkup(map)}
    ${highlight}
    <polyline points="${pointList}" fill="none" stroke="#2457d6" stroke-width="10" stroke-opacity=".14" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${pointList}" fill="none" stroke="#2457d6" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10 7"/>
    ${start ? `<circle cx="${num(start[0])}" cy="${num(start[1])}" r="10" fill="#2457d6"/><text x="${num(start[0])}" y="${num(start[1]) + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">始</text>` : ''}
    ${end ? `<circle cx="${num(end[0])}" cy="${num(end[1])}" r="10" fill="#157a4f"/><text x="${num(end[0])}" y="${num(end[1]) + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">终</text>` : ''}
    ${seat ? `<text x="${num(seat.x)}" y="${num(seat.y) - 42}" text-anchor="middle" font-size="13" font-weight="700" fill="#1b46b2">${escapeHtml(targetSeatCode)}</text>` : ''}
  </svg>`;
  const wrap = h('div', { class: 'route-map' });
  wrap.innerHTML = svg;
  return wrap;
}

export function seatMapLegend(withFilter = true) {
  return h(
    'div',
    { class: 'legend' },
    h('span', { class: 'l-free' }, h('i'), '可预约'),
    h('span', { class: 'l-picked' }, h('i'), '已选'),
    h('span', { class: 'l-taken' }, h('i'), '已预约'),
    h('span', { class: 'l-suspend' }, h('i'), '停用'),
    withFilter ? h('span', { class: 'l-filter' }, h('i'), '不满足必要条件') : null,
    h('span', { class: 'l-closed' }, h('i'), '未开放'),
  );
}