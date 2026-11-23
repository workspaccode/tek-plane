import { api, clearToken, getToken } from './api.js';
import { connectRealtime, disconnectRealtime } from './realtime.js';
import { currentQuery, defineRoutes, navigate, onRoute, resolve } from './router.js';
import {
  emit, loadBoard, loadPinned, loadProjects, loadTimer, on, removeBoardTask, state, upsertBoardTask,
} from './store.js';
import {
  avatar, clear, debounce, emptyState, errorToast, fmtDuration, h, icon, menu, mount, openModal, spinner, toast,
} from './ui.js';

const view = (path) => () => import(path);

defineRoutes([
  { path: '/login', load: view('./views/auth.js'), public: true, props: { mode: 'login' } },
  { path: '/register', load: view('./views/auth.js'), public: true, props: { mode: 'register' } },
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', load: view('./views/dashboard.js'), nav: 'dashboard' },
  { path: '/tasks', load: view('./views/mytasks.js'), nav: 'tasks' },
  { path: '/agenda', load: view('./views/agenda.js'), nav: 'agenda' },
  { path: '/time', load: view('./views/time.js'), nav: 'time' },
  { path: '/profile', load: view('./views/profile.js'), nav: 'profile' },
  { path: '/projects', load: view('./views/projects.js'), nav: 'projects' },
  { path: '/projects/:id', load: view('./views/board.js'), nav: 'project' },
  { path: '/projects/:id/list', load: view('./views/list.js'), nav: 'project' },
  { path: '/projects/:id/timeline', load: view('./views/timeline.js'), nav: 'project' },
  { path: '/projects/:id/reports', load: view('./views/reports.js'), nav: 'project' },
  { path: '/projects/:id/activity', load: view('./views/activity.js'), nav: 'project' },
  { path: '/projects/:id/settings', load: view('./views/projectSettings.js'), nav: 'project' },
], { load: null, notFound: true });

const app = document.getElementById('app');
let shell = null; // { root, sidebar, viewEl, topbar }
let cleanup = null;
let renderToken = 0;

// ------------------------------------------------------------------ shell

function buildShell() {
  const sidebar = h('aside', { class: 'sidebar' });
  const viewEl = h('main', { class: 'view', id: 'view' });
  const topbar = h('header', { class: 'topbar' });
  const root = h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, topbar, viewEl));
  root.addEventListener('click', (e) => {
    if (root.classList.contains('nav-open') && (e.target === root || e.target.closest('.nav-item'))) {
      root.classList.remove('nav-open');
    }
  });
  mount(app, root);
  shell = { root, sidebar, viewEl, topbar };
  renderTopbar();
  renderSidebar();
}

function renderSidebar(activeNav, activeProjectId) {
  if (!shell) return;
  const navItem = (href, ic, label, key, count) => h('a', {
    href, class: ['nav-item', activeNav === key && 'active'],
  }, icon(ic, 17), h('span', null, label), count ? h('span', { class: 'count' }, count) : null);

  const active = state.projects.filter((p) => !p.archived);
  const archived = state.projects.filter((p) => p.archived);
  const projectLink = (p) => h('a', {
    href: `/projects/${p.id}`, class: ['nav-item', p.archived && 'archived', activeProjectId === p.id && 'active'],
  },
  h('span', { class: 'project-dot', style: { background: p.color } }, icon(p.icon || 'folder', 11)),
  h('span', { class: 'truncate' }, p.name),
  p.open_tasks ? h('span', { class: 'count' }, p.open_tasks) : null);

  const u = state.user;
  const userBtn = h('button', { class: 'user-chip', onclick: (e) => openUserMenu(e.currentTarget) },
    avatar(u, 30),
    h('div', { class: 'grow' }, h('div', { class: 'name truncate' }, u.name), h('div', { class: 'email truncate' }, u.email)),
    icon('more', 16));

  mount(shell.sidebar,
    h('a', { href: '/dashboard', class: 'brand', style: { textDecoration: 'none' } },
      h('span', { class: 'brand-mark' }, icon('layers', 16)), 'tek-plane'),
    h('div', { class: 'side-scroll' },
      navItem('/dashboard', 'home', 'Dashboard', 'dashboard'),
      navItem('/tasks', 'check-circle', 'My Tasks', 'tasks'),
      navItem('/agenda', 'pin', 'Agenda', 'agenda'),
      navItem('/time', 'clock', 'Time Tracking', 'time'),
      h('div', { class: 'side-label' },
        h('a', { href: '/projects', class: ['side-label-link', activeNav === 'projects' && 'active'] }, 'Projects'),
        h('button', { title: 'New project', 'aria-label': 'New project', onclick: newProject }, icon('plus', 15))),
      active.length ? active.map(projectLink)
        : h('button', { class: 'nav-item', onclick: newProject }, icon('plus', 17), 'Create a project'),
      archived.length ? [h('div', { class: 'side-label' }, 'Archived'), archived.map(projectLink)] : null),
    h('div', { class: 'side-foot' }, userBtn));
}

