import { api, ApiError, setUnauthorizedHandler } from './api.js';
import {
  store, setUser, applyClock, refreshClock, refreshUnread, beijingDateTime,
  startTicker, isSysAdmin,
} from './state.js';
import { h, icon, toast, clear, emptyState, inputField } from './util.js';
import { renderBook } from './views/book.js';
import { renderMine } from './views/mine.js';
import { renderGuide } from './views/guide.js';
import { renderFeedback } from './views/feedback.js';
import { renderNotifications } from './views/notifications.js';
import { renderRecords } from './views/records.js';
import { renderProfile } from './views/profile.js';
import { renderAdminVenue } from './views/admin-venue.js';
import { renderAdminReview } from './views/admin-review.js';
import { renderAdminComplaints } from './views/admin-complaints.js';
import { renderAdminStats } from './views/admin-stats.js';
import { renderAdminSystem } from './views/admin-system.js';

const appEl = document.getElementById('app');
let currentDispose = null;
let navToken = 0;
let stopClock = null;
let clockRefreshTimer = null;
let unreadTimer = null;
let shellCleanup = null;

const ROLE_LABEL = { student: '学生', venue_admin: '场地管理员', sys_admin: '系统管理员' };

function grantsText(user) {
  if (!user) return '';
  if (user.grantRooms?.length) return user.grantRooms.map((room) => room.name).join('、');
  return (user.grants || []).join('、');
}

const NAV = {
  student: [
    {
      title: '预约与使用',
      items: [
        { path: '/book', label: '预约座位', icon: 'calendar' },
        { path: '/mine', label: '我的预约', icon: 'ticket' },
        { path: '/guide', label: '到座导航', icon: 'compass' },
      ],
    },
    {
      title: '账户与反馈',
      items: [
        { path: '/feedback', label: '投诉与申诉', icon: 'chat' },
        { path: '/notifications', label: '通知', icon: 'bell' },
        { path: '/records', label: '违约与限制', icon: 'history' },
        { path: '/profile', label: '个人资料', icon: 'user' },
      ],
    },
  ],
  venue_admin: [
    {
      title: '场地管理',
      items: [
        { path: '/admin/venue', label: '场地与资源', icon: 'grid' },
        { path: '/admin/review', label: '违约与限制', icon: 'shield' },
        { path: '/admin/complaints', label: '投诉处理', icon: 'chat' },
        { path: '/admin/stats', label: '数据统计', icon: 'chart' },
      ],
    },
    {
      title: '账户',
      items: [
        { path: '/notifications', label: '通知', icon: 'bell' },
        { path: '/profile', label: '个人资料', icon: 'user' },
      ],
    },
  ],
  sys_admin: [
    {
      title: '系统管理',
      items: [
        { path: '/admin/system', label: '账号与规则', icon: 'settings' },
      ],
    },
    {
      title: '业务授权',
      items: [
        { path: '/admin/stats', label: '数据统计', icon: 'chart' },
        { path: '/admin/complaints', label: '投诉处理', icon: 'chat' },
      ],
    },
    {
      title: '账户',
      items: [
        { path: '/notifications', label: '通知', icon: 'bell' },
        { path: '/profile', label: '个人资料', icon: 'user' },
      ],
    },
  ],
};

function defaultPath(user) {
  if (user.role === 'student') return '/book';
  if (user.role === 'venue_admin') return '/admin/venue';
  return '/admin/system';
}

function canAccess(path, user) {
  if (path === '/book' || path === '/mine' || path === '/guide' || path === '/feedback' || path === '/records') {
    return user.role === 'student';
  }
  if (path === '/notifications' || path === '/profile') return true;
  if (path === '/admin/venue' || path === '/admin/review') return user.role === 'venue_admin';
  if (path === '/admin/complaints') return user.role === 'venue_admin' || (isSysAdmin() && user.canReview);
  if (path === '/admin/stats') return user.role === 'venue_admin' || (isSysAdmin() && user.canStats);
  if (path === '/admin/system') return isSysAdmin();
  return false;
}

function navFor(user) {
  const groups = NAV[user.role] || NAV.student;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => canAccess(item.path, user)) }))
    .filter((group) => group.items.length);
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '';
  return { path, params: new URLSearchParams(queryPart || '') };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) {
    history.replaceState(null, '', target);
    route();
  } else if (window.location.hash === target) {
    route();
  } else {
    window.location.hash = target;
  }
}

/* ------------------------------ 登录 ------------------------------ */

