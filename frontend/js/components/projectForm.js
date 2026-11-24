import { api } from '../api.js';
import { navigate } from '../router.js';
import { loadProjects } from '../store.js';
import { COLORS, PROJECT_ICONS, colorSwatches, errorToast, h, icon, mount, openModal } from '../ui.js';

export const TEMPLATE_INFO = {
  kanban: { label: 'Kanban', desc: 'Open, In Progress, Review, Done' },
  scrum: { label: 'Scrum', desc: 'Backlog, Sprint, In Progress, Testing, Done' },
  personal: { label: 'Personal', desc: 'To Do, Doing, Done' },
  marketing: { label: 'Content', desc: 'Ideas, Planned, Writing, Approval, Published' },
  blank: { label: 'Blank', desc: 'Start with one empty section' },
};

/** Opens the create-project dialog, or edit mode when `project` is given. */
export function openNewProject(project = null, { kind: presetKind = 'board' } = {}) {
  const editing = !!project;
  let kind = project?.kind || presetKind;
  let color = project?.color || COLORS[kind === 'mindmap' ? 1 : 0];
  let iconName = project?.icon || (kind === 'mindmap' ? 'mindmap' : 'folder');
  let iconTouched = !!project;
  let template = 'kanban';
  const name = h('input', { class: 'input', value: project?.name || '', placeholder: 'e.g. Website relaunch', autofocus: true, maxlength: 160 });
  const desc = h('textarea', { class: 'textarea', placeholder: 'What is this project about? (optional)', rows: 3 }, project?.description || '');
  const preview = h('span', { class: 'project-dot', style: { width: '40px', height: '40px', borderRadius: '11px' } });
  const drawPreview = () => {
    preview.style.background = color;
    mount(preview, icon(iconName, 20));
  };
  drawPreview();

  const icons = h('div', { class: 'icon-grid' });
  const drawIcons = () => mount(icons, PROJECT_ICONS.map((n) => h('button', {
    type: 'button', class: ['icon-btn', n === iconName && 'active'], 'aria-label': n,
    onclick: () => { iconName = n; iconTouched = true; drawIcons(); drawPreview(); },
  }, icon(n, 16))));
  drawIcons();

  const templates = h('div', { class: 'template-grid' });
  const drawTemplates = () => mount(templates, Object.entries(TEMPLATE_INFO).map(([id, t]) => h('button', {
    type: 'button', class: ['template-card', id === template && 'active'], onclick: () => { template = id; drawTemplates(); },
  }, h('strong', null, t.label), h('span', null, t.desc))));
  drawTemplates();

  const templateField = h('div', { class: 'field' }, h('label', { class: 'label' }, 'Board layout'), templates);
  const kinds = h('div', { class: 'kind-grid' });
  const drawKinds = () => {
    mount(kinds, [
      ['board', 'board', 'Board', 'Tasks in columns, with list, timeline and reports. Mind maps can be added inside.'],
      ['mindmap', 'mindmap', 'Mind map', 'The whole project is one mind map. Brainstorm freely, then add a board when you want tasks.'],
    ].map(([id, ic, label, desc]) => h('button', {
      type: 'button', class: ['kind-card', kind === id && 'active'], 'aria-pressed': String(kind === id),
      onclick: () => {
        kind = id;
        if (!iconTouched) { iconName = id === 'mindmap' ? 'mindmap' : 'folder'; drawIcons(); drawPreview(); }
        drawKinds();
      },
    }, h('span', { class: 'kind-icon' }, icon(ic, 20)), h('strong', null, label), h('span', null, desc))));
    templateField.style.display = kind === 'mindmap' ? 'none' : '';
    name.placeholder = kind === 'mindmap' ? 'e.g. Product ideas 2027' : 'e.g. Website relaunch';
    name.closest('.field')?.querySelector('.label')?.replaceChildren(kind === 'mindmap' ? 'Central topic' : 'Project name');
  };

  const submit = h('button', { class: 'btn btn-primary' }, editing ? 'Save changes' : 'Create project');
  const save = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    submit.disabled = true;
    try {
      const body = { name: name.value.trim(), description: desc.value, color, icon: iconName };
      if (editing) {
        await api.patch(`/projects/${project.id}`, body);
        await loadProjects();
        m.close();
      } else {
        const p = await api.post('/projects', { ...body, template, kind });
        await loadProjects();
        m.close();
        navigate(`/projects/${p.id}`);
      }
    } catch (err) {
      errorToast(err);
      submit.disabled = false;
    }
  };
  submit.addEventListener('click', save);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  const m = openModal({
    title: editing ? 'Edit project' : 'New project',
    width: 560,
    content: h('div', null,
      editing ? null : h('div', { class: 'field' }, h('label', { class: 'label' }, 'Type'), kinds),
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-end', marginBottom: '14px' } },
        preview,
        h('div', { class: 'field grow', style: { margin: 0 } }, h('label', { class: 'label' }, 'Project name'), name)),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Description'), desc),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Color'), colorSwatches(color, (c) => { color = c; drawPreview(); })),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Icon'), icons),
      editing ? null : templateField),
    footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'), submit],
  });
  if (!editing) drawKinds();
}
