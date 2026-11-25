// Admin panel (site admins only): overview, users, projects, activity and system health.
import { api } from '../api.js';
import { activityIcon, activityText } from '../components/activityText.js';
import { state } from '../store.js';
import {
  avatar, confirmDialog, debounce, emptyState, errorToast, fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtRelative,
  h, icon, menu, mount, openModal, spinner, toast, userHandle,
} from '../ui.js';
import { columnChart } from './dashboard.js';

const TABS = [
  ['overview', 'chart', 'Overview'],
  ['users', 'users', 'Users'],
  ['projects', 'folder', 'Projects'],
  ['activity', 'activity', 'Activity'],
  ['system', 'server', 'System'],
];

const GOOGLE_G = '<svg width="13" height="13" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

const num = (n) => Number(n || 0).toLocaleString();
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ small building blocks

function kpi(label, value, ic, sub, tone = '') {
  return h('div', { class: ['card', 'db-kpi', 'ad-kpi', tone && `db-kpi-${tone}`] },
    h('div', { class: 'db-kpi-icon' }, icon(ic, 17)),
    h('div', { class: 'db-kpi-body' },
      h('div', { class: 'db-kpi-value' }, value),
      h('div', { class: 'db-kpi-label' }, label),
      sub ? h('div', { class: 'ad-kpi-sub' }, sub) : null));
}

function pill(text, tone = '', ic = null) {
  return h('span', { class: ['ad-pill', tone && `ad-pill-${tone}`] }, ic, text);
}

function statusPill(u) {
  if (u.disabled) return pill('Suspended', 'danger', icon('ban', 11));
  if (u.online) return pill('Online', 'success', h('span', { class: 'ad-dot' }));
  if (!u.email_verified) return pill('Unverified', 'warning');
  return pill(u.last_seen_at ? `Seen ${fmtRelative(u.last_seen_at)}` : 'Never signed in');
}

function methodBadge(u) {
  if (u.has_password && u.username) {
    return h('span', { class: 'ad-method', title: `Signs in with a password as ${u.username}` }, icon('key', 13), 'Password');
  }
  return u.google_linked
    ? h('span', { class: 'ad-method', title: 'Signs in with Google' }, h('span', { html: GOOGLE_G, class: 'ad-g' }), 'Google')
    : h('span', { class: 'ad-method', title: 'Signs in with an email code' }, icon('mail', 13), 'Email');
}

function userCell(u) {
  return h('div', { class: 'ad-user' },
    avatar(u, 32, { title: false }),
    h('div', { class: 'grow' },
      h('div', { class: 'ad-user-name' },
        h('span', { class: 'truncate' }, u.name),
        u.is_admin ? pill('Admin', 'primary', icon('shield', 10)) : null,
        u.id === state.user.id ? pill('You') : null),
      h('div', { class: 'ad-user-email truncate' }, userHandle(u))));
}

function projectChip(p) {
  return h('span', { class: 'ad-proj' },
    h('span', { class: 'project-dot', style: { background: p.color } }, icon(p.icon || 'folder', 10)),
    h('span', { class: 'truncate' }, p.name));
}

function cardHead(title, sub, right) {
  return h('div', { class: 'card-head' },
    h('div', null, h('h2', { class: 'card-title' }, title), sub ? h('div', { class: 'small muted' }, sub) : null),
    right || null);
}