function loginPage(errorMessage = '') {
  clear(appEl);
  const username = h('input', { id: 'login-username', type: 'text', autocomplete: 'username' });
  const password = h('input', { id: 'login-password', type: 'password', autocomplete: 'current-password' });
  const error = h('p', { class: 'auth-error', role: 'alert' }, errorMessage);
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, '登录');

  async function doLogin(name, pass) {
    if (!name || !pass) {
      error.textContent = !name ? '请输入账号' : '请输入密码';
      (!name ? username : password).focus();
      return;
    }
    submit.disabled = true;
    error.textContent = '';
    try {
      const result = await api.post('/auth/login', { username: name, password: pass });
      setUser(result.user);
      applyClock(result.clock);
      await afterLogin();
    } catch (err) {
      error.textContent = err instanceof ApiError ? err.message : '登录失败，请稍后重试';
    } finally {
      submit.disabled = false;
    }
  }

  const form = h('form', {
    class: 'auth-form',
    novalidate: true,
    on: {
      submit: (event) => {
        event.preventDefault();
        doLogin(username.value.trim(), password.value);
      },
    },
  },
  h('h2', {}, '登录账号'),
  inputField('账号', username),
  inputField('密码', password),
  error,
  submit,
  h('div', { class: 'demo-accounts' },
    h('div', { class: 'demo-accounts-head' },
      h('h3', {}, '演示账号'),
      h('span', { class: 'demo-password' }, '密码均为 123456'),
    ),
    h('div', { class: 'demo-btns' },
      [
        ['u01', '学生'],
        ['m1', '二层场地管理员'],
        ['m2', '三层场地管理员'],
        ['s1', '系统管理员'],
      ].map(([name, label]) => h('button', {
        type: 'button',
        on: { click: () => { username.value = name; password.value = '123456'; doLogin(name, '123456'); } },
      }, h('strong', {}, label), h('span', { class: 'muted' }, name))),
    ),
  ),
  );

  appEl.append(
    h('div', { class: 'auth-page' },
      h('div', { class: 'auth-shell' },
        h('section', { class: 'auth-visual' },
          h('div', { class: 'auth-brand' },
            h('span', { class: 'brand-mark' }, icon('logo')),
            h('span', { class: 'auth-brand-name' }, '静阅'),
            h('span', { class: 'auth-brand-divider', 'aria-hidden': 'true' }),
            h('span', { class: 'auth-brand-sub' }, '智慧自习室'),
          ),
          h('div', { class: 'auth-visual-content' },
            h('div', { class: 'auth-copy' },
              h('p', { class: 'auth-eyebrow' }, '自习室预约与管理'),
              h('h1', {}, '为专注，留一席。'),
            ),
          ),
        ),
        h('section', { class: 'auth-panel' }, form),
      ),
    ),
  );
  username.focus();
}

/* ------------------------------ 应用外壳 ------------------------------ */

function renderShell() {
  const user = store.user;
  clear(appEl);
  const clockText = h('span', { class: 'top-clock', 'aria-label': '业务时间（北京时间）' });
  const bellBadge = h('span', { class: 'dot', hidden: true });
  const bellButton = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': '通知',
    on: { click: () => navigate('/notifications') },
  }, icon('bell'), bellBadge);
  const profileName = h('span', { class: 'profile-name' }, user.displayName);
  let menuOpen = false;
  const menu = h('div', { class: 'user-menu', hidden: true },
    h('div', { class: 'user-menu-head' },
      h('strong', {}, user.displayName),
      h('span', { class: 'small muted' }, `${user.username} · ${ROLE_LABEL[user.role]}`),
      user.role === 'venue_admin' && user.grants.length
        ? h('span', { class: 'small muted' }, `授权场地：${grantsText(user)}`)
        : null,
    ),
    h('div', { class: 'user-menu-links' },
      h('button', { type: 'button', on: { click: () => { closeMenu(); navigate('/profile'); } } }, icon('user'), '个人资料'),
      h('button', { type: 'button', on: { click: () => { closeMenu(); navigate('/notifications'); } } }, icon('bell'), '通知'),
      h('button', { class: 'danger-text', type: 'button', on: { click: logout } }, icon('logout'), '退出登录'),
    ),
  );
  const profileWrap = h('div', { class: 'user-menu-wrap' },
    h('button', {
      class: 'profile-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      on: {
        click: (event) => {
          event.stopPropagation();
          menuOpen = !menuOpen;
          menu.hidden = !menuOpen;
          event.currentTarget.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
        },
      },
    },
    h('span', { class: 'avatar' }, user.displayName.slice(0, 1)),
    h('span', { class: 'right' }, profileName, h('span', { class: 'role-tag', style: { display: 'block' } }, ROLE_LABEL[user.role])),
    ),
    menu,
  );
  function closeMenu() {
    menuOpen = false;
    menu.hidden = true;
    profileWrap.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
  }
  const outsideClick = (event) => {
    if (!profileWrap.contains(event.target)) closeMenu();
  };
  const escHandler = (event) => { if (event.key === 'Escape') closeMenu(); };
  document.addEventListener('click', outsideClick);
  document.addEventListener('keydown', escHandler);

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-mark' }, icon('logo')),
      h('span', {}, '静阅'),
      h('span', { class: 'brand-sub' }, '智慧自习室'),
    ),
    h('div', { class: 'topbar-spacer' }),
    clockText,
    h('div', { class: 'top-actions' }, bellButton, profileWrap),
  );

  const sidebar = h('aside', { class: 'sidebar', 'aria-label': '主导航' },
    navFor(user).map((group) => h('div', {},
      h('div', { class: 'nav-group-title' }, group.title),
      h('nav', { class: 'nav' }, group.items.map((item) => h('a', {
        href: `#${item.path}`,
        dataset: { path: item.path },
        on: { click: () => closeMenu() },
      }, icon(item.icon), h('span', {}, item.label)))),
    )),
    h('div', { class: 'sidebar-foot' }, '时间均为北京时间'),
  );

  const main = h('main', { class: 'main', id: 'main' });
  appEl.append(topbar, h('div', { class: 'shell' }, sidebar, main));

  const updateActive = (path) => {
    for (const link of sidebar.querySelectorAll('a[data-path]')) {
      const active = path === link.dataset.path;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };

  const updateUnread = () => {
    const count = store.unread;
    bellBadge.hidden = count <= 0;
    bellBadge.textContent = count > 99 ? '99+' : String(count);
    bellButton.setAttribute('aria-label', count ? `通知，${count} 条未读` : '通知');
  };
  const onUnread = () => updateUnread();
  const onUser = () => {
    profileName.textContent = store.user.displayName;
    profileWrap.querySelector('.avatar').textContent = store.user.displayName.slice(0, 1);
  };
  window.addEventListener('srb:unread', onUnread);
  window.addEventListener('srb:user', onUser);

  stopClock = startTicker(() => {
    clockText.textContent = beijingDateTime();
  }, 1000);
  refreshUnread().then(updateUnread);
  unreadTimer = setInterval(() => refreshUnread().then(updateUnread), 30000);
  clockRefreshTimer = setInterval(() => refreshClock(), 60000);

  shellCleanup = () => {
    document.removeEventListener('click', outsideClick);
    document.removeEventListener('keydown', escHandler);
    window.removeEventListener('srb:unread', onUnread);
    window.removeEventListener('srb:user', onUser);
    if (stopClock) stopClock();
    clearInterval(unreadTimer);
    clearInterval(clockRefreshTimer);
  };

  window.__srbUpdateActive = updateActive;
  return main;
}

