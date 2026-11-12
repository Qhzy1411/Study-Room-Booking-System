import { setContent } from '../util.js';
import { api, ApiError } from '../api.js';
import { refreshUnread } from '../state.js';
import { h, icon, toast, emptyState, plainBadge } from '../util.js';

export async function renderNotifications(container, { navigate }) {
  let disposed = false;
  let items = [];
  let unread = 0;
  let filter = 'all';
  let loading = true;
  const root = h('div', { class: 'stack-20' });
  container.append(root);
  let pollTimer = null;

  async function load({ silent = false } = {}) {
    if (!silent) {
      loading = true;
      renderAll();
    }
    try {
      const data = await api.get('/notifications');
      if (disposed) return;
      items = data.notifications;
      unread = data.unread;
      storeUnread(unread);
    } catch (error) {
      if (!silent) toast(error instanceof ApiError ? error.message : '加载通知失败', 'error');
    } finally {
      loading = false;
      renderAll();
    }
  }

  function storeUnread(value) {
    window.dispatchEvent(new CustomEvent('srb:unread', { detail: value }));
  }

  async function markRead(item) {
    if (item.read) return;
    try {
      await api.post(`/notifications/${item.id}/read`, {});
      item.read = true;
      unread = Math.max(0, unread - 1);
      storeUnread(unread);
      refreshUnread();
      renderAll();
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    }
  }

  async function markAll() {
    try {
      await api.post('/notifications/read-all', {});
      items.forEach((item) => { item.read = true; });
      unread = 0;
      storeUnread(0);
      refreshUnread();
      renderAll();
      toast('已将全部通知标记为已读');
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    }
  }

  function deliveryBadge(item) {
    if (item.status === 'sent') return plainBadge('已送达', 'green');
    if (item.status === 'failed') return plainBadge('投递失败', 'red');
    return plainBadge('待发送', 'amber');
  }

  function visibleItems() {
    return filter === 'unread' ? items.filter((item) => !item.read) : items;
  }

  function renderItem(item) {
    return h('article', { class: `record ${item.read ? '' : 'active-record'}` },
      h('div', { class: 'record-top' },
        h('div', { class: 'record-title' },
          h('strong', {}, item.title),
          deliveryBadge(item),
          item.read ? null : plainBadge('未读', 'blue'),
        ),
        h('span', { class: 'record-sub' }, item.createdAtText),
      ),
      h('p', { class: 'record-note', style: { whiteSpace: 'pre-wrap' } }, item.body),
      h('div', { class: 'record-actions' },
        item.read ? null : h('button', { class: 'btn sm', type: 'button', on: { click: () => markRead(item) } }, '标记为已读'),
        item.status === 'failed'
          ? h('span', { class: 'tiny muted' }, `投递失败：${item.lastError || '未知原因'}。业务结果不受影响。`)
          : null,
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    const list = visibleItems();
    setContent(root, 
      h('header', { class: 'page-head' },
        h('div', {},
          h('h1', {}, '通知'),
          h('p', {}, '查看业务结果与投递状态。'),
        ),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn sm', type: 'button', on: { click: () => load() } }, icon('refresh'), '刷新'),
          h('button', { class: 'btn sm primary', type: 'button', on: { click: markAll }, disabled: unread === 0 }, '全部标为已读'),
        ),
      ),
      h('div', { class: 'row between' },
        h('div', { class: 'segmented' },
          [['all', `全部（${items.length}）`], ['unread', `未读（${unread}）`]].map(([value, label]) => h('button', {
            type: 'button', 'aria-pressed': filter === value ? 'true' : 'false',
            on: { click: () => { filter = value; renderAll(); } },
          }, label)),
        ),
        h('span', { class: 'small muted' }, '每 30 秒自动刷新'),
      ),
      loading
        ? h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, '正在加载通知…')))
        : list.length
          ? h('div', { class: 'list' }, list.map(renderItem))
          : h('section', { class: 'card' }, h('div', { class: 'card-body' },
            emptyState(filter === 'unread' ? '没有未读通知' : '暂无通知',
              '预约创建、停用处置、违规复核和投诉答复等业务结果会在此显示。',
              filter === 'unread' ? h('button', { class: 'btn', type: 'button', on: { click: () => { filter = 'all'; renderAll(); } } }, '查看全部通知') : null),
          )),
      h('div', { class: 'notice' },
        '通知偏好可在“个人资料”中调整。',
        h('button', { class: 'link-btn', type: 'button', on: { click: () => navigate('/profile') } }, '前往个人资料 →'),
      ),
    );
  }

  renderAll();
  await load();
  pollTimer = setInterval(() => load({ silent: true }), 30000);
  return () => {
    disposed = true;
    clearInterval(pollTimer);
  };
}