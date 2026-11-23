// Kanban board: sections as columns, drag & drop for tasks and sections, inline quick add.
import { api } from '../api.js';
import { navigate } from '../router.js';
import { can, emit, loadBoard, member, state, tag } from '../store.js';
import {
  COLORS, confirmDialog, emptyState, errorToast, h, icon, menu, mount, openModal, promptDialog, toast,
} from '../ui.js';
import { applyFilters, filterBar, filtersActive, projectShell } from '../components/projectShell.js';
import { taskCard } from '../components/taskCard.js';
import { openTask } from '../components/taskModal.js';

const SECTION_ICONS = ['circle', 'inbox', 'play', 'eye', 'check', 'flag', 'beaker', 'bulb', 'pen', 'calendar', 'star', 'zap', 'alert', 'archive'];

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'board', () => draw());
  const toolbar = h('div', { class: 'board-toolbar' });
  const boardEl = h('div', { class: 'board', role: 'list' });
  mount(shell.body, toolbar, boardEl);
  mount(toolbar, filterBar(() => draw()));

  let drag = null; // { type: 'task'|'section', id }
  const openComposers = new Set();

  function sortedTasks(sectionId, tasks) {
    const inSection = tasks.filter((t) => t.section_id === sectionId);
    const open = inSection.filter((t) => t.status === 'open').sort((a, b) => a.position - b.position);
    const done = inSection.filter((t) => t.status !== 'open')
      .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
    return [...open, ...done];
  }

  function draw() {
    const b = state.board;
    if (!b) return;
    const scrollLeft = boardEl.scrollLeft;
    const tasks = applyFilters(b.tasks);
    const columns = b.sections.map((s) => column(s, sortedTasks(s.id, tasks), b.tasks.filter((t) => t.section_id === s.id && t.status === 'open').length));
    if (can('admin')) columns.push(addSectionColumn());
    mount(boardEl, columns);
    boardEl.scrollLeft = scrollLeft;
    for (const sid of openComposers) boardEl.querySelector(`[data-section-id="${sid}"] .composer textarea`)?.focus();
  }

  // ---------------------------------------------------------------- columns

  function column(section, tasks, openCount) {
    const editable = can('member');
    const over = section.wip_limit && openCount > section.wip_limit;
    const list = h('div', { class: 'col-tasks', dataset: { sectionId: section.id } },
      tasks.map((t) => card(t)),
      !tasks.length && filtersActive() ? h('div', { class: 'col-empty' }, 'No matching tasks') : null);

    const head = h('div', {
      class: 'col-head', draggable: can('admin') ? 'true' : null,
      ondragstart: (e) => {
        if (e.target.closest('button')) return;
        drag = { type: 'section', id: section.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `section:${section.id}`);
        requestAnimationFrame(() => col.classList.add('dragging'));
      },
      ondragend: () => { col.classList.remove('dragging'); drag = null; clearMarkers(); },
    },
    h('span', { class: 'col-icon', style: { background: section.color } }, icon(section.icon || 'circle', 13)),
    h('span', { class: 'col-name truncate', title: section.name }, section.name),
    h('span', { class: ['col-count', over && 'over'], title: section.wip_limit ? `WIP limit ${section.wip_limit}` : 'Open tasks' },
      section.wip_limit ? `${openCount}/${section.wip_limit}` : openCount),
    section.automations.some((a) => a.active) ? h('span', { class: 'col-auto', title: `${section.automations.filter((a) => a.active).length} automation(s)` }, icon('zap', 13)) : null,
    h('div', { class: 'grow' }),
    editable ? h('button', { class: 'icon-btn sm', 'aria-label': 'Add task', title: 'Add task to top', onclick: () => openComposer(section.id, 0) }, icon('plus', 15)) : null,
    can('admin') ? h('button', { class: 'icon-btn sm', 'aria-label': 'Section menu', onclick: (e) => sectionMenu(e.currentTarget, section) }, icon('more', 15)) : null);

    const col = h('section', { class: ['column', over && 'over-limit'], dataset: { sectionId: section.id }, style: { '--col-color': section.color } },
      head, list,
      editable ? composer(section.id) : null);

    // drop target for tasks
    list.addEventListener('dragover', (e) => {
      if (drag?.type !== 'task') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showTaskMarker(list, e.clientY);
    });
    list.addEventListener('drop', (e) => {
      if (drag?.type !== 'task') return;
      e.preventDefault();
      const index = markerIndex(list);
      clearMarkers();
      moveTask(drag.id, section.id, index);
    });
    // drop target for sections
    col.addEventListener('dragover', (e) => {
      if (drag?.type !== 'section') return;
      e.preventDefault();
      const r = col.getBoundingClientRect();
      clearMarkers();
      col.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    });
    col.addEventListener('drop', (e) => {
      if (drag?.type !== 'section') return;
      e.preventDefault();
      const after = col.classList.contains('drop-after');
      clearMarkers();
      reorderSection(drag.id, section.id, after);
    });
    return col;
  }

  function card(t) {
    const el = taskCard(t, {
      tags: t.tag_ids.map(tag).filter(Boolean),
      assignee: member(t.assignee_id),
      onOpen: () => openTask(t.id),
      onToggle: can('member') ? toggleComplete : null,
    });
    if (can('member')) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        drag = { type: 'task', id: t.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `task:${t.id}`);
        requestAnimationFrame(() => el.classList.add('dragging'));
      });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); drag = null; clearMarkers(); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); cardMenu(el, t); });
    }
    return el;
  }

  function addSectionColumn() {
    return h('button', { class: 'add-column', onclick: addSection }, icon('plus', 16), 'Add section');
  }

  // ---------------------------------------------------------------- drag helpers

  const marker = h('div', { class: 'drop-marker' });

  function showTaskMarker(list, y) {
    const cards = [...list.querySelectorAll('.task-card:not(.dragging):not(.completed)')];
    const before = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (before) list.insertBefore(marker, before);
    else {
      const firstDone = list.querySelector('.task-card.completed:not(.dragging)');
      firstDone ? list.insertBefore(marker, firstDone) : list.appendChild(marker);
    }
  }

  function markerIndex(list) {
    let i = 0;
    for (const el of list.children) {
      if (el === marker) return i;
      if (el.classList.contains('task-card') && !el.classList.contains('dragging') && !el.classList.contains('completed')) i++;
    }
    return i;
  }

  function clearMarkers() {
    marker.remove();
    boardEl.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  }

  // ---------------------------------------------------------------- actions

  async function moveTask(taskId, sectionId, index) {
    const b = state.board;
    const task = b.tasks.find((t) => t.id === taskId);
    if (!task) return;
    // optimistic reorder
    const siblings = b.tasks.filter((t) => t.section_id === sectionId && t.status === 'open' && t.id !== taskId)
      .sort((a, c) => a.position - c.position);
    siblings.splice(Math.min(index, siblings.length), 0, task);
    const fromSection = task.section_id;
    task.section_id = sectionId;
    siblings.forEach((t, i) => { t.position = i * 1024; });
    draw();
    try {
      const updated = await api.post(`/tasks/${taskId}/move`, { section_id: sectionId, index });
      Object.assign(task, updated);
      if (fromSection !== sectionId) {
        const sec = b.sections.find((s) => s.id === sectionId);
        if (sec?.automations.some((a) => a.active)) await loadBoard(projectId);
      }
      draw();
    } catch (err) {
      errorToast(err);
      loadBoard(projectId);
    }
  }

  async function reorderSection(dragId, targetId, after) {
    if (dragId === targetId) return;
    const b = state.board;
    const ids = b.sections.map((s) => s.id).filter((id) => id !== dragId);
    const i = ids.indexOf(targetId) + (after ? 1 : 0);
    ids.splice(i, 0, dragId);
    b.sections.sort((a, c) => ids.indexOf(a.id) - ids.indexOf(c.id));
    draw();
    try {
      await api.post(`/projects/${projectId}/sections/reorder`, { ids });
    } catch (err) {
      errorToast(err);
      loadBoard(projectId);
    }
  }

  async function toggleComplete(t) {
    const status = t.status === 'completed' ? 'open' : 'completed';
    const prev = t.status;
    t.status = status;
    t.completed_at = status === 'completed' ? new Date().toISOString() : null;
    draw();
    try {
      const updated = await api.patch(`/tasks/${t.id}`, { status });
      Object.assign(t, updated);
      if (status === 'completed') {
        toast(`Completed “${t.title}”`, 'success', { action: { label: 'Undo', onClick: () => toggleComplete(t) } });
        if (t.recurrence || updated.recurrence !== t.recurrence) await loadBoard(projectId);
      }
      draw();
    } catch (err) {
      t.status = prev;
      draw();
      errorToast(err);
    }
  }

  function cardMenu(anchor, t) {
    menu(anchor, [
      { label: 'Open', icon: 'external', onClick: () => openTask(t.id) },
      { label: t.status === 'completed' ? 'Reopen' : 'Complete', icon: 'check', onClick: () => toggleComplete(t) },
      { label: 'Assign to me', icon: 'user', onClick: () => patch(t, { assignee_id: state.user.id }) },
      { label: 'Duplicate', icon: 'copy', onClick: async () => {
        try { const c = await api.post(`/tasks/${t.id}/duplicate`); state.board.tasks.push(c); await loadBoard(projectId); } catch (err) { errorToast(err); }
      } },
      { label: 'Archive', icon: 'archive', onClick: () => patch(t, { status: 'archived' }, 'Task archived') },
    ]);
  }

  async function patch(t, body, msg) {
    try {
      Object.assign(t, await api.patch(`/tasks/${t.id}`, body));
      emit('board', state.board);
      if (msg) toast(msg, 'success');
    } catch (err) { errorToast(err); }
  }

  // ---------------------------------------------------------------- composer

  const composerIndex = new Map();

  function composer(sectionId) {
    const isOpen = openComposers.has(sectionId);
    const wrap = h('div', { class: 'col-foot' });
    if (!isOpen) {
      wrap.appendChild(h('button', { class: 'add-task-btn', onclick: () => openComposer(sectionId, null) }, icon('plus', 15), 'Add task'));
      return wrap;
    }
    const ta = h('textarea', { class: 'textarea composer-input', rows: 2, placeholder: 'Task title — press Enter to add, Esc to close' });
    const submit = async () => {
      const title = ta.value.trim();
      if (!title) return;
      ta.value = '';
      try {
        const index = composerIndex.get(sectionId);
        const task = await api.post(`/projects/${projectId}/tasks`, {
          title, section_id: sectionId, index,
        });
        const exists = state.board.tasks.find((t) => t.id === task.id);
        if (!exists) state.board.tasks.push(task);
        if (index === 0) {
          const sec = state.board.tasks.filter((t) => t.section_id === sectionId && t.status === 'open' && t.id !== task.id)
            .sort((a, c) => a.position - c.position);
          sec.forEach((t, i) => { t.position = (i + 1) * 1024; });
          task.position = 0;
        }
        draw();
      } catch (err) { errorToast(err); }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeComposer(sectionId); }
    });
    wrap.classList.add('composer');
    wrap.append(ta, h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'btn btn-primary btn-sm', onclick: submit }, 'Add task'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => closeComposer(sectionId) }, 'Cancel')));
    return wrap;
  }

  function openComposer(sectionId, index) {
    openComposers.clear();
    openComposers.add(sectionId);
    composerIndex.set(sectionId, index);
    draw();
    const col = boardEl.querySelector(`.column[data-section-id="${sectionId}"]`);
    if (index === 0) col?.querySelector('.col-tasks')?.scrollTo({ top: 0 });
    col?.querySelector('.composer textarea')?.scrollIntoView({ block: 'nearest' });
  }

  function closeComposer(sectionId) {
    openComposers.delete(sectionId);
    draw();
  }

  // ---------------------------------------------------------------- sections

  async function addSection() {
    const name = await promptDialog('New section', { placeholder: 'e.g. Blocked', confirmText: 'Add section' });
    if (!name) return;
    try {
      const color = COLORS[state.board.sections.length % COLORS.length];
      const s = await api.post(`/projects/${projectId}/sections`, { name, color });
      state.board.sections.push(s);
      draw();
      boardEl.scrollTo({ left: boardEl.scrollWidth, behavior: 'smooth' });
    } catch (err) { errorToast(err); }
  }

  function sectionMenu(anchor, s) {
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onClick: async () => {
        const name = await promptDialog('Rename section', { value: s.name });
        if (name) updateSection(s, { name });
      } },
      { label: 'Appearance', icon: 'star', onClick: () => editAppearance(s) },
      { label: s.wip_limit ? `WIP limit: ${s.wip_limit}` : 'Set WIP limit', icon: 'flag', onClick: async () => {
        const v = await promptDialog('Work-in-progress limit', { value: s.wip_limit || '', placeholder: 'Leave empty for no limit', label: 'Maximum open tasks in this section' });
        if (v === null && !s.wip_limit) return;
        const n = parseInt(v, 10);
        updateSection(s, { wip_limit: Number.isFinite(n) && n > 0 ? n : null });
      } },
      { label: 'Automations', icon: 'zap', hint: s.automations.length || '', onClick: () => navigate(`/projects/${projectId}/settings?tab=automations&section=${s.id}`) },
      'divider',
      { label: 'Delete section', icon: 'trash', danger: true, onClick: () => deleteSection(s) },
    ]);
  }

  function editAppearance(s) {
    let color = s.color;
    let ic = s.icon;
    const iconGrid = h('div', { class: 'icon-grid' });
    const drawIcons = () => mount(iconGrid, SECTION_ICONS.map((n) => h('button', {
      class: ['icon-btn', n === ic && 'active'], 'aria-label': n, onclick: () => { ic = n; drawIcons(); },
    }, icon(n, 16))));
    drawIcons();
    const swatches = h('div', { class: 'swatches' });
    const drawSw = () => mount(swatches, COLORS.map((c) => h('button', {
      class: ['swatch-btn', c === color && 'active'], style: { background: c }, 'aria-label': c, onclick: () => { color = c; drawSw(); },
    })));
    drawSw();
    const m = openModal({
      title: `Appearance: ${s.name}`, width: 420,
      content: h('div', null,
        h('div', { class: 'field' }, h('label', { class: 'label' }, 'Color'), swatches),
        h('div', { class: 'field' }, h('label', { class: 'label' }, 'Icon'), iconGrid)),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: () => { updateSection(s, { color, icon: ic }); m.close(); } }, 'Save')],
    });
  }

  async function updateSection(s, body) {
    try {
      Object.assign(s, await api.patch(`/sections/${s.id}`, body));
      draw();
    } catch (err) { errorToast(err); }
  }

  async function deleteSection(s) {
    const b = state.board;
    const others = b.sections.filter((x) => x.id !== s.id);
    if (!others.length) { toast('A project needs at least one section', 'error'); return; }
    const count = b.tasks.filter((t) => t.section_id === s.id).length;
    if (!count) {
      if (!await confirmDialog(`Delete the section “${s.name}”?`, { title: 'Delete section', confirmText: 'Delete', danger: true })) return;
      return doDelete(s, null);
    }
    const select = h('select', { class: 'select' }, others.map((o) => h('option', { value: o.id }, o.name)));
    const m = openModal({
      title: 'Delete section', width: 440,
      content: h('div', null,
        h('p', { class: 'confirm-text', style: { marginBottom: '14px' } }, `“${s.name}” contains ${count} task${count > 1 ? 's' : ''}. Move them to:`),
        select),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-danger', onclick: () => { m.close(); doDelete(s, Number(select.value)); } }, 'Move tasks & delete')],
    });
  }

  async function doDelete(s, moveTo) {
    try {
      await api.del(`/sections/${s.id}${moveTo ? `?move_to=${moveTo}` : ''}`);
      await loadBoard(projectId);
      toast('Section deleted', 'success');
    } catch (err) { errorToast(err); }
  }

  // ---------------------------------------------------------------- go

  draw();
  if (!state.board.sections.length) {
    mount(boardEl, emptyState('board', 'No sections yet', 'Add a section to start organizing tasks.', can('admin') ? h('button', { class: 'btn btn-primary', onclick: addSection }, 'Add section') : null));
  }
  const onKey = (e) => {
    if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA'].includes(e.target.tagName) && !document.querySelector('.modal-backdrop') && can('member')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const first = state.board.sections[0];
      if (first) openComposer(first.id, null);
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => {
    shell.cleanup();
    window.removeEventListener('keydown', onKey, true);
  };
}