async function logout() {
  try { await api.post('/auth/logout', {}); } catch { /* ignore */ }
  teardown();
  setUser(null);
  loginPage();
}

function teardown() {
  if (shellCleanup) shellCleanup();
  shellCleanup = null;
  if (currentDispose) { try { currentDispose(); } catch { /* ignore */ } }
  currentDispose = null;
}

/* ------------------------------ 路由 ------------------------------ */

const VIEWS = {
  '/book': renderBook,
  '/mine': renderMine,
  '/guide': renderGuide,
  '/feedback': renderFeedback,
  '/notifications': renderNotifications,
  '/records': renderRecords,
  '/profile': renderProfile,
  '/admin/venue': renderAdminVenue,
  '/admin/review': renderAdminReview,
  '/admin/complaints': renderAdminComplaints,
  '/admin/stats': renderAdminStats,
  '/admin/system': renderAdminSystem,
};

let mainEl = null;

async function route() {
  if (!store.user) return;
  const { path, params } = parseHash();
  const fallback = defaultPath(store.user);
  if (!path || !VIEWS[path]) {
    navigate(fallback, { replace: true });
    return;
  }
  if (!canAccess(path, store.user)) {
    toast('当前角色无权访问该页面', 'warn');
    navigate(fallback, { replace: true });
    return;
  }
  const token = ++navToken;
  if (currentDispose) {
    try { currentDispose(); } catch { /* ignore */ }
    currentDispose = null;
  }
  window.__srbUpdateActive?.(path);
  mainEl.replaceChildren();
  const host = h('div', {});
  const loading = h('div', { class: 'page-loading' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', {}, '正在加载页面…'),
  );
  mainEl.append(host, loading);
  try {
    const dispose = await VIEWS[path](host, {
      navigate,
      params,
      path,
    });
    if (token !== navToken) {
      host.remove();
      if (typeof dispose === 'function') dispose();
      return;
    }
    loading.remove();
    currentDispose = typeof dispose === 'function' ? dispose : null;
  } catch (error) {
    if (token !== navToken) return;
    loading.remove();
    host.replaceChildren();
    const message = error instanceof ApiError ? error.message : '页面加载失败，请稍后重试';
    host.append(h('section', { class: 'card' },
      h('div', { class: 'card-body' },
        emptyState('无法打开该页面', message,
          h('button', { class: 'btn primary', type: 'button', on: { click: () => navigate(fallback, { replace: true }) } }, '返回首页')),
      ),
    ));
    if (!(error instanceof ApiError)) console.error(error);
  }
  refreshUnread();
}

/* ------------------------------ 启动 ------------------------------ */

async function afterLogin() {
  teardown();
  mainEl = renderShell();
  window.__srbUpdateActive?.(parseHash().path || defaultPath(store.user));
  route();
}

async function boot() {
  setUnauthorizedHandler(() => {
    if (store.user) {
      teardown();
      setUser(null);
      loginPage('登录状态已失效，请重新登录');
    }
  });
  window.addEventListener('hashchange', route);
  try {
    const result = await api.get('/auth/session');
    if (result.user) {
      setUser(result.user);
      applyClock(result.clock);
      await afterLogin();
    } else {
      applyClock(result.clock);
      loginPage();
    }
  } catch (error) {
    loginPage(error.message || '无法连接服务器');
  }
}

boot();