function sortableTable(columns, rows, { sortKey, onRow, empty }) {
  // columns: [{ key, label, cell(row), sort(row) -> value, class }]
  let key = sortKey;
  let dir = -1;
  const wrap = h('div', { class: 'tm-table-wrap' });
  const draw = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = col?.sort ? [...rows].sort((a, b) => {
      const x = col.sort(a); const y = col.sort(b);
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    }) : rows;
    mount(wrap, rows.length ? h('table', { class: 'tm-table ad-table' },
      h('thead', null, h('tr', null, columns.map((c) => h('th', {
        class: [c.class, c.sort && 'ad-sortable', key === c.key && 'sorted'],
        'aria-sort': key === c.key ? (dir > 0 ? 'ascending' : 'descending') : null,
        onclick: c.sort ? () => { dir = key === c.key ? -dir : -1; key = c.key; draw(); } : null,
      }, c.label, c.sort && key === c.key ? icon('chevron-down', 12, dir > 0 ? 'ad-sort-ic up' : 'ad-sort-ic') : null)))),
      h('tbody', null, sorted.map((r) => h('tr', {
        class: onRow && 'ad-row', tabindex: onRow ? '0' : null,
        onclick: onRow ? (e) => { if (!e.target.closest('button, a')) onRow(r); } : null,
        onkeydown: onRow ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRow(r); } : null,
      }, columns.map((c) => h('td', { class: c.class }, c.cell(r)))))))
      : empty);
  };
  draw();
  return wrap;
}

// ------------------------------------------------------------------ user actions + detail

function userActions(u, done) {
  const me = u.id === state.user.id;
  const act = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg, 'success'); done?.(); } catch (err) { errorToast(err); }
  };
  return [
    { label: 'View details', icon: 'eye', onClick: () => openUser(u.id, done) },
    'divider',
    u.is_admin
      ? { label: 'Remove admin', icon: 'shield', disabled: me || u.protected,
        onClick: () => act(() => api.patch(`/admin/users/${u.id}`, { is_admin: false }), `${u.name} is no longer an admin`) }
      : { label: 'Make admin', icon: 'shield', disabled: u.disabled,
        onClick: async () => {
          if (await confirmDialog(`${u.name} will be able to see every user and project, and suspend accounts.`,
            { title: 'Make admin?', confirmText: 'Make admin' })) {
            act(() => api.patch(`/admin/users/${u.id}`, { is_admin: true }), `${u.name} is now an admin`);
          }
        } },
    { label: 'Sign out everywhere', icon: 'logout', disabled: me,
      onClick: async () => {
        if (await confirmDialog(`${u.name} will be signed out on every device and has to sign in again.`,
          { title: 'Sign out everywhere?', confirmText: 'Sign out' })) {
          act(() => api.post(`/admin/users/${u.id}/signout`), `${u.name} was signed out`);
        }
      } },
    u.disabled
      ? { label: 'Restore account', icon: 'check-circle',
        onClick: () => act(() => api.patch(`/admin/users/${u.id}`, { disabled: false }), `${u.name} can sign in again`) }
      : { label: 'Suspend account', icon: 'ban', danger: true, disabled: me || u.protected,
        onClick: async () => {
          if (await confirmDialog(`${u.name} is signed out right away and can't sign in until you restore the account. Their projects and tasks stay as they are.`,
            { title: 'Suspend account?', confirmText: 'Suspend', danger: true })) {
            act(() => api.patch(`/admin/users/${u.id}`, { disabled: true }), `${u.name} was suspended`);
          }
        } },
  ];
}

