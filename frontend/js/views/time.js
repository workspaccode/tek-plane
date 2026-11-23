// Time tracking report across projects.
import { api } from '../api.js';
import { on, state } from '../store.js';
import {
  debounce, emptyState, errorToast, fmtDate, fmtDuration, h, icon, mount, spinner,
} from '../ui.js';
import { openTask } from '../components/taskModal.js';
import { columnChart } from './dashboard.js';

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function render(root, { query }) {
  let days = Number(query.days) || 7;
  let projectId = query.project ? Number(query.project) : null;
  let entries = null;
  const page = h('div', { class: 'page tm-page' });
  const controls = h('div', { class: 'tm-controls' });
  const content = h('div', { class: 'tm-content' });
  const exportBtn = h('button', { class: 'btn btn-secondary', onclick: exportCsv }, icon('download', 15), 'Export CSV');
  mount(root, page);
  mount(page,
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Time Tracking'),
        h('p', { class: 'page-sub' }, 'Time logged by everyone on your projects. Start a timer from any task.')),
      exportBtn),
    controls, content);

  function drawControls() {
    const sel = h('select', { class: 'select input-sm tm-project', 'aria-label': 'Project' },
      h('option', { value: '' }, 'All projects'),
      state.projects.map((p) => h('option', { value: p.id, selected: p.id === projectId }, p.name)));
    sel.addEventListener('change', () => { projectId = sel.value ? Number(sel.value) : null; load(); });
    mount(controls,
      h('div', { class: 'seg' }, RANGES.map(([v, l]) => h('button', {
        class: v === days && 'active', 'aria-pressed': String(v === days), onclick: () => { days = v; drawControls(); load(); },
      }, l))),
      sel);
  }

  async function load() {
    if (!entries) mount(content, spinner());
    try {
      entries = await api.get(`/reports/time?days=${days}${projectId ? `&project_id=${projectId}` : ''}`);
      draw();
    } catch (err) {
      errorToast(err);
      mount(content, emptyState('alert', 'Could not load time entries', err.message));
    }
  }

  function draw() {
    exportBtn.disabled = !entries?.length;
    if (!entries.length) {
      mount(content, h('div', { class: 'card' }, emptyState('clock', 'No time tracked in this period',
        'Open a task and press “Start timer”, or add time manually from the task’s Time section.')));
      return;
    }
    const total = entries.reduce((s, e) => s + e.duration_seconds, 0);
    const running = entries.filter((e) => e.running);
    const mine = entries.filter((e) => e.user?.id === state.user.id).reduce((s, e) => s + e.duration_seconds, 0);

    // per day
    const byDay = new Map();
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(start.getDate() + i); byDay.set(dayKey(d), 0); }
    for (const e of entries) {
      const k = dayKey(new Date(e.started_at));
      if (byDay.has(k)) byDay.set(k, byDay.get(k) + e.duration_seconds);
    }
    const chartData = [...byDay.entries()].map(([k, secs]) => {
      const d = new Date(`${k}T12:00:00`);
      return {
        label: d.toLocaleDateString(undefined, days <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }),
        value: secs / 3600,
        tip: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmtDuration(secs, { short: true })}`,
      };
    });

    // per project
    const byProject = new Map();
    for (const e of entries) {
      const p = byProject.get(e.project.id) || { ...e.project, seconds: 0 };
      p.seconds += e.duration_seconds;
      byProject.set(e.project.id, p);
    }
    const projects = [...byProject.values()].sort((a, b) => b.seconds - a.seconds);
    const maxP = projects[0]?.seconds || 1;

    const tile = (label, value, ic) => h('div', { class: 'card db-kpi' },
      h('div', { class: 'db-kpi-icon' }, icon(ic, 17)),
      h('div', { class: 'db-kpi-body' }, h('div', { class: 'db-kpi-value' }, value), h('div', { class: 'db-kpi-label' }, label)));

    mount(content,
      h('div', { class: 'db-kpis tm-kpis' },
        tile('Total tracked', fmtDuration(total, { short: true }), 'clock'),
        tile('Tracked by you', fmtDuration(mine, { short: true }), 'user'),
        tile('Daily average', fmtDuration(total / days, { short: true }), 'chart'),
        tile('Entries', entries.length, 'list')),
      h('div', { class: 'tm-grid' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Hours per day')),
          h('div', { class: 'card-pad' }, columnChart(chartData, {
            integer: false, height: 200, ariaLabel: 'Hours tracked per day',
            format: (v) => `${Math.round(v * 10) / 10}h`,
          }))),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'By project')),
          h('div', { class: 'card-pad tm-projects' }, projects.map((p) => h('div', { class: 'tm-proj' },
            h('div', { class: 'tm-proj-row' },
              h('span', { class: 'swatch', style: { background: p.color } }),
              h('a', { href: `/projects/${p.id}`, class: 'grow truncate tm-proj-name' }, p.name),
              h('strong', { class: 'tm-num' }, fmtDuration(p.seconds, { short: true })),
              h('span', { class: 'muted small tm-pct' }, `${Math.round((p.seconds / total) * 100)}%`)),
            h('div', { class: 'tm-bar' }, h('span', { style: { width: `${Math.max(2, (p.seconds / maxP) * 100)}%`, background: p.color } }))))))),
      h('div', { class: 'card tm-table-card' },
        h('div', { class: 'card-head' },
          h('h2', { class: 'card-title' }, 'Entries'),
          running.length ? h('span', { class: 'chip tm-live' }, h('span', { class: 'tm-live-dot' }), `${running.length} running`) : null),
        h('div', { class: 'tm-table-wrap' },
          h('table', { class: 'tm-table' },
            h('thead', null, h('tr', null, ['Date', 'Project', 'Task', 'Person', 'Note', 'Duration'].map((c, i) => h('th', { class: i === 5 ? 'num' : null }, c)))),
            h('tbody', null, entries.map((e) => h('tr', { class: e.running && 'tm-running' },
              h('td', { class: 'nowrap' }, fmtDate(e.started_at), h('div', { class: 'muted small' },
                new Date(e.started_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))),
              h('td', null, h('span', { class: 'tm-cell-proj' }, h('span', { class: 'swatch', style: { background: e.project.color } }), e.project.name)),
              h('td', null, h('button', { class: 'tm-task-link', onclick: () => openTask(e.task.id) }, h('span', { class: 'muted' }, `#${e.task.number} `), e.task.title)),
              h('td', { class: 'nowrap' }, e.user?.name || '—'),
              h('td', { class: 'muted' }, e.note || ''),
              h('td', { class: 'num nowrap' }, e.running ? h('span', { class: 'tm-live-dot' }) : null, fmtDuration(e.duration_seconds, { short: true })))))))));
  }

  function exportCsv() {
    if (!entries?.length) return;
    const rows = [['Started', 'Ended', 'Project', 'Task number', 'Task', 'Person', 'Note', 'Minutes']];
    for (const e of entries) {
      rows.push([e.started_at, e.ended_at || '', e.project.name, e.task.number, e.task.title, e.user?.name || '', e.note, Math.round(e.duration_seconds / 60)]);
    }
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `tek-plane-time-${days}d.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  drawControls();
  await load();
  const reload = debounce(load, 800);
  const offs = [
    on('timer', reload),
    on('ws', (msg) => { if (msg.type === 'task.updated') reload(); }),
    on('projects', drawControls),
  ];
  const tick = setInterval(() => { if (entries?.some((e) => e.running)) load(); }, 60000);
  return () => { offs.forEach((off) => off()); clearInterval(tick); };
}
