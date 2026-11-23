// "New task" dialog usable from anywhere (top bar +, N shortcut, dashboard).
import { api } from '../api.js';
import { state, upsertBoardTask } from '../store.js';
import { PRIORITIES, errorToast, fromDateInput, h, icon, mount, openModal, toast } from '../ui.js';
import { openNewProject } from './projectForm.js';

/** opts: { projectId, sectionId, title } */
export function openQuickTask(opts = {}) {
  const eligible = state.projects.filter((p) => !p.archived && p.role && p.role !== 'viewer');
  if (!eligible.length) {
    const m = openModal({
      title: 'New task', width: 440,
      content: h('p', { class: 'confirm-text' }, 'Tasks live inside projects. Create a project first, then add tasks to it.'),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: () => { m.close(); openNewProject(); } }, icon('plus', 15), 'Create project')],
    });
    return;
  }
  const fromUrl = Number(location.pathname.match(/^\/projects\/(\d+)/)?.[1]);
  const projectId = [opts.projectId, fromUrl, state.board?.project.id].find((id) => id && eligible.some((p) => p.id === id)) || eligible[0].id;

  const title = h('input', { class: 'input qt-title', placeholder: 'What needs to be done?', autofocus: true, maxlength: 300, value: opts.title || '' });
  const project = h('select', { class: 'select', id: 'qt-project' }, eligible.map((p) => h('option', { value: p.id, selected: p.id === projectId }, p.name)));
  const section = h('select', { class: 'select', id: 'qt-section', disabled: true }, h('option', null, 'Loading…'));
  const assignee = h('select', { class: 'select', id: 'qt-assignee', disabled: true }, h('option', { value: '' }, 'Unassigned'));
  const due = h('input', { class: 'input', id: 'qt-due', type: 'date' });
  const priority = h('select', { class: 'select', id: 'qt-priority' },
    Object.entries(PRIORITIES).map(([k, p]) => h('option', { value: k }, p.label)));
  const another = h('input', { type: 'checkbox', id: 'qt-another' });
  const submit = h('button', { class: 'btn btn-primary' }, 'Create task');
  let loadSeq = 0;

  async function loadProject(id, preferSection) {
    const my = ++loadSeq;
    section.disabled = true;
    assignee.disabled = true;
    try {
      const board = state.board?.project.id === id ? state.board : await api.get(`/projects/${id}`);
      if (my !== loadSeq) return;
      mount(section, board.sections.map((s) => h('option', { value: s.id, selected: s.id === preferSection }, s.name)));
      const current = assignee.value;
      mount(assignee, h('option', { value: '' }, 'Unassigned'),
        board.members.map((m) => h('option', { value: m.id, selected: String(m.id) === current }, m.id === state.user.id ? `${m.name} (me)` : m.name)));
      section.disabled = !board.sections.length;
      assignee.disabled = false;
    } catch (err) { errorToast(err); }
  }
  project.addEventListener('change', () => loadProject(Number(project.value)));

  const save = async () => {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    if (!section.value || section.disabled) return;
    submit.disabled = true;
    const pid = Number(project.value);
    try {
      const task = await api.post(`/projects/${pid}/tasks`, {
        title: text,
        section_id: Number(section.value),
        assignee_id: assignee.value ? Number(assignee.value) : null,
        due_date: fromDateInput(due.value, 17),
        priority: priority.value,
      });
      upsertBoardTask(task);
      const pname = eligible.find((p) => p.id === pid)?.name;
      toast(`Created “${task.title}” in ${pname}`, 'success', {
        action: { label: 'Open', onClick: () => import('./taskModal.js').then((mod) => mod.openTask(task.id)) },
      });
      if (another.checked) {
        title.value = '';
        due.value = '';
        title.focus();
      } else {
        m.close();
      }
    } catch (err) { errorToast(err); }
    submit.disabled = false;
  };
  submit.addEventListener('click', save);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  const field = (label, id, el) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), el);
  const m = openModal({
    title: 'New task',
    width: 540,
    content: h('div', { class: 'qt-form' },
      h('div', { class: 'field' }, title),
      h('div', { class: 'qt-grid' },
        field('Project', 'qt-project', project),
        field('Section', 'qt-section', section),
        field('Assignee', 'qt-assignee', assignee),
        field('Due date', 'qt-due', due),
        field('Priority', 'qt-priority', priority))),
    footer: [
      h('label', { class: 'qt-another', for: 'qt-another' }, another, 'Create another'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
      submit,
    ],
  });
  loadProject(projectId, opts.sectionId);
}