function openUser(id, onChange) {
  openModal({
    title: 'Member',
    width: 640,
    className: 'ad-modal',
    content: (body, modal) => {
      mount(body, spinner());
      const load = async () => {
        let u;
        try { u = await api.get(`/admin/users/${id}`); } catch (err) { errorToast(err); modal.close(); return; }
        const stat = (label, value) => h('div', { class: 'ad-stat' }, h('div', { class: 'ad-stat-value' }, value), h('div', { class: 'ad-stat-label' }, label));
        const meta = (label, value) => h('div', { class: 'ad-meta' }, h('span', null, label), h('span', null, value));
        const changed = () => { load(); onChange?.(); };
        mount(body,
          h('div', { class: 'ad-profile' },
            avatar(u, 60, { title: false }),
            h('div', { class: 'grow' },
              h('div', { class: 'ad-profile-name' }, u.name, u.is_admin ? pill('Admin', 'primary', icon('shield', 10)) : null),
              h('div', { class: 'muted' }, userHandle(u), u.title ? ` · ${u.title}` : ''),
              h('div', { class: 'row ad-profile-badges' }, statusPill(u), methodBadge(u),
                u.email_verified ? pill('Verified', 'primary', icon('check', 10)) : null)),
            h('button', { class: 'btn btn-secondary btn-sm', onclick: (e) => menu(e.currentTarget, userActions(u, changed), { align: 'end' }) },
              'Actions', icon('chevron-down', 13))),
          h('div', { class: 'ad-stats' },
            stat('Projects', num(u.projects)),
            stat('Open tasks', num(u.open_tasks)),
            stat('Completed', num(u.completed_tasks)),
            stat('Created tasks', num(u.created_tasks)),
            stat('Comments', num(u.comments)),
            stat('Time tracked', fmtDuration(u.tracked_seconds, { short: true }) || '0m')),
          h('div', { class: 'ad-metas' },
            meta('Joined', fmtDateTime(u.created_at)),
            meta('Last sign-in', u.last_login_at ? fmtDateTime(u.last_login_at) : '—'),
            meta('Last active', u.online ? 'Online now' : (u.last_seen_at ? fmtRelative(u.last_seen_at) : '—')),
            meta('Owns', plural(u.owned_projects, 'project'))),
          h('h3', { class: 'ad-sub' }, 'Projects'),
          u.project_list.length
            ? h('div', { class: 'ad-plist' }, u.project_list.map((p) => h('div', { class: 'ad-plist-row' },
              projectChip(p),
              p.kind === 'mindmap' ? pill('Mind map') : null,
              p.archived ? pill('Archived') : null,
              h('span', { class: `role-badge ${p.role}` }, p.role))))
            : h('div', { class: 'db-empty' }, 'Not in any project yet.'),
          h('h3', { class: 'ad-sub' }, 'Recent activity'),
          u.activity.length ? activityList(u.activity, { showUser: false }) : h('div', { class: 'db-empty' }, 'No activity yet.'));
      };
      load();
    },
  });
}

function activityList(items, { showUser = true } = {}) {
  return h('ul', { class: 'db-activity ad-activity' }, items.map((a) => h('li', { class: 'db-act' },
    showUser && a.user ? avatar(a.user, 26) : h('span', { class: 'db-act-icon' }, icon(activityIcon(a.action), 13)),
    h('div', { class: 'grow' },
      h('div', { class: 'db-act-text' }, activityText(a)),
      h('div', { class: 'db-act-meta' }, projectChip(a.project), h('span', null, fmtRelative(a.created_at)))))));
}

// ------------------------------------------------------------------ tabs

let chartSeries = 'signups'; // kept across the overview's auto-refresh

