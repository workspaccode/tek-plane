// Project settings: general, members, sections, automations, tags, danger zone.
import { api } from '../api.js';
import { currentQuery, navigate, setQuery } from '../router.js';
import { can, loadBoard, loadProjects, state } from '../store.js';
import {
  COLORS, PRIORITIES, PROJECT_ICONS, ROLES, avatar, colorSwatches, confirmDialog, debounce, emptyState, errorToast,
  fmtDate, h, icon, menu, mount, openModal, popover, toast,
} from '../ui.js';
import { addBoardDialog, isMindmapProject, projectShell } from '../components/projectShell.js';

const BOARD_ONLY = new Set(['sections', 'automations', 'tags']);
const TABS = [
  ['general', 'settings', 'General'],
  ['members', 'users', 'Members'],
  ['sections', 'board', 'Sections'],
  ['automations', 'zap', 'Automations'],
  ['tags', 'tag', 'Tags'],
  ['danger', 'alert', 'Danger zone'],
];

const SECTION_ICONS = ['circle', 'inbox', 'play', 'eye', 'check', 'flag', 'beaker', 'bulb', 'pen', 'calendar', 'star', 'zap', 'alert', 'archive'];

const AUTOMATION_TYPES = {
  complete: { label: 'Mark as complete', icon: 'check-circle', help: 'Completes the task (and creates the next one if it repeats).' },
  reopen: { label: 'Reopen task', icon: 'repeat', help: 'Turns a completed task back into an open one.' },
  assign: { label: 'Assign to someone', icon: 'user', help: 'Hands the task over, e.g. to the reviewer.' },
  add_tag: { label: 'Add a tag', icon: 'tag', help: 'Labels the task automatically.' },
  set_due: { label: 'Set due date', icon: 'calendar', help: 'Gives the task a deadline relative to when it arrives.' },
  add_checklist: { label: 'Add a checklist', icon: 'checklist', help: 'Adds a ready-made checklist, e.g. a review checklist.' },
  add_watcher: { label: 'Add a watcher', icon: 'eye', help: 'Keeps someone informed about the task.' },
  set_priority: { label: 'Set priority', icon: 'flag', help: 'Raises or lowers the priority.' },
};

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  let tab = TABS.some(([k]) => k === currentQuery().tab) ? currentQuery().tab : 'general';
  let focusSection = Number(currentQuery().section) || null;
  let pendingRedraw = false;

  const shell = await projectShell(root, projectId, 'settings', () => {
    // don't wipe a field the user is typing into; redraw once they leave it
    const a = document.activeElement;
    if (a && content.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) { pendingRedraw = true; return; }
    draw();
  });
  const nav = h('nav', { class: 'ps-nav', 'aria-label': 'Settings sections' });
  const content = h('div', { class: 'ps-content' });
  content.addEventListener('focusout', () => {
    if (!pendingRedraw) return;
    setTimeout(() => {
      if (content.contains(document.activeElement)) return;
      pendingRedraw = false;
      draw();
    }, 150);
  });
  mount(shell.body, h('div', { class: 'ps-page' }, nav, content));

  // Local actions always redraw; only remote (realtime) updates wait for the user to leave a field.
  const reload = async () => {
    await loadBoard(projectId);
    pendingRedraw = false;
    draw();
  };
  const isAdmin = () => can('admin');

  const visibleTabs = () => TABS.filter(([k]) => !(isMindmapProject() && BOARD_ONLY.has(k)));

  function drawNav() {
    if (!visibleTabs().some(([k]) => k === tab)) tab = 'general';
    mount(nav, visibleTabs().map(([k, ic, label]) => h('button', {
      class: ['ps-nav-item', tab === k && 'active', k === 'danger' && 'ps-nav-danger'], 'aria-current': tab === k ? 'page' : null,
      onclick: () => { tab = k; focusSection = null; setQuery({ tab: k, section: null }); drawNav(); draw(); },
    }, icon(ic, 16), label)));
  }

  function draw() {
    if (!state.board) return;
    drawNav();
    const fn = { general, members, sections, automations, tags, danger }[tab];
    const extra = tab === 'general' && isMindmapProject() && isAdmin() ? panel('Board',
      'This project is a mind map. Add a board to turn topics into tasks and get List, Timeline and Reports. The map stays as it is.',
      h('button', { class: 'btn btn-secondary', onclick: () => addBoardDialog() }, icon('board', 15), 'Add a board')) : null;
    mount(content, fn(), extra);
  }

  const panel = (title, sub, ...children) => h('section', { class: 'card ps-panel' },
    h('div', { class: 'ps-panel-head' }, h('h2', { class: 'ps-title' }, title), sub ? h('p', { class: 'ps-sub' }, sub) : null),
    h('div', { class: 'ps-panel-body' }, children));

  const readOnlyNote = (what = 'change these settings') => h('div', { class: 'ps-note' }, icon('eye', 14), `Only project admins can ${what}.`);

  // ================================================================ general

  function general() {
    const p = state.board.project;
    const editable = isAdmin();
    let color = p.color;
    let ic = p.icon || 'folder';
    const name = h('input', { class: 'input', value: p.name, maxlength: 160, disabled: !editable });
    const desc = h('textarea', { class: 'textarea', rows: 3, disabled: !editable, placeholder: 'What is this project about?' }, p.description || '');
    const preview = h('span', { class: 'project-dot ps-preview' });
    const drawPreview = () => { preview.style.background = color; mount(preview, icon(ic, 20)); };
    drawPreview();
    const icons = h('div', { class: 'icon-grid' });
    const drawIcons = () => mount(icons, PROJECT_ICONS.map((n) => h('button', {
      type: 'button', class: ['icon-btn', n === ic && 'active'], 'aria-label': n, disabled: !editable,
      onclick: () => { ic = n; drawIcons(); drawPreview(); },
    }, icon(n, 16))));
    drawIcons();
    const save = h('button', { class: 'btn btn-primary' }, 'Save changes');
    save.addEventListener('click', async () => {
      if (!name.value.trim()) { name.focus(); return; }
      save.disabled = true;
      try {
        await api.patch(`/projects/${projectId}`, { name: name.value.trim(), description: desc.value, color, icon: ic });
        await Promise.all([reload(), loadProjects()]);
        toast('Project updated', 'success');
      } catch (err) { errorToast(err); } finally { save.disabled = false; }
    });
    return panel('General', 'Name, description and look of this project.',
      editable ? null : readOnlyNote(),
      h('div', { class: 'row ps-name-row' }, preview,
        h('div', { class: 'field grow', style: { margin: 0 } }, h('label', { class: 'label' }, 'Project name'), name)),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Description'), desc),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Color'),
        editable ? colorSwatches(color, (c) => { color = c; drawPreview(); }) : h('span', { class: 'swatch', style: { background: color, width: '20px', height: '20px' } })),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Icon'), icons),
      h('div', { class: 'ps-meta' }, `Created ${fmtDate(p.created_at)} · Your role: ${ROLES[p.role] || p.role}`),
      editable ? h('div', { class: 'ps-actions' }, save) : null);
  }

  // ================================================================ members

  function members() {
    const b = state.board;
    const me = b.project.role;
    const list = [...b.members].sort((a, c) => ({ owner: 0, admin: 1, member: 2, viewer: 3 }[a.role] - { owner: 0, admin: 1, member: 2, viewer: 3 }[c.role]) || a.name.localeCompare(c.name));
    const online = new Set(b.online_user_ids || []);
    return h('div', { class: 'ps-stack' },
      isAdmin() ? inviteCard() : null,
      panel(`Members (${list.length})`, 'People who can see this project. Viewers can only read; members can edit tasks; admins manage the project.',
        h('div', { class: 'ps-members' }, list.map((m) => {
          const self = m.id === state.user.id;
          const canEdit = isAdmin() && !self && m.role !== 'owner';
          const roleCtl = canEdit
            ? h('button', { class: 'btn btn-secondary btn-sm ps-role-btn', onclick: (e) => roleMenu(e.currentTarget, m, me) },
              ROLES[m.role], icon('chevron-down', 13))
            : h('span', { class: ['role-badge', m.role] }, ROLES[m.role]);
          return h('div', { class: 'ps-member' },
            h('span', { class: 'avatar-wrap' }, avatar(m, 36, { title: false }), online.has(m.id) ? h('span', { class: 'online-dot' }) : null),
            h('div', { class: 'grow' },
              h('div', { class: 'ps-member-name' }, m.name, self ? h('span', { class: 'muted' }, ' (you)') : null),
              h('div', { class: 'ps-member-email truncate' }, m.email, m.title ? ` · ${m.title}` : '')),
            h('span', { class: 'ps-joined muted small' }, `Joined ${fmtDate(m.joined_at)}`),
            roleCtl,
            canEdit ? h('button', { class: 'icon-btn sm', 'aria-label': `Remove ${m.name}`, title: 'Remove from project', onclick: () => removeMember(m) }, icon('x', 15))
              : self && m.role !== 'owner' ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => leave() }, 'Leave') : h('span', { class: 'ps-spacer' }));
        }))));
  }

  function roleMenu(anchor, m, myRole) {
    const roles = ['admin', 'member', 'viewer'];
    menu(anchor, [
      ...roles.map((r) => ({ label: ROLES[r], checked: m.role === r, onClick: () => setRole(m, r) })),
      myRole === 'owner' ? 'divider' : null,
      myRole === 'owner' ? { label: 'Make owner…', icon: 'star', onClick: () => transferOwnership(m) } : null,
    ]);
  }

  async function setRole(m, role) {
    if (m.role === role) return;
    try {
      await api.patch(`/projects/${projectId}/members/${m.id}`, { role });
      await reload();
      toast(`${m.name} is now ${ROLES[role].toLowerCase()}`, 'success');
    } catch (err) { errorToast(err); }
  }

  async function transferOwnership(m) {
    if (!await confirmDialog(`${m.name} will become the owner of “${state.board.project.name}”. You will become an admin.`,
      { title: 'Transfer ownership?', confirmText: 'Transfer ownership', danger: true })) return;
    try {
      await api.patch(`/projects/${projectId}/members/${m.id}`, { role: 'owner' });
      await Promise.all([reload(), loadProjects()]);
      toast(`${m.name} is now the owner`, 'success');
    } catch (err) { errorToast(err); }
  }

  async function removeMember(m) {
    if (!await confirmDialog(`${m.name} will lose access to this project. Tasks assigned to them become unassigned.`,
      { title: 'Remove member?', confirmText: 'Remove', danger: true })) return;
    try {
      await api.del(`/projects/${projectId}/members/${m.id}`);
      await reload();
      toast(`${m.name} removed`, 'success');
    } catch (err) { errorToast(err); }
  }

  async function leave() {
    if (!await confirmDialog(`You will lose access to “${state.board.project.name}”.`, { title: 'Leave project?', confirmText: 'Leave', danger: true })) return;
    try {
      await api.del(`/projects/${projectId}/members/${state.user.id}`);
      await loadProjects();
      navigate('/dashboard');
    } catch (err) { errorToast(err); }
  }

  function inviteCard() {
    let role = 'member';
    const input = h('input', { class: 'input', type: 'email', placeholder: 'Name or email address', autocomplete: 'off', 'aria-label': 'Invite by email' });
    const suggestions = h('div', { class: 'ps-suggest hidden', role: 'listbox' });
    const roleSel = h('select', { class: 'select ps-role-select', 'aria-label': 'Role' },
      ['member', 'admin', 'viewer'].map((r) => h('option', { value: r, selected: r === role }, ROLES[r])));
    roleSel.addEventListener('change', () => { role = roleSel.value; });
    const btn = h('button', { class: 'btn btn-primary' }, icon('user-plus', 15), 'Invite');
    const memberIds = new Set(state.board.members.map((m) => m.id));

    const search = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { suggestions.classList.add('hidden'); return; }
      try {
        const users = (await api.get(`/users/search?q=${encodeURIComponent(q)}`)).filter((u) => !memberIds.has(u.id));
        if (!users.length) { suggestions.classList.add('hidden'); return; }
        mount(suggestions, users.map((u) => h('button', {
          type: 'button', class: 'menu-item', role: 'option',
          onmousedown: (e) => { e.preventDefault(); input.value = u.email; suggestions.classList.add('hidden'); },
        }, avatar(u, 22), h('span', { class: 'menu-label' }, u.name), h('span', { class: 'menu-hint' }, u.email))));
        suggestions.classList.remove('hidden');
      } catch (_) { suggestions.classList.add('hidden'); }
    }, 200);
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(() => suggestions.classList.add('hidden'), 120));
    const invite = async () => {
      const email = input.value.trim();
      if (!email) { input.focus(); return; }
      btn.disabled = true;
      try {
        const m = await api.post(`/projects/${projectId}/members`, { email, role });
        input.value = '';
        await reload();
        toast(`${m.name} added as ${ROLES[m.role].toLowerCase()}`, 'success');
      } catch (err) { errorToast(err); } finally { btn.disabled = false; }
    };
    btn.addEventListener('click', invite);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); invite(); } });
    return panel('Invite people', 'Add teammates who already have a tek-plane account.',
      h('div', { class: 'ps-invite' }, h('div', { class: 'ps-invite-input' }, input, suggestions), roleSel, btn));
  }

  // ================================================================ sections

  function sections() {
    const b = state.board;
    const editable = isAdmin();
    const counts = new Map();
    b.tasks.forEach((t) => { if (t.status !== 'archived') counts.set(t.section_id, (counts.get(t.section_id) || 0) + 1); });
    let dragId = null;
    const list = h('div', { class: 'ps-sections' }, b.sections.map((s, i) => {
      const nameInput = h('input', { class: 'input input-sm ps-sec-name', value: s.name, disabled: !editable, maxlength: 120, 'aria-label': 'Section name' });
      nameInput.addEventListener('change', () => {
        const v = nameInput.value.trim();
        if (!v) { nameInput.value = s.name; return; }
        if (v !== s.name) updateSection(s, { name: v });
      });
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
      const wip = h('input', { class: 'input input-sm ps-wip', type: 'number', min: 1, value: s.wip_limit || '', placeholder: '∞', disabled: !editable, 'aria-label': 'WIP limit' });
      wip.addEventListener('change', () => {
        const n = parseInt(wip.value, 10);
        updateSection(s, { wip_limit: Number.isFinite(n) && n > 0 ? n : null });
      });
      const rowEl = h('div', { class: 'ps-sec-row', draggable: editable ? 'true' : null, dataset: { id: s.id } },
        editable ? h('span', { class: 'ps-grip', title: 'Drag to reorder' }, icon('grip', 15)) : null,
        h('button', {
          class: 'col-icon ps-sec-icon', style: { background: s.color }, disabled: !editable, 'aria-label': 'Change color and icon',
          onclick: (e) => appearancePopover(e.currentTarget, s),
        }, icon(s.icon || 'circle', 13)),
        nameInput,
        h('span', { class: 'ps-sec-count muted small' }, `${counts.get(s.id) || 0} tasks`),
        h('label', { class: 'ps-wip-wrap small muted' }, 'WIP', wip),
        s.automations.length ? h('button', { class: 'ps-auto-chip', title: 'Automations', onclick: () => { tab = 'automations'; focusSection = s.id; setQuery({ tab, section: s.id }); drawNav(); draw(); } },
          icon('zap', 12), s.automations.length) : null,
        editable ? h('div', { class: 'ps-sec-move' },
          h('button', { class: 'icon-btn sm', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveSection(s.id, i - 1) }, icon('chevron-down', 14, 'ps-up')),
          h('button', { class: 'icon-btn sm', 'aria-label': 'Move down', disabled: i === b.sections.length - 1, onclick: () => moveSection(s.id, i + 1) }, icon('chevron-down', 14))) : null,
        editable ? h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${s.name}`, onclick: () => deleteSection(s, counts.get(s.id) || 0) }, icon('trash', 15)) : null);
      if (editable) {
        rowEl.addEventListener('dragstart', (e) => { dragId = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(s.id)); rowEl.classList.add('dragging'); });
        rowEl.addEventListener('dragend', () => { rowEl.classList.remove('dragging'); list.querySelectorAll('.ps-drop').forEach((x) => x.classList.remove('ps-drop')); });
        rowEl.addEventListener('dragover', (e) => { if (dragId && dragId !== s.id) { e.preventDefault(); rowEl.classList.add('ps-drop'); } });
        rowEl.addEventListener('dragleave', () => rowEl.classList.remove('ps-drop'));
        rowEl.addEventListener('drop', (e) => { e.preventDefault(); rowEl.classList.remove('ps-drop'); if (dragId) moveSection(dragId, i); dragId = null; });
      }
      return rowEl;
    }));

    const addName = h('input', { class: 'input', placeholder: 'New section name', maxlength: 120 });
    const add = async () => {
      const name = addName.value.trim();
      if (!name) { addName.focus(); return; }
      try {
        await api.post(`/projects/${projectId}/sections`, { name, color: COLORS[b.sections.length % COLORS.length] });
        addName.value = '';
        await reload();
      } catch (err) { errorToast(err); }
    };
    addName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return panel('Sections', 'The columns of your board, in order. Drag to reorder; set a WIP limit to flag overloaded columns.',
      editable ? null : readOnlyNote('manage sections'),
      list,
      editable ? h('div', { class: 'ps-add-row' }, addName, h('button', { class: 'btn btn-secondary', onclick: add }, icon('plus', 15), 'Add section')) : null);
  }

  function appearancePopover(anchor, s) {
    popover(anchor, (_, close) => {
      let color = s.color;
      let ic = s.icon || 'circle';
      const icons = h('div', { class: 'icon-grid' });
      const drawIcons = () => mount(icons, SECTION_ICONS.map((n) => h('button', {
        class: ['icon-btn', 'sm', n === ic && 'active'], 'aria-label': n, onclick: () => { ic = n; drawIcons(); },
      }, icon(n, 14))));
      drawIcons();
      return h('div', { class: 'ps-pop' },
        h('div', { class: 'label' }, 'Color'), colorSwatches(color, (c) => { color = c; }),
        h('div', { class: 'label', style: { marginTop: '10px' } }, 'Icon'), icons,
        h('div', { class: 'ps-actions' }, h('button', { class: 'btn btn-primary btn-sm', onclick: () => { close(); updateSection(s, { color, icon: ic }); } }, 'Apply')));
    }, { width: 260 });
  }

  async function updateSection(s, body) {
    try {
      Object.assign(s, await api.patch(`/sections/${s.id}`, body));
      draw();
    } catch (err) { errorToast(err); reload(); }
  }

  async function moveSection(id, toIndex) {
    const ids = state.board.sections.map((x) => x.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id);
    state.board.sections.sort((a, c) => ids.indexOf(a.id) - ids.indexOf(c.id));
    draw();
    try {
      await api.post(`/projects/${projectId}/sections/reorder`, { ids });
    } catch (err) { errorToast(err); reload(); }
  }

  async function deleteSection(s, count) {
    const others = state.board.sections.filter((x) => x.id !== s.id);
    if (!others.length) { toast('A project needs at least one section', 'error'); return; }
    const hasTasks = state.board.tasks.some((t) => t.section_id === s.id);
    const doDelete = async (moveTo) => {
      try {
        await api.del(`/sections/${s.id}${moveTo ? `?move_to=${moveTo}` : ''}`);
        await reload();
        toast('Section deleted', 'success');
      } catch (err) { errorToast(err); }
    };
    if (!hasTasks) {
      if (await confirmDialog(`Delete the section “${s.name}” and its automations?`, { title: 'Delete section', confirmText: 'Delete', danger: true })) doDelete(null);
      return;
    }
    const select = h('select', { class: 'select' }, others.map((o) => h('option', { value: o.id }, o.name)));
    const m = openModal({
      title: 'Delete section', width: 440,
      content: h('div', null,
        h('p', { class: 'confirm-text', style: { marginBottom: '14px' } }, `“${s.name}” contains ${count || 'some'} task${count === 1 ? '' : 's'}. Move them to:`),
        select),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-danger', onclick: () => { m.close(); doDelete(Number(select.value)); } }, 'Move tasks & delete')],
    });
  }

  // ================================================================ automations

  function describe(a, section) {
    const c = a.config || {};
    const b = state.board;
    const who = (id) => b.members.find((m) => m.id === id)?.name || 'a former member';
    switch (a.type) {
      case 'complete': return 'mark it complete';
      case 'reopen': return 'reopen it';
      case 'assign': return c.user_id ? `assign it to ${who(c.user_id)}` : 'remove the assignee';
      case 'add_tag': return `add the tag “${b.tags.find((t) => t.id === c.tag_id)?.name || 'deleted tag'}”`;
      case 'set_due': {
        const d = Number(c.days) || 0;
        return d === 0 ? 'set the due date to today' : `set the due date ${d} day${d === 1 ? '' : 's'} later`;
      }
      case 'add_checklist': return `add the checklist “${c.name || 'Checklist'}” (${(c.items || []).length} item${(c.items || []).length === 1 ? '' : 's'})`;
      case 'add_watcher': return `add ${who(c.user_id)} as a watcher`;
      case 'set_priority': return `set priority to ${PRIORITIES[c.priority]?.label || c.priority}`;
      default: return a.type;
    }
  }

  function automations() {
    const b = state.board;
    const editable = isAdmin();
    const cards = b.sections.map((s) => {
      const card = h('section', { class: ['card', 'ps-auto-card', focusSection === s.id && 'ps-focus'], dataset: { sectionId: s.id } },
        h('div', { class: 'ps-auto-head' },
          h('span', { class: 'col-icon', style: { background: s.color } }, icon(s.icon || 'circle', 13)),
          h('div', { class: 'grow' },
            h('div', { class: 'ps-auto-when' }, 'When a task enters ', h('strong', null, s.name))),
          editable ? h('button', { class: 'btn btn-soft btn-sm', onclick: () => automationModal(s) }, icon('plus', 14), 'Add automation') : null),
        s.automations.length
          ? h('div', { class: 'ps-auto-list' }, s.automations.map((a) => h('div', { class: ['ps-auto-item', !a.active && 'ps-off'] },
            h('span', { class: 'ps-auto-icon' }, icon(AUTOMATION_TYPES[a.type]?.icon || 'zap', 14)),
            h('div', { class: 'grow ps-auto-text' }, h('span', { class: 'muted' }, '→ '), describe(a, s).replace(/^./, (ch) => ch.toUpperCase())),
            editable ? h('button', {
              class: ['toggle', a.active && 'on'], role: 'switch', 'aria-checked': String(a.active), 'aria-label': a.active ? 'Disable automation' : 'Enable automation',
              onclick: () => toggleAutomation(a),
            }) : h('span', { class: 'muted small' }, a.active ? 'On' : 'Off'),
            editable ? h('button', { class: 'icon-btn sm', 'aria-label': 'Edit automation', onclick: () => automationModal(s, a) }, icon('edit', 14)) : null,
            editable ? h('button', { class: 'icon-btn sm', 'aria-label': 'Delete automation', onclick: () => deleteAutomation(a) }, icon('trash', 14)) : null)))
          : h('div', { class: 'ps-auto-empty' }, 'No automations. Tasks just move here.'));
      return card;
    });
    if (focusSection) {
      requestAnimationFrame(() => content.querySelector(`.ps-auto-card[data-section-id="${focusSection}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
    return h('div', { class: 'ps-stack' },
      panel('Automations', 'Automations run whenever a task is moved into a section, saving you the busywork.',
        editable ? null : readOnlyNote('manage automations')),
      b.sections.length ? cards : emptyState('zap', 'No sections', 'Add a section first.'));
  }

  async function toggleAutomation(a) {
    try {
      Object.assign(a, await api.patch(`/automations/${a.id}`, { active: !a.active }));
      draw();
    } catch (err) { errorToast(err); }
  }

  async function deleteAutomation(a) {
    if (!await confirmDialog('This automation will stop running.', { title: 'Delete automation?', confirmText: 'Delete', danger: true })) return;
    try {
      await api.del(`/automations/${a.id}`);
      await reload();
    } catch (err) { errorToast(err); }
  }

  function automationModal(section, existing = null) {
    const b = state.board;
    let type = existing?.type || 'complete';
    let config = { ...(existing?.config || {}) };
    const typeGrid = h('div', { class: 'ps-type-grid', role: 'radiogroup' });
    const configEl = h('div', { class: 'ps-config' });
    const preview = h('div', { class: 'ps-preview-text' });

    const drawPreview = () => {
      mount(preview, icon('zap', 14), h('span', null, 'When a task enters ', h('strong', null, section.name), ` → ${describe({ type, config }, section)}`));
    };
    const drawTypes = () => mount(typeGrid, Object.entries(AUTOMATION_TYPES).map(([k, t]) => h('button', {
      type: 'button', class: ['ps-type', k === type && 'active'], role: 'radio', 'aria-checked': String(k === type), disabled: !!existing && k !== type,
      onclick: () => { if (existing) return; type = k; config = defaults(k); drawTypes(); drawConfig(); drawPreview(); },
    }, icon(t.icon, 16), h('span', null, t.label))));

    function defaults(k) {
      if (k === 'assign') return { user_id: b.members.find((m) => m.role !== 'viewer')?.id || null };
      if (k === 'add_tag') return { tag_id: b.tags[0]?.id || null };
      if (k === 'set_due') return { days: 1 };
      if (k === 'add_checklist') return { name: 'Checklist', items: [] };
      if (k === 'add_watcher') return { user_id: b.members[0]?.id || null };
      if (k === 'set_priority') return { priority: 'high' };
      return {};
    }
    if (!existing) config = defaults(type);

    const field = (label, ctl, hint) => h('div', { class: 'field' }, h('label', { class: 'label' }, label), ctl, hint ? h('span', { class: 'hint' }, hint) : null);
    const select = (options, value, onChange) => {
      const el = h('select', { class: 'select' }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
      el.addEventListener('change', () => { onChange(el.value); drawPreview(); });
      return el;
    };

    function drawConfig() {
      const t = AUTOMATION_TYPES[type];
      let ctl = null;
      if (type === 'assign') {
        ctl = field('Assign to', select([['', 'Nobody (remove assignee)'], ...b.members.filter((m) => m.role !== 'viewer').map((m) => [m.id, m.name])],
          config.user_id ?? '', (v) => { config = v ? { user_id: Number(v) } : { unassign: true }; }));
      } else if (type === 'add_tag') {
        ctl = b.tags.length ? field('Tag', select(b.tags.map((tg) => [tg.id, tg.name]), config.tag_id, (v) => { config = { tag_id: Number(v) }; }))
          : h('div', { class: 'ps-note' }, icon('tag', 14), 'This project has no tags yet. Create one in the Tags tab first.');
      } else if (type === 'set_due') {
        const inp = h('input', { class: 'input', type: 'number', min: 0, max: 365, value: config.days ?? 1 });
        inp.addEventListener('input', () => { config = { days: Math.max(0, parseInt(inp.value, 10) || 0) }; drawPreview(); });
        ctl = field('Days after the task arrives', inp, '0 means today. The due time is set to 17:00 UTC.');
      } else if (type === 'add_checklist') {
        const nm = h('input', { class: 'input', value: config.name || 'Checklist', maxlength: 160 });
        const items = h('textarea', { class: 'textarea', rows: 5, placeholder: 'One item per line' }, (config.items || []).join('\n'));
        const sync = () => { config = { name: nm.value.trim() || 'Checklist', items: items.value.split('\n').map((x) => x.trim()).filter(Boolean) }; drawPreview(); };
        nm.addEventListener('input', sync);
        items.addEventListener('input', sync);
        ctl = [field('Checklist name', nm), field('Items', items, 'One item per line.')];
      } else if (type === 'add_watcher') {
        ctl = field('Watcher', select(b.members.map((m) => [m.id, m.name]), config.user_id, (v) => { config = { user_id: Number(v) }; }));
      } else if (type === 'set_priority') {
        ctl = field('Priority', select(Object.entries(PRIORITIES).reverse().map(([k, p]) => [k, p.label]), config.priority, (v) => { config = { priority: v }; }));
      }
      mount(configEl, h('p', { class: 'hint ps-type-help' }, t.help), ctl);
    }

    drawTypes();
    drawConfig();
    drawPreview();
    const saveBtn = h('button', { class: 'btn btn-primary' }, existing ? 'Save automation' : 'Add automation');
    saveBtn.addEventListener('click', async () => {
      if (type === 'add_tag' && !config.tag_id) { toast('Pick a tag first', 'error'); return; }
      if ((type === 'add_watcher') && !config.user_id) { toast('Pick a member first', 'error'); return; }
      saveBtn.disabled = true;
      try {
        if (existing) await api.patch(`/automations/${existing.id}`, { config });
        else await api.post(`/sections/${section.id}/automations`, { type, config });
        m.close();
        focusSection = section.id;
        await reload();
        toast(existing ? 'Automation updated' : 'Automation added', 'success');
      } catch (err) { errorToast(err); saveBtn.disabled = false; }
    });
    const m = openModal({
      title: existing ? 'Edit automation' : `New automation for ${section.name}`, width: 580,
      content: h('div', null,
        h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Then…'), typeGrid, configEl, preview),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'), saveBtn],
    });
  }

  // ================================================================ tags

  function tags() {
    const b = state.board;
    const editable = can('member');
    const usage = new Map();
    b.tasks.forEach((t) => t.tag_ids.forEach((id) => usage.set(id, (usage.get(id) || 0) + 1)));
    const sorted = [...b.tags].sort((a, c) => a.name.localeCompare(c.name));
    const rows = sorted.map((tg) => {
      const nm = h('input', { class: 'input input-sm', value: tg.name, maxlength: 60, disabled: !editable, 'aria-label': 'Tag name' });
      nm.addEventListener('change', async () => {
        const v = nm.value.trim();
        if (!v) { nm.value = tg.name; return; }
        if (v === tg.name) return;
        try { Object.assign(tg, await api.patch(`/tags/${tg.id}`, { name: v })); toast('Tag renamed', 'success'); } catch (err) { errorToast(err); nm.value = tg.name; }
      });
      nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') nm.blur(); });
      return h('div', { class: 'ps-tag-row' },
        h('button', {
          class: 'ps-tag-swatch', style: { background: tg.color }, disabled: !editable, 'aria-label': `Change color of ${tg.name}`,
          onclick: (e) => popover(e.currentTarget, (_, close) => h('div', { class: 'ps-pop' }, colorSwatches(tg.color, async (c) => {
            close();
            try { Object.assign(tg, await api.patch(`/tags/${tg.id}`, { color: c })); draw(); } catch (err) { errorToast(err); }
          })), { width: 230 }),
        }),
        nm,
        h('span', { class: 'card-tag ps-tag-preview', style: { background: tg.color } }, tg.name),
        h('span', { class: 'muted small ps-tag-usage' }, `${usage.get(tg.id) || 0} task${usage.get(tg.id) === 1 ? '' : 's'}`),
        isAdmin() ? h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${tg.name}`, onclick: () => deleteTag(tg, usage.get(tg.id) || 0) }, icon('trash', 15)) : null);
    });
    let newColor = COLORS[b.tags.length % COLORS.length];
    const newName = h('input', { class: 'input', placeholder: 'New tag name', maxlength: 60 });
    const swatch = h('button', { class: 'ps-tag-swatch', style: { background: newColor }, 'aria-label': 'Pick color',
      onclick: (e) => popover(e.currentTarget, (_, close) => h('div', { class: 'ps-pop' }, colorSwatches(newColor, (c) => { newColor = c; swatch.style.background = c; close(); })), { width: 230 }) });
    const add = async () => {
      const name = newName.value.trim();
      if (!name) { newName.focus(); return; }
      try {
        await api.post(`/projects/${projectId}/tags`, { name, color: newColor });
        await reload();
      } catch (err) { errorToast(err); }
    };
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return panel('Tags', 'Labels you can put on tasks and filter by.',
      editable ? null : readOnlyNote('manage tags'),
      rows.length ? h('div', { class: 'ps-tags' }, rows) : h('div', { class: 'ps-auto-empty' }, 'No tags yet.'),
      editable ? h('div', { class: 'ps-add-row' }, swatch, newName, h('button', { class: 'btn btn-secondary', onclick: add }, icon('plus', 15), 'Add tag')) : null);
  }

  async function deleteTag(tg, n) {
    if (!await confirmDialog(n ? `“${tg.name}” will be removed from ${n} task${n === 1 ? '' : 's'}.` : `Delete the tag “${tg.name}”?`,
      { title: 'Delete tag?', confirmText: 'Delete', danger: true })) return;
    try {
      await api.del(`/tags/${tg.id}`);
      await reload();
    } catch (err) { errorToast(err); }
  }

  // ================================================================ danger

  function danger() {
    const p = state.board.project;
    const blocks = [];
    if (isAdmin()) {
      blocks.push(h('div', { class: 'ps-danger-row' },
        h('div', { class: 'grow' }, h('strong', null, p.archived ? 'Restore project' : 'Archive project'),
          h('p', { class: 'ps-sub' }, p.archived ? 'Bring the project back to the sidebar and dashboards.' : 'Hide the project from the sidebar and dashboards. Nothing is deleted.')),
        h('button', { class: 'btn btn-secondary', onclick: async () => {
          const archiving = !p.archived;
          try {
            await api.patch(`/projects/${projectId}`, { archived: archiving });
            await Promise.all([reload(), loadProjects()]);
            toast(archiving ? 'Project archived' : 'Project restored', 'success');
          } catch (err) { errorToast(err); }
        } }, icon('archive', 15), p.archived ? 'Restore' : 'Archive')));
    }
    if (p.role !== 'owner') {
      blocks.push(h('div', { class: 'ps-danger-row' },
        h('div', { class: 'grow' }, h('strong', null, 'Leave project'), h('p', { class: 'ps-sub' }, 'You will lose access until someone invites you again.')),
        h('button', { class: 'btn btn-secondary', onclick: leave }, icon('logout', 15), 'Leave')));
    }
    if (p.role === 'owner') {
      blocks.push(h('div', { class: 'ps-danger-row' },
        h('div', { class: 'grow' }, h('strong', null, 'Delete project'),
          h('p', { class: 'ps-sub' }, 'Permanently deletes the project with all its tasks, comments, files and time entries.')),
        h('button', { class: 'btn btn-danger', onclick: deleteProject }, icon('trash', 15), 'Delete project')));
    }
    return h('section', { class: 'card ps-panel ps-danger' },
      h('div', { class: 'ps-panel-head' }, h('h2', { class: 'ps-title' }, 'Danger zone'), h('p', { class: 'ps-sub' }, 'Actions here affect everyone in the project.')),
      h('div', { class: 'ps-panel-body' }, blocks));
  }

  function deleteProject() {
    const p = state.board.project;
    const input = h('input', { class: 'input', placeholder: p.name, autofocus: true, 'aria-label': 'Type the project name to confirm' });
    const btn = h('button', { class: 'btn btn-danger', disabled: true }, 'Delete forever');
    input.addEventListener('input', () => { btn.disabled = input.value.trim() !== p.name; });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.del(`/projects/${projectId}`);
        m.close();
        state.board = null;
        await loadProjects();
        navigate('/dashboard');
        toast(`Deleted “${p.name}”`, 'success');
      } catch (err) { errorToast(err); btn.disabled = false; }
    });
    const m = openModal({
      title: 'Delete project', width: 460,
      content: h('div', null,
        h('p', { class: 'confirm-text', style: { marginBottom: '12px' } }, 'This cannot be undone. Type ', h('strong', null, p.name), ' to confirm.'),
        input),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'), btn],
    });
  }

  drawNav();
  draw();
  return () => shell.cleanup();
}
