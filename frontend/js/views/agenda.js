// Agenda: a personal board of pinned tasks from any project, in your own sections.
import { api } from '../api.js';
import { loadPinned, on, state } from '../store.js';
import {
  COLORS, colorSwatches, confirmDialog, debounce, emptyState, errorToast, h, icon, menu, mount, openModal,
  promptDialog, spinner, toast,
} from '../ui.js';
import { taskCard } from '../components/taskCard.js';
import { openTask } from '../components/taskModal.js';

export default async function render(root) {
  const page = h('div', { class: 'page ag-page' });
  const boardEl = h('div', { class: 'ag-board' });
  const side = h('aside', { class: 'ag-side card' });
  mount(root, page);
  mount(page,
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Agenda'),
        h('p', { class: 'page-sub' }, 'Your personal board. Pin tasks from any project and plan your own week.')),
      h('button', { class: 'btn btn-secondary', onclick: addSection }, icon('plus', 15), 'Add section')),
    h('div', { class: 'ag-layout' }, boardEl, side));
  mount(boardEl, spinner());

  let agenda = null;
  let candidates = [];
  let sideQuery = '';
  let drag = null; // { type: 'pin'|'new'|'section', id }
  const marker = h('div', { class: 'drop-marker' });

  async function load() {
    try {
      const [a, mine] = await Promise.all([api.get('/agenda'), api.get('/me/tasks?scope=assigned')]);
      agenda = a;
      candidates = mine;
      draw();
    } catch (err) {
      errorToast(err);
      if (!agenda) mount(boardEl, emptyState('alert', 'Could not load your agenda', err.message));
    }
  }

  function draw() {
    if (!agenda) return;
    drawBoard();
    drawSide();
  }

  // ---------------------------------------------------------------- board

  function drawBoard() {
    if (!agenda.sections.length) {
      mount(boardEl, h('div', { class: 'card ag-empty' }, emptyState('pin', 'No agenda sections', 'Add a section like “Today” or “This week” to start planning.',
        h('button', { class: 'btn btn-primary', onclick: addSection }, icon('plus', 15), 'Add section'))));
      return;
    }
    const scrollLeft = boardEl.scrollLeft;
    mount(boardEl, agenda.sections.map(column));
    boardEl.scrollLeft = scrollLeft;
  }

  function column(sec) {
    const pins = agenda.pins.filter((p) => p.section_id === sec.id).sort((a, b) => a.position - b.position);
    const list = h('div', { class: 'col-tasks ag-tasks' },
      pins.length ? pins.map(pinCard) : h('div', { class: 'col-empty ag-drop-hint' }, icon('pin', 15), 'Drop tasks here'));
    const head = h('div', {
      class: 'col-head', draggable: 'true',
      ondragstart: (e) => {
        if (e.target.closest('button')) return;
        drag = { type: 'section', id: sec.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `agenda-section:${sec.id}`);
        requestAnimationFrame(() => col.classList.add('dragging'));
      },
      ondragend: () => { col.classList.remove('dragging'); drag = null; clearMarkers(); },
    },
    h('span', { class: 'ag-dot', style: { background: sec.color } }),
    h('span', { class: 'col-name truncate' }, sec.name),
    h('span', { class: 'col-count' }, pins.length),
    h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn sm', 'aria-label': `${sec.name} menu`, onclick: (e) => sectionMenu(e.currentTarget, sec) }, icon('more', 15)));
    const col = h('section', { class: 'column ag-column', dataset: { sectionId: sec.id }, style: { borderTopColor: sec.color } }, head, list);

    list.addEventListener('dragover', (e) => {
      if (drag?.type !== 'pin' && drag?.type !== 'new') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelector('.ag-drop-hint')?.classList.add('hidden');
      showMarker(list, e.clientY);
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) { marker.remove(); list.querySelector('.ag-drop-hint')?.classList.remove('hidden'); }
    });
    list.addEventListener('drop', (e) => {
      if (drag?.type !== 'pin' && drag?.type !== 'new') return;
      e.preventDefault();
      const index = markerIndex(list);
      const d = drag;
      clearMarkers();
      if (d.type === 'pin') movePin(d.id, sec.id, index);
      else pinTask(d.id, sec.id, index);
    });
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
      reorderSections(drag.id, sec.id, after);
    });
    return col;
  }

  function pinCard(pin) {
    const t = pin.task;
    const card = taskCard(t, {
      tags: t.tags, project: t.project, assignee: t.assignee_id === state.user.id ? state.user : undefined,
      onOpen: () => openTask(t.id), onToggle: () => toggle(t), compact: true,
    });
    card.classList.add('ag-card');
    card.draggable = true;
    card.appendChild(h('button', {
      class: 'icon-btn sm ag-unpin', title: 'Remove from agenda', 'aria-label': 'Remove from agenda',
      onclick: (e) => { e.stopPropagation(); unpin(pin); },
    }, icon('x', 14)));
    card.addEventListener('dragstart', (e) => {
      drag = { type: 'pin', id: pin.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `pin:${pin.id}`);
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); drag = null; clearMarkers(); });
    return card;
  }

  function showMarker(list, y) {
    const cards = [...list.querySelectorAll('.task-card:not(.dragging)')];
    const before = cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (before) list.insertBefore(marker, before);
    else list.appendChild(marker);
  }

  function markerIndex(list) {
    let i = 0;
    for (const el of list.children) {
      if (el === marker) return i;
      if (el.classList.contains('task-card') && !el.classList.contains('dragging')) i++;
    }
    return i;
  }

  function clearMarkers() {
    marker.remove();
    boardEl.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    boardEl.querySelectorAll('.ag-drop-hint.hidden').forEach((x) => x.classList.remove('hidden'));
  }

  // ---------------------------------------------------------------- side panel

  function drawSide() {
    const pinned = new Set(agenda.pins.map((p) => p.task.id));
    const q = sideQuery.toLowerCase();
    const items = candidates.filter((t) => !pinned.has(t.id) && (!q || t.title.toLowerCase().includes(q) || t.project?.name.toLowerCase().includes(q)));
    const input = h('input', { class: 'input input-sm', placeholder: 'Filter your tasks…', value: sideQuery, 'aria-label': 'Filter your tasks' });
    input.addEventListener('input', debounce(() => { sideQuery = input.value; drawSide(); side.querySelector('input')?.focus(); }, 150));
    mount(side,
      h('div', { class: 'ag-side-head' },
        h('h2', { class: 'card-title' }, 'Add to agenda'),
        h('p', { class: 'small muted' }, 'Your open tasks. Drag onto a section, or click to pin.')),
      input,
      h('div', { class: 'ag-side-list' },
        items.length ? items.map((t) => {
          const el = h('button', { class: 'ag-cand', draggable: 'true', onclick: () => pinTask(t.id, agenda.sections[0]?.id, null), title: 'Pin to the first section' },
            h('span', { class: 'swatch', style: { background: t.project?.color } }),
            h('span', { class: 'grow' },
              h('span', { class: 'ag-cand-title' }, t.title),
              h('span', { class: 'ag-cand-sub' }, t.project?.name, t.due_date ? ` · due ${new Date(t.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '')),
            icon('pin', 14));
          el.addEventListener('dragstart', (e) => {
            drag = { type: 'new', id: t.id };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', `task:${t.id}`);
          });
          el.addEventListener('dragend', () => { drag = null; clearMarkers(); });
          return el;
        }) : h('div', { class: 'ag-side-empty' }, icon('check-circle', 16),
          candidates.length ? (q ? 'No matching tasks.' : 'All your open tasks are on your agenda.') : 'No open tasks are assigned to you.')));
  }

  // ---------------------------------------------------------------- actions

  async function pinTask(taskId, sectionId, index) {
    if (!sectionId) { toast('Add a section first', 'error'); return; }
    try {
      const pin = await api.post('/agenda/pins', { task_id: taskId, section_id: sectionId });
      if (index !== null && index !== undefined) await api.post(`/agenda/pins/${pin.id}/move`, { section_id: sectionId, index });
      await Promise.all([load(), loadPinned()]);
    } catch (err) { errorToast(err); }
  }

  async function movePin(pinId, sectionId, index) {
    const pin = agenda.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const siblings = agenda.pins.filter((p) => p.section_id === sectionId && p.id !== pinId).sort((a, b) => a.position - b.position);
    siblings.splice(Math.min(index, siblings.length), 0, pin);
    pin.section_id = sectionId;
    siblings.forEach((p, i) => { p.position = i * 1024; });
    drawBoard();
    try {
      await api.post(`/agenda/pins/${pinId}/move`, { section_id: sectionId, index });
    } catch (err) { errorToast(err); load(); }
  }

  async function unpin(pin) {
    agenda.pins = agenda.pins.filter((p) => p.id !== pin.id);
    draw();
    try {
      await api.del(`/agenda/pins/${pin.id}`);
      loadPinned();
      toast('Removed from agenda', 'info', { action: { label: 'Undo', onClick: () => pinTask(pin.task.id, pin.section_id, null) } });
    } catch (err) { errorToast(err); load(); }
  }

  async function toggle(t) {
    const status = t.status === 'completed' ? 'open' : 'completed';
    t.status = status;
    drawBoard();
    try {
      await api.patch(`/tasks/${t.id}`, { status });
      if (status === 'completed') toast(`Completed “${t.title}”`, 'success');
    } catch (err) {
      errorToast(err);
      load();
    }
  }

  async function reorderSections(dragId, targetId, after) {
    if (dragId === targetId) return;
    const ids = agenda.sections.map((x) => x.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, dragId);
    agenda.sections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    drawBoard();
    try { await api.post('/agenda/sections/reorder', { ids }); } catch (err) { errorToast(err); load(); }
  }

  async function addSection() {
    const name = await promptDialog('New agenda section', { placeholder: 'e.g. Next week', confirmText: 'Add section' });
    if (!name) return;
    try {
      const color = COLORS[(agenda?.sections.length || 0) % COLORS.length];
      const sec = await api.post('/agenda/sections', { name, color });
      agenda.sections.push(sec);
      draw();
      boardEl.scrollTo({ left: boardEl.scrollWidth, behavior: 'smooth' });
    } catch (err) { errorToast(err); }
  }

  function sectionMenu(anchor, sec) {
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onClick: async () => {
        const name = await promptDialog('Rename section', { value: sec.name });
        if (name) updateSection(sec, { name });
      } },
      { label: 'Change color', icon: 'star', onClick: () => {
        let color = sec.color;
        const m = openModal({
          title: `Color: ${sec.name}`, width: 380,
          content: colorSwatches(color, (c) => { color = c; }),
          footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: () => { m.close(); updateSection(sec, { color }); } }, 'Save')],
        });
      } },
      'divider',
      { label: 'Delete section', icon: 'trash', danger: true, onClick: async () => {
        const n = agenda.pins.filter((p) => p.section_id === sec.id).length;
        const msg = n ? `“${sec.name}” and its ${n} pinned task${n === 1 ? '' : 's'} will be removed from your agenda. The tasks themselves are not deleted.`
          : `Delete the section “${sec.name}”?`;
        if (!await confirmDialog(msg, { title: 'Delete section', confirmText: 'Delete', danger: true })) return;
        try {
          await api.del(`/agenda/sections/${sec.id}`);
          await Promise.all([load(), loadPinned()]);
        } catch (err) { errorToast(err); }
      } },
    ]);
  }

  async function updateSection(sec, body) {
    try {
      Object.assign(sec, await api.patch(`/agenda/sections/${sec.id}`, body));
      drawBoard();
    } catch (err) { errorToast(err); }
  }

  await load();
  const reload = debounce(load, 700);
  const offs = [
    on('ws', (msg) => { if (msg.type?.startsWith('task.') || msg.type === 'board.changed') reload(); }),
    on('task-saved', reload),
  ];
  return () => offs.forEach((off) => off());
}