async function overviewTab(el, ctx) {
  const d = await api.get('/admin/overview');
  const { users: u, projects: p, tasks: t, content: c } = d;

  const series = {
    signups: { label: 'Sign-ups', data: d.signups, word: 'sign-up' },
    activity: { label: 'Activity', data: d.activity, word: 'event' },
    completed: { label: 'Completed tasks', data: d.completed, word: 'task' },
  };
  let current = chartSeries;
  const chartBox = h('div', { class: 'card-pad' });
  const chartSub = h('div', { class: 'small muted' });
  const chartSeg = h('div', { class: 'seg seg-sm' });
  const drawChart = () => {
    const s = series[current];
    const total = s.data.reduce((sum, x) => sum + x.count, 0);
    chartSub.textContent = `${plural(total, s.word)} in the last 30 days`;
    mount(chartSeg, Object.entries(series).map(([k, v]) => h('button', {
      class: k === current && 'active', 'aria-pressed': String(k === current), onclick: () => { current = k; chartSeries = k; drawChart(); },
    }, v.label)));
    mount(chartBox, columnChart(s.data.map((x) => {
      const date = new Date(`${x.date}T12:00:00`);
      return {
        label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        value: x.count,
        tip: `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${plural(x.count, s.word)}`,
      };
    }), { height: 200, ariaLabel: `${s.label} per day over the last 30 days` }));
  };
  drawChart();

  const maxEvents = Math.max(1, ...d.top_projects.map((x) => x.events));
  const health = d.health;
  const healthRow = (ic, label, ok, text, go) => h('button', { class: 'ad-health-row', onclick: go },
    h('span', { class: ['ad-health-ic', ok ? 'ok' : 'warn'] }, icon(ic, 15)),
    h('span', { class: 'grow' }, h('div', { class: 'ad-health-label' }, label), h('div', { class: 'small muted' }, text)),
    icon('chevron-right', 14));

  mount(el,
    h('div', { class: 'db-kpis ad-kpis' },
      kpi('Members', num(u.total), 'users', `+${num(u.new_week)} this week`),
      kpi('Active today', num(u.active_day), 'activity', `${num(u.active_week)} this week`),
      kpi('Online now', num(u.online), 'globe', u.online ? 'Live' : 'Nobody right now', u.online ? 'success' : ''),
      kpi('Projects', num(p.total), 'folder', `${plural(p.boards, 'board')} · ${plural(p.mindmaps, 'map')}`),
      kpi('Open tasks', num(t.open), 'check-circle', t.overdue ? `${num(t.overdue)} overdue` : 'None overdue', t.overdue ? 'danger' : ''),
      kpi('Done this week', num(t.completed_week), 'star', `${num(t.created_week)} created`, 'success')),
    h('div', { class: 'db-grid' },
      h('div', { class: 'db-col' },
        h('div', { class: 'card' }, cardHead('Growth', chartSub, chartSeg), chartBox),
        h('div', { class: 'card' },
          cardHead('Most active projects', 'Last 30 days', h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ctx.go('projects') }, 'All projects', icon('arrow-right', 14))),
          d.top_projects.length ? h('div', { class: 'ad-bars' }, d.top_projects.map((x) => h('div', { class: 'ad-bar-row' },
            projectChip(x),
            h('div', { class: 'ad-bar' }, h('span', { style: { width: `${(x.events / maxEvents) * 100}%`, background: x.color } })),
            h('span', { class: 'ad-bar-n' }, num(x.events)))))
            : h('div', { class: 'db-empty' }, 'No project activity in the last 30 days.')),
        h('div', { class: 'card' },
          cardHead('Content'),
          h('div', { class: 'ad-stats ad-stats-flat' },
            [['Tasks', num(t.total)], ['Completed', num(t.completed)], ['Mind map topics', num(c.mind_nodes)],
              ['Comments', num(c.comments)], ['Files', `${num(c.attachments)} · ${fmtBytes(c.attachment_bytes)}`],
              ['Time tracked', fmtDuration(c.tracked_seconds, { short: true }) || '0m']]
              .map(([l, v]) => h('div', { class: 'ad-stat' }, h('div', { class: 'ad-stat-value' }, v), h('div', { class: 'ad-stat-label' }, l)))))),
      h('div', { class: 'db-col' },
        h('div', { class: 'card' },
          cardHead('Newest members', null, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ctx.go('users') }, 'All members', icon('arrow-right', 14))),
          h('div', { class: 'ad-people' }, d.recent_users.map((x) => h('button', { class: 'ad-person', onclick: () => openUser(x.id, ctx.refresh) },
            userCell(x),
            h('div', { class: 'ad-person-side' }, methodBadge(x), h('span', { class: 'small muted' }, fmtRelative(x.created_at))))))),
        h('div', { class: 'card' },
          cardHead('Health'),
          h('div', { class: 'ad-health' },
            healthRow('mail', 'Email delivery', health.email !== 'console',
              health.email === 'console' ? 'Not set up: codes print in the server terminal' : `Sending through ${health.email === 'smtp' ? 'SMTP' : 'Resend'}`, () => ctx.go('system')),
            healthRow('globe', 'Google sign-in', health.google, health.google ? 'Configured' : 'Not configured', () => ctx.go('system')),
            healthRow('server', 'Server', true, `Up for ${fmtDuration(health.uptime_seconds, { short: true }) || 'a moment'}`, () => ctx.go('system')),
            healthRow('users', 'Accounts', !u.suspended, `${num(u.verified)} verified · ${num(u.google)} with Google · ${num(u.suspended)} suspended`, () => ctx.go('users')))))));
}

