// My Tasks: everything assigned to / watched / created by me across projects.
import { api } from '../api.js';
import { loadPinned, on, state } from '../store.js';
import {
  debounce, emptyState, errorToast, h, icon, mount, spinner, startOfDay, toast,
} from '../ui.js';
import { dueChip, priorityBars } from '../components/taskCard.js';
import { openTask } from '../components/taskModal.js';

const PREFS_KEY = 'tp-mytasks';

function loadPrefs() {
  try { return { scope: 'assigned', group: 'due', completed: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (_) { return { scope: 'assigned', group: 'due', completed: false }; }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {}
}

/**
 * Dense task row for personal lists (task from a personal endpoint, with project/section/tags embedded).
 * opts: { onToggle(task), onOpen(task), onPin(task), pinned, showProject = true }
 */
export function taskRow(task, opts = {}) {
  const done = task.status === 'completed';
  return h('div', {
    class: ['mt-row', done && 'done'], tabindex: '0', dataset: { taskId: task.id },
    onclick: () => opts.onOpen?.(task),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) opts.onOpen?.(task); },
  },
  opts.onToggle ? h('button', {
    class: ['checkbox', done && 'checked'], 'aria-label': done ? 'Mark as open' : 'Mark as complete',
    onclick: (e) => { e.stopPropagation(); opts.onToggle(task); },
  }, done ? icon('check', 12) : null) : null,
  h('div', { class: 'mt-row-main' },
    h('div', { class: 'mt-row-title' }, task.title),
    h('div', { class: 'mt-row-sub' },
      opts.showProject !== false && task.project ? h('span', { class: 'mt-proj' },
        h('span', { class: 'swatch', style: { background: task.project.color } }), task.project.name) : null,
      task.section ? h('span', { class: 'mt-sec' }, task.section.name) : null,
      h('span', { class: 'mt-num' }, `#${task.number}`),
      (task.tags || []).slice(0, 3).map((t) => h('span', { class: 'mt-tag', style: { background: t.color } }, t.name)))),
  h('div', { class: 'mt-row-right' },
    task.priority && task.priority !== 'none' ? priorityBars(task.priority) : null,
    task.checklist_total ? h('span', { class: 'meta' }, icon('checklist', 13), `${task.checklist_done}/${task.checklist_total}`) : null,
    task.comments ? h('span', { class: 'meta' }, icon('message', 13), task.comments) : null,
    task.due_date ? dueChip(task.due_date, done) : null,
    opts.onPin ? h('button', {
      class: ['icon-btn', 'sm', 'mt-pin', opts.pinned && 'active'],
      title: opts.pinned ? 'In your agenda' : 'Add to agenda', 'aria-label': opts.pinned ? 'In your agenda' : 'Add to agenda',
      onclick: (e) => { e.stopPropagation(); opts.onPin(task); },
    }, icon('pin', 14)) : null));
}

function dueBucket(t) {
  if (!t.due_date) return 'No date';
  const d = startOfDay(new Date(t.due_date));
  const today = startOfDay(new Date());
  const days = Math.round((d - today) / 86400000);
  if (t.status === 'open' && new Date(t.due_date) < new Date() && days < 0) return 'Overdue';
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return 'This week';
  return 'Later';
}

const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];

