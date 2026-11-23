// All projects: searchable grid with active/archived toggle and sorting.
import { on, state } from '../store.js';
import { avatarStack, emptyState, h, icon, mount, ROLES } from '../ui.js';
import { openNewProject } from '../components/projectForm.js';

/** Project summary card (from GET /api/projects). Used here and on the dashboard. */
export function projectCard(p) {
  const total = (p.open_tasks || 0) + (p.completed_tasks || 0);
  const pct = total ? Math.round((p.completed_tasks / total) * 100) : 0;
  return h('a', { href: `/projects/${p.id}`, class: ['pj-card', p.archived && 'pj-archived'] },
    h('div', { class: 'pj-card-top' },
      h('span', { class: 'project-dot', style: { background: p.color, width: '34px', height: '34px', borderRadius: '9px' } }, icon(p.icon || 'folder', 16)),
      h('div', { class: 'grow' },
        h('div', { class: 'pj-name truncate' }, p.name),
        h('div', { class: 'pj-desc truncate' }, p.description || `${p.member_count} member${p.member_count === 1 ? '' : 's'}`)),
      p.role && p.role !== 'member' ? h('span', { class: ['role-badge', p.role] }, ROLES[p.role]) : null),
    h('div', { class: 'pj-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${pct}% of tasks completed` },
      h('span', { style: { width: `${pct}%` } })),
    h('div', { class: 'pj-foot' },
      h('span', { class: 'pj-stat' }, h('strong', null, p.open_tasks || 0), ' open'),
      h('span', { class: 'pj-stat' }, h('strong', null, p.completed_tasks || 0), ' done'),
      h('span', { class: 'pj-stat muted' }, `${pct}%`),
      h('div', { class: 'grow' }),
      p.members?.length ? avatarStack(p.members, 22, 4) : null));
}

export default async function render(root) {
  let query = '';
  let archived = false;
  let sort = (() => { try { return localStorage.getItem('tp-projects-sort') || 'name'; } catch (_) { return 'name'; } })();
  const grid = h('div', { class: 'pj-grid' });
  const search = h('input', { class: 'input input-sm', placeholder: 'Search projects…', 'aria-label': 'Search projects' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });
  const toggles = h('div', { class: 'seg' });
  const sortSel = h('select', { class: 'select input-sm pj-sort', 'aria-label': 'Sort projects' },
    [['name', 'Name'], ['recent', 'Recently updated'], ['open', 'Most open tasks']].map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
  sortSel.addEventListener('change', () => {
    sort = sortSel.value;
    try { localStorage.setItem('tp-projects-sort', sort); } catch (_) {}
    draw();
  });

  const drawToggles = () => mount(toggles, [[false, 'Active'], [true, 'Archived']].map(([v, l]) => h('button', {
    class: archived === v && 'active', onclick: () => { archived = v; drawToggles(); draw(); },
  }, l, h('span', { class: 'pj-count' }, state.projects.filter((p) => !!p.archived === v).length))));

  function draw() {
    drawToggles();
    let list = state.projects.filter((p) => !!p.archived === archived)
      .filter((p) => !query || p.name.toLowerCase().includes(query) || (p.description || '').toLowerCase().includes(query));
    list = list.sort({
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
      open: (a, b) => (b.open_tasks || 0) - (a.open_tasks || 0),
    }[sort]);
    if (!state.projects.length) {
      mount(grid, h('div', { class: 'card pj-span' }, emptyState('folder', 'No projects yet', 'Create a project to start planning work with your team.',
        h('button', { class: 'btn btn-primary', onclick: () => openNewProject() }, icon('plus', 15), 'New project'))));
      return;
    }
    if (!list.length) {
      mount(grid, h('div', { class: 'card pj-span' }, emptyState(archived ? 'archive' : 'search',
        query ? 'No matching projects' : archived ? 'No archived projects' : 'No active projects',
        query ? 'Try a different search.' : archived ? 'Archived projects appear here.' : 'All your projects are archived.')));
      return;
    }
    mount(grid, list.map(projectCard),
      archived ? null : h('button', { class: 'pj-card pj-new', onclick: () => openNewProject() }, icon('plus', 22), h('span', null, 'New project')));
  }

  mount(root, h('div', { class: 'page pj-page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Projects'),
        h('p', { class: 'page-sub' }, 'All the projects you are a member of.')),
      h('button', { class: 'btn btn-primary', onclick: () => openNewProject() }, icon('plus', 15), 'New project')),
    h('div', { class: 'pj-toolbar' },
      h('div', { class: 'filter-search-wrap' }, icon('search', 14), Object.assign(search, { className: 'input input-sm filter-search' })),
      toggles, h('div', { class: 'grow' }), sortSel),
    grid));
  draw();
  search.focus();
  const off = on('projects', draw);
  return off;
}
