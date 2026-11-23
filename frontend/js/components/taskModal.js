// Task detail dialog. openTask(id) / closeTask(). Syncs ?task=<id> in the URL.
import { api } from '../api.js';
import { setQuery } from '../router.js';
import {
  emit, loadPinned, loadTimer, on, state, upsertBoardTask, removeBoardTask,
} from '../store.js';
import {
  PRIORITIES, avatar, confirmDialog, debounce, errorToast, fmtBytes, fmtDateTime, fmtDuration, fmtRelative,
  fromDateInput, h, icon, menu, mount, openModal, pickerPopover, popover, renderMarkdown, spinner, toDateInput,
  toast, COLORS,
} from '../ui.js';
import { activityIcon, activityText } from './activityText.js';
import { dueChip, priorityBars } from './taskCard.js';

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const RECURRENCE = { null: 'Does not repeat', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

let current = null; // { id, modal, cleanup }

export function closeTask() {
  current?.modal.close();
}

export async function openTask(taskId) {
  taskId = Number(taskId);
  if (current?.id === taskId) return;
  if (current) {
    const prev = current;
    current = null;
    prev.silent = true;
    prev.modal.close();
  }
  const state$ = { id: taskId, silent: false };
  current = state$;
  setQuery({ task: taskId });
  emit('task-modal', taskId);

  const modal = openModal({
    width: 1040,
    className: 'task-modal',
    content: spinner(),
    onClose: () => {
      state$.cleanup?.();
      if (current === state$) current = null;
      if (!state$.silent) {
        setQuery({ task: null });
        emit('task-modal', null);
      }
    },
  });
  state$.modal = modal;
  try {
    await renderTask(modal, state$);
  } catch (err) {
    mount(modal.body, h('div', { class: 'tm-error' },
      h('h3', null, err.status === 404 ? 'Task not found' : 'Could not load task'),
      h('p', { class: 'muted' }, err.message),
      h('button', { class: 'btn btn-secondary', onclick: () => modal.close() }, 'Close')));
  }
}

// ------------------------------------------------------------------ render

async function renderTask(modal, st) {
  let task = await api.get(`/tasks/${st.id}`);
  let ctx = await projectContext(task.project_id);
  const role = ctx.project.role || 'viewer';
  const canEdit = RANK[role] >= RANK.member;
  const canAdmin = RANK[role] >= RANK.admin;
  let feedTab = 'comments';
  let editingDesc = false;
  let descDraft = null;
  let commentDraft = '';

  const memberById = (id) => ctx.members.find((m) => m.id === id) || null;
  const tagById = (id) => ctx.tags.find((t) => t.id === id) || null;

  async function refresh() {
    if (!current || current !== st) return;
    try {
      task = await api.get(`/tasks/${st.id}`);
      draw();
    } catch (err) {
      if (err.status === 404) { toast('This task was deleted'); modal.close(); }
    }
  }

  async function patch(body) {
    try {
      const summary = await api.patch(`/tasks/${task.id}`, body);
      upsertBoardTask(summary);
      emit('task-saved', summary);
      await refresh();
      return summary;
    } catch (err) {
      errorToast(err);
      await refresh();
      return null;
    }
  }

  async function act(promise) {
    try {
      const res = await promise;
      await refresh();
      if (state.board?.project.id === task.project_id) {
        upsertBoardTask(stripDetail(task));
      }
      emit('task-saved', task);
      return res;
    } catch (err) {
      errorToast(err);
      return null;
    }
  }

  // ---------------------------------------------------------------- layout

  function draw() {
    const scroll = modal.body.querySelector('.tm-main')?.scrollTop || 0;
    const active = document.activeElement;
    const keepFocus = active && modal.body.contains(active) && active.dataset.keep ? active.dataset.keep : null;
    mount(modal.body,
      header(),
      h('div', { class: 'tm-layout' },
        h('div', { class: 'tm-main' },
          titleBlock(),
          descriptionBlock(),
          checklistsBlock(),
          attachmentsBlock(),
          relationsBlock(),
          feedBlock()),
        h('aside', { class: 'tm-side' }, sidebar())));
    const main = modal.body.querySelector('.tm-main');
    if (main) main.scrollTop = scroll;
    if (keepFocus) modal.body.querySelector(`[data-keep="${keepFocus}"]`)?.focus();
  }

  function header() {
    const completed = task.status === 'completed';
    const archived = task.status === 'archived';
    const timerRunning = state.timer && state.timer.task.id === task.id;
    const pinned = state.pinnedTaskIds.has(task.id);
    return h('div', { class: 'tm-head' },
      h('div', { class: 'tm-crumbs' },
        h('a', { class: 'tm-crumb', href: `/projects/${task.project.id}`, onclick: () => modal.close() },
          h('span', { class: 'swatch', style: { background: task.project.color } }), task.project.name),
        icon('chevron-right', 14, 'muted'),
        h('button', {
          class: 'tm-crumb tm-section-btn', disabled: !canEdit,
          onclick: (e) => menu(e.currentTarget, ctx.sections.map((s) => ({
            label: s.name, swatch: s.color, checked: s.id === task.section_id,
            onClick: () => moveToSection(s.id),
          }))),
        }, h('span', { class: 'swatch', style: { background: task.section.color } }), task.section.name, canEdit ? icon('chevron-down', 13) : null),
        h('span', { class: 'tm-num' }, `#${task.number}`),
        archived ? h('span', { class: 'role-badge' }, 'Archived') : null),
      h('div', { class: 'tm-head-actions' },
        canEdit && !archived ? h('button', {
          class: ['btn', 'btn-sm', completed ? 'btn-secondary' : 'btn-complete'],
          onclick: () => patch({ status: completed ? 'open' : 'completed' }).then((s) => {
            if (s && s.status === 'completed') toast('Task completed', 'success');
          }),
        }, icon('check', 14), completed ? 'Completed' : 'Complete') : null,
        archived && canEdit ? h('button', { class: 'btn btn-sm btn-secondary', onclick: () => patch({ status: 'open' }) }, icon('repeat', 14), 'Restore') : null,
        canEdit ? h('button', {
          class: ['icon-btn', timerRunning && 'timer-on'], title: timerRunning ? 'Stop timer' : 'Start timer',
          'aria-label': timerRunning ? 'Stop timer' : 'Start timer', onclick: toggleTimer,
        }, icon(timerRunning ? 'stop' : 'play', 16)) : null,
        h('button', {
          class: ['icon-btn', pinned && 'active'], title: pinned ? 'Pinned to your agenda' : 'Pin to agenda',
          'aria-label': 'Pin to agenda', onclick: togglePin,
        }, icon('pin', 16)),
        h('button', { class: 'icon-btn', 'aria-label': 'More actions', onclick: (e) => moreMenu(e.currentTarget) }, icon('more', 18)),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => modal.close() }, icon('x', 18))));
  }

  function titleBlock() {
    const ta = h('textarea', {
      class: 'tm-title', rows: 1, readonly: !canEdit, 'aria-label': 'Task title', 'data-keep': 'title', maxlength: 300,
    }, task.title);
    ta.value = task.title;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
    requestAnimationFrame(grow);
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ta.blur(); } });
    ta.addEventListener('blur', () => {
      const v = ta.value.trim();
      if (v && v !== task.title) patch({ title: v });
      else ta.value = task.title;
    });
    const by = memberById(task.creator_id);
    return h('div', { class: 'tm-title-wrap' }, ta,
      h('div', { class: 'tm-sub muted small' },
        `Created ${fmtRelative(task.created_at)}${by ? ` by ${by.name}` : ''}`,
        task.completed_at ? ` · Completed ${fmtRelative(task.completed_at)}` : ''));
  }

  // ---------------------------------------------------------------- description

  function descriptionBlock() {
    const sectionHead = blockHead('edit', 'Description',
      canEdit && !editingDesc ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { editingDesc = true; draw(); } }, task.description ? 'Edit' : 'Add') : null);
    if (editingDesc) {
      const ta = h('textarea', { class: 'textarea tm-desc-input', rows: 8, 'data-keep': 'desc', placeholder: 'Add details. Markdown supported: **bold**, *italic*, `code`, - lists, - [ ] checkboxes, @mention' });
      if (descDraft === null) descDraft = task.description;
      ta.value = descDraft;
      ta.addEventListener('input', () => { descDraft = ta.value; });
      attachMentions(ta, ctx.members);
      const save = async () => {
        editingDesc = false;
        descDraft = null;
        if (ta.value !== task.description) await patch({ description: ta.value });
        else draw();
      };
      const cancel = () => { editingDesc = false; descDraft = null; draw(); };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      });
      if (!modal.body.querySelector('[data-keep="desc"]')) {
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
      }
      return h('section', { class: 'tm-block' }, sectionHead, ta,
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn btn-primary btn-sm', onclick: save }, 'Save'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: cancel }, 'Cancel'),
          h('span', { class: 'muted small' }, '⌘/Ctrl + Enter to save')));
    }
    return h('section', { class: 'tm-block' }, sectionHead,
      task.description
        ? h('div', { class: 'md tm-desc', html: renderMarkdown(task.description), ondblclick: () => { if (canEdit) { editingDesc = true; draw(); } } })
        : h('button', { class: 'tm-placeholder', disabled: !canEdit, onclick: () => { editingDesc = true; draw(); } }, canEdit ? 'Add a description…' : 'No description'));
  }

  // ---------------------------------------------------------------- checklists

  function checklistsBlock() {
    const lists = task.checklists;
    if (!lists.length && !canEdit) return null;
    return h('section', { class: 'tm-block' },
      blockHead('checklist', 'Checklists', canEdit ? h('button', { class: 'btn btn-ghost btn-sm', onclick: addChecklist }, icon('plus', 13), 'Add checklist') : null),
      lists.length ? lists.map(checklist) : h('button', { class: 'tm-placeholder', onclick: addChecklist }, 'Break this task into steps…'));
  }

  function checklist(cl) {
    const done = cl.items.filter((i) => i.done).length;
    const pct = cl.items.length ? Math.round((done / cl.items.length) * 100) : 0;
    const input = h('input', { class: 'input input-sm', placeholder: 'Add an item and press Enter', 'data-keep': `cl-${cl.id}` });
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const text = input.value.trim();
      input.value = '';
      await act(api.post(`/checklists/${cl.id}/items`, { text }));
    });
    return h('div', { class: 'tm-checklist' },
      h('div', { class: 'tm-cl-head' },
        h('strong', { class: 'grow truncate' }, cl.name),
        h('span', { class: 'muted small' }, `${done}/${cl.items.length}`),
        canEdit ? h('button', { class: 'icon-btn sm', 'aria-label': 'Checklist menu', onclick: (e) => menu(e.currentTarget, [
          { label: 'Rename', icon: 'edit', onClick: async () => {
            const { promptDialog } = await import('../ui.js');
            const name = await promptDialog('Rename checklist', { value: cl.name });
            if (name) act(api.patch(`/checklists/${cl.id}`, { name }));
          } },
          { label: 'Delete checklist', icon: 'trash', danger: true, onClick: async () => {
            if (await confirmDialog(`Delete “${cl.name}” and its ${cl.items.length} items?`, { confirmText: 'Delete', danger: true })) act(api.del(`/checklists/${cl.id}`));
          } },
        ]) }, icon('more', 15)) : null),
      h('div', { class: 'tm-progress' }, h('div', { class: 'tm-progress-bar', style: { width: `${pct}%` } })),
      h('div', { class: 'tm-cl-items' }, cl.items.map((it) => checklistItem(it))),
      canEdit ? input : null);
  }

  function checklistItem(it) {
    const text = h('span', { class: 'tm-cl-text' }, it.text);
    if (canEdit) {
      text.addEventListener('dblclick', () => {
        const inp = h('input', { class: 'input input-sm', value: it.text });
        const commit = () => {
          const v = inp.value.trim();
          if (v && v !== it.text) act(api.patch(`/checklist-items/${it.id}`, { text: v }));
          else draw();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { e.stopPropagation(); draw(); }
        });
        inp.addEventListener('blur', commit);
        text.replaceWith(inp);
        inp.focus();
      });
    }
    return h('div', { class: ['tm-cl-item', it.done && 'done'] },
      h('button', {
        class: ['checkbox', it.done && 'checked'], disabled: !canEdit, 'aria-label': it.done ? 'Uncheck' : 'Check',
        onclick: () => { it.done = !it.done; draw(); act(api.patch(`/checklist-items/${it.id}`, { done: it.done })); },
      }, it.done ? icon('check', 12) : null),
      text,
      canEdit ? h('button', { class: 'icon-btn sm tm-hover', 'aria-label': 'Delete item', onclick: () => act(api.del(`/checklist-items/${it.id}`)) }, icon('x', 13)) : null);
  }

  async function addChecklist() {
    await act(api.post(`/tasks/${task.id}/checklists`, { name: task.checklists.length ? `Checklist ${task.checklists.length + 1}` : 'Checklist' }));
    const inputs = modal.body.querySelectorAll('.tm-checklist input');
    inputs[inputs.length - 1]?.focus();
  }

  // ---------------------------------------------------------------- attachments

  function attachmentsBlock() {
    const files = task.attachments;
    if (!files.length && !canEdit) return null;
    const fileInput = h('input', { type: 'file', multiple: true, class: 'sr-only', onchange: (e) => upload([...e.target.files]) });
    const block = h('section', { class: 'tm-block tm-attachments' },
      blockHead('paperclip', 'Attachments', canEdit ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => fileInput.click() }, icon('upload', 13), 'Upload') : null),
      fileInput,
      files.length ? h('div', { class: 'tm-files' }, files.map(fileTile))
        : h('button', { class: 'tm-dropzone', onclick: () => fileInput.click() }, icon('upload', 18), 'Drop files here or click to upload'));
    if (canEdit) {
      block.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); block.classList.add('drag-over'); } });
      block.addEventListener('dragleave', (e) => { if (!block.contains(e.relatedTarget)) block.classList.remove('drag-over'); });
      block.addEventListener('drop', (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        block.classList.remove('drag-over');
        upload([...e.dataTransfer.files]);
      });
    }
    return block;
  }

  function fileTile(a) {
    const ext = (a.filename.split('.').pop() || '').slice(0, 4).toUpperCase();
    return h('div', { class: 'tm-file' },
      h('a', { class: 'tm-file-thumb', href: api.fileUrl(a.url, { inline: a.is_image }), target: '_blank', rel: 'noopener' },
        a.is_image && a.mime !== 'image/svg+xml' ? h('img', { src: api.fileUrl(a.url, { inline: true }), alt: a.filename, loading: 'lazy' }) : h('span', { class: 'tm-ext' }, ext || 'FILE')),
      h('div', { class: 'tm-file-info' },
        h('a', { class: 'truncate tm-file-name', href: api.fileUrl(a.url), title: a.filename }, a.filename),
        h('span', { class: 'muted small' }, `${fmtBytes(a.size)} · ${fmtRelative(a.created_at)}`)),
      canEdit ? h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${a.filename}`, onclick: async () => {
        if (await confirmDialog(`Delete “${a.filename}”?`, { confirmText: 'Delete', danger: true })) act(api.del(`/attachments/${a.id}`));
      } }, icon('trash', 14)) : null);
  }

  async function upload(files) {
    for (const f of files) {
      const t = toast(`Uploading ${f.name}…`, 'info', { timeout: 60000 });
      try {
        await api.upload(`/tasks/${task.id}/attachments`, f);
      } catch (err) {
        errorToast(err);
      } finally {
        t();
      }
    }
    await act(Promise.resolve());
  }

  // ---------------------------------------------------------------- relations

  function relationsBlock() {
    const rels = task.relations;
    if (!rels.length && !canEdit) return null;
    return h('section', { class: 'tm-block' },
      blockHead('link', 'Linked tasks', canEdit ? h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => addRelation(e.currentTarget) }, icon('plus', 13), 'Link task') : null),
      rels.length ? h('div', { class: 'tm-relations' }, rels.map((r) => h('div', { class: 'tm-rel' },
        h('span', { class: ['tm-rel-type', r.type] }, r.label),
        h('button', { class: ['tm-rel-task', r.task.status === 'completed' && 'done'], onclick: () => openTask(r.task.id) },
          h('span', { class: 'muted' }, `#${r.task.number}`), h('span', { class: 'truncate' }, r.task.title),
          r.task.project_id !== task.project_id ? h('span', { class: 'muted small' }, `· ${r.task.project_name}`) : null),
        canEdit ? h('button', { class: 'icon-btn sm tm-hover', 'aria-label': 'Remove link', onclick: () => act(api.del(`/relations/${r.id}`)) }, icon('x', 13)) : null)))
        : h('p', { class: 'muted small' }, 'Link tasks that block, duplicate or relate to this one.'));
  }

  function addRelation(anchor) {
    let type = 'relates';
    popover(anchor, (_, close) => {
      const input = h('input', { class: 'input input-sm', placeholder: 'Search tasks by title or #number', autofocus: true });
      const results = h('div', { class: 'picker-list' });
      const seg = h('div', { class: 'seg', style: { width: '100%' } });
      const drawSeg = () => mount(seg, [['relates', 'Relates to'], ['blocks', 'Blocks'], ['duplicates', 'Duplicates']].map(([k, label]) => h('button', {
        class: type === k ? 'active' : '', style: { flex: 1 }, onclick: () => { type = k; drawSeg(); },
      }, label)));
      drawSeg();
      const search = debounce(async () => {
        const q = input.value.trim();
        if (!q) { mount(results); return; }
        try {
          const res = await api.get(`/search?q=${encodeURIComponent(q)}`);
          const items = res.tasks.filter((t) => t.id !== task.id);
          mount(results, items.length ? items.map((t) => h('button', {
            class: 'menu-item', onclick: async () => {
              close();
              await act(api.post(`/tasks/${task.id}/relations`, { related_task_id: t.id, type }));
            },
          }, h('span', { class: 'muted' }, `#${t.number}`), h('span', { class: 'menu-label' }, t.title),
          h('span', { class: 'menu-hint' }, t.project?.name || ''))) : h('div', { class: 'picker-empty' }, 'No tasks found'));
        } catch (err) { errorToast(err); }
      }, 200);
      input.addEventListener('input', search);
      return h('div', { class: 'picker' }, seg, input, results);
    }, { width: 340 });
  }

  // ---------------------------------------------------------------- comments & activity

  function feedBlock() {
    const tabs = h('div', { class: 'seg' },
      h('button', { class: feedTab === 'comments' ? 'active' : '', onclick: () => { feedTab = 'comments'; draw(); } }, `Comments (${task.comments.length})`),
      h('button', { class: feedTab === 'activity' ? 'active' : '', onclick: () => { feedTab = 'activity'; draw(); } }, 'Activity'));
    return h('section', { class: 'tm-block tm-feed' }, h('div', { class: 'tm-feed-head' }, tabs),
      feedTab === 'comments' ? commentsList() : activityList());
  }

  function commentsList() {
    const composer = canEdit ? commentComposer() : null;
    return h('div', { class: 'tm-comments' },
      composer,
      task.comments.length ? [...task.comments].reverse().map(commentItem)
        : h('p', { class: 'muted small tm-empty-feed' }, 'No comments yet. Start the conversation, use @ to mention someone.'));
  }

  function commentComposer() {
    const ta = h('textarea', { class: 'textarea tm-comment-input', rows: 2, placeholder: 'Write a comment… (@ to mention, ⌘/Ctrl+Enter to send)', 'data-keep': 'comment' });
    ta.value = commentDraft;
    ta.addEventListener('input', () => { commentDraft = ta.value; });
    attachMentions(ta, ctx.members);
    const send = h('button', { class: 'btn btn-primary btn-sm' }, 'Comment');
    const submit = async () => {
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await api.post(`/tasks/${task.id}/comments`, { body });
        ta.value = '';
        commentDraft = '';
        await act(Promise.resolve());
      } catch (err) { errorToast(err); }
      send.disabled = false;
    };
    send.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    return h('div', { class: 'tm-composer' }, avatar(state.user, 30), h('div', { class: 'grow' }, ta, h('div', { class: 'row', style: { marginTop: '6px', justifyContent: 'flex-end' } }, send)));
  }

  function commentItem(c) {
    const mine = c.user_id === state.user.id;
    const body = h('div', { class: 'md tm-comment-body', html: renderMarkdown(c.body) });
    const edit = () => {
      const ta = h('textarea', { class: 'textarea', rows: 3 });
      ta.value = c.body;
      attachMentions(ta, ctx.members);
      const save = async () => {
        if (ta.value.trim() && ta.value !== c.body) await act(api.patch(`/comments/${c.id}`, { body: ta.value.trim() }));
        else draw();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        if (e.key === 'Escape') { e.stopPropagation(); draw(); }
      });
      body.replaceWith(h('div', null, ta, h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn btn-primary btn-sm', onclick: save }, 'Save'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: draw }, 'Cancel'))));
      ta.focus();
    };
    return h('div', { class: 'tm-comment' },
      avatar(c.user, 30),
      h('div', { class: 'grow' },
        h('div', { class: 'tm-comment-meta' },
          h('strong', null, c.user?.name || 'Deleted user'),
          h('span', { class: 'muted small', title: fmtDateTime(c.created_at) }, fmtRelative(c.created_at)),
          c.updated_at ? h('span', { class: 'muted small' }, '(edited)') : null,
          h('div', { class: 'grow' }),
          mine || RANK[role] >= RANK.admin ? h('button', { class: 'icon-btn sm tm-hover', 'aria-label': 'Comment menu', onclick: (e) => menu(e.currentTarget, [
            mine ? { label: 'Edit', icon: 'edit', onClick: edit } : null,
            { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
              if (await confirmDialog('Delete this comment?', { confirmText: 'Delete', danger: true })) act(api.del(`/comments/${c.id}`));
            } },
          ]) }, icon('more', 15)) : null),
        body));
  }

  function activityList() {
    if (!task.activity.length) return h('p', { class: 'muted small tm-empty-feed' }, 'No activity yet.');
    return h('div', { class: 'tm-activity' }, task.activity.map((a) => h('div', { class: 'tm-act' },
      h('span', { class: 'tm-act-icon' }, icon(activityIcon(a.action), 13)),
      h('div', { class: 'grow' }, activityText(a, { withTask: false }),
        h('div', { class: 'muted small', title: fmtDateTime(a.created_at) }, fmtRelative(a.created_at))))));
  }

  // ---------------------------------------------------------------- sidebar

  function sidebar() {
    const assignee = task.assignee;
    const prop = (label, content, onclick, opts = {}) => h('div', { class: 'tm-prop' },
      h('div', { class: 'tm-prop-label' }, label),
      onclick && canEdit
        ? h('button', { class: ['tm-prop-value', opts.empty && 'empty'], onclick }, content, icon('chevron-down', 13, 'tm-caret'))
        : h('div', { class: ['tm-prop-value', 'static', opts.empty && 'empty'] }, content));

    const tags = task.tag_ids.map(tagById).filter(Boolean);
    const total = task.time_entries.reduce((s, e) => s + (e.running ? (Date.now() - new Date(e.started_at)) / 1000 : e.duration_seconds), 0);
    const est = task.estimate_minutes ? task.estimate_minutes * 60 : 0;

    return [
      prop('Assignee', assignee ? [avatar(assignee, 24), h('span', { class: 'truncate' }, assignee.name)] : [avatar(null, 24), 'Unassigned'],
        (e) => pickerPopover(e.currentTarget, {
          items: [{ value: 0, label: 'Unassigned' }, ...ctx.members.filter((m) => m.role !== 'viewer').map((m) => ({ value: m.id, label: m.name, user: m }))],
          selected: [task.assignee_id || 0], placeholder: 'Assign to…',
          render: (it) => [it.user ? avatar(it.user, 22) : avatar(null, 22), h('span', { class: 'menu-label' }, it.label)],
          onChange: (v) => patch({ assignee_id: v || null }),
        }), { empty: !assignee }),

      prop('Due date', task.due_date ? [dueChip(task.due_date, task.status === 'completed'), h('span', { class: 'muted small' }, fmtDateTime(task.due_date))] : 'No due date',
        (e) => datePopover(e.currentTarget, 'due_date', 17), { empty: !task.due_date }),

      prop('Start date', task.start_date ? fmtDateTime(task.start_date) : 'No start date',
        (e) => datePopover(e.currentTarget, 'start_date', 9), { empty: !task.start_date }),

      prop('Priority', task.priority !== 'none' ? [priorityBars(task.priority), PRIORITIES[task.priority].label] : 'No priority',
        (e) => menu(e.currentTarget, Object.entries(PRIORITIES).reverse().map(([k, p]) => ({
          label: p.label, swatch: p.color, checked: task.priority === k, onClick: () => patch({ priority: k }),
        }))), { empty: task.priority === 'none' }),

      prop('Tags', tags.length ? h('div', { class: 'tm-tags' }, tags.map((t) => h('span', { class: 'chip tag-chip', style: { background: t.color } }, t.name))) : 'No tags',
        (e) => tagPicker(e.currentTarget), { empty: !tags.length }),

      prop('Repeat', task.recurrence ? [icon('repeat', 14), RECURRENCE[task.recurrence]] : 'Does not repeat',
        (e) => menu(e.currentTarget, Object.entries(RECURRENCE).map(([k, label]) => ({
          label, checked: String(task.recurrence) === k, onClick: () => {
            if (k !== 'null' && !task.due_date) { toast('Set a due date first: repeats are based on it', 'error'); return; }
            patch({ recurrence: k === 'null' ? null : k });
          },
        }))), { empty: !task.recurrence }),

      h('div', { class: 'tm-prop' },
        h('div', { class: 'tm-prop-label' }, 'Watchers'),
        h('div', { class: 'tm-watchers' },
          task.watchers.map((w) => avatar(w, 26)),
          canEdit ? h('button', { class: 'icon-btn sm', 'aria-label': 'Edit watchers', onclick: (e) => pickerPopover(e.currentTarget, {
            items: ctx.members.map((m) => ({ value: m.id, label: m.name, user: m })), multi: true, selected: task.watcher_ids,
            render: (it) => [avatar(it.user, 22), h('span', { class: 'menu-label' }, it.label)],
            onChange: debounce((ids) => patch({ watcher_ids: ids }), 500),
          }) }, icon('plus', 14)) : null,
          h('button', {
            class: 'btn btn-ghost btn-sm', onclick: () => {
              const ids = new Set(task.watcher_ids);
              ids.has(state.user.id) ? ids.delete(state.user.id) : ids.add(state.user.id);
              patch({ watcher_ids: [...ids] });
            }, disabled: !canEdit,
          }, task.watcher_ids.includes(state.user.id) ? 'Unwatch' : 'Watch'))),

      h('div', { class: 'tm-prop tm-time' },
        h('div', { class: 'tm-prop-label' }, 'Time tracking'),
        h('div', { class: 'tm-time-total' },
          h('strong', null, fmtDuration(total, { short: true })),
          est ? h('span', { class: 'muted small' }, ` of ${fmtDuration(est, { short: true })} estimated`) : null),
        est ? h('div', { class: 'tm-progress' }, h('div', { class: ['tm-progress-bar', total > est && 'over'], style: { width: `${Math.min(100, (total / est) * 100)}%` } })) : null,
        canEdit ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
          h('button', { class: ['btn', 'btn-sm', state.timer?.task.id === task.id ? 'btn-danger' : 'btn-soft'], onclick: toggleTimer },
            icon(state.timer?.task.id === task.id ? 'stop' : 'play', 12), state.timer?.task.id === task.id ? 'Stop' : 'Start timer'),
          h('button', { class: 'btn btn-sm btn-secondary', onclick: (e) => addTimePopover(e.currentTarget) }, icon('plus', 12), 'Log time'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
            const { promptDialog } = await import('../ui.js');
            const v = await promptDialog('Time estimate', { value: task.estimate_minutes ? String(task.estimate_minutes / 60) : '', placeholder: 'Hours, e.g. 2.5', label: 'Estimated hours' });
            if (v === null) return;
            const hrs = parseFloat(v);
            patch({ estimate_minutes: Number.isFinite(hrs) && hrs > 0 ? Math.round(hrs * 60) : null });
          } }, 'Estimate')) : null,
        task.time_entries.length ? h('div', { class: 'tm-time-entries' }, task.time_entries.slice(0, 8).map((e) => h('div', { class: 'tm-time-entry' },
          avatar(e.user, 20),
          h('span', { class: 'grow truncate', title: e.note || '' }, e.running ? h('span', { class: 'tm-live' }, 'Running') : fmtDuration(e.duration_seconds, { short: true }),
            e.note ? h('span', { class: 'muted' }, ` · ${e.note}`) : null),
          h('span', { class: 'muted small' }, fmtRelative(e.started_at)),
          canEdit && (e.user_id === state.user.id || RANK[role] >= RANK.admin) && !e.running
            ? h('button', { class: 'icon-btn sm tm-hover', 'aria-label': 'Delete entry', onclick: () => act(api.del(`/time-entries/${e.id}`)) }, icon('x', 12)) : null))) : null),
    ];
  }

  function datePopover(anchor, field, hour) {
    popover(anchor, (_, close) => {
      const input = h('input', { class: 'input', type: 'date', value: toDateInput(task[field]) });
      const set = (iso) => { close(); patch({ [field]: iso }); };
      const quick = (label, days) => h('button', { class: 'menu-item', onclick: () => {
        const d = new Date(); d.setDate(d.getDate() + days);
        set(fromDateInput(toDateInput(d.toISOString()), hour));
      } }, h('span', { class: 'menu-label' }, label), h('span', { class: 'menu-hint' },
        new Date(Date.now() + days * 86400000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })));
      input.addEventListener('change', () => input.value && set(fromDateInput(input.value, hour)));
      return h('div', { class: 'menu' },
        quick('Today', 0), quick('Tomorrow', 1), quick('In 3 days', 3), quick('Next week', 7),
        h('div', { class: 'menu-divider' }),
        h('div', { style: { padding: '4px' } }, input),
        task[field] ? h('button', { class: 'menu-item danger', onclick: () => set(null) }, icon('x', 14), h('span', { class: 'menu-label' }, 'Remove date')) : null);
    }, { width: 250 });
  }

  function tagPicker(anchor) {
    pickerPopover(anchor, {
      items: ctx.tags.map((t) => ({ value: t.id, label: t.name, color: t.color })),
      selected: task.tag_ids, multi: true, placeholder: 'Find tag…',
      render: (it) => [h('span', { class: 'swatch', style: { background: it.color } }), h('span', { class: 'menu-label' }, it.label)],
      onChange: debounce((ids) => patch({ tag_ids: ids }), 450),
      footer: (close) => h('button', { class: 'menu-item', onclick: async () => {
        close();
        const { promptDialog } = await import('../ui.js');
        const name = await promptDialog('New tag', { placeholder: 'Tag name', confirmText: 'Create' });
        if (!name) return;
        try {
          const t = await api.post(`/projects/${task.project_id}/tags`, { name, color: COLORS[ctx.tags.length % COLORS.length] });
          ctx.tags.push(t);
          if (state.board?.project.id === task.project_id && !state.board.tags.some((x) => x.id === t.id)) state.board.tags.push(t);
          patch({ tag_ids: [...task.tag_ids, t.id] });
        } catch (err) { errorToast(err); }
      } }, icon('plus', 14), h('span', { class: 'menu-label' }, 'Create new tag')),
    });
  }

  function addTimePopover(anchor) {
    popover(anchor, (_, close) => {
      const hrs = h('input', { class: 'input input-sm', type: 'number', min: 0, step: 1, value: 0, 'aria-label': 'Hours' });
      const mins = h('input', { class: 'input input-sm', type: 'number', min: 0, max: 59, step: 5, value: 30, 'aria-label': 'Minutes' });
      const date = h('input', { class: 'input input-sm', type: 'date', value: toDateInput(new Date().toISOString()) });
      const note = h('input', { class: 'input input-sm', placeholder: 'Note (optional)', maxlength: 300 });
      const save = async () => {
        const minutes = (parseInt(hrs.value, 10) || 0) * 60 + (parseInt(mins.value, 10) || 0);
        if (minutes <= 0) { toast('Enter a duration', 'error'); return; }
        close();
        await act(api.post(`/tasks/${task.id}/time`, { minutes, note: note.value, date: fromDateInput(date.value, 9) }));
      };
      return h('div', { class: 'stack', style: { padding: '6px' } },
        h('strong', null, 'Log time'),
        h('div', { class: 'row' }, hrs, h('span', { class: 'muted' }, 'h'), mins, h('span', { class: 'muted' }, 'm')),
        date, note,
        h('button', { class: 'btn btn-primary btn-sm', onclick: save }, 'Add entry'));
    }, { width: 250 });
  }

  // ---------------------------------------------------------------- header actions

  async function moveToSection(sectionId) {
    if (sectionId === task.section_id) return;
    try {
      const summary = await api.post(`/tasks/${task.id}/move`, { section_id: sectionId });
      upsertBoardTask(summary);
      emit('task-saved', summary);
      if (state.board?.project.id === task.project_id) {
        const { loadBoard } = await import('../store.js');
        loadBoard(task.project_id);
      }
      await refresh();
    } catch (err) { errorToast(err); }
  }

  async function toggleTimer() {
    try {
      if (state.timer?.task.id === task.id) {
        const entry = await api.post('/me/timer/stop');
        if (entry) toast(`Tracked ${fmtDuration(entry.duration_seconds, { short: true })}`, 'success');
      } else {
        await api.post(`/tasks/${task.id}/timer/start`);
      }
      await loadTimer();
      await refresh();
    } catch (err) { errorToast(err); }
  }

  async function togglePin() {
    try {
      if (state.pinnedTaskIds.has(task.id)) {
        const ag = await api.get('/agenda');
        const pin = ag.pins.find((p) => p.task.id === task.id);
        if (pin) await api.del(`/agenda/pins/${pin.id}`);
        toast('Removed from your agenda');
      } else {
        await api.post('/agenda/pins', { task_id: task.id });
        toast('Pinned to your agenda', 'success');
      }
      await loadPinned();
      draw();
    } catch (err) { errorToast(err); }
  }

  function moreMenu(anchor) {
    const creatorOrAdmin = canAdmin || task.creator_id === state.user.id;
    menu(anchor, [
      { label: 'Copy link', icon: 'link', onClick: async () => {
        try { await navigator.clipboard.writeText(`${location.origin}/projects/${task.project_id}?task=${task.id}`); toast('Link copied', 'success'); } catch (_) { toast('Could not copy link', 'error'); }
      } },
      canEdit ? { label: 'Duplicate', icon: 'copy', onClick: async () => {
        try {
          const c = await api.post(`/tasks/${task.id}/duplicate`);
          upsertBoardTask(c);
          toast('Task duplicated', 'success', { action: { label: 'Open', onClick: () => openTask(c.id) } });
        } catch (err) { errorToast(err); }
      } } : null,
      canEdit ? { label: 'Move to project…', icon: 'arrow-right', onClick: () => moveToProject(anchor) } : null,
      canEdit && task.status !== 'archived' ? { label: 'Archive', icon: 'archive', onClick: () => patch({ status: 'archived' }).then(() => toast('Task archived')) } : null,
      canEdit && creatorOrAdmin ? 'divider' : null,
      canEdit && creatorOrAdmin ? { label: 'Delete task', icon: 'trash', danger: true, onClick: async () => {
        if (!await confirmDialog(`“${task.title}” and its comments, checklists and files will be permanently deleted.`, { title: 'Delete task?', confirmText: 'Delete', danger: true })) return;
        try {
          await api.del(`/tasks/${task.id}`);
          removeBoardTask(task.id);
          emit('task-saved', { id: task.id, deleted: true });
          toast('Task deleted');
          modal.close();
        } catch (err) { errorToast(err); }
      } } : null,
    ]);
  }

  function moveToProject(anchor) {
    const targets = state.projects.filter((p) => p.id !== task.project_id && !p.archived && p.role !== 'viewer');
    if (!targets.length) { toast('No other projects to move to'); return; }
    pickerPopover(anchor, {
      items: targets.map((p) => ({ value: p.id, label: p.name, color: p.color })),
      placeholder: 'Move to project…',
      render: (it) => [h('span', { class: 'swatch', style: { background: it.color } }), h('span', { class: 'menu-label' }, it.label)],
      onChange: async (pid) => {
        try {
          const board = await api.get(`/projects/${pid}`);
          const target = board.sections[0];
          if (!target) { toast('That project has no sections', 'error'); return; }
          if (!await confirmDialog(`Move to “${board.project.name}” → ${target.name}? Tags are removed and the assignee is kept only if they are a member there.`, { title: 'Move task', confirmText: 'Move' })) return;
          const summary = await api.post(`/tasks/${task.id}/move`, { section_id: target.id, project_id: pid });
          removeBoardTask(task.id);
          emit('task-saved', summary);
          ctx = await projectContext(pid);
          await refresh();
          toast(`Moved to ${board.project.name}`, 'success');
        } catch (err) { errorToast(err); }
      },
    });
  }

  // ---------------------------------------------------------------- live updates

  const scheduleRefresh = debounce(refresh, 300);
  const offs = [
    on('ws', (msg) => {
      if (msg.actor_id === state.user.id) return;
      const tid = msg.data?.task?.id ?? msg.data?.task_id;
      if (tid === task.id) {
        if (msg.type === 'task.deleted') { toast('This task was deleted by someone else'); modal.close(); return; }
        scheduleRefresh();
      }
      if (msg.type === 'board.changed' && msg.project_id === task.project_id) {
        projectContext(task.project_id).then((c) => { ctx = c; scheduleRefresh(); });
      }
    }),
    on('timer', () => draw()),
    on('pinned', () => draw()),
  ];
  const tick = setInterval(() => {
    if (task.time_entries.some((e) => e.running)) {
      const el = modal.body.querySelector('.tm-time-total strong');
      if (el) {
        const total = task.time_entries.reduce((s, e) => s + (e.running ? (Date.now() - new Date(e.started_at)) / 1000 : e.duration_seconds), 0);
        el.textContent = fmtDuration(total, { short: true });
      }
    }
  }, 15000);
  st.cleanup = () => { offs.forEach((off) => off()); clearInterval(tick); };

  draw();
}