async function usersTab(el, ctx) {
  const FILTERS = [['all', 'All'], ['online', 'Online'], ['admins', 'Admins'], ['google', 'Google'], ['unverified', 'Unverified'], ['suspended', 'Suspended']];
  let filter = 'all';
  const search = h('input', { class: 'input input-sm ad-search', type: 'search', placeholder: 'Search name or email…', 'aria-label': 'Search members' });
  const seg = h('div', { class: 'seg seg-sm ad-filter' });
  const count = h('span', { class: 'small muted' });
  const list = h('div', { class: 'card ad-card-table' }, spinner());

  const load = async () => {
    mount(seg, FILTERS.map(([k, l]) => h('button', { class: k === filter && 'active', onclick: () => { filter = k; load(); } }, l)));
    let rows;
    try { rows = await api.get(`/admin/users?filter=${filter}&q=${encodeURIComponent(search.value.trim())}`); } catch (err) { errorToast(err); return; }
    count.textContent = plural(rows.length, 'member');
    mount(list, sortableTable([
      { key: 'user', label: 'Member', cell: userCell, sort: (r) => r.name.toLowerCase(), class: 'ad-col-user' },
      { key: 'method', label: 'Sign-in', cell: methodBadge, class: 'ad-hide-sm' },
      { key: 'status', label: 'Status', cell: statusPill, sort: (r) => (r.online ? 2e12 : 0) + (r.last_seen_at ? Date.parse(r.last_seen_at) : 0) },
      { key: 'projects', label: 'Projects', cell: (r) => num(r.projects), sort: (r) => r.projects, class: 'num ad-hide-sm' },
      { key: 'tasks', label: 'Open tasks', cell: (r) => num(r.open_tasks), sort: (r) => r.open_tasks, class: 'num ad-hide-sm' },
      { key: 'joined', label: 'Joined', cell: (r) => h('span', { title: fmtDateTime(r.created_at) }, fmtDate(r.created_at)), sort: (r) => r.created_at, class: 'nowrap ad-hide-md' },
      { key: 'menu', label: '', class: 'ad-col-menu', cell: (r) => h('button', {
        class: 'icon-btn', 'aria-label': `Actions for ${r.name}`, onclick: (e) => menu(e.currentTarget, userActions(r, load), { align: 'end' }),
      }, icon('more', 16)) },
    ], rows, { sortKey: 'joined', onRow: (r) => openUser(r.id, load), empty: emptyState('users', 'No members found', 'Try another search or filter.') }));
  };
  search.addEventListener('input', debounce(load, 250));
  mount(el, h('div', { class: 'ad-toolbar' }, search, seg, h('span', { class: 'grow' }), count), list);
  ctx.refresh = load;
  await load();
}

