// Notifications popover anchored to the bell in the top bar.
import { api } from '../api.js';
import { navigate } from '../router.js';
import { emit } from '../store.js';
import { avatar, errorToast, fmtRelative, h, icon, mount, popover, spinner } from '../ui.js';

export function openNotifications(anchor) {
  let data = null;
  let unreadOnly = false;
  const list = h('div', { class: 'nt-list' }, spinner());
  const head = h('div', { class: 'nt-head' });

  const p = popover(anchor, () => h('div', { class: 'nt-panel' }, head, list), { align: 'end', className: 'nt-popover', width: 380 });

  async function load() {
    try {
      data = await api.get(`/notifications?limit=50${unreadOnly ? '&unread_only=true' : ''}`);
      emit('unread', data.unread);
      draw();
    } catch (err) {
      errorToast(err);
      mount(list, h('div', { class: 'nt-empty' }, 'Could not load notifications.'));
    }
  }

  async function markRead(ids) {
    try {
      await api.post('/notifications/read', ids === 'all' ? { all: true } : { ids });
      if (ids === 'all') { data.items.forEach((n) => { n.read = true; }); data.unread = 0; }
      else {
        data.items.forEach((n) => { if (ids.includes(n.id) && !n.read) { n.read = true; data.unread = Math.max(0, data.unread - 1); } });
      }
      emit('unread', data.unread);
      draw();
    } catch (err) { errorToast(err); }
  }

  function openItem(n) {
    if (!n.read) markRead([n.id]);
    p.close();
    if (n.task_id) import('./taskModal.js').then((m) => m.openTask(n.task_id));
    else if (n.project_id) navigate(`/projects/${n.project_id}`);
  }

  function draw() {
    mount(head,
      h('h2', { class: 'nt-title' }, 'Notifications'),
      data.unread ? h('span', { class: 'nt-count' }, data.unread) : null,
      h('div', { class: 'grow' }),
      h('button', {
        class: ['btn', 'btn-ghost', 'btn-sm', unreadOnly && 'nt-filter-on'], onclick: () => { unreadOnly = !unreadOnly; load(); },
      }, unreadOnly ? 'Show all' : 'Unread only'),
      data.unread ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => markRead('all') }, icon('check', 13), 'Mark all read') : null);
    if (!data.items.length) {
      mount(list, h('div', { class: 'nt-empty' },
        h('div', { class: 'empty-icon' }, icon('bell', 22)),
        h('strong', null, unreadOnly ? 'No unread notifications' : 'You’re all caught up'),
        h('span', null, 'Assignments, mentions, and comments on tasks you watch show up here.')));
      return;
    }
    mount(list, data.items.map((n) => h('button', { class: ['nt-item', !n.read && 'unread'], onclick: () => openItem(n) },
      n.actor ? avatar(n.actor, 32) : h('span', { class: 'nt-sys' }, icon('zap', 15)),
      h('span', { class: 'nt-body' },
        h('span', { class: 'nt-msg' }, n.message),
        h('span', { class: 'nt-time' }, icon(typeIcon(n.type), 12), fmtRelative(n.created_at))),
      !n.read ? h('span', { class: 'nt-dot', 'aria-label': 'Unread' }) : null)));
    p.reposition();
  }

  load();
}

function typeIcon(type) {
  return {
    'task.assigned': 'user', mention: 'message', comment: 'message', 'task.completed': 'check-circle',
    'task.updated': 'edit', 'project.invited': 'user-plus',
  }[type] || 'bell';
}