// ------------------------------------------------------------------ helpers

function blockHead(ic, title, action) {
  return h('div', { class: 'tm-block-head' }, icon(ic, 15), h('h3', null, title), h('div', { class: 'grow' }), action);
}

function stripDetail(t) {
  const { project, section, assignee, watchers, checklists, comments, attachments, time_entries: te, relations, activity, ...summary } = t;
  return {
    ...summary,
    checklist_total: checklists.reduce((n, c) => n + c.items.length, 0),
    checklist_done: checklists.reduce((n, c) => n + c.items.filter((i) => i.done).length, 0),
    comments: comments.length,
    attachments: attachments.length,
    relations: relations.length,
    time_seconds: te.reduce((n, e) => n + (e.duration_seconds || 0), 0),
  };
}

async function projectContext(projectId) {
  if (state.board?.project.id === projectId) return state.board;
  return api.get(`/projects/${projectId}`);
}

/** @mention autocomplete for a textarea: inserts @[Name](id). */
export function attachMentions(textarea, members) {
  let pop = null;
  let items = [];
  let active = 0;
  let start = -1;
  const closeList = () => { pop?.remove(); pop = null; start = -1; };
  const choose = (m) => {
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(textarea.selectionStart);
    const insert = `@[${m.name}](${m.id}) `;
    textarea.value = before + insert + after;
    const pos = before.length + insert.length;
    textarea.setSelectionRange(pos, pos);
    closeList();
    textarea.focus();
  };
  const drawList = () => {
    if (!pop) {
      pop = h('div', { class: 'popover mention-pop' });
      document.getElementById('overlays').appendChild(pop);
    }
    const r = textarea.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 220)}px`;
    pop.style.width = '240px';
    mount(pop, items.map((m, i) => h('button', {
      class: ['menu-item', i === active && 'kbd-active'],
      onmousedown: (e) => { e.preventDefault(); choose(m); },
    }, avatar(m, 22), h('span', { class: 'menu-label' }, m.name), h('span', { class: 'menu-hint' }, m.email))));
  };
  textarea.addEventListener('input', () => {
    const pos = textarea.selectionStart;
    const text = textarea.value.slice(0, pos);
    const m = text.match(/(^|\s)@([\w.-]{0,30})$/);
    if (!m) { closeList(); return; }
    start = pos - m[2].length - 1;
    const q = m[2].toLowerCase();
    items = members.filter((x) => x.name.toLowerCase().includes(q) || x.email.toLowerCase().startsWith(q)).slice(0, 6);
    active = 0;
    if (!items.length) { closeList(); return; }
    drawList();
  });
  textarea.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; drawList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; drawList(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); choose(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); }
  });
  textarea.addEventListener('blur', () => setTimeout(closeList, 150));
}