async function projectsTab(el, ctx) {
  const FILTERS = [['all', 'All'], ['board', 'Boards'], ['mindmap', 'Mind maps'], ['archived', 'Archived']];
  let filter = 'all';
  let all = [];
  const search = h('input', { class: 'input input-sm ad-search', type: 'search', placeholder: 'Search projects…', 'aria-label': 'Search projects' });
  const seg = h('div', { class: 'seg seg-sm ad-filter' });
  const count = h('span', { class: 'small muted' });
  const list = h('div', { class: 'card ad-card-table' }, spinner());

  const remove = async (p) => {
    const what = p.kind === 'mindmap' ? plural(p.nodes, 'topic') : plural(p.tasks, 'task');
    if (!await confirmDialog(`“${p.name}” and everything in it (${what}, ${plural(p.members, 'member')}) will be deleted for everyone. This can't be undone.`,
      { title: 'Delete project?', confirmText: 'Delete project', danger: true })) return;
    try { await api.del(`/admin/projects/${p.id}`); toast(`Deleted “${p.name}”`, 'success'); load(); } catch (err) { errorToast(err); }
  };
  const draw = () => {
    mount(seg, FILTERS.map(([k, l]) => h('button', { class: k === filter && 'active', onclick: () => { filter = k; draw(); } }, l)));
    const rows = all.filter((p) => (filter === 'all' ? true : filter === 'archived' ? p.archived : p.kind === filter && !p.archived));
    count.textContent = plural(rows.length, 'project');
    mount(list, sortableTable([
      { key: 'name', label: 'Project', class: 'ad-col-user', sort: (r) => r.name.toLowerCase(), cell: (r) => h('div', { class: 'row' },
        projectChip(r), r.kind === 'mindmap' ? pill('Mind map') : pill('Board'), r.archived ? pill('Archived', 'warning') : null) },
      { key: 'owner', label: 'Owner', class: 'ad-hide-sm', sort: (r) => r.owner?.name?.toLowerCase() || '', cell: (r) => (r.owner
        ? h('span', { class: 'row ad-owner' }, avatar(r.owner, 22), h('span', { class: 'truncate' }, r.owner.name)) : '—') },
      { key: 'members', label: 'Members', class: 'num ad-hide-sm', sort: (r) => r.members, cell: (r) => num(r.members) },
      { key: 'size', label: 'Content', class: 'num nowrap', sort: (r) => r.tasks + r.nodes, cell: (r) => (r.kind === 'mindmap'
        ? plural(r.nodes, 'topic') : h('span', { title: `${num(r.open_tasks)} open` }, `${num(r.open_tasks)} / ${num(r.tasks)} open`)) },
      { key: 'last', label: 'Last activity', class: 'nowrap ad-hide-md', sort: (r) => r.last_activity_at || '', cell: (r) => (r.last_activity_at ? fmtRelative(r.last_activity_at) : '—') },
      { key: 'menu', label: '', class: 'ad-col-menu', cell: (r) => h('button', {
        class: 'icon-btn', 'aria-label': `Actions for ${r.name}`,
        onclick: (e) => menu(e.currentTarget, [
          r.is_member ? { label: 'Open project', icon: 'external', onClick: () => { location.href = `/projects/${r.id}`; } }
            : { label: 'You’re not a member', icon: 'eye', disabled: true },
          'divider',
          { label: 'Delete project', icon: 'trash', danger: true, onClick: () => remove(r) },
        ], { align: 'end' }),
      }, icon('more', 16)) },
    ], rows, { sortKey: 'last', empty: emptyState('folder', 'No projects found', 'Try another search or filter.') }));
  };
  const load = async () => {
    try { all = await api.get(`/admin/projects?q=${encodeURIComponent(search.value.trim())}`); } catch (err) { errorToast(err); return; }
    draw();
  };
  search.addEventListener('input', debounce(load, 250));
  mount(el, h('div', { class: 'ad-toolbar' }, search, seg, h('span', { class: 'grow' }), count), list);
  ctx.refresh = load;
  await load();
}

async function activityTab(el, ctx) {
  const items = [];
  const box = h('div', { class: 'card' }, cardHead('Everything that happened', 'Across all projects, newest first'));
  const listEl = h('div');
  const more = h('button', { class: 'btn btn-secondary btn-sm' }, 'Load more');
  const foot = h('div', { class: 'ad-more' }, more);
  box.append(listEl, foot);
  const load = async (reset = false) => {
    if (reset) items.length = 0;
    more.disabled = true;
    try {
      const before = items.length ? `&before=${items[items.length - 1].id}` : '';
      const page = await api.get(`/admin/activity?limit=50${before}`);
      items.push(...page);
      foot.hidden = page.length < 50;
    } catch (err) { errorToast(err); }
    more.disabled = false;
    mount(listEl, items.length ? activityList(items) : h('div', { class: 'db-empty' }, 'Nothing has happened yet.'));
  };
  more.addEventListener('click', () => load());
  mount(el, box);
  ctx.refresh = () => load(true);
  await load();
}

