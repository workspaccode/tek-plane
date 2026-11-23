// Timeline (Gantt) view: bars per task grouped by section, drag to reschedule, drag edge to change due date.
import { api } from '../api.js';
import { can, member, state } from '../store.js';
import { avatar, emptyState, errorToast, h, icon, mount, startOfDay, toast } from '../ui.js';
import { applyFilters, filterBar, projectShell } from '../components/projectShell.js';
import { dueChip } from '../components/taskCard.js';
import { openTask } from '../components/taskModal.js';

const DAY = 86400000;
const ZOOMS = { day: { px: 40, label: 'Day' }, week: { px: 18, label: 'Week' }, month: { px: 6, label: 'Month' } };
let LABEL_W = 260;
const ROW_H = 40;

function dayDiff(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function atHour(d, hour) {
  const x = new Date(d);
  x.setHours(hour, 0, 0, 0);
  return x;
}

/** Bar span for a task, or null when unscheduled. */
function span(t) {
  const s = t.start_date ? new Date(t.start_date) : null;
  const d = t.due_date ? new Date(t.due_date) : null;
  if (!s && !d) return null;
  if (s && d) return { start: startOfDay(s <= d ? s : d), end: startOfDay(s <= d ? d : s) };
  if (d) {
    const created = startOfDay(new Date(t.created_at));
    return { start: created <= d ? created : startOfDay(d), end: startOfDay(d), derivedStart: true };
  }
  return { start: startOfDay(s), end: startOfDay(s), derivedEnd: true };
}

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'timeline', () => draw());
  let zoom = 'week';
  try { zoom = localStorage.getItem('tp-tl-zoom') || 'week'; } catch (_) {}
  if (!ZOOMS[zoom]) zoom = 'week';
  const collapsed = new Set();
  let scrolledOnce = false;
  let dragging = null;

  const toolbar = h('div', { class: 'board-toolbar tl-toolbar' });
  const scroller = h('div', { class: 'tl-scroll' });
  const unscheduled = h('div', { class: 'tl-unscheduled' });
  const area = h('div', { class: 'tl-area' }, scroller, unscheduled);
  mount(shell.body, toolbar, area);

  function drawToolbar() {
    mount(toolbar, h('div', { class: 'lv-toolbar-row' },
      filterBar(() => draw()),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-secondary btn-sm', onclick: () => scrollToToday(true) }, icon('calendar', 14), 'Today'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Zoom' }, Object.entries(ZOOMS).map(([k, z]) => h('button', {
        class: zoom === k && 'active', 'aria-pressed': String(zoom === k),
        onclick: () => {
          const center = centerDate();
          zoom = k;
          try { localStorage.setItem('tp-tl-zoom', k); } catch (_) {}
          drawToolbar();
          draw();
          scrollToDate(center);
        },
      }, z.label)))));
  }

  let range = null; // { start: Date, days: number }

  function computeRange(tasks) {
    const today = startOfDay(new Date());
    let min = addDays(today, -14);
    let max = addDays(today, 45);
    for (const t of tasks) {
      const s = span(t);
      if (!s) continue;
      if (s.start < min) min = s.start;
      if (s.end > max) max = s.end;
    }
    min = addDays(min, -7);
    max = addDays(max, 30);
    // align to Monday for clean week headers
    const dow = (min.getDay() + 6) % 7;
    min = addDays(min, -dow);
    return { start: startOfDay(min), days: dayDiff(max, min) + 1 };
  }

  function centerDate() {
    if (!range) return new Date();
    const px = ZOOMS[zoom].px;
    const x = scroller.scrollLeft + (scroller.clientWidth - LABEL_W) / 2;
    return addDays(range.start, Math.floor(x / px));
  }

  function scrollToDate(d, smooth = false) {
    if (!range) return;
    const px = ZOOMS[zoom].px;
    const x = dayDiff(d, range.start) * px - (scroller.clientWidth - LABEL_W) / 2;
    scroller.scrollTo({ left: Math.max(0, x), behavior: smooth ? 'smooth' : 'auto' });
  }

  function scrollToToday(smooth) {
    if (!range) return;
    const px = ZOOMS[zoom].px;
    const x = dayDiff(new Date(), range.start) * px - (scroller.clientWidth - LABEL_W) * 0.25;
    scroller.scrollTo({ left: Math.max(0, x), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---------------------------------------------------------------- render

  function draw() {
    if (!state.board || dragging) return;
    LABEL_W = window.innerWidth < 700 ? 150 : 260;
    const b = state.board;
    const tasks = applyFilters(b.tasks);
    const scheduled = tasks.filter((t) => span(t));
    const unsched = tasks.filter((t) => !span(t) && t.status === 'open');
    const prevLeft = scroller.scrollLeft;
    const prevTop = scroller.scrollTop;
    const oldStart = range?.start;
    range = computeRange(scheduled);
    const px = ZOOMS[zoom].px;
    const width = range.days * px;

    const inner = h('div', { class: 'tl-inner', style: { width: `${LABEL_W + width}px`, '--tl-px': `${px}px`, '--tl-lw': `${LABEL_W}px` } });
    inner.appendChild(header(width, px));

    // background: weekends + today line
    const bg = h('div', { class: 'tl-bg', style: { left: `${LABEL_W}px`, width: `${width}px` } });
    for (let i = 0; i < range.days; i++) {
      const d = addDays(range.start, i);
      const dow = d.getDay();
      if (px >= 6 && (dow === 0 || dow === 6)) bg.appendChild(h('div', { class: 'tl-weekend', style: { left: `${i * px}px`, width: `${px}px` } }));
      if (zoom !== 'day' && dow === 1) bg.appendChild(h('div', { class: 'tl-weekline', style: { left: `${i * px}px` } }));
    }
    const todayX = dayDiff(new Date(), range.start) * px;
    bg.appendChild(h('div', { class: 'tl-today', style: { left: `${todayX + px / 2}px` } }));
    inner.appendChild(bg);

    if (!scheduled.length) {
      inner.appendChild(h('div', { class: 'tl-empty', style: { left: `${LABEL_W}px` } },
        emptyState('timeline', 'Nothing scheduled yet', 'Give tasks a start or due date and they appear here as bars.')));
    }

    for (const s of b.sections) {
      const rows = scheduled.filter((t) => t.section_id === s.id)
        .sort((a, c) => span(a).start - span(c).start || a.position - c.position);
      if (!rows.length) continue;
      const isCollapsed = collapsed.has(s.id);
      inner.appendChild(h('div', { class: 'tl-group' },
        h('button', {
          class: 'tl-group-label', style: { width: `${LABEL_W}px` }, 'aria-expanded': String(!isCollapsed),
          onclick: () => { isCollapsed ? collapsed.delete(s.id) : collapsed.add(s.id); draw(); },
        }, icon(isCollapsed ? 'chevron-right' : 'chevron-down', 14),
        h('span', { class: 'swatch', style: { background: s.color } }),
        h('span', { class: 'truncate' }, s.name), h('span', { class: 'tl-count' }, rows.length)),
        h('div', { class: 'tl-group-fill', style: { width: `${width}px` } })));
      if (isCollapsed) continue;
      rows.forEach((t) => inner.appendChild(taskRow(t, s, px)));
    }

    inner.appendChild(h('div', { class: 'tl-filler' }, h('div', { class: 'tl-filler-label', style: { width: `${LABEL_W}px` } })));
    mount(scroller, inner);
    if (!scrolledOnce) {
      scrolledOnce = true;
      requestAnimationFrame(() => scrollToToday(false));
    } else {
      // keep the same dates in view when the range start moves
      const shift = oldStart ? dayDiff(oldStart, range.start) * px : 0;
      scroller.scrollLeft = prevLeft + shift;
      scroller.scrollTop = prevTop;
    }
    drawUnscheduled(unsched);
  }

  function header(width, px) {
    const months = h('div', { class: 'tl-months' });
    const ticks = h('div', { class: 'tl-ticks' });
    let i = 0;
    while (i < range.days) {
      const d = addDays(range.start, i);
      const daysLeft = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
      const n = Math.min(daysLeft, range.days - i);
      months.appendChild(h('div', { class: 'tl-month', style: { left: `${i * px}px`, width: `${n * px}px` } },
        h('span', { class: 'truncate' }, d.toLocaleDateString(undefined, { month: zoom === 'month' && n * px < 70 ? 'short' : 'long', year: 'numeric' }))));
      i += n;
    }
    const today = startOfDay(new Date());
    for (let j = 0; j < range.days; j++) {
      const d = addDays(range.start, j);
      const isToday = +d === +today;
      if (zoom === 'day') {
        ticks.appendChild(h('div', { class: ['tl-tick', isToday && 'today', (d.getDay() === 0 || d.getDay() === 6) && 'weekend'], style: { left: `${j * px}px`, width: `${px}px` } },
          h('span', { class: 'tl-dow' }, d.toLocaleDateString(undefined, { weekday: 'narrow' })), h('span', null, d.getDate())));
      } else if (d.getDay() === 1) {
        ticks.appendChild(h('div', { class: 'tl-tick tl-tick-week', style: { left: `${j * px}px`, width: `${7 * px}px` } },
          zoom === 'week' ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()));
      }
    }
    return h('div', { class: 'tl-head' },
      h('div', { class: 'tl-corner', style: { width: `${LABEL_W}px` } }, 'Task'),
      h('div', { class: 'tl-scale', style: { width: `${width}px` } }, months, ticks));
  }

  function taskRow(t, s, px) {
    const sp = span(t);
    const left = dayDiff(sp.start, range.start) * px;
    const w = (dayDiff(sp.end, sp.start) + 1) * px;
    const done = t.status !== 'open';
    const editable = can('member') && t.status === 'open';
    const m = member(t.assignee_id);
    const labelOutside = w < 90;
    const bar = h('div', {
      class: ['tl-bar', done && 'tl-bar-done', editable && 'tl-bar-edit', sp.derivedStart && 'tl-bar-derived'],
      style: { left: `${left}px`, width: `${w}px`, '--bar': s.color },
      tabindex: '0', role: 'button',
      'aria-label': `#${t.number} ${t.title}, ${sp.start.toLocaleDateString()} to ${sp.end.toLocaleDateString()}`,
      title: `#${t.number} ${t.title}\n${sp.start.toLocaleDateString()} → ${sp.end.toLocaleDateString()}`,
      onkeydown: (e) => { if (e.key === 'Enter') openTask(t.id); },
    },
    labelOutside ? null : h('span', { class: 'tl-bar-label truncate' }, t.title),
    editable ? h('span', { class: 'tl-handle', 'aria-hidden': 'true' }) : null);
    const outside = labelOutside ? h('span', { class: 'tl-bar-out truncate', style: { left: `${left + w + 6}px` } }, t.title) : null;
    if (editable) attachDrag(bar, outside, t, sp, px);
    else bar.addEventListener('click', () => openTask(t.id));

    return h('div', { class: ['tl-row', done && 'tl-row-done'] },
      h('div', { class: 'tl-label', style: { width: `${LABEL_W}px` }, onclick: () => openTask(t.id) },
        h('span', { class: ['tl-status', done && 'done'] }, done ? icon('check', 10) : null),
        h('span', { class: 'tl-num' }, `#${t.number}`),
        h('span', { class: 'tl-title truncate' }, t.title),
        avatar(m, 20)),
      h('div', { class: 'tl-track' }, bar, outside));
  }

  // ---------------------------------------------------------------- drag

  function attachDrag(bar, outside, t, sp, px) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const mode = e.target.classList.contains('tl-handle') ? 'resize' : 'move';
      const startX = e.clientX;
      const left0 = parseFloat(bar.style.left);
      const w0 = parseFloat(bar.style.width);
      let delta = 0;
      let moved = false;
      bar.setPointerCapture(e.pointerId);
      dragging = { t };
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        if (!moved) return;
        delta = Math.round(dx / px);
        bar.classList.add('tl-dragging');
        if (mode === 'move') {
          bar.style.left = `${left0 + delta * px}px`;
          if (outside) outside.style.left = `${left0 + delta * px + w0 + 6}px`;
        } else {
          const minDelta = -(dayDiff(sp.end, sp.start));
          delta = Math.max(delta, minDelta);
          bar.style.width = `${w0 + delta * px}px`;
          if (outside) outside.style.left = `${left0 + w0 + delta * px + 6}px`;
        }
        const ns = mode === 'move' ? addDays(sp.start, delta) : sp.start;
        const ne = addDays(sp.end, delta);
        bar.dataset.tip = `${ns.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} → ${ne.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      };
      const onUp = async () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
        bar.classList.remove('tl-dragging');
        delete bar.dataset.tip;
        dragging = null;
        if (!moved) { openTask(t.id); return; }
        if (!delta) { draw(); return; }
        const start = mode === 'move' ? addDays(sp.start, delta) : sp.start;
        const end = addDays(sp.end, delta);
        await reschedule(t, start, end);
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });
  }

  async function reschedule(t, start, end) {
    // keep existing time-of-day where possible
    const sh = t.start_date ? new Date(t.start_date).getHours() : 9;
    const eh = t.due_date ? new Date(t.due_date).getHours() : 17;
    const body = { start_date: atHour(start, sh).toISOString(), due_date: atHour(end, eh).toISOString() };
    const before = { start_date: t.start_date, due_date: t.due_date };
    Object.assign(t, body);
    draw();
    try {
      Object.assign(t, await api.patch(`/tasks/${t.id}`, body));
      draw();
    } catch (err) {
      Object.assign(t, before);
      draw();
      errorToast(err);
    }
  }

  // ---------------------------------------------------------------- unscheduled

  function drawUnscheduled(list) {
    if (!list.length) { mount(unscheduled); unscheduled.classList.add('hidden'); return; }
    unscheduled.classList.remove('hidden');
    const editable = can('member');
    mount(unscheduled,
      h('div', { class: 'tl-uns-head' }, icon('inbox', 15), h('strong', null, 'Unscheduled'), h('span', { class: 'tl-count' }, list.length),
        h('span', { class: 'muted small' }, 'Open tasks without start or due date')),
      h('div', { class: 'tl-uns-list' }, list.slice(0, 60).map((t) => {
        const s = state.board.sections.find((x) => x.id === t.section_id);
        return h('div', { class: 'tl-uns-item' },
          h('span', { class: 'swatch', style: { background: s?.color || 'var(--text-3)' } }),
          h('button', { class: 'tl-uns-title truncate', onclick: () => openTask(t.id) }, `#${t.number} ${t.title}`),
          t.due_date ? dueChip(t.due_date) : null,
          avatar(member(t.assignee_id), 20),
          editable ? h('button', { class: 'btn btn-soft btn-sm', onclick: async () => {
            const today = new Date();
            try {
              Object.assign(t, await api.patch(`/tasks/${t.id}`, {
                start_date: atHour(today, 9).toISOString(), due_date: atHour(today, 17).toISOString(),
              }));
              draw();
              scrollToToday(true);
              toast(`Scheduled “${t.title}” for today`, 'success');
            } catch (err) { errorToast(err); }
          } }, icon('calendar', 13), 'Schedule today') : null);
      }), list.length > 60 ? h('div', { class: 'muted small', style: { padding: '6px 10px' } }, `and ${list.length - 60} more…`) : null));
  }

  drawToolbar();
  draw();
  return () => shell.cleanup();
}