async function newProject() {
  const { openNewProject } = await import('./components/projectForm.js');
  openNewProject();
}

function openUserMenu(anchor) {
  const theme = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  menu(anchor, [
    { label: 'Profile & settings', icon: 'user', onClick: () => navigate('/profile') },
    { label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? 'sun' : 'moon', onClick: toggleTheme },
    { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', onClick: showShortcuts },
    'divider',
    { label: 'Log out', icon: 'logout', danger: true, onClick: logout },
  ]);
}

export function toggleTheme() {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('tp-theme', next); } catch (_) {}
}

function logout() {
  clearToken();
  disconnectRealtime();
  state.user = null;
  state.board = null;
  shell = null;
  navigate('/login');
}

let timerTick = null;

function renderTopbar() {
  if (!shell) return;
  const t = state.timer;
  clearInterval(timerTick);
  let timerEl = null;
  if (t) {
    const time = h('span', null, fmtDuration((Date.now() - new Date(t.started_at)) / 1000));
    timerTick = setInterval(() => { time.textContent = fmtDuration((Date.now() - new Date(t.started_at)) / 1000); }, 1000);
    timerEl = h('div', { class: 'timer-pill', title: 'Timer running' },
      icon('clock', 15), time,
      h('a', { class: 'timer-task truncate', href: `?task=${t.task.id}`,
        onclick: (e) => { e.preventDefault(); openTaskById(t.task.id); } }, t.task.title),
      h('button', { class: 'icon-btn', title: 'Stop timer', 'aria-label': 'Stop timer', onclick: stopTimer }, icon('stop', 12)));
  }
  mount(shell.topbar,
    h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Menu', onclick: () => shell.root.classList.toggle('nav-open') }, icon('menu', 20)),
    h('button', { class: 'search-trigger', onclick: openSearch },
      icon('search', 15), h('span', { class: 'search-label' }, 'Search tasks and projects'), h('kbd', null, '⌘K')),
    h('div', { class: 'topbar-spacer' }),
    timerEl,
    h('span', { class: 'conn-status', id: 'conn-status', title: 'Live updates connected' }),
    h('button', { class: 'icon-btn bell', id: 'bell', 'aria-label': 'Notifications', onclick: (e) => openNotifications(e.currentTarget) },
      icon('bell', 19), state.unread ? h('span', { class: 'badge-dot' }, state.unread > 99 ? '99+' : state.unread) : null),
    h('button', { class: 'icon-btn', 'aria-label': 'New task', title: 'New task (N)', onclick: () => quickNewTask() }, icon('plus', 19)));
}

async function stopTimer() {
  try {
    const entry = await api.post('/me/timer/stop');
    state.timer = null;
    emit('timer', null);
    if (entry) toast(`Tracked ${fmtDuration(entry.duration_seconds, { short: true })} on “${entry.task.title}”`, 'success');
  } catch (err) { errorToast(err); }
}

async function openSearch() {
  const { openSearch: open } = await import('./components/search.js');
  open();
}