async function systemTab(el) {
  const s = await api.get('/admin/system');
  const row = (label, value) => h('div', { class: 'ad-meta' }, h('span', null, label), h('span', null, value));
  const code = (text) => h('code', { class: 'ad-code' }, text);
  const copyBtn = (text) => h('button', {
    class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy',
    onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success')).catch(() => toast('Could not copy', 'error')),
  }, icon('copy', 14));
  const section = (ic, title, status, ...body) => h('div', { class: 'card card-pad ad-sys' },
    h('div', { class: 'ad-sys-head' }, h('span', { class: 'db-kpi-icon' }, icon(ic, 16)), h('h2', { class: 'card-title grow' }, title), status),
    body);

  // email test
  const to = h('input', { class: 'input input-sm', type: 'email', value: state.user.email, 'aria-label': 'Send test email to' });
  const sendBtn = h('button', { class: 'btn btn-secondary btn-sm' }, icon('mail', 14), 'Send test');
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    try {
      const r = await api.post('/admin/system/test-email', { to: to.value.trim() || null });
      toast(r.provider === 'console' ? 'Printed in the server terminal (email is not set up)' : `Test email sent to ${r.to}`, 'success');
    } catch (err) { errorToast(err); }
    sendBtn.disabled = false;
  });

  const e = s.email;
  const providerName = { smtp: 'SMTP', resend: 'Resend', console: 'Not set up' }[e.provider];
  mount(el, h('div', { class: 'ad-sys-grid' },
    section('mail', 'Email delivery', pill(providerName, e.provider === 'console' ? 'warning' : 'success'),
      e.provider === 'console'
        ? h('p', { class: 'hint' }, 'Codes and links are printed in the server terminal. Add SMTP or Resend settings to .env and restart.')
        : [row('From', e.from), e.host ? row('Server', e.host) : null],
      h('div', { class: 'ad-inline' }, to, sendBtn)),
    section('globe', 'Google sign-in', pill(s.google.configured ? 'Configured' : 'Off', s.google.configured ? 'success' : 'warning'),
      h('div', { class: 'small muted' }, 'Authorized redirect URI in Google Cloud:'),
      h('div', { class: 'ad-inline' }, code(s.google.redirect_uri), copyBtn(s.google.redirect_uri)),
      h('p', { class: 'hint' }, 'Google accepts only https addresses or localhost. Other devices on your Wi-Fi sign in with an email code.')),
    section('shield', 'Admins', pill(plural(s.admins.length, 'admin'), 'primary'),
      h('div', { class: 'ad-people ad-people-flat' }, s.admins.map((a) => h('div', { class: 'ad-person' },
        h('div', { class: 'ad-user' }, avatar(a, 28, { title: false }), h('div', { class: 'grow' },
          h('div', { class: 'ad-user-name' }, a.name), h('div', { class: 'ad-user-email truncate' }, userHandle(a)))),
        pill(a.from_config ? 'From .env' : a.has_password ? 'Password' : 'Granted here')))),
      s.pending_admin_emails.length ? h('p', { class: 'hint' }, `Waiting to sign up: ${s.pending_admin_emails.join(', ')}`) : null,
      h('p', { class: 'hint' }, 'Password admins are created with: uv run python -m backend.app.manage create-admin NAME. Email admins can be listed in TEKPLANE_ADMIN_EMAILS in .env, or made admin from the Users tab.')),
    section('link', 'Network', null,
      row('This page', s.network.current_url),
      row('Public URL', s.network.base_url || 'Automatic (the address people open)'),
      h('p', { class: 'hint' }, 'Run ./run.sh --lan to let other devices on your Wi-Fi open tek-plane.')),
    section('database', 'Storage', null,
      row('Database', s.storage.database_bytes == null ? '—' : fmtBytes(s.storage.database_bytes)),
      row('Uploaded files', `${num(s.storage.uploads_files)} · ${fmtBytes(s.storage.uploads_bytes)}`),
      h('div', { class: 'ad-meta ad-meta-stack' }, h('span', null, 'Data folder'), h('div', { class: 'ad-inline' }, code(s.storage.data_dir), copyBtn(s.storage.data_dir)))),
    section('server', 'Server', pill('Running', 'success', h('span', { class: 'ad-dot' })),
      row('Version', `tek-plane ${s.runtime.version}`),
      row('Python', s.runtime.python),
      row('System', s.runtime.platform),
      row('Started', fmtDateTime(s.runtime.started_at)),
      row('Uptime', fmtDuration(s.runtime.uptime_seconds, { short: true }) || 'just started'),
      row('Live connections', num(s.runtime.connections))),
    section('ban', 'Sign-in security', null,
      row('Code lifetime', `${s.security.otp_ttl_minutes} minutes`),
      row('Wrong tries per code', num(s.security.otp_max_attempts)),
      row('Session length', `${s.security.session_days} days`),
      row('Codes waiting right now', num(s.security.pending_codes)))));
}

