// List (table) view: sortable, groupable, multi-select with bulk actions.
import { api } from '../api.js';
import { can, loadBoard, member, section as sectionOf, state, tag } from '../store.js';
import {
  PRIORITIES, avatar, confirmDialog, emptyState, errorToast, fmtDuration, h, icon, menu, mount, toast,
} from '../ui.js';
import { applyFilters, filterBar, filtersActive, projectShell } from '../components/projectShell.js';
import { dueChip, priorityBars } from '../components/taskCard.js';
import { openTask } from '../components/taskModal.js';

const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  section: (a, b) => (sectionPos(a) - sectionPos(b)) || (statusRank(a) - statusRank(b)) || (a.position - b.position),
  assignee: (a, b) => cmpNullLast(member(a.assignee_id)?.name, member(b.assignee_id)?.name, (x, y) => x.localeCompare(y)),
  due: (a, b) => cmpNullLast(a.due_date, b.due_date, (x, y) => new Date(x) - new Date(y)),
  priority: (a, b) => (PRIORITIES[b.priority]?.rank || 0) - (PRIORITIES[a.priority]?.rank || 0),
  created: (a, b) => new Date(b.created_at) - new Date(a.created_at),
};

function sectionPos(t) {
  const i = state.board.sections.findIndex((s) => s.id === t.section_id);
  return i < 0 ? 999 : i;
}

function statusRank(t) {
  return { open: 0, completed: 1, archived: 2 }[t.status] ?? 3;
}

function cmpNullLast(a, b, cmp) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return cmp(a, b);
}

