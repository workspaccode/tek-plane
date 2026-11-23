// Personal dashboard: KPIs, upcoming tasks, completion trend, projects, activity feed.
import { api } from '../api.js';
import { on, state } from '../store.js';
import {
  debounce, emptyState, errorToast, fmtDuration, fmtRelative, h, icon, mount, spinner, toast,
} from '../ui.js';
import { activityIcon, activityText } from '../components/activityText.js';
import { openNewProject } from '../components/projectForm.js';
import { openQuickTask } from '../components/quickTask.js';
import { openTask } from '../components/taskModal.js';
import { taskRow } from './mytasks.js';
import { projectCard } from './projects.js';

// ------------------------------------------------------------------ column chart (shared with time.js)

const SVG_NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

function niceStep(max, ticks = 4, integer = true) {
  const rough = Math.max(max, integer ? 1 : 0.0001) / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= rough) || 10 * mag;
  if (integer) step = Math.max(1, Math.round(step));
  return step;
}

/**
 * Single-series column chart rendered as inline SVG, sized to its container.
 * data: [{ label, value, tip }], opts: { height, integer, format(v) -> tick text, ariaLabel }
 */
export function columnChart(data, { height = 170, integer = true, format = (v) => String(v), ariaLabel = 'Chart' } = {}) {
  const wrap = h('div', { class: 'db-chart', role: 'img', 'aria-label': ariaLabel });
  const tip = h('div', { class: 'db-chart-tip', role: 'status' });
  const draw = () => {
    const width = wrap.clientWidth;
    if (!width) return;
    const padL = 34; const padR = 6; const padT = 10; const padB = 22;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const max = Math.max(0, ...data.map((d) => d.value));
    const step = niceStep(max, 4, integer);
    const top = Math.max(step, Math.ceil(max / step) * step);
    const y = (v) => padT + plotH - (v / top) * plotH;
    const band = plotW / Math.max(1, data.length);
    const barW = Math.min(24, Math.max(3, band - 2));
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'db-chart-svg' });
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg.appendChild(s('line', { x1: padL, x2: width - padR, y1: y(v), y2: y(v), class: v === 0 ? 'db-axis' : 'db-gridline' }));
      svg.appendChild(s('text', { x: padL - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'db-tick' }, format(v)));
    }
    const every = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 48)));
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - barW / 2;
      if (d.value > 0) {
        const yTop = y(d.value);
        const bh = padT + plotH - yTop;
        const r = Math.min(4, bh, barW / 2);
        svg.appendChild(s('path', {
          class: 'db-bar',
          d: `M${x},${yTop + bh} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + bh} Z`,
        }));
      }
      if ((data.length - 1 - i) % every === 0) {
        svg.appendChild(s('text', { x: cx, y: height - 6, 'text-anchor': 'middle', class: 'db-tick' }, d.label));
      }
      const hit = s('rect', {
        x: padL + band * i, y: padT, width: band, height: plotH, class: 'db-hit', tabindex: '0',
        'aria-label': d.tip,
      });
      const show = () => {
        hit.classList.add('active');
        tip.textContent = d.tip;
        tip.classList.add('show');
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(width - tw, cx - tw / 2))}px`;
        tip.style.top = `${Math.max(0, y(d.value) - 34)}px`;
      };
      const hide = () => { hit.classList.remove('active'); tip.classList.remove('show'); };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('blur', hide);
      svg.insertBefore(hit, svg.firstChild);
    });
    mount(wrap, svg, tip, h('table', { class: 'sr-only' },
      h('tbody', null, data.map((d) => h('tr', null, h('td', null, d.label), h('td', null, d.tip))))));
  };
  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  requestAnimationFrame(draw);
  return wrap;
}

// ------------------------------------------------------------------ view

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Good evening';
  if (hr < 12) return 'Good morning';
  if (hr < 18) return 'Good afternoon';
  return 'Good evening';
}

function kpi(label, value, ic, tone = '') {
  return h('div', { class: ['card', 'db-kpi', tone && `db-kpi-${tone}`] },
    h('div', { class: 'db-kpi-icon' }, icon(ic, 17)),
    h('div', { class: 'db-kpi-body' },
      h('div', { class: 'db-kpi-value' }, value),
      h('div', { class: 'db-kpi-label' }, label)));
}

export default async function render(root) {
  const page = h('div', { class: 'page db-page' });
  mount(root, page);
  mount(page, spinner());
  let data = null;

  async function load() {
    try {
      data = await api.get('/dashboard');
      draw();
    } catch (err) {
      errorToast(err);
      if (!data) mount(page, emptyState('alert', 'Could not load your dashboard', err.message));
    }
  }

  async function toggle(task) {
    const status = task.status === 'completed' ? 'open' : 'completed';
    try {
      await api.patch(`/tasks/${task.id}`, { status });
      if (status === 'completed') {
        toast(`Completed “${task.title}”`, 'success', {
          action: { label: 'Undo', onClick: () => api.patch(`/tasks/${task.id}`, { status: 'open' }).then(load).catch(errorToast) },
        });
      }
      load();
    } catch (err) { errorToast(err); }
  }

  function draw() {
    const c = data.counts;
    const now = new Date();
    const head = h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, `${greeting()}, ${state.user.name.split(' ')[0]}`),
        h('p', { class: 'page-sub' }, now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
          c.open ? ` · You have ${c.open} open task${c.open === 1 ? '' : 's'}` : '')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-secondary', onclick: () => openNewProject() }, icon('folder', 15), 'New project'),
        h('button', { class: 'btn btn-primary', onclick: () => openQuickTask() }, icon('plus', 15), 'New task')));

    if (!state.projects.length) {
      mount(page, head, h('div', { class: 'card' }, emptyState('rocket', 'Create your first project',
        'Projects hold your boards, tasks and team. Start from a template and invite your teammates.',
        h('button', { class: 'btn btn-primary', onclick: () => openNewProject() }, icon('plus', 15), 'Create project'))));
      return;
    }

    const kpis = h('div', { class: 'db-kpis' },
      kpi('Open tasks', c.open, 'check-circle'),
      kpi('Overdue', c.overdue, 'alert', c.overdue ? 'danger' : ''),
      kpi('Due today', c.due_today, 'calendar', c.due_today ? 'warning' : ''),
      kpi('Completed this week', c.completed_week, 'star', 'success'),
      kpi('Tracked this week', fmtDuration(c.tracked_week_seconds, { short: true }), 'clock'),
      kpi('Projects', c.projects, 'folder'));

    const upcoming = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title' }, 'Upcoming deadlines'),
        h('a', { href: '/tasks', class: 'btn btn-ghost btn-sm' }, 'All my tasks', icon('arrow-right', 14))),
      data.upcoming.length
        ? h('div', { class: 'db-list' }, data.upcoming.map((t) => taskRow(t, { onToggle: toggle, onOpen: () => openTask(t.id) })))
        : h('div', { class: 'db-empty' }, icon('check-circle', 18), 'Nothing due. Tasks with due dates assigned to you show up here.'));

    const total = data.trend.reduce((sum, d) => sum + d.completed, 0);
    const trend = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null,
          h('h2', { class: 'card-title' }, 'Tasks you completed'),
          h('div', { class: 'small muted' }, `${total} in the last 14 days`))),
      h('div', { class: 'card-pad' }, columnChart(data.trend.map((d) => {
        const date = new Date(`${d.date}T12:00:00`);
        return {
          label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
          value: d.completed,
          tip: `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.completed} completed`,
        };
      }), { ariaLabel: 'Tasks completed per day over the last 14 days' })));

    const projects = h('div', { class: 'db-section' },
      h('div', { class: 'db-section-head' },
        h('h2', { class: 'card-title' }, 'Projects'),
        h('a', { href: '/projects', class: 'btn btn-ghost btn-sm' }, 'View all', icon('arrow-right', 14))),
      h('div', { class: 'pj-grid db-projects' },
        state.projects.filter((p) => !p.archived).slice(0, 5).map((p) => projectCard(p)),
        h('button', { class: 'pj-card pj-new', onclick: () => openNewProject() }, icon('plus', 22), h('span', null, 'New project'))));

    const activity = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Recent activity')),
      data.activity.length
        ? h('ul', { class: 'db-activity' }, data.activity.slice(0, 20).map((a) => h('li', { class: 'db-act' },
          h('span', { class: 'db-act-icon' }, icon(activityIcon(a.action), 13)),
          h('div', { class: 'grow' },
            h('div', {
              class: ['db-act-text', a.task_id && 'clickable'],
              onclick: a.task_id && a.action !== 'task.deleted' ? () => openTask(a.task_id) : null,
            }, activityText(a)),
            h('div', { class: 'db-act-meta' },
              h('a', { href: `/projects/${a.project.id}`, class: 'db-proj-chip' },
                h('span', { class: 'swatch', style: { background: a.project.color } }), a.project.name),
              h('span', null, fmtRelative(a.created_at)))))))
        : h('div', { class: 'db-empty' }, 'No activity yet.'));

    mount(page, head, kpis,
      h('div', { class: 'db-grid' },
        h('div', { class: 'db-col' }, upcoming, projects),
        h('div', { class: 'db-col' }, trend, activity)));
  }

  await load();
  const reload = debounce(load, 800);
  const offs = [
    on('ws', (msg) => { if (msg.type !== 'presence') reload(); }),
    on('task-saved', reload),
    on('projects', () => { if (data) draw(); }),
  ];
  return () => offs.forEach((off) => off());
}