export default async function render(root) {
  const prefs = loadPrefs();
  const page = h('div', { class: 'page mt-page' });
  const controls = h('div', { class: 'mt-controls' });
  const list = h('div', { class: 'mt-list' });
  mount(root, page);
  mount(page,
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'My Tasks'),
        h('p', { class: 'page-sub' }, 'Everything on your plate, across all your projects.'))),
    controls, list);
  let tasks = null;

  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', {
    class: v === value && 'active', 'aria-pressed': String(v === value), onclick: () => onPick(v),
  }, label)));

  function drawControls() {
    mount(controls,
      seg([['assigned', 'Assigned to me'], ['watching', 'Watching'], ['created', 'Created by me']], prefs.scope,
        (v) => { prefs.scope = v; savePrefs(prefs); drawControls(); load(); }),
      h('div', { class: 'grow' }),
      h('span', { class: 'small muted' }, 'Group by'),
      seg([['due', 'Due date'], ['project', 'Project']], prefs.group,
        (v) => { prefs.group = v; savePrefs(prefs); drawControls(); draw(); }),
      h('button', {
        class: ['filter-pill', prefs.completed && 'active'],
        onclick: () => { prefs.completed = !prefs.completed; savePrefs(prefs); drawControls(); load(); },
      }, icon('check-circle', 14), prefs.completed ? 'Showing completed' : 'Show completed'));
  }

  async function load() {
    if (!tasks) mount(list, spinner());
    try {
      tasks = await api.get(`/me/tasks?scope=${prefs.scope}&include_completed=${prefs.completed}`);
      draw();
    } catch (err) {
      errorToast(err);
      mount(list, emptyState('alert', 'Could not load tasks', err.message));
    }
  }

  async function toggle(task) {
    const status = task.status === 'completed' ? 'open' : 'completed';
    try {
      await api.patch(`/tasks/${task.id}`, { status });
      if (status === 'completed') {
        toast(`Completed “${task.title}”`, 'success', {
          action: { label: 'Undo', onClick: () => api.patch(`/tasks/${task.id}`, { status: 'open' }).then(load).catch(errorToast) },
        });
      }
      load();
    } catch (err) { errorToast(err); }
  }

  async function pin(task) {
    if (state.pinnedTaskIds.has(task.id)) {
      toast('Already in your agenda');
      return;
    }
    try {
      await api.post('/agenda/pins', { task_id: task.id });
      await loadPinned();
      toast('Added to your agenda', 'success', { action: { label: 'View', onClick: () => import('../router.js').then((r) => r.navigate('/agenda')) } });
      draw();
    } catch (err) { errorToast(err); }
  }

  function draw() {
    if (!tasks) return;
    if (!tasks.length) {
      const msg = {
        assigned: ['Nothing assigned to you', 'Tasks assigned to you in any project will appear here.'],
        watching: ['You are not watching any open tasks', 'You automatically watch tasks you create, comment on, or are assigned to.'],
        created: ['You have not created any open tasks', 'Create a task with N or the + button in the top bar.'],
      }[prefs.scope];
      mount(list, h('div', { class: 'card' }, emptyState('check-circle', ...msg)));
      return;
    }
    const groups = new Map();
    if (prefs.group === 'due') {
      BUCKETS.forEach((b) => groups.set(b, { title: b, tasks: [] }));
      for (const t of tasks) groups.get(dueBucket(t)).tasks.push(t);
    } else {
      for (const t of tasks) {
        const key = t.project?.id ?? 0;
        if (!groups.has(key)) groups.set(key, { title: t.project?.name || 'Project', color: t.project?.color, href: `/projects/${key}`, tasks: [] });
        groups.get(key).tasks.push(t);
      }
    }
    const rowOpts = (t) => ({
      onToggle: toggle, onOpen: () => openTask(t.id), onPin: pin, pinned: state.pinnedTaskIds.has(t.id),
      showProject: prefs.group !== 'project',
    });
    mount(list, [...groups.values()].filter((g) => g.tasks.length).map((g) => h('section', { class: ['card', 'mt-group', g.title === 'Overdue' && 'mt-overdue'] },
      h('div', { class: 'mt-group-head' },
        g.color ? h('span', { class: 'swatch', style: { background: g.color } }) : null,
        g.href ? h('a', { href: g.href, class: 'mt-group-title' }, g.title) : h('h2', { class: 'mt-group-title' }, g.title),
        h('span', { class: 'col-count' }, g.tasks.length)),
      g.tasks
        .sort((a, b) => (a.status === 'completed') - (b.status === 'completed'))
        .map((t) => taskRow(t, rowOpts(t))))));
  }

  drawControls();
  await load();
  const reload = debounce(load, 600);
  const offs = [
    on('ws', (msg) => { if (msg.type?.startsWith('task.') || msg.type === 'board.changed') reload(); }),
    on('task-saved', reload),
    on('pinned', draw),
  ];
  return () => offs.forEach((off) => off());
}
