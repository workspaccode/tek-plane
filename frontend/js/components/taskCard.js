// Task card used on the board, agenda and personal lists.
import { PRIORITIES, avatar, dueInfo, fmtDuration, h, icon } from '../ui.js';

export function priorityBars(priority) {
  const p = PRIORITIES[priority] || PRIORITIES.none;
  const lvl = { none: 0, low: 1, medium: 2, high: 3, urgent: 3 }[priority] || 0;
  return h('span', { class: 'prio', style: { color: p.color }, title: `${p.label} priority` },
    h('span', { class: 'prio-bars' }, [1, 2, 3].map((i) => h('i', { class: i <= lvl ? 'on' : '' }))),
    priority === 'urgent' ? icon('alert', 12) : null);
}

export function dueChip(iso, completed) {
  const d = dueInfo(iso, completed);
  if (!d) return null;
  return h('span', { class: ['chip', 'due-chip', d.cls] }, icon('calendar', 12), d.text);
}

/**
 * task: task summary from the API.
 * opts: { tags: [{name,color}], assignee: user|null, project: {name,color}|null, onToggle, onOpen, compact }
 */
export function taskCard(task, opts = {}) {
  const completed = task.status === 'completed';
  const meta = [];
  if (task.due_date) meta.push(dueChip(task.due_date, completed));
  if (task.checklist_total) {
    const done = task.checklist_done === task.checklist_total;
    meta.push(h('span', { class: ['meta', done && 'meta-done'], title: 'Checklist' }, icon('checklist', 13), `${task.checklist_done}/${task.checklist_total}`));
  }
  if (task.comments) meta.push(h('span', { class: 'meta', title: 'Comments' }, icon('message', 13), task.comments));
  if (task.attachments) meta.push(h('span', { class: 'meta', title: 'Attachments' }, icon('paperclip', 13), task.attachments));
  if (task.time_seconds) meta.push(h('span', { class: 'meta', title: 'Tracked time' }, icon('clock', 13), fmtDuration(task.time_seconds, { short: true })));
  if (task.relations) meta.push(h('span', { class: 'meta', title: 'Linked tasks' }, icon('link', 13), task.relations));
  if (task.recurrence) meta.push(h('span', { class: 'meta', title: `Repeats ${task.recurrence}` }, icon('repeat', 13)));

  const check = h('button', {
    class: ['card-check', 'checkbox', completed && 'checked'],
    'aria-label': completed ? 'Mark as open' : 'Mark as complete',
    onclick: (e) => { e.stopPropagation(); opts.onToggle?.(task); },
  }, completed ? icon('check', 12) : null);

  const card = h('div', {
    class: ['task-card', completed && 'completed', opts.compact && 'compact'],
    tabindex: '0', dataset: { taskId: task.id },
    onclick: () => opts.onOpen?.(task),
    onkeydown: (e) => { if (e.key === 'Enter') opts.onOpen?.(task); },
  },
  opts.project ? h('div', { class: 'card-project' }, h('span', { class: 'swatch', style: { background: opts.project.color } }), opts.project.name) : null,
  (opts.tags || []).length ? h('div', { class: 'card-tags' }, opts.tags.map((t) => h('span', { class: 'card-tag', style: { background: t.color }, title: t.name }, t.name))) : null,
  h('div', { class: 'card-main' },
    opts.onToggle ? check : null,
    h('div', { class: 'card-title' }, task.title)),
  h('div', { class: 'card-foot' },
    h('span', { class: 'card-num' }, `#${task.number}`),
    task.priority && task.priority !== 'none' ? priorityBars(task.priority) : null,
    h('div', { class: 'card-meta' }, meta),
    h('div', { class: 'grow' }),
    opts.assignee !== undefined ? avatar(opts.assignee, 24) : null));
  return card;
}
