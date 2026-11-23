// Shared header for every project view (board, list, timeline, reports, activity, settings)
// plus the filter bar and filtering logic used by board/list/timeline.
import { api } from '../api.js';
import { navigate } from '../router.js';
import { can, emit, loadBoard, loadProjects, on, state } from '../store.js';
import {
  PRIORITIES, avatar, confirmDialog, debounce, errorToast, h, icon, menu, mount, pickerPopover, toast,
} from '../ui.js';
import { openNewProject } from './projectForm.js';

const TABS = [
  ['', 'board', 'Board'],
  ['/list', 'list', 'List'],
  ['/timeline', 'timeline', 'Timeline'],
  ['/reports', 'chart', 'Reports'],
  ['/activity', 'activity', 'Activity'],
];

// ------------------------------------------------------------------ filters

export const filters = {
  projectId: null,
  q: '',
  assignee: null, // user id | 'me' | 'none' | null
  tags: [],
  due: null, // overdue | today | week | none | null
  priority: null,
  showCompleted: true,
};

function resetFiltersFor(projectId) {
  if (filters.projectId === projectId) return;
  Object.assign(filters, { projectId, q: '', assignee: null, tags: [], due: null, priority: null, showCompleted: true });
}

export function filtersActive() {
  return !!(filters.q || filters.assignee || filters.tags.length || filters.due || filters.priority);
}

export function applyFilters(tasks, { includeArchived = false } = {}) {
  const q = filters.q.trim().toLowerCase();
  const now = new Date();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const endWeek = new Date(endToday.getTime() + 6 * 86400000);
  return tasks.filter((t) => {
    if (t.status === 'archived' && !includeArchived) return false;
    if (t.status === 'completed' && !filters.showCompleted) return false;
    if (q && !(`#${t.number} ${t.title} ${t.description}`.toLowerCase().includes(q))) return false;
    if (filters.assignee === 'me' && t.assignee_id !== state.user.id) return false;
    if (filters.assignee === 'none' && t.assignee_id) return false;
    if (typeof filters.assignee === 'number' && t.assignee_id !== filters.assignee) return false;
    if (filters.tags.length && !filters.tags.every((id) => t.tag_ids.includes(id))) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.due) {
      const d = t.due_date ? new Date(t.due_date) : null;
      if (filters.due === 'none' && d) return false;
      if (filters.due !== 'none' && !d) return false;
      if (filters.due === 'overdue' && !(d < now && t.status === 'open')) return false;
      if (filters.due === 'today' && !(d <= endToday)) return false;
      if (filters.due === 'week' && !(d <= endWeek)) return false;
    }
    return true;
  });
}

/** Filter toolbar. onChange is called after any filter change. */
export function filterBar(onChange, { showCompletedToggle = true } = {}) {
  const b = state.board;
  const bar = h('div', { class: 'filter-bar' });
  const changed = () => { draw(); onChange(); };
  const search = h('input', { class: 'input input-sm filter-search', placeholder: 'Filter tasks…', value: filters.q });
  search.addEventListener('input', debounce(() => { filters.q = search.value; onChange(); }, 150));

  const pill = (label, active, onclick, ic) => h('button', { class: ['filter-pill', active && 'active'], onclick },
    ic ? icon(ic, 14) : null, label, icon('chevron-down', 13));

  function draw() {
    const who = filters.assignee === 'me' ? 'Me' : filters.assignee === 'none' ? 'Unassigned'
      : typeof filters.assignee === 'number' ? (b.members.find((m) => m.id === filters.assignee)?.name || 'Someone') : 'Assignee';
    const dueLabels = { overdue: 'Overdue', today: 'Due today', week: 'Due this week', none: 'No due date' };
    const tagLabel = filters.tags.length ? `${filters.tags.length} tag${filters.tags.length > 1 ? 's' : ''}` : 'Tags';
    mount(bar,
      h('div', { class: 'filter-search-wrap' }, icon('search', 14), search),
      pill(who, filters.assignee !== null, (e) => menu(e.currentTarget, [
        { label: 'Anyone', checked: filters.assignee === null, onClick: () => { filters.assignee = null; changed(); } },
        { label: 'Me', icon: 'user', checked: filters.assignee === 'me', onClick: () => { filters.assignee = 'me'; changed(); } },
        { label: 'Unassigned', icon: 'circle', checked: filters.assignee === 'none', onClick: () => { filters.assignee = 'none'; changed(); } },
        'divider',
        ...b.members.map((m) => ({ label: m.name, avatar: m, checked: filters.assignee === m.id, onClick: () => { filters.assignee = m.id; changed(); } })),
      ]), 'user'),
      pill(tagLabel, filters.tags.length > 0, (e) => pickerPopover(e.currentTarget, {
        items: b.tags.map((t) => ({ value: t.id, label: t.name, color: t.color })),
        selected: filters.tags, multi: true, placeholder: 'Find tag…',
        render: (it) => [h('span', { class: 'swatch', style: { background: it.color } }), h('span', { class: 'menu-label' }, it.label)],
        onChange: (ids) => { filters.tags = ids; draw(); onChange(); },
      }), 'tag'),
      pill(filters.due ? dueLabels[filters.due] : 'Due date', !!filters.due, (e) => menu(e.currentTarget, [
        { label: 'Any time', checked: !filters.due, onClick: () => { filters.due = null; changed(); } },
        ...Object.entries(dueLabels).map(([k, label]) => ({ label, checked: filters.due === k, onClick: () => { filters.due = k; changed(); } })),
      ]), 'calendar'),
      pill(filters.priority ? PRIORITIES[filters.priority].label : 'Priority', !!filters.priority, (e) => menu(e.currentTarget, [
        { label: 'Any priority', checked: !filters.priority, onClick: () => { filters.priority = null; changed(); } },
        ...Object.entries(PRIORITIES).reverse().map(([k, p]) => ({ label: p.label, swatch: p.color, checked: filters.priority === k, onClick: () => { filters.priority = k; changed(); } })),
      ]), 'flag'),
      showCompletedToggle ? h('button', {
        class: ['filter-pill', !filters.showCompleted && 'active'],
        onclick: () => { filters.showCompleted = !filters.showCompleted; changed(); },
      }, icon(filters.showCompleted ? 'eye' : 'check-circle', 14), filters.showCompleted ? 'Hide completed' : 'Completed hidden') : null,
      filtersActive() ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
        Object.assign(filters, { q: '', assignee: null, tags: [], due: null, priority: null });
        search.value = '';
        changed();
      } }, icon('x', 13), 'Clear') : null);
  }
  draw();
  return bar;
}

