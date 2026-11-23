// Project activity feed: paginated, grouped by day, live-refreshing.
import { api } from '../api.js';
import { avatar, debounce, emptyState, errorToast, fmtDateTime, fmtRelative, h, icon, mount, spinner, startOfDay } from '../ui.js';
import { activityIcon, activityText } from '../components/activityText.js';
import { projectShell } from '../components/projectShell.js';
import { openTask } from '../components/taskModal.js';

const PAGE = 50;

function dayLabel(d) {
  const today = startOfDay(new Date());
  const diff = Math.round((today - startOfDay(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  let items = [];
  let hasMore = true;
  let loadingMore = false;

  const refresh = debounce(async () => {
    try {
      const latest = await api.get(`/projects/${projectId}/activity?limit=${PAGE}`);
      const known = new Set(items.map((a) => a.id));
      const fresh = latest.filter((a) => !known.has(a.id));
      if (fresh.length) {
        items = [...fresh, ...items].sort((a, b) => b.id - a.id);
        draw();
      }
    } catch (_) { /* transient */ }
  }, 700);

  const shell = await projectShell(root, projectId, 'activity', () => refresh());
  const page = h('div', { class: 'pa-page' });
  mount(shell.body, page);
  mount(page, spinner());

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    draw();
    try {
      const before = items.length ? items[items.length - 1].id : null;
      const batch = await api.get(`/projects/${projectId}/activity?limit=${PAGE}${before ? `&before=${before}` : ''}`);
      items.push(...batch);
      hasMore = batch.length === PAGE;
    } catch (err) {
      errorToast(err);
    } finally {
      loadingMore = false;
      draw();
    }
  }

  function entry(a) {
    const clickable = !!a.task_id && !['task.deleted', 'task.moved_out'].includes(a.action);
    const isSystem = a.action === 'automation.ran';
    return h(clickable ? 'button' : 'div', {
      class: ['pa-item', clickable && 'pa-clickable'],
      onclick: clickable ? () => openTask(a.task_id) : null,
    },
    h('div', { class: 'pa-avatar' },
      isSystem ? h('span', { class: 'pa-system' }, icon('zap', 14)) : avatar(a.user, 32),
      h('span', { class: 'pa-badge' }, icon(activityIcon(a.action), 11))),
    h('div', { class: 'pa-body' },
      activityText(a),
      a.action === 'comment.added' && a.data?.excerpt
        ? h('div', { class: 'pa-quote' }, a.data.excerpt.replace(/@\[([^\]]+)\]\(\d+\)/g, '@$1')) : null,
      h('time', { class: 'pa-time', datetime: a.created_at, title: fmtDateTime(a.created_at) }, fmtRelative(a.created_at))));
  }

  function draw() {
    if (!items.length && !loadingMore) {
      mount(page, emptyState('activity', 'No activity yet', 'Changes to tasks, sections and members will appear here.'));
      return;
    }
    const groups = [];
    for (const a of items) {
      const label = dayLabel(new Date(a.created_at));
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(a);
    }
    mount(page,
      h('div', { class: 'pa-head' }, h('h2', { class: 'rp-title' }, 'Activity'),
        h('p', { class: 'rp-sub' }, 'Everything that happened in this project, newest first.')),
      groups.map((g) => h('section', { class: 'pa-group' },
        h('h3', { class: 'pa-day' }, g.label),
        h('div', { class: 'card pa-list' }, g.items.map(entry)))),
      hasMore ? h('div', { class: 'pa-more' },
        h('button', { class: 'btn btn-secondary', disabled: loadingMore, onclick: loadMore }, loadingMore ? 'Loading…' : 'Load more'))
        : items.length > 10 ? h('p', { class: 'pa-end' }, 'That’s everything.') : null);
  }

  await loadMore();
  return () => shell.cleanup();
}