const GROUPS = { none: 'No grouping', section: 'Section', assignee: 'Assignee', priority: 'Priority' };

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'list', () => draw());
  const sort = { key: 'section', dir: 1 };
  let groupBy = 'section';
  let includeArchived = false;
  const selected = new Set();

  const toolbar = h('div', { class: 'board-toolbar lv-toolbar' });
  const bulkBar = h('div', { class: 'lv-bulk', role: 'region', 'aria-label': 'Bulk actions' });
  const tableWrap = h('div', { class: 'lv-wrap' });
  mount(shell.body, toolbar, bulkBar, tableWrap);

  function drawToolbar() {
    mount(toolbar, h('div', { class: 'lv-toolbar-row' },
      filterBar(() => draw()),
      h('div', { class: 'grow' }),
      h('button', {
        class: ['filter-pill', groupBy !== 'none' && 'active'],
        onclick: (e) => menu(e.currentTarget, Object.entries(GROUPS).map(([k, label]) => ({
          label, checked: groupBy === k, onClick: () => { groupBy = k; drawToolbar(); draw(); },
        }))),
      }, icon('layers', 14), groupBy === 'none' ? 'Group' : `Group: ${GROUPS[groupBy]}`, icon('chevron-down', 13)),
      h('button', {
        class: ['filter-pill', includeArchived && 'active'], 'aria-pressed': String(includeArchived),
        onclick: () => { includeArchived = !includeArchived; drawToolbar(); draw(); },
      }, icon('archive', 14), includeArchived ? 'Archived shown' : 'Include archived')));
  }

  function visibleTasks() {
    const tasks = applyFilters(state.board.tasks, { includeArchived });
    const cmp = SORTS[sort.key] || SORTS.section;
    return tasks.sort((a, b) => cmp(a, b) * sort.dir || a.number - b.number);
  }

  function groups(tasks) {
    if (groupBy === 'none') return [{ key: 'all', label: null, tasks }];
    const map = new Map();
    const push = (key, label, extra, t) => {
      if (!map.has(key)) map.set(key, { key, label, ...extra, tasks: [] });
      map.get(key).tasks.push(t);
    };
    if (groupBy === 'section') {
      for (const s of state.board.sections) map.set(s.id, { key: s.id, label: s.name, color: s.color, tasks: [] });
      tasks.forEach((t) => push(t.section_id, sectionOf(t.section_id)?.name || 'Unknown', {}, t));
    } else if (groupBy === 'assignee') {
      tasks.forEach((t) => {
        const m = member(t.assignee_id);
        push(m ? m.id : 0, m ? m.name : 'Unassigned', { user: m || null }, t);
      });
    } else if (groupBy === 'priority') {
      for (const k of ['urgent', 'high', 'medium', 'low', 'none']) map.set(k, { key: k, label: PRIORITIES[k].label, color: PRIORITIES[k].color, tasks: [] });
      tasks.forEach((t) => push(t.priority, PRIORITIES[t.priority]?.label, {}, t));
    }
    return [...map.values()].filter((g) => g.tasks.length || groupBy === 'section');
  }

  // ---------------------------------------------------------------- table

  function headerCell(key, label, cls) {
    const active = sort.key === key;
    return h('th', { class: cls, 'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
      key ? h('button', {
        class: ['lv-sort', active && 'active'],
        onclick: () => {
          if (sort.key === key) sort.dir *= -1;
          else { sort.key = key; sort.dir = 1; }
          draw();
        },
      }, label, active ? icon(sort.dir === 1 ? 'chevron-down' : 'chevron-right', 12, sort.dir === 1 ? '' : 'lv-rot') : null) : label);
  }

  function draw() {
    if (!state.board) return;
    // drop selections that no longer exist
    const ids = new Set(state.board.tasks.map((t) => t.id));
    [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });
    const tasks = visibleTasks();
    drawBulk();
    if (!tasks.length) {
      mount(tableWrap, emptyState('list', filtersActive() ? 'No matching tasks' : 'No tasks yet',
        filtersActive() ? 'Try clearing some filters.' : 'Tasks you add on the board show up here.'));
      return;
    }
    const editable = can('member');
    const allChecked = tasks.every((t) => selected.has(t.id));
    const selectAll = editable ? h('button', {
      class: ['checkbox', 'lv-select', allChecked && 'checked'], 'aria-label': allChecked ? 'Deselect all' : 'Select all',
      onclick: () => {
        if (allChecked) tasks.forEach((t) => selected.delete(t.id));
        else tasks.forEach((t) => selected.add(t.id));
        draw();
      },
    }, allChecked ? icon('check', 12) : null) : null;

    const colCount = editable ? 10 : 9;
    const body = h('tbody');
    for (const g of groups(tasks)) {
      if (g.label !== null) {
        body.appendChild(h('tr', { class: 'lv-group' }, h('td', { colspan: colCount },
          h('div', { class: 'lv-group-label' },
            g.user !== undefined ? avatar(g.user, 20) : h('span', { class: 'swatch', style: { background: g.color || 'var(--text-3)' } }),
            h('span', null, g.label), h('span', { class: 'lv-group-count' }, g.tasks.length)))));
      }
      if (!g.tasks.length) {
        body.appendChild(h('tr', { class: 'lv-empty-row' }, h('td', { colspan: colCount }, 'No tasks')));
      }
      g.tasks.forEach((t) => body.appendChild(row(t, editable)));
    }

    const table = h('table', { class: 'lv-table' },
      h('thead', null, h('tr', null,
        editable ? h('th', { class: 'lv-c-sel' }, selectAll) : null,
        h('th', { class: 'lv-c-done' }, h('span', { class: 'sr-only' }, 'Complete')),
        headerCell('created', '#', 'lv-c-num'),
        headerCell('title', 'Task', 'lv-c-title'),
        headerCell('section', 'Section', 'lv-c-section'),
        headerCell('assignee', 'Assignee', 'lv-c-assignee'),
        headerCell('due', 'Due', 'lv-c-due'),
        headerCell('priority', 'Priority', 'lv-c-prio'),
        h('th', { class: 'lv-c-tags' }, 'Tags'),
        h('th', { class: 'lv-c-time' }, 'Time'))),
      body);
    mount(tableWrap, table);
  }

  function row(t, editable) {
    const s = sectionOf(t.section_id);
    const done = t.status === 'completed';
    const isSel = selected.has(t.id);
    return h('tr', {
      class: ['lv-row', done && 'lv-done', t.status === 'archived' && 'lv-archived', isSel && 'lv-selected'],
      tabindex: '0',
      onclick: (e) => { if (!e.target.closest('button')) openTask(t.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openTask(t.id); },
    },
    editable ? h('td', { class: 'lv-c-sel' }, h('button', {
      class: ['checkbox', 'lv-select', isSel && 'checked'], 'aria-label': `Select #${t.number}`,
      onclick: () => { isSel ? selected.delete(t.id) : selected.add(t.id); draw(); },
    }, isSel ? icon('check', 12) : null)) : null,
    h('td', { class: 'lv-c-done' }, t.status === 'archived' ? h('span', { class: 'lv-archived-icon', title: 'Archived' }, icon('archive', 14))
      : h('button', {
        class: ['checkbox', 'lv-round', done && 'checked'], disabled: !editable,
        'aria-label': done ? 'Mark as open' : 'Mark as complete',
        onclick: () => toggleComplete(t),
      }, done ? icon('check', 12) : null)),
    h('td', { class: 'lv-c-num' }, `#${t.number}`),
    h('td', { class: 'lv-c-title' }, h('div', { class: 'lv-title' },
      h('span', { class: 'truncate' }, t.title),
      t.recurrence ? h('span', { class: 'lv-mini', title: `Repeats ${t.recurrence}` }, icon('repeat', 12)) : null,
      t.comments ? h('span', { class: 'lv-mini', title: 'Comments' }, icon('message', 12), t.comments) : null,
      t.checklist_total ? h('span', { class: 'lv-mini', title: 'Checklist' }, icon('checklist', 12), `${t.checklist_done}/${t.checklist_total}`) : null)),
    h('td', { class: 'lv-c-section' }, s ? h('span', { class: 'lv-section' }, h('span', { class: 'swatch', style: { background: s.color } }), h('span', { class: 'truncate' }, s.name)) : ''),
    h('td', { class: 'lv-c-assignee' }, (() => {
      const m = member(t.assignee_id);
      return h('span', { class: 'lv-assignee' }, avatar(m, 22), h('span', { class: 'truncate' }, m ? m.name : 'Unassigned'));
    })()),
    h('td', { class: 'lv-c-due' }, t.due_date ? dueChip(t.due_date, t.status !== 'open') : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'lv-c-prio' }, t.priority && t.priority !== 'none'
      ? h('span', { class: 'lv-prio' }, priorityBars(t.priority), PRIORITIES[t.priority].label) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'lv-c-tags' }, h('div', { class: 'lv-tags' }, t.tag_ids.map(tag).filter(Boolean)
      .map((tg) => h('span', { class: 'card-tag', style: { background: tg.color }, title: tg.name }, tg.name)))),
    h('td', { class: 'lv-c-time' }, t.time_seconds ? fmtDuration(t.time_seconds, { short: true }) : h('span', { class: 'muted' }, '—')));
  }

  async function toggleComplete(t) {
    const status = t.status === 'completed' ? 'open' : 'completed';
    const recurring = !!t.recurrence;
    try {
      Object.assign(t, await api.patch(`/tasks/${t.id}`, { status }));
      if (status === 'completed' && recurring) await loadBoard(projectId); // next occurrence was spawned
      else draw();
    } catch (err) { errorToast(err); }
  }

  // ---------------------------------------------------------------- bulk

  function drawBulk() {
    if (!selected.size || !can('member')) {
      bulkBar.classList.remove('open');
      mount(bulkBar);
      return;
    }
    bulkBar.classList.add('open');
    const b = state.board;
    const act = (label, ic, onclick, cls) => h('button', { class: ['btn', 'btn-sm', cls || 'btn-ghost'], onclick }, icon(ic, 14), label);
    mount(bulkBar,
      h('span', { class: 'lv-bulk-count' }, `${selected.size} selected`),
      act('Complete', 'check', () => bulk('complete')),
      act('Reopen', 'repeat', () => bulk('reopen')),
      act('Move', 'arrow-right', (e) => menu(e.currentTarget, b.sections.map((s) => ({
        label: s.name, swatch: s.color, onClick: () => bulk('move', s.id),
      })))),
      act('Assign', 'user', (e) => menu(e.currentTarget, [
        { label: 'Unassigned', icon: 'circle', onClick: () => bulk('assign', null) },
        'divider',
        ...b.members.filter((m) => m.role !== 'viewer').map((m) => ({ label: m.name, avatar: m, onClick: () => bulk('assign', m.id) })),
      ])),
      act('Priority', 'flag', (e) => menu(e.currentTarget, Object.entries(PRIORITIES).reverse().map(([k, p]) => ({
        label: p.label, swatch: p.color, onClick: () => bulk('priority', k),
      })))),
      act('Archive', 'archive', () => bulk('archive')),
      act('Delete', 'trash', async () => {
        const n = selected.size;
        if (!await confirmDialog(`Delete ${n} task${n > 1 ? 's' : ''}? This can't be undone. Tasks created by others are skipped unless you are an admin.`,
          { title: 'Delete tasks', confirmText: 'Delete', danger: true })) return;
        bulk('delete');
      }, 'btn-ghost lv-danger'),
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Clear selection', onclick: () => { selected.clear(); draw(); } }, icon('x', 15)));
  }

  async function bulk(action, value) {
    const ids = [...selected];
    try {
      const res = await api.post(`/projects/${projectId}/tasks/bulk`, { task_ids: ids, action, value });
      selected.clear();
      await loadBoard(projectId);
      toast(`Updated ${res.count} task${res.count === 1 ? '' : 's'}`, 'success');
    } catch (err) { errorToast(err); }
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && selected.size && !document.querySelector('.modal-backdrop, .popover')) {
      selected.clear();
      draw();
    }
  };
  document.addEventListener('keydown', onKey);

  drawToolbar();
  draw();
  return () => {
    shell.cleanup();
    document.removeEventListener('keydown', onKey);
  };
}