async function openNotifications(anchor) {
  const { openNotifications: open } = await import('./components/notifications.js');
  open(anchor);
}

export async function openTaskById(id) {
  const { openTask } = await import('./components/taskModal.js');
  openTask(id);
}

async function quickNewTask() {
  const { openQuickTask } = await import('./components/quickTask.js');
  openQuickTask();
}

function showShortcuts() {
  const rows = [
    ['⌘K or /', 'Search'], ['N', 'New task'], ['B', 'Board view (in a project)'], ['L', 'List view (in a project)'],
    ['G then D', 'Go to dashboard'], ['G then T', 'Go to My Tasks'], ['G then A', 'Go to Agenda'],
    ['Esc', 'Close dialogs'], ['?', 'This help'],
  ];
  openModal({
    title: 'Keyboard shortcuts', width: 420,
    content: h('div', { class: 'shortcut-list' }, rows.map(([k, label]) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)' } },
      h('span', null, label), h('kbd', null, k)))),
  });
}

// ------------------------------------------------------------------ routing

onRoute(async ({ route, params, query, samePath }) => {
  if (route?.redirect) { navigate(route.redirect, { replace: true }); return; }
  const authed = !!getToken();
  if (!route?.public && !authed) { navigate('/login', { replace: true }); return; }
  if (route?.public && authed && state.user) { navigate('/dashboard', { replace: true }); return; }

  if (samePath) { syncTaskModal(query); return; }

  const token = ++renderToken;
  cleanup?.();
  cleanup = null;

  if (route?.public) {
    shell = null;
    const mod = await route.load();
    if (token !== renderToken) return;
    clear(app);
    cleanup = await mod.default(app, { params, query, ...route.props }) || null;
    return;
  }

  if (!state.user) {
    try { await bootstrap(); } catch (_) { return; }
  }
  if (!shell) buildShell();
  const projectId = params.id ? Number(params.id) : null;
  renderSidebar(route?.nav, projectId);
  if (!route?.load) {
    mount(shell.viewEl, h('div', { class: 'page' }, emptyState('alert', 'Page not found', 'That page does not exist.',
      h('a', { class: 'btn btn-primary', href: '/dashboard' }, 'Go to dashboard'))));
    return;
  }
  mount(shell.viewEl, spinner());
  shell.viewEl.scrollTop = 0;
  try {
    const mod = await route.load();
    if (token !== renderToken) return;
    const container = h('div', { class: 'view-inner' });
    mount(shell.viewEl, container);
    const result = await mod.default(container, { params, query });
    if (token !== renderToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    if (err.status !== 404) console.error(err);
    if (token !== renderToken) return;
    mount(shell.viewEl, h('div', { class: 'page' }, emptyState('alert', err.status === 404 ? 'Not found' : 'Could not load this page',
      err.message, h('a', { class: 'btn btn-primary', href: '/dashboard' }, 'Go to dashboard'))));
  }
  syncTaskModal(query);
});

let modalTaskId = null;

async function syncTaskModal(query) {
  const id = query.task ? Number(query.task) : null;
  if (id && id !== modalTaskId) {
    modalTaskId = id;
    await openTaskById(id);
  } else if (!id && modalTaskId) {
    modalTaskId = null;
    const { closeTask } = await import('./components/taskModal.js');
    closeTask();
  }
}

on('task-modal', (id) => { modalTaskId = id; });

async function bootstrap() {
  try {
    state.user = await api.get('/me');
  } catch (err) {
    clearToken();
    navigate('/login', { replace: true });
    throw err;
  }
  await Promise.all([
    loadProjects(),
    loadTimer().catch(() => null),
    loadPinned().catch(() => null),
    api.get('/notifications?limit=1').then((n) => { state.unread = n.unread; }).catch(() => null),
  ]);
  connectRealtime();
}

// ------------------------------------------------------------------ live sync

const refreshProjects = debounce(() => loadProjects().catch(() => null), 400);
const refreshBoard = debounce(() => {
  if (state.board) loadBoard(state.board.project.id).catch(() => null);
}, 250);

on('ws', (msg) => {
  const b = state.board;
  const onBoard = b && msg.project_id === b.project.id;
  switch (msg.type) {
    case 'task.created':
    case 'task.updated':
      if (onBoard && msg.data.task) upsertBoardTask(msg.data.task);
      if (msg.type === 'task.created') refreshProjects();
      break;
    case 'task.deleted':
      if (onBoard) removeBoardTask(msg.data.task_id);
      refreshProjects();
      break;
    case 'board.changed':
    case 'board.reordered':
    case 'members.changed':
      if (onBoard && msg.actor_id !== state.user?.id) refreshBoard();
      if (msg.type === 'members.changed') refreshProjects();
      break;
    case 'project.updated':
      refreshProjects();
      if (onBoard) { Object.assign(b.project, msg.data.project, { role: b.project.role }); emit('board', b); }
      break;
    case 'project.deleted':
      refreshProjects();
      if (onBoard) {
        if (msg.actor_id !== state.user?.id) toast('You no longer have access to this project');
        navigate('/dashboard');
      }
      break;
    case 'notification':
      state.unread += 1;
      renderTopbar();
      toast(msg.data.message, 'info', msg.data.task_id ? { action: { label: 'Open', onClick: () => openTaskById(msg.data.task_id) } } : {});
      break;
    case 'presence':
      if (b && b.members.some((m) => m.id === msg.data.user_id)) {
        const set = new Set(b.online_user_ids || []);
        msg.data.online ? set.add(msg.data.user_id) : set.delete(msg.data.user_id);
        b.online_user_ids = [...set];
        emit('presence', b.online_user_ids);
      }
      break;
    default:
  }
});

on('ws:status', (s) => {
  const el = document.getElementById('conn-status');
  if (!el) return;
  el.classList.toggle('offline', s !== 'online');
  el.title = s === 'online' ? 'Live updates connected' : 'Reconnecting…';
  if (s === 'online' && state.board) refreshBoard();
});

on('projects', () => {
  const m = location.pathname.match(/^\/projects\/(\d+)/);
  const nav = m ? 'project' : location.pathname.slice(1).split('/')[0];
  renderSidebar(nav, m ? Number(m[1]) : null);
});
on('timer', () => renderTopbar());
on('unread', (n) => { state.unread = n; renderTopbar(); });
on('user', () => renderSidebar(...currentNav()));

function currentNav() {
  const m = location.pathname.match(/^\/projects\/(\d+)/);
  return [m ? 'project' : location.pathname.slice(1).split('/')[0], m ? Number(m[1]) : null];
}

window.addEventListener('tp:unauthorized', () => {
  if (location.pathname !== '/login' && location.pathname !== '/register') logout();
});

// ------------------------------------------------------------------ keyboard

let pendingG = false;
document.addEventListener('keydown', (e) => {
  if (!state.user || !shell) return;
  const t = e.target;
  const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-backdrop')) return;
  const k = e.key.toLowerCase();
  if (pendingG) {
    pendingG = false;
    const dest = { d: '/dashboard', t: '/tasks', a: '/agenda', p: '/projects' }[k];
    if (dest) { e.preventDefault(); navigate(dest); }
    return;
  }
  const pm = location.pathname.match(/^\/projects\/(\d+)/);
  if (k === 'g') { pendingG = true; setTimeout(() => { pendingG = false; }, 1200); }
  else if (k === '/') { e.preventDefault(); openSearch(); }
  else if (k === 'n') { e.preventDefault(); quickNewTask(); }
  else if (k === '?') { e.preventDefault(); showShortcuts(); }
  else if (k === 'b' && pm) navigate(`/projects/${pm[1]}`);
  else if (k === 'l' && pm) navigate(`/projects/${pm[1]}/list`);
});

// ------------------------------------------------------------------ start

export function rerenderShell() {
  renderTopbar();
  renderSidebar(...currentNav());
}

resolve({ force: true });
if (currentQuery().task && !getToken()) navigate('/login', { replace: true });
