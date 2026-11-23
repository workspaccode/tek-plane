// Project reports: KPI tiles + hand-built SVG/CSS charts with hover tooltips and table views.
import { api } from '../api.js';
import { member, state } from '../store.js';
import { PRIORITIES, avatar, debounce, emptyState, errorToast, fmtDuration, h, icon, mount, spinner } from '../ui.js';
import { projectShell } from '../components/projectShell.js';

const RANGES = [7, 30, 90];
const SVGNS = 'http://www.w3.org/2000/svg';
const nf = new Intl.NumberFormat();

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  children.flat().forEach((c) => c && el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return el;
}

/** Axis max with 4 equal integer steps of a "nice" size (1, 2, 5 × 10^n). */
function niceMax(v) {
  const raw = Math.max(1, v / 4);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  return step * 4;
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------ tooltip

const tip = h('div', { class: 'rp-tip', role: 'tooltip' });

function showTip(x, y, content) {
  if (!tip.isConnected) document.body.appendChild(tip);
  mount(tip, content);
  tip.classList.add('show');
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y - r.height - 10;
  if (top < 8) top = y + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  tip.classList.remove('show');
}

function tipRow(color, label, value) {
  return h('div', { class: 'rp-tip-row' },
    color ? h('span', { class: 'rp-key', style: { background: color } }) : null,
    h('span', { class: 'rp-tip-label' }, label), h('strong', null, value));
}

// ------------------------------------------------------------------ line / area chart

/**
 * series: [{ label, color (css var), values: number[] }], dates: string[] (yyyy-mm-dd)
 */
function lineChart(el, { dates, series, area = false, height = 230 }) {
  const width = Math.max(280, el.clientWidth || 600);
  const m = { l: 40, r: series.length > 1 ? 86 : 18, t: 14, b: 28 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const max = niceMax(Math.max(1, ...series.flatMap((x) => x.values)));
  const n = dates.length;
  const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;
  const svg = s('svg', { class: 'rp-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  // grid + y ticks
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.appendChild(s('line', { class: 'rp-gridline', x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v) }));
    svg.appendChild(s('text', { class: 'rp-axis', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, nf.format(v)));
  }
  // x ticks
  // whole-day steps anchored on the latest date, so spacing is even and "today" is always labeled
  const maxTicks = Math.max(2, Math.floor(iw / 72));
  const step = [1, 2, 3, 5, 7, 14, 30, 60].find((d) => Math.ceil(n / d) <= maxTicks) || Math.ceil(n / maxTicks);
  for (let i = n - 1; i >= 0; i -= step) {
    const anchor = i === n - 1 ? 'end' : (x(i) - m.l < 30 ? 'start' : 'middle');
    svg.appendChild(s('text', { class: 'rp-axis', x: x(i), y: height - 8, 'text-anchor': anchor }, shortDate(dates[i])));
  }
  // series
  series.forEach((ser) => {
    const pts = ser.values.map((v, i) => `${x(i)},${y(v)}`);
    if (area) {
      svg.appendChild(s('path', { class: 'rp-area', d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`, style: `fill:${ser.color}` }));
    }
    svg.appendChild(s('polyline', { class: 'rp-line', points: pts.join(' '), style: `stroke:${ser.color}` }));
    const last = ser.values[n - 1];
    svg.appendChild(s('circle', { class: 'rp-dot', cx: x(n - 1), cy: y(last), r: 4, style: `fill:${ser.color}` }));
  });
  // direct end labels (only when series separate enough)
  if (series.length > 1) {
    const ends = series.map((ser) => ({ ser, yy: y(ser.values[n - 1]) })).sort((a, b) => a.yy - b.yy);
    const collide = ends.some((e, i) => i && e.yy - ends[i - 1].yy < 14);
    if (!collide) {
      ends.forEach(({ ser, yy }) => svg.appendChild(s('text', { class: 'rp-endlabel', x: x(n - 1) + 9, y: yy + 4 }, `${ser.label} ${nf.format(ser.values[n - 1])}`)));
    }
  }

  // hover layer: crosshair + tooltip
  const cross = s('line', { class: 'rp-cross', y1: m.t, y2: m.t + ih, x1: 0, x2: 0, visibility: 'hidden' });
  const hoverDots = series.map((ser) => s('circle', { class: 'rp-dot rp-hover-dot', r: 5, cx: 0, cy: 0, style: `fill:${ser.color}`, visibility: 'hidden' }));
  const setHover = (on) => [cross, ...hoverDots].forEach((el) => el.setAttribute('visibility', on ? 'visible' : 'hidden'));
  svg.appendChild(cross);
  hoverDots.forEach((d) => svg.appendChild(d));
  const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', class: 'rp-hit' });
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    setHover(true);
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    series.forEach((ser, k) => { hoverDots[k].setAttribute('cx', x(i)); hoverDots[k].setAttribute('cy', y(ser.values[i])); });
    showTip(e.clientX, e.clientY, [h('div', { class: 'rp-tip-title' }, shortDate(dates[i])),
      series.map((ser) => tipRow(ser.color, ser.label, nf.format(ser.values[i])))]);
  });
  hit.addEventListener('pointerleave', () => {
    hideTip();
    setHover(false);
  });
  svg.appendChild(hit);
  svg.setAttribute('aria-label', series.map((ser) => `${ser.label}: ${ser.values.reduce((a, b) => a + b, 0)} total`).join(', '));
  mount(el, svg);
}

// ------------------------------------------------------------------ horizontal bars (HTML)

/**
 * rows: [{ label, lead (node), segments: [{ value, color, name }] }]
 */
function barList(rows, { legend } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((a, sg) => a + sg.value, 0)));
  return h('div', { class: 'rp-bars' },
    legend ? h('div', { class: 'rp-legend' }, legend.map((l) => h('span', { class: 'rp-legend-item' }, h('span', { class: 'rp-key', style: { background: l.color } }), l.label))) : null,
    rows.map((r) => {
      const total = r.segments.reduce((a, sg) => a + sg.value, 0);
      const bar = h('div', { class: 'rp-bar', style: { width: `${(total / max) * 100}%` } },
        r.segments.filter((sg) => sg.value > 0).map((sg) => h('span', {
          class: 'rp-seg', style: { flexGrow: sg.value, background: sg.color },
        })));
      const rowEl = h('div', { class: 'rp-bar-row', tabindex: '0' },
        h('div', { class: 'rp-bar-label' }, r.lead || null, h('span', { class: 'truncate' }, r.label)),
        h('div', { class: 'rp-bar-track' }, bar, h('span', { class: 'rp-bar-value' }, r.display ?? nf.format(total))));
      const show = (e) => showTip(e.clientX, e.clientY, [h('div', { class: 'rp-tip-title' }, r.label),
        r.segments.map((sg) => tipRow(sg.color, sg.name, sg.fmt ? sg.fmt(sg.value) : nf.format(sg.value)))]);
      rowEl.addEventListener('pointermove', show);
      rowEl.addEventListener('pointerleave', hideTip);
      rowEl.addEventListener('focus', () => {
        const rr = rowEl.getBoundingClientRect();
        show({ clientX: rr.left + rr.width / 2, clientY: rr.top });
      });
      rowEl.addEventListener('blur', hideTip);
      return rowEl;
    }));
}

function dataTable(headers, rows) {
  return h('div', { class: 'rp-table-wrap' }, h('table', { class: 'rp-table' },
    h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '' }, c)))))));
}

/** Card with a Chart/Table toggle. drawChart(el) renders into el; table() returns a node. */
function chartCard(title, sub, drawChart, table, { wide = false } = {}) {
  let mode = 'chart';
  const body = h('div', { class: 'rp-card-body' });
  const toggle = h('div', { class: 'seg rp-mode', role: 'group', 'aria-label': `${title} display` });
  const card = h('section', { class: ['card', 'rp-card', wide && 'rp-wide'] },
    h('div', { class: 'rp-card-head' },
      h('div', null, h('h3', { class: 'rp-card-title' }, title), sub ? h('p', { class: 'rp-sub' }, sub) : null),
      toggle),
    body);
  const draw = () => {
    mount(toggle, ['chart', 'table'].map((k) => h('button', {
      class: mode === k && 'active', 'aria-pressed': String(mode === k),
      onclick: () => { mode = k; draw(); },
    }, k === 'chart' ? 'Chart' : 'Table')));
    if (mode === 'table') mount(body, table());
    else {
      mount(body);
      drawChart(body);
    }
  };
  card.redraw = () => { if (mode === 'chart') { mount(body); drawChart(body); } };
  requestAnimationFrame(draw);
  return card;
}

// ------------------------------------------------------------------ view

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'reports', () => refresh());
  let days = 30;
  try { days = Number(localStorage.getItem('tp-rp-days')) || 30; } catch (_) {}
  if (!RANGES.includes(days)) days = 30;
  let stats = null;
  let cards = [];

  const page = h('div', { class: 'rp-root' });
  mount(shell.body, page);

  async function load() {
    mount(page, spinner());
    try {
      stats = await api.get(`/projects/${projectId}/stats?days=${days}`);
      draw();
    } catch (err) {
      errorToast(err);
      mount(page, emptyState('alert', 'Could not load reports', err.message));
    }
  }

  const refresh = debounce(async () => {
    try {
      stats = await api.get(`/projects/${projectId}/stats?days=${days}`);
      draw();
    } catch (_) { /* keep the last good render */ }
  }, 1500);

  function kpi(label, value, sub, ic, tone) {
    return h('div', { class: 'card rp-kpi' },
      h('div', { class: 'rp-kpi-head' }, h('span', { class: ['rp-kpi-icon', tone && `rp-tone-${tone}`] }, icon(ic, 15)), h('span', null, label)),
      h('div', { class: 'rp-kpi-value' }, value),
      sub ? h('div', { class: 'rp-kpi-sub' }, sub) : null);
  }

  function draw() {
    const b = state.board;
    const t = stats.totals;
    const S1 = 'var(--rp-s1)';
    const S2 = 'var(--rp-s2)';
    const dates = stats.series.map((x) => x.date);
    const created = stats.series.map((x) => x.created);
    const completed = stats.series.map((x) => x.completed);
    // open work at end of each day, reconstructed backwards from today's open count
    const openSeries = new Array(dates.length);
    let open = t.open;
    for (let i = dates.length - 1; i >= 0; i--) {
      openSeries[i] = Math.max(0, open);
      open = open - created[i] + completed[i];
    }
    const totalCreated = created.reduce((a, c) => a + c, 0);
    const totalCompleted = completed.reduce((a, c) => a + c, 0);
    const userName = (id) => (id ? member(id)?.name || 'Former member' : 'Unassigned');

    const head = h('div', { class: 'rp-head' },
      h('div', null, h('h2', { class: 'rp-title' }, 'Project reports'),
        h('p', { class: 'rp-sub' }, `Last ${days} days · ${nf.format(totalCreated)} created · ${nf.format(totalCompleted)} completed`)),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' }, RANGES.map((d) => h('button', {
        class: days === d && 'active', 'aria-pressed': String(days === d),
        onclick: () => { days = d; try { localStorage.setItem('tp-rp-days', d); } catch (_) {} load(); },
      }, `${d} days`))));

    const kpis = h('div', { class: 'rp-kpis' },
      kpi('Open tasks', nf.format(t.open), `${nf.format(t.unassigned)} unassigned`, 'inbox'),
      kpi('Completed', nf.format(t.completed), `${nf.format(totalCompleted)} in the last ${days} days`, 'check-circle'),
      kpi('Overdue', nf.format(t.overdue), t.overdue ? 'Open tasks past their due date' : 'Nothing overdue', 'alert', t.overdue ? 'danger' : null),
      kpi('Unassigned', nf.format(t.unassigned), 'Open tasks without an owner', 'user'),
      kpi('Avg. lead time', t.avg_lead_days == null ? '—' : `${t.avg_lead_days}d`, 'Created → completed', 'clock'),
      kpi('Time tracked', fmtDuration(t.tracked_seconds, { short: true }), 'All time, all members', 'clock'));

    const sectionRows = stats.by_section.map((x) => ({
      label: x.name, lead: h('span', { class: 'swatch', style: { background: x.color } }),
      segments: [{ value: x.count, color: x.color, name: 'Open tasks' }],
    }));
    const assigneeRows = [...stats.by_assignee].sort((a, c) => (c.open + c.completed) - (a.open + a.completed)).map((x) => ({
      label: userName(x.user_id), lead: avatar(member(x.user_id), 20),
      segments: [{ value: x.open, color: S1, name: 'Open' }, { value: x.completed, color: S2, name: 'Completed' }],
    }));
    const prioRows = ['urgent', 'high', 'medium', 'low', 'none'].map((k) => ({
      label: PRIORITIES[k].label, lead: h('span', { class: 'swatch', style: { background: PRIORITIES[k].color } }),
      segments: [{ value: stats.by_priority[k] || 0, color: PRIORITIES[k].color, name: 'Open tasks' }],
    }));
    const timeRows = [...stats.time_by_user].sort((a, c) => c.seconds - a.seconds).map((x) => ({
      label: userName(x.user_id), lead: avatar(member(x.user_id), 20), display: fmtDuration(x.seconds, { short: true }),
      segments: [{ value: x.seconds, color: S1, name: 'Tracked', fmt: (v) => fmtDuration(v, { short: true }) }],
    }));
    const emptyNote = (text) => h('div', { class: 'rp-empty' }, text);

    cards = [
      chartCard('Created vs completed', 'Tasks per day',
        (el) => lineChart(el, { dates, series: [{ label: 'Created', color: S1, values: created }, { label: 'Completed', color: S2, values: completed }] }),
        () => dataTable(['Date', 'Created', 'Completed'], stats.series.map((x) => [shortDate(x.date), x.created, x.completed])),
        { wide: true }),
      chartCard('Open work', 'Open tasks at the end of each day',
        (el) => lineChart(el, { dates, area: true, series: [{ label: 'Open', color: S1, values: openSeries }] }),
        () => dataTable(['Date', 'Open'], dates.map((d, i) => [shortDate(d), openSeries[i]])),
        { wide: true }),
      chartCard('By section', 'Open tasks in each section',
        (el) => mount(el, sectionRows.length ? barList(sectionRows) : emptyNote('No sections')),
        () => dataTable(['Section', 'Open'], stats.by_section.map((x) => [x.name, x.count]))),
      chartCard('By assignee', 'Open and completed tasks',
        (el) => mount(el, assigneeRows.length ? barList(assigneeRows, { legend: [{ label: 'Open', color: S1 }, { label: 'Completed', color: S2 }] }) : emptyNote('No tasks yet')),
        () => dataTable(['Assignee', 'Open', 'Completed'], assigneeRows.map((r) => [r.label, r.segments[0].value, r.segments[1].value]))),
      chartCard('By priority', 'Open tasks by priority',
        (el) => mount(el, barList(prioRows)),
        () => dataTable(['Priority', 'Open'], prioRows.map((r) => [r.label, r.segments[0].value]))),
      chartCard('Time by member', 'Tracked time, all time',
        (el) => mount(el, timeRows.length ? barList(timeRows) : emptyNote('No time tracked yet')),
        () => dataTable(['Member', 'Tracked'], timeRows.map((r) => [r.label, r.display]))),
    ];
    mount(page, head, kpis, h('div', { class: 'rp-grid' }, cards));
    if (!b.tasks.length) {
      page.insertBefore(h('div', { class: 'rp-hint' }, icon('bulb', 15), 'Add a few tasks on the board to see your reports come alive.'), kpis);
    }
  }

  const ro = new ResizeObserver(debounce(() => cards.forEach((c) => c.redraw?.()), 120));
  ro.observe(page);

  await load();
  return () => {
    shell.cleanup();
    ro.disconnect();
    hideTip();
    tip.remove();
  };
}
