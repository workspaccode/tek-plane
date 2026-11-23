// Human-readable text for activity entries (project activity, dashboard feed, task history).
import { PRIORITIES, fmtDate, fmtDuration, h } from '../ui.js';

/** Returns a DOM fragment like: "<b>Alice</b> moved <b>#12 Write spec</b> to Done". */
export function activityText(a, { withTask = true } = {}) {
  const d = a.data || {};
  const who = h('strong', null, a.user?.name || 'Someone');
  const task = withTask && d.task_title ? h('strong', { class: 'act-task' }, `#${d.task_number} ${d.task_title}`) : (withTask ? 'a task' : 'this task');
  const b = (s) => h('strong', null, s);
  const parts = (() => {
    switch (a.action) {
      case 'project.created': return ['created the project ', b(d.name || '')];
      case 'project.updated': return ['updated project settings'];
      case 'project.archived': return ['archived the project'];
      case 'project.restored': return ['restored the project'];
      case 'member.added': return ['added ', b(d.member), ` as ${d.role}`];
      case 'member.removed': return ['removed ', b(d.member)];
      case 'member.role': return ['changed ', b(d.member), `'s role to ${d.role}`];
      case 'section.created': return ['added the section ', b(d.name)];
      case 'section.deleted': return ['deleted the section ', b(d.name)];
      case 'automation.created': return ['added an automation to ', b(d.section)];
      case 'automation.ran': return ['Automation in ', b(d.section), ' updated ', task];
      case 'task.created': return [d.duplicated_from ? 'duplicated ' : 'created ', task, d.section ? ` in ${d.section}` : ''];
      case 'task.deleted': return ['deleted ', task];
      case 'task.completed': return ['completed ', task];
      case 'task.reopened': return ['reopened ', task];
      case 'task.archived': return ['archived ', task];
      case 'task.renamed': return ['renamed ', b(d.old), ' to ', b(d.new)];
      case 'task.description': return ['edited the description of ', task];
      case 'task.assigned': return d.assignee ? ['assigned ', task, ' to ', b(d.assignee)] : ['unassigned ', task];
      case 'task.due_date': return d.value ? ['set the due date of ', task, ` to ${fmtDate(d.value + 'Z')}`] : ['removed the due date of ', task];
      case 'task.start_date': return d.value ? ['set the start date of ', task, ` to ${fmtDate(d.value + 'Z')}`] : ['removed the start date of ', task];
      case 'task.priority': return ['set priority of ', task, ` to ${PRIORITIES[d.value]?.label || d.value}`];
      case 'task.recurrence': return d.value ? ['made ', task, ` repeat ${d.value}`] : ['stopped ', task, ' from repeating'];
      case 'task.recurred': return ['created the next occurrence ', task];
      case 'task.tags': return ['updated tags on ', task];
      case 'task.moved': return ['moved ', task, ' to ', b(d.section)];
      case 'task.moved_out': return ['moved ', task, ' to project ', b(d.to_project)];
      case 'task.bulk': return [`updated ${d.count} tasks (${d.operation})`];
      case 'checklist.created': return ['added the checklist ', b(d.name), ' to ', task];
      case 'checklist.checked': return ['checked ', b(d.item), ' on ', task];
      case 'checklist.unchecked': return ['unchecked ', b(d.item), ' on ', task];
      case 'comment.added': return ['commented on ', task];
      case 'attachment.added': return ['attached ', b(d.filename), ' to ', task];
      case 'time.tracked': return [`tracked ${fmtDuration(d.seconds, { short: true })} on `, task];
      case 'relation.added': return ['linked ', task, ` (${d.type}) `, b(d.other)];
      default: return [a.action.replace('.', ' '), ' ', task];
    }
  })();
  const isSystem = a.action === 'automation.ran';
  return h('span', { class: 'act-text' }, isSystem ? null : [who, ' '], parts);
}

export function activityIcon(action) {
  const map = {
    'task.created': 'plus', 'task.completed': 'check-circle', 'task.reopened': 'repeat', 'task.archived': 'archive',
    'task.deleted': 'trash', 'task.moved': 'arrow-right', 'task.assigned': 'user', 'comment.added': 'message',
    'attachment.added': 'paperclip', 'time.tracked': 'clock', 'automation.ran': 'zap', 'member.added': 'user-plus',
    'checklist.checked': 'checklist', 'relation.added': 'link', 'task.due_date': 'calendar', 'task.priority': 'flag',
  };
  return map[action] || 'activity';
}
