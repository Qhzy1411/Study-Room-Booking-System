import { h, escapeHtml } from './util.js';

const W = 560;
const H = 300;
const PAD = { left: 52, right: 22, top: 24, bottom: 46 };

function axes({ max = 100, xLabels = [], yTicks = [0, 25, 50, 75, 100], xLabelEvery = 1 }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const parts = [];
  for (const tick of yTicks) {
    const y = PAD.top + innerH - (tick / max) * innerH;
    parts.push(`<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" stroke="#e8edf4" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8b95a7">${tick}</text>`);
  }
  parts.push(`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="#cbd5e3" stroke-width="1.4"/>`);
  parts.push(`<line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="#cbd5e3" stroke-width="1.4"/>`);
  const step = innerW / Math.max(xLabels.length, 1);
  xLabels.forEach((label, index) => {
    if (index % xLabelEvery !== 0) return;
    const x = PAD.left + step * (index + 0.5);
    parts.push(`<text x="${x.toFixed(1)}" y="${H - PAD.bottom + 19}" text-anchor="middle" font-size="11.5" fill="#6b7688">${escapeHtml(label)}</text>`);
  });
  return { parts, innerW, innerH, step };
}

export function barChart({ items, max = 100, yTicks = [0, 25, 50, 75, 100], ariaLabel = '柱状图' }) {
  const labels = items.map((item) => item.label);
  const { parts, innerW, innerH, step } = axes({ max, xLabels: labels, yTicks });
  const barWidth = Math.min(64, step * 0.48);
  items.forEach((item, index) => {
    const x = PAD.left + step * (index + 0.5);
    if (item.value == null) {
      parts.push(`<text x="${x.toFixed(1)}" y="${(H - PAD.bottom - 8).toFixed(1)}" text-anchor="middle" font-size="12" fill="#9aa5b8">—</text>`);
      return;
    }
    const height = Math.max(2, (Math.min(item.value, max) / max) * innerH);
    const y = H - PAD.bottom - height;
    parts.push(`<rect x="${(x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="5" fill="${item.color || '#2457d6'}" opacity=".9"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#344054">${escapeHtml(item.display ?? `${item.value}%`)}</text>`);
  });
  const wrap = h('div', { class: 'chart-card' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join('')}</svg>`;
  return wrap;
}

export function lineChart({ points, ariaLabel = '折线图' }) {
  const labels = points.map((p) => p.label);
  const { parts, innerW, innerH, step } = axes({ max: 100, xLabels: labels, yTicks: [0, 25, 50, 75, 100], xLabelEvery: labels.length > 8 ? 2 : 1 });
  const coords = points.map((point, index) => {
    if (point.value == null) return null;
    const x = PAD.left + step * (index + 0.5);
    const y = H - PAD.bottom - (Math.min(point.value, 100) / 100) * innerH;
    return { x, y, point };
  });
  const segments = [];
  let current = [];
  for (const coord of coords) {
    if (coord) current.push(coord);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  for (const segment of segments) {
    const line = segment.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    if (segment.length > 1) {
      parts.push(`<polyline points="${line}" fill="none" stroke="#2457d6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  for (const coord of coords) {
    if (!coord) continue;
    parts.push(`<circle cx="${coord.x.toFixed(1)}" cy="${coord.y.toFixed(1)}" r="4.5" fill="#fff" stroke="#2457d6" stroke-width="2.4"/>`);
    parts.push(`<text x="${coord.x.toFixed(1)}" y="${(coord.y - 10).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#344054">${escapeHtml(coord.point.display ?? `${coord.point.value}%`)}</text>`);
  }
  if (!coords.some(Boolean)) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="#8b95a7">所选日期范围暂无可统计数据</text>`);
  }
  const wrap = h('div', { class: 'chart-card' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${parts.join('')}</svg>`;
  return wrap;
}