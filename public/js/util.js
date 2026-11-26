/* 通用 DOM 工具、提示与对话框。所有用户数据通过 textContent 写入，避免 XSS。 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    } else if (key === 'html') el.innerHTML = value; // 仅用于受信任的图标常量
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'readOnly') el[key] = !!value;
    else if (key.startsWith('aria-') || key === 'role' || key === 'tabindex' || key === 'title') el.setAttribute(key, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function svgEl(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** 与 h() 相同的空值处理，用于直接替换容器内容，避免 null 被渲染成文本 */
export function setContent(el, ...children) {
  const nodes = [];
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    nodes.push(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  el.replaceChildren(...nodes);
  return el;
}

export function requiredMark() {
  return h('span', { class: 'required-mark', 'aria-hidden': 'true' }, '*');
}

export function inputField(label, control, { required = true, wide = false } = {}) {
  control.required = required;
  return h('label', { class: wide ? 'field span-2' : 'field' },
    h('span', { class: 'field-label' }, label, required ? requiredMark() : null),
    control,
  );
}

const ICONS = {
  logo: '<path d="M5 4.5h6.2a2 2 0 0 1 2 2V22a2 2 0 0 0-2-2H5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M19 4.5h-5.8a2 2 0 0 0-2 2V22a2 2 0 0 1 2-2H19z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  ticket: '<path d="M4 6.5h16v4a2.5 2.5 0 0 0 0 5v3.5H4v-3.5a2.5 2.5 0 0 0 0-5z"/><path d="M9 6.5v2M9 12v2M9 16v2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13.6 13.6 8.5 15.5l1.9-5.1z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 6 2 6.5H4c.5-.5 2-2.5 2-6.5z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M4 3v18h17"/><path d="M8 17v-6M13 17V7M18 17V4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  scan: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5v.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  qr: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h2.5v2.5h-2.5zM20.5 20.5H18V18h2.5zM14.5 20.5h2M20.5 14.5v2"/>',
  book: '<path d="M4 4.5h6a2 2 0 0 1 2 2V21a2 2 0 0 0-2-2H4z"/><path d="M20 4.5h-6a2 2 0 0 0-2 2V21a2 2 0 0 1 2-2h6z"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  print: '<path d="M7 8V3h10v5"/><path d="M5 8h14a2 2 0 0 1 2 2v6h-4v5H7v-5H3v-6a2 2 0 0 1 2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l3 2"/>',
  map: '<path d="M3 5.5 9 3l6 2.5L21 3v15.5L15 21l-6-2.5L3 21z"/><path d="M9 3v15.5M15 5.5V21"/>',
};

export function icon(name, className = '') {
  const node = document.createElement('span');
  node.className = 'icon ' + className;
  node.style.display = 'inline-flex';
  node.style.flex = 'none';
  node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em">${ICONS[name] || ICONS.info}</svg>`;
  return node;
}

export function toast(message, type = 'success', timeout = 4200) {
  const root = document.getElementById('toast-root');
  const node = h(
    'div',
    { class: `toast ${type === 'success' ? '' : type}`, role: 'status' },
    h('span', { class: 'grow' }, message),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': '关闭提示', on: { click: () => node.remove() } }, '×'),
  );
  root.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

export function openModal({ title, body, footer, wide = false, onClose = null, labelledBy = null }) {
  const root = document.getElementById('modal-root');
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const closeBtn = h('button', { class: 'close-x', type: 'button', 'aria-label': '关闭对话框', on: { click: close } }, '×');
  const modal = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' },
      h('h2', { id: titleId }, title),
      closeBtn,
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', {
    class: 'modal-backdrop',
    on: {
      mousedown: (event) => {
        if (event.target === backdrop) close();
      },
    },
  }, modal);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => {
    const focusable = modal.querySelector('input, select, textarea, button.primary, button');
    if (focusable) focusable.focus();
  }, 30);
  return { close, modal, backdrop };
}

export function confirmDialog({ title = '请确认', message, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    const body = h('div', { class: 'stack' }, message instanceof Node ? message : h('p', { class: 'muted' }, message));
    const dialog = openModal({
      title,
      body,
      footer: [
        h('button', { class: 'btn ghost', type: 'button', on: { click: () => finish(false) } }, cancelText),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', on: { click: () => finish(true) } }, confirmText),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, message = null, placeholder = '', value = '', confirmText = '提交', required = true, multiline = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const input = multiline
      ? h('textarea', { placeholder, value, rows: 4 })
      : h('input', { type: 'text', placeholder, value });
    const error = h('p', { class: 'form-error', style: { color: 'var(--danger)', fontSize: '13px', minHeight: '18px' } });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(result);
    };
    const submit = () => {
      const text = input.value.trim();
      if (required && !text) {
        error.textContent = `请填写${label}`;
        input.focus();
        return;
      }
      finish(text);
    };
    const dialog = openModal({
      title,
      body: h('div', { class: 'stack' },
        message ? h('p', { class: 'muted small' }, message) : null,
        inputField(label, input, { required }),
        error,
      ),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', on: { click: () => finish(null) } }, '取消'),
        h('button', { class: 'btn primary', type: 'button', on: { click: submit } }, confirmText),
      ],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (event) => {
      if (!multiline && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  });
}

export function emptyState(title, message = '', action = null) {
  return h('div', { class: 'empty' },
    icon('info'),
    h('p', { class: 'empty-title' }, title),
    message ? h('p', { class: 'small' }, message) : null,
    action ? h('div', { style: { marginTop: '14px' } }, action) : null,
  );
}

const RESERVATION_STATUS = {
  pending: { label: '待签到', tone: 'blue' },
  using: { label: '使用中', tone: 'green' },
  away: { label: '暂离中', tone: 'amber' },
  cancelled: { label: '已取消', tone: 'gray' },
  completed: { label: '已完成', tone: 'gray' },
  no_show: { label: '已违约', tone: 'red' },
  aborted: { label: '异常关闭', tone: 'red' },
};

export function reservationStatusMeta(status) {
  return RESERVATION_STATUS[status] || { label: status, tone: 'gray' };
}

export function statusBadge(status) {
  const meta = reservationStatusMeta(status);
  return h('span', { class: `badge ${meta.tone}` }, meta.label);
}

export function plainBadge(label, tone = 'gray') {
  return h('span', { class: `badge ${tone}` }, label);
}

export function violationTypeLabel(type) {
  if (type === 'no_show') return '未按时签到';
  if (type === 'site_event') return '现场事件';
  return '违规事件';
}

export function timeRangeText(start, end) {
  if (!start || !end) return start || end || '—';
  const date = /^\d{4}-\d{2}-\d{2} /.exec(start)?.[0];
  return `${start}—${date && end.startsWith(date) ? end.slice(date.length) : end}`;
}

export function describeReservation(r) {
  return [r.roomName, r.seatCode ? `${r.seatCode} 座位` : null, r.startText && r.endText ? timeRangeText(r.startText, r.endText) : null]
    .filter(Boolean).join(' · ');
}

export function describeComplaint(c) {
  return [c.roomName, c.typeLabel, c.createdAtText].filter(Boolean).join(' · ');
}

export function describeViolation(v) {
  return [v.roomName, violationTypeLabel(v.type), v.occurredAtText].filter(Boolean).join(' · ');
}

export function describeLimit(l) {
  return [l.roomName, l.startText && l.endText ? timeRangeText(l.startText, l.endText) : null].filter(Boolean).join(' · ');
}

export function roomText(room) {
  if (!room) return '';
  return room.building ? `${room.name} · ${room.building}` : room.name;
}

export function durationText(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${minutes} 分钟`;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hh} 小时 ${mm} 分钟` : `${hh} 小时`;
}

export function diffMinutes(startTs, endTs) {
  return Math.max(0, Math.round((endTs - startTs) / 60000));
}

export function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function formatPercent(value) {
  return value == null ? '—' : `${Number(value).toFixed(1)}%`;
}

export function parseLocalInput(value) {
  return String(value || '').replace('T', ' ');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

export function section(title, description = null, actions = null) {
  return h('div', { class: 'section-title' },
    h('div', {}, h('h2', {}, title), description ? h('p', { class: 'card-sub' }, description) : null),
    actions,
  );
}

export { ICONS };