const RENDER = { overview: overviewTab, users: usersTab, projects: projectsTab, activity: activityTab, system: systemTab };

// ------------------------------------------------------------------ page

export default async function render(root, { query = {} } = {}) {
  if (!state.user?.is_admin) {
    mount(root, h('div', { class: 'page' }, emptyState('shield', 'Admins only', 'You need admin access to open this page.',
      h('a', { class: 'btn btn-primary', href: '/dashboard' }, 'Go to dashboard'))));
    return null;
  }
  let tab = RENDER[query.tab] ? query.tab : 'overview';
  const tabs = h('div', { class: 'seg ad-tabs', role: 'tablist', 'aria-label': 'Admin sections' });
  const body = h('div', { class: 'ad-body' });
  const refreshBtn = h('button', { class: 'btn btn-secondary', title: 'Refresh' }, icon('refresh', 15), 'Refresh');
  let timer = null;
  let renderId = 0;
  const ctx = { go: (t) => select(t), refresh: null };

  async function show() {
    const id = ++renderId;
    ctx.refresh = null;
    clearInterval(timer);
    mount(body, spinner());
    const el = h('div', { class: 'ad-tab' });
    try {
      await RENDER[tab](el, ctx);
      if (id !== renderId) return;
      mount(body, el);
    } catch (err) {
      if (id !== renderId) return;
      mount(body, h('div', { class: 'card' }, emptyState('alert', 'Could not load this section', err.message)));
    }
    if (tab === 'overview') timer = setInterval(() => { if (!document.hidden) quietRefresh(); }, 30000);
  }

  async function quietRefresh() {
    if (ctx.refresh) { ctx.refresh(); return; }
    const id = renderId;
    const el = h('div', { class: 'ad-tab' });
    try { await RENDER[tab](el, ctx); if (id === renderId) mount(body, el); } catch (_) { /* keep what is on screen */ }
  }

  function drawTabs() {
    mount(tabs, TABS.map(([k, ic, label]) => h('button', {
      role: 'tab', class: k === tab && 'active', 'aria-selected': String(k === tab), onclick: () => select(k),
    }, icon(ic, 14), h('span', null, label))));
  }

  function select(t) {
    if (t === tab) return;
    tab = t;
    history.replaceState(history.state, '', t === 'overview' ? '/admin' : `/admin?tab=${t}`);
    drawTabs();
    show();
  }

  refreshBtn.addEventListener('click', () => quietRefresh().then(() => toast('Updated', 'success', { timeout: 1200 })));
  drawTabs();
  mount(root, h('div', { class: 'page ad-page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Admin'),
        h('p', { class: 'page-sub' }, 'Members, projects and the health of your tek-plane, in one place.')),
      refreshBtn),
    tabs,
    body));
  await show();
  return () => { clearInterval(timer); renderId += 1; };
}
