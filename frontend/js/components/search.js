// Command palette: search tasks & projects, plus quick actions.
import { api } from '../api.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import { debounce, dueInfo, errorToast, h, icon, mount, openModal } from '../ui.js';

let open = null;

export function openSearch() {
  if (open) { open.input.focus(); return; }
  const input = h('input', {
    class: 'sr-input', placeholder: 'Search tasks, projects, or type #number…', autofocus: true,
    'aria-label': 'Search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'sr-results', autocomplete: 'off',
  });
  const results = h('div', { class: 'sr-results', id: 'sr-results', role: 'listbox' });
  let items = []; // [{ el, run }]
  let active = 0;
  let seq = 0;

  const close = () => modal.close();
  const run = (fn) => { close(); setTimeout(fn, 0); };

  async function toggleTheme() {
    const mod = await import('../app.js');
    mod.toggleTheme();
  }

  const quickActions = () => [
    { icon: 'home', label: 'Go to Dashboard', hint: 'G D', run: () => navigate('/dashboard') },
    { icon: 'check-circle', label: 'Go to My Tasks', hint: 'G T', run: () => navigate('/tasks') },
    { icon: 'pin', label: 'Go to Agenda', hint: 'G A', run: () => navigate('/agenda') },
    { icon: 'clock', label: 'Go to Time Tracking', run: () => navigate('/time') },
    { icon: 'folder', label: 'All projects', hint: 'G P', run: () => navigate('/projects') },
    { icon: 'plus', label: 'New task', hint: 'N', run: () => import('./quickTask.js').then((m) => m.openQuickTask()) },
    { icon: 'layers', label: 'New project', run: () => import('./projectForm.js').then((m) => m.openNewProject()) },
    { icon: 'moon', label: 'Toggle dark mode', run: toggleTheme },
  ];

  function row({ icon: ic, swatch, label, sub, hint, run: fn, extra }) {
    const el = h('button', { class: 'sr-item', role: 'option', onclick: () => run(fn), onmousemove: () => setActive(items.findIndex((x) => x.el === el)) },
      swatch ? h('span', { class: 'project-dot', style: { background: swatch.color } }, icon(swatch.icon || 'folder', 11)) : h('span', { class: 'sr-icon' }, icon(ic, 15)),
      h('span', { class: 'sr-text' }, h('span', { class: 'sr-label' }, label), sub ? h('span', { class: 'sr-sub' }, sub) : null),
      extra || null,
      hint ? h('kbd', null, hint) : null);
    items.push({ el, run: fn });
    return el;
  }

  function setActive(i) {
    if (i < 0 || !items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((it, j) => {
      it.el.classList.toggle('active', j === active);
      it.el.setAttribute('aria-selected', String(j === active));
    });
    items[active].el.scrollIntoView({ block: 'nearest' });
  }

  function drawEmpty() {
    items = [];
    const recent = state.projects.filter((p) => !p.archived).slice(0, 5);
    mount(results,
      h('div', { class: 'sr-group' }, 'Quick actions'),
      quickActions().map(row),
      recent.length ? [h('div', { class: 'sr-group' }, 'Projects'),
        recent.map((p) => row({ swatch: p, label: p.name, sub: `${p.open_tasks} open tasks`, run: () => navigate(`/projects/${p.id}`) }))] : null);
    setActive(0);
  }

  async function search(q) {
    const my = ++seq;
    try {
      const res = await api.get(`/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      items = [];
      const groups = [];
      if (res.projects.length) {
        groups.push(h('div', { class: 'sr-group' }, 'Projects'),
          res.projects.map((p) => row({ swatch: p, label: p.name, sub: p.archived ? 'Archived' : null, run: () => navigate(`/projects/${p.id}`) })));
      }
      if (res.tasks.length) {
        groups.push(h('div', { class: 'sr-group' }, 'Tasks'),
          res.tasks.map((t) => {
            const due = t.status === 'open' ? dueInfo(t.due_date) : null;
            return row({
              icon: t.status === 'completed' ? 'check-circle' : t.status === 'archived' ? 'archive' : 'circle',
              label: t.title,
              sub: `#${t.number} · ${t.project?.name || ''}${t.section ? ` · ${t.section.name}` : ''}${t.status !== 'open' ? ` · ${t.status}` : ''}`,
              extra: due ? h('span', { class: ['chip', 'due-chip', due.cls] }, due.text) : null,
              run: () => import('./taskModal.js').then((m) => m.openTask(t.id)),
            });
          }));
      }
      if (!groups.length) {
        mount(results, h('div', { class: 'sr-none' }, icon('search', 20), h('div', null, `No results for “${q}”`)));
        return;
      }
      mount(results, groups);
      setActive(0);
    } catch (err) {
      if (my === seq) errorToast(err);
    }
  }

  const onInput = debounce(() => {
    const q = input.value.trim();
    if (!q) { seq++; drawEmpty(); } else search(q);
  }, 180);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.el.click(); }
  });

  const modal = openModal({
    className: 'sr-modal search-modal',
    width: 620,
    content: h('div', null,
      h('div', { class: 'sr-bar' }, icon('search', 18), input, h('kbd', null, 'Esc')),
      results,
      h('div', { class: 'sr-foot' },
        h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' navigate'),
        h('span', null, h('kbd', null, '↵'), ' open'))),
    onClose: () => { open = null; },
  });
  open = { modal, input };
  drawEmpty();
}