// ------------------------------------------------------------------ header

/**
 * Loads the project board into state.board and renders the project header + tabs.
 * Returns { body, board, cleanup }. `body` is the element views render into.
 * onBoard is called whenever state.board changes (realtime or local).
 */
export async function projectShell(root, projectId, tab, onBoard) {
  projectId = Number(projectId);
  resetFiltersFor(projectId);
  const board = await loadBoard(projectId);
  const header = h('div', { class: 'project-header' });
  const body = h('div', { class: 'project-body' });
  root.classList.add('project-view');
  mount(root, header, body);

  const drawHeader = () => {
    const b = state.board;
    const p = b.project;
    const online = new Set(b.online_user_ids || []);
    mount(header,
      h('div', { class: 'project-title-row' },
        h('span', { class: 'project-dot lg', style: { background: p.color } }, icon(p.icon || 'folder', 16)),
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: { gap: '8px' } },
            h('h1', { class: 'project-name truncate' }, p.name),
            p.archived ? h('span', { class: 'role-badge' }, 'Archived') : null,
            h('button', { class: 'icon-btn sm', 'aria-label': 'Project menu', onclick: (e) => projectMenu(e.currentTarget) }, icon('chevron-down', 16))),
          p.description ? h('div', { class: 'project-desc truncate' }, p.description) : null),
        h('div', { class: 'project-members' },
          b.members.slice(0, 6).map((m) => h('span', { class: 'avatar-wrap', title: `${m.name}${online.has(m.id) ? ' (online)' : ''}` },
            avatar(m, 30, { title: false }), online.has(m.id) ? h('span', { class: 'online-dot' }) : null)),
          b.members.length > 6 ? h('span', { class: 'avatar avatar-more', style: { width: '30px', height: '30px' } }, `+${b.members.length - 6}`) : null,
          can('admin') ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => navigate(`/projects/${p.id}/settings?tab=members`) },
            icon('user-plus', 14), 'Invite') : null)),
      h('nav', { class: 'tabs project-tabs' },
        TABS.map(([suffix, ic, label]) => h('a', {
          href: `/projects/${p.id}${suffix}`, class: ['tab', tab === (suffix.slice(1) || 'board') && 'active'],
        }, icon(ic, 15), label)),
        h('div', { class: 'grow' }),
        h('a', { href: `/projects/${p.id}/settings`, class: ['tab', tab === 'settings' && 'active'] }, icon('settings', 15), 'Settings')));
  };

  async function projectMenu(anchor) {
    const p = state.board.project;
    menu(anchor, [
      can('admin') ? { label: 'Edit project', icon: 'edit', onClick: () => openNewProject(p) } : null,
      { label: 'Project settings', icon: 'settings', onClick: () => navigate(`/projects/${p.id}/settings`) },
      can('admin') ? { label: p.archived ? 'Restore project' : 'Archive project', icon: 'archive', onClick: async () => {
        try {
          await api.patch(`/projects/${p.id}`, { archived: !p.archived });
          p.archived = !p.archived;
          await loadProjects();
          emit('board', state.board);
          toast(p.archived ? 'Project archived' : 'Project restored', 'success');
        } catch (err) { errorToast(err); }
      } } : null,
      p.role !== 'owner' ? { label: 'Leave project', icon: 'logout', danger: true, onClick: async () => {
        if (!await confirmDialog(`You will lose access to “${p.name}”.`, { title: 'Leave project?', confirmText: 'Leave', danger: true })) return;
        try {
          await api.del(`/projects/${p.id}/members/${state.user.id}`);
          await loadProjects();
          navigate('/dashboard');
        } catch (err) { errorToast(err); }
      } } : null,
    ]);
  }

  drawHeader();
  const offs = [
    on('board', (b) => { if (b?.project.id === projectId) { drawHeader(); onBoard?.(b); } }),
    on('presence', () => drawHeader()),
  ];
  return { body, board, cleanup: () => offs.forEach((off) => off()) };
}
