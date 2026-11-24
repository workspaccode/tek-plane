// Mind maps inside a project. Tree layout (left/right of the central topic), pan & zoom,
// keyboard editing, drag to re-parent, and node → task conversion with live task status.
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { can, on, state } from '../store.js';
import {
  COLORS, avatar, confirmDialog, debounce, emptyState, errorToast, fmtRelative, h, icon, menu, mount, openModal,
  popover, promptDialog, toast,
} from '../ui.js';
import { addBoardDialog, isMindmapProject, projectShell } from '../components/projectShell.js';
import { openTask } from '../components/taskModal.js';
import {
  DEFAULT_SETTINGS, LAYOUTS, PALETTES, branchPath, foldPoint, inkFor, layout, layoutGlyph,
} from '../components/mindmapLayout.js';
const views = new Map(); // map id -> { x, y, k } so switching tabs keeps your viewport

export default async function render(root, { params, query }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'mindmap', () => current && drawToolbar());
  const editable = () => can('member');

  let maps = [];
  let current = null; // { map, nodes }
  let byId = new Map();
  let selected = null;
  let editing = null;
  let pendingRemote = false;
  let view = { x: 0, y: 0, k: 1 };

  const toolbar = h('div', { class: 'mm-toolbar' });
  const canvas = h('div', { class: 'mm-canvas', tabindex: '0', 'aria-label': 'Mind map canvas' });
  const world = h('div', { class: 'mm-world' });
  const links = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  links.setAttribute('class', 'mm-links');
  world.append(links);
  canvas.append(world);
  const hint = h('div', { class: 'mm-hint' },
    h('kbd', null, 'Tab'), ' child ', h('kbd', null, 'Enter'), ' sibling ', h('kbd', null, 'F2'), ' edit ',
    h('kbd', null, 'Space'), ' fold ', h('kbd', null, 'Del'), ' delete ', h('kbd', null, 'Arrows'), ' move');
  mount(shell.body, toolbar, h('div', { class: 'mm-stage' }, canvas, hint));

  // ---------------------------------------------------------------- data

  async function loadMaps(selectId) {
    maps = await api.get(`/projects/${projectId}/mindmaps`);
    const id = selectId || Number(query.map) || current?.map.id || maps[0]?.id;
    if (id && maps.some((m) => m.id === id)) await openMap(id);
    else { current = null; drawToolbar(); drawEmpty(); }
  }

  async function openMap(id, { keepView = true } = {}) {
    const firstOpen = current?.map.id !== id;
    current = await api.get(`/mindmaps/${id}`);
    byId = new Map(current.nodes.map((n) => [n.id, n]));
    if (selected && !byId.has(selected)) selected = null;
    setQuery({ map: id });
    let needsFit = false;
    if (firstOpen) {
      selected = rootNode()?.id ?? null;
      const saved = views.get(id);
      needsFit = !saved || !keepView;
      view = saved ? { ...saved } : { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, k: 1 };
    }
    drawToolbar();
    draw();
    if (needsFit) fit();
  }

  const refresh = debounce(async () => {
    if (!current) return;
    if (editing) { pendingRemote = true; return; }
    try { await openMap(current.map.id); } catch (err) {
      if (err.status === 404) { toast('This mind map was deleted'); loadMaps(); }
    }
  }, 250);

  const rootNode = () => current?.nodes.find((n) => n.parent_id === null);
  const kids = (id) => current.nodes.filter((n) => n.parent_id === id).sort((a, b) => a.position - b.position || a.id - b.id);
  const S = () => ({ ...DEFAULT_SETTINGS, ...(current?.map.settings || {}) });
  const visibleKids = (n) => (n.collapsed && n.parent_id !== null ? [] : kids(n.id));
  let lastPos = new Map(); // id -> position from the last layout (navigation, fold buttons)
  let order = []; // visible nodes in tree order

  // ---------------------------------------------------------------- toolbar

  function drawToolbar() {
    const m = current?.map;
    const solo = isMindmapProject();
    mount(toolbar,
      solo
        ? h('div', { class: 'mm-map-pick mm-map-solo' }, icon('mindmap', 16), h('span', { class: 'truncate' }, m ? m.title : 'Mind map'))
        : h('button', { class: 'mm-map-pick', onclick: (e) => mapMenu(e.currentTarget), disabled: !maps.length },
          icon('mindmap', 16), h('span', { class: 'truncate' }, m ? m.title : 'No mind maps'), icon('chevron-down', 14)),
      m ? h('span', { class: 'muted small mm-updated' }, `${current.nodes.length} topics · edited ${fmtRelative(m.updated_at)}`) : null,
      h('div', { class: 'grow' }),
      m ? h('div', { class: 'seg mm-layouts', role: 'radiogroup', 'aria-label': 'Layout' },
        Object.entries(LAYOUTS).map(([id, info]) => h('button', {
          class: S().layout === id ? 'active' : '', role: 'radio', 'aria-checked': String(S().layout === id),
          title: `${info.label}: ${info.hint}`, 'aria-label': info.label, onclick: () => setSettings({ layout: id }, { refit: true }),
        }, layoutGlyph(id), h('span', { class: 'mm-layout-label' }, info.label)))) : null,
      m ? h('button', { class: 'btn btn-secondary btn-sm mm-display-btn', onclick: (e) => openDisplay(e.currentTarget) },
        icon('settings', 14), 'Display') : null,
      m ? h('div', { class: 'mm-zoom' },
        h('button', { class: 'icon-btn sm', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, icon('minus', 14)),
        h('button', { class: 'mm-zoom-val', title: 'Reset zoom', onclick: () => { view.k = 1; centerOn(byId.get(selected) || rootNode()); } }, `${Math.round(view.k * 100)}%`),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.2) }, icon('plus', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Fit to screen', title: 'Fit to screen', onclick: fit }, icon('maximize', 14))) : null,
      editable() && !solo ? h('button', { class: 'btn btn-primary btn-sm', onclick: newMap }, icon('plus', 14), 'New mind map') : null);
  }

  function mapMenu(anchor) {
    const m = current?.map;
    menu(anchor, [
      { header: 'Mind maps' },
      ...maps.map((x) => ({ label: x.title, icon: 'mindmap', hint: `${x.node_count ?? ''}`, checked: x.id === m?.id, onClick: () => openMap(x.id) })),
      editable() && m ? 'divider' : null,
      editable() && m ? { label: 'Rename', icon: 'edit', onClick: async () => {
        const title = await promptDialog('Rename mind map', { value: m.title });
        if (!title) return;
        try { await api.patch(`/mindmaps/${m.id}`, { title }); await loadMaps(m.id); } catch (err) { errorToast(err); }
      } } : null,
      editable() && m ? { label: 'Delete mind map', icon: 'trash', danger: true, onClick: async () => {
        if (!await confirmDialog(`Delete “${m.title}” and all its topics? Linked tasks are kept.`, { title: 'Delete mind map?', confirmText: 'Delete', danger: true })) return;
        try { await api.del(`/mindmaps/${m.id}`); current = null; setQuery({ map: null }); await loadMaps(); } catch (err) { errorToast(err); }
      } } : null,
    ], { width: 260 });
  }

  function newMap() {
    let fromBoard = false;
    const title = h('input', { class: 'input', placeholder: 'e.g. Launch plan', autofocus: true, maxlength: 200 });
    const opts = h('div', { class: 'template-grid' });
    const drawOpts = () => mount(opts,
      h('button', { type: 'button', class: ['template-card', !fromBoard && 'active'], onclick: () => { fromBoard = false; drawOpts(); } },
        h('strong', null, 'Blank'), h('span', null, 'Start from one central topic')),
      h('button', { type: 'button', class: ['template-card', fromBoard && 'active'], onclick: () => { fromBoard = true; drawOpts(); } },
        h('strong', null, 'From this board'), h('span', null, 'Sections become branches, open tasks become linked topics')));
    drawOpts();
    const create = async () => {
      const t = title.value.trim() || state.board.project.name;
      dlg.close();
      try {
        const mm = await api.post(`/projects/${projectId}/mindmaps`, { title: t, from_board: fromBoard });
        await loadMaps(mm.id);
        if (!fromBoard) {
          const r = rootNode();
          if (r) addChild(r.id);
        }
      } catch (err) { errorToast(err); }
    };
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    const dlg = openModal({
      title: 'New mind map', width: 480,
      content: h('div', null, h('div', { class: 'field' }, h('label', { class: 'label' }, 'Central topic'), title),
        h('div', { class: 'field' }, h('label', { class: 'label' }, 'Start with'), opts)),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: create }, 'Create')],
    });
  }

  function drawEmpty() {
    world.style.display = 'none';
    hint.style.display = 'none';
    canvas.querySelector('.mm-empty')?.remove();
    canvas.append(h('div', { class: 'mm-empty' }, emptyState('mindmap', 'Think it through, then make it happen',
      'Brainstorm on a mind map, then turn topics into tasks with one click. They stay linked, so you can see progress right on the map.',
      editable() ? h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px' } },
        h('button', { class: 'btn btn-primary', onclick: newMap }, icon('plus', 14), 'New mind map')) : null)));
  }

  // ---------------------------------------------------------------- layout & render

  function branchColor(n) {
    if (n.color) return n.color;
    let cur = n;
    while (cur.parent_id !== null && byId.get(cur.parent_id)?.parent_id !== null) {
      cur = byId.get(cur.parent_id);
      if (cur.color) return cur.color;
    }
    if (n.parent_id === null) return 'var(--text)';
    const palette = (PALETTES[S().palette] || PALETTES.vibrant).colors;
    const first = kids(rootNode().id);
    const i = first.findIndex((x) => x.id === cur.id);
    return cur.color || palette[(i < 0 ? 0 : i) % palette.length];
  }

  function applyCanvasClasses() {
    const st = S();
    canvas.className = ['mm-canvas', `mm-layout-${st.layout}`, `mm-shape-${st.shape}`, `mm-bg-${st.background}`,
      !st.show_tasks && 'mm-hide-tasks', !st.show_notes && 'mm-hide-notes', canvas.classList.contains('panning') && 'panning']
      .filter(Boolean).join(' ');
    world.style.setProperty('--mm-scale', st.font_scale);
  }

  function draw() {
    canvas.querySelector('.mm-empty')?.remove();
    world.style.display = '';
    hint.style.display = editable() ? '' : 'none';
    world.querySelectorAll('.mm-node, .mm-fold').forEach((el) => el.remove());
    const root = rootNode();
    if (!root) return;
    applyCanvasClasses();
    const st = S();

    // 1) create elements and measure them
    const els = new Map();
    order = [];
    const depthOf = new Map();
    const walk = (n, depth) => {
      order.push(n);
      depthOf.set(n.id, depth);
      visibleKids(n).forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    for (const n of order) {
      const el = nodeEl(n, depthOf.get(n.id));
      world.append(el);
      els.set(n.id, el);
    }
    const sizes = new Map([...els].map(([id, el]) => [id, { w: el.offsetWidth, h: el.offsetHeight }]));

    // 2) layout
    const pos = layout(root, visibleKids, (id) => sizes.get(id), {
      layout: st.layout, spacingX: st.spacing_x, spacingY: st.spacing_y,
    });
    lastPos = pos;

    // 3) position topics, fold toggles and branches
    const underline = st.shape === 'underline';
    let paths = '';
    for (const n of order) {
      const p = pos.get(n.id);
      els.get(n.id).style.transform = `translate(${p.x}px, ${p.y}px)`;
      const childCount = kids(n.id).length;
      if (n.parent_id !== null && childCount) {
        const fp = foldPoint(st.layout, p);
        world.append(h('button', {
          class: ['mm-fold', n.collapsed && 'collapsed'], style: { transform: `translate(${fp.x}px, ${fp.y}px)`, '--branch': branchColor(n) },
          'aria-label': n.collapsed ? `Expand (${childCount})` : 'Collapse', title: n.collapsed ? `Show ${childCount} sub-topics` : 'Collapse',
          onpointerdown: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation(); toggleFold(n); },
        }, n.collapsed ? String(childCount) : icon('minus', 10)));
      }
      if (n.parent_id === null) continue;
      const depth = p.depth;
      const wdt = Math.max(st.line_width * 0.45, st.line_width * (1.5 - 0.3 * depth));
      let prev = null;
      if (st.layout === 'tree') {
        const sib = visibleKids(byId.get(n.parent_id));
        const i = sib.findIndex((x) => x.id === n.id);
        prev = i > 0 ? pos.get(sib[i - 1].id) : null;
      }
      const d = branchPath(st.layout, st.lines, pos.get(n.parent_id), p, { underline, prev });
      paths += `<path d="${d}" stroke="${branchColor(n)}" stroke-width="${wdt.toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${depth > 1 ? 0.75 : 0.92}"/>`;
    }
    links.innerHTML = paths;
    applyView();
  }

  function nodeEl(n, depth) {
    const isRoot = n.parent_id === null;
    const color = branchColor(n);
    const task = n.task;
    const done = task?.status === 'completed';
    const el = h('div', {
      class: ['mm-node', isRoot && 'root', depth === 1 && 'level1', depth > 1 && 'leaf', n.id === selected && 'selected', done && 'done'],
      dataset: { id: n.id }, style: { '--branch': color, '--branch-ink': inkFor(color) }, role: 'treeitem', 'aria-selected': String(n.id === selected),
    },
    h('span', { class: 'mm-text' }, n.text || (isRoot ? 'Central topic' : 'New topic')),
    n.note ? h('span', { class: 'mm-badge', title: 'Has a note' }, icon('note', 12)) : null,
    task ? h('button', {
      class: ['mm-task', task.status], title: `#${task.number} ${task.title} (${task.status}). Click to open`,
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); openTask(task.id); },
    }, icon(done ? 'check-circle' : 'checklist', 12), `#${task.number}`, task.assignee ? avatar(task.assignee, 16) : null) : null);
    if (!n.text) el.classList.add('placeholder');
    return el;
  }

  // ---------------------------------------------------------------- display settings

  const saveSettings = debounce(async (patch) => {
    if (!editable() || !current) return;
    try { await api.patch(`/mindmaps/${current.map.id}`, { settings: patch }); } catch (err) { errorToast(err); }
  }, 450);
  let pendingPatch = {};

  const RESHAPES = new Set(['layout', 'shape', 'spacing_x', 'spacing_y', 'font_scale', 'show_tasks', 'show_notes']);

  function setSettings(patch, { refit = false } = {}) {
    if (!current) return;
    refit = refit || Object.keys(patch).some((k) => RESHAPES.has(k));
    current.map.settings = { ...(current.map.settings || {}), ...patch };
    pendingPatch = { ...pendingPatch, ...patch };
    const sent = pendingPatch;
    saveSettings(sent);
    setTimeout(() => { if (pendingPatch === sent) pendingPatch = {}; }, 500);
    drawToolbar();
    draw();
    if (refit) fit();
    displayRedraw?.();
  }

  async function resetSettings() {
    if (!current) return;
    current.map.settings = {};
    draw();
    fit();
    drawToolbar();
    displayRedraw?.();
    if (editable()) {
      try { await api.patch(`/mindmaps/${current.map.id}`, { settings: { reset: true } }); } catch (err) { errorToast(err); }
    }
  }

  async function foldTo(level) {
    if (!current) return;
    if (!editable()) {
      // viewers fold locally only
      for (const n of current.nodes) {
        let d = 0; let c = n;
        while (c.parent_id !== null) { d++; c = byId.get(c.parent_id); }
        n.collapsed = level !== null && d >= level && n.parent_id !== null;
      }
      draw(); fit();
      return;
    }
    try {
      await api.post(`/mindmaps/${current.map.id}/fold`, { level });
      await openMap(current.map.id);
      fit();
    } catch (err) { errorToast(err); }
  }

  let displayRedraw = null;

  function openDisplay(anchor) {
    popover(anchor, (panel) => {
      const body = h('div', { class: 'mm-display' });
      const seg = (key, options) => h('div', { class: 'seg mm-seg-full' }, options.map(([v, label]) => h('button', {
        class: S()[key] === v ? 'active' : '', 'aria-pressed': String(S()[key] === v), onclick: () => setSettings({ [key]: v }),
      }, label)));
      const slider = (key, label, min, max, step, fmt) => {
        const val = h('span', { class: 'mm-slider-val' }, fmt(S()[key]));
        const input = h('input', { type: 'range', min, max, step, value: S()[key], 'aria-label': label, class: 'mm-range' });
        input.addEventListener('input', () => {
          val.textContent = fmt(Number(input.value));
          current.map.settings = { ...(current.map.settings || {}), [key]: Number(input.value) };
          draw();
        });
        input.addEventListener('change', () => setSettings({ [key]: Number(input.value) }));
        return h('div', { class: 'mm-slider' }, h('div', { class: 'mm-slider-head' }, h('span', null, label), val), input);
      };
      const toggle = (key, label) => h('button', {
        class: 'mm-toggle-row', role: 'switch', 'aria-checked': String(!!S()[key]),
        onclick: () => setSettings({ [key]: !S()[key] }),
      }, h('span', null, label), h('span', { class: ['toggle', S()[key] && 'on'] }));
      const section = (title, ...children) => h('div', { class: 'mm-dsec' }, h('div', { class: 'mm-dsec-title' }, title), children);

      const drawPanel = () => mount(body,
        h('div', { class: 'mm-display-head' },
          h('strong', null, 'Display'),
          h('span', { class: 'muted small' }, editable() ? 'Saved for everyone on this map' : 'Only for you (view access)')),
        section('Layout', h('div', { class: 'mm-layout-grid' }, Object.entries(LAYOUTS).map(([id, info]) => h('button', {
          class: ['mm-layout-tile', S().layout === id && 'active'], 'aria-pressed': String(S().layout === id),
          onclick: () => setSettings({ layout: id }, { refit: true }),
        }, layoutGlyph(id), h('span', null, info.label))))),
        section('Branches', seg('lines', [['curved', 'Curved'], ['straight', 'Straight'], ['elbow', 'Elbow']])),
        section('Topic shape', seg('shape', [['rounded', 'Rounded'], ['pill', 'Pill'], ['rect', 'Box'], ['underline', 'Line'], ['plain', 'Text']])),
        section('Colors', h('div', { class: 'mm-palettes' }, Object.entries(PALETTES).map(([id, pal]) => h('button', {
          class: ['mm-palette', S().palette === id && 'active'], 'aria-pressed': String(S().palette === id), title: pal.label,
          onclick: () => setSettings({ palette: id }),
        }, h('span', { class: 'mm-palette-dots' }, pal.colors.slice(0, 5).map((c) => h('i', { style: { background: c } }))),
        h('span', null, pal.label))))),
        section('Size & spacing',
          slider('spacing_x', 'Horizontal spacing', 16, 200, 2, (v) => `${Math.round(v)}px`),
          slider('spacing_y', 'Vertical spacing', 2, 60, 1, (v) => `${Math.round(v)}px`),
          slider('font_scale', 'Text size', 0.7, 1.6, 0.05, (v) => `${Math.round(v * 100)}%`),
          slider('line_width', 'Branch thickness', 0.5, 8, 0.25, (v) => `${(+v).toFixed(1)}`)),
        section('Canvas', seg('background', [['dots', 'Dots'], ['grid', 'Grid'], ['plain', 'Plain']]),
          toggle('show_tasks', 'Show task badges'), toggle('show_notes', 'Show note icons')),
        section('Expand & collapse', h('div', { class: 'mm-fold-row' },
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => foldTo(null) }, 'Expand all'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => foldTo(1) }, 'Level 1'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => foldTo(2) }, 'Level 2'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => foldTo(3) }, 'Level 3'))),
        h('div', { class: 'mm-display-foot' },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: resetSettings }, icon('repeat', 13), 'Reset to defaults'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: fit }, icon('maximize', 13), 'Fit to screen')));
      drawPanel();
      displayRedraw = () => { if (document.body.contains(body)) drawPanel(); else displayRedraw = null; };
      return body;
    }, { width: 340, align: 'end', className: 'mm-display-pop', onClose: () => { displayRedraw = null; } });
  }

  // ---------------------------------------------------------------- viewport

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    if (current) views.set(current.map.id, view);
    const zv = toolbar.querySelector('.mm-zoom-val');
    if (zv) zv.textContent = `${Math.round(view.k * 100)}%`;
  }

  function fit() {
    const nodes = [...world.querySelectorAll('.mm-node')];
    if (!nodes.length) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const el of nodes) {
      const m = el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      if (!m) continue;
      const x = +m[1]; const y = +m[2];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
    }
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    if (S().layout === 'tree') {
      // a tall outline: fit the width, keep text readable, start at the top
      const k = Math.min(1.1, Math.max(0.8, Math.min((W - 120) / (maxX - minX || 1), (H - 100) / (maxY - minY || 1))));
      view = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: 56 - minY * k };
      applyView();
      return;
    }
    const k = Math.min(1.2, Math.max(0.25, Math.min((W - 80) / (maxX - minX || 1), (H - 80) / (maxY - minY || 1))));
    view = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k };
    applyView();
  }

  function zoomBy(f, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
    const k = Math.min(2.5, Math.max(0.2, view.k * f));
    view = { k, x: cx - ((cx - view.x) / view.k) * k, y: cy - ((cy - view.y) / view.k) * k };
    applyView();
  }

  function centerOn(n, onlyIfHidden = false) {
    if (!n) return;
    const el = world.querySelector(`.mm-node[data-id="${n.id}"]`);
    if (!el) return;
    const m = el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
    const x = (+m[1] + el.offsetWidth / 2) * view.k + view.x;
    const y = (+m[2] + el.offsetHeight / 2) * view.k + view.y;
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    if (onlyIfHidden && x > 60 && x < W - 60 && y > 40 && y < H - 40) return;
    view.x += W / 2 - x;
    view.y += H / 2 - y;
    applyView();
  }

  canvas.addEventListener('wheel', (e) => {
    if (!current) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });

  // pointer: pan on background, select / drag-to-reparent on nodes
  let ptr = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!current || e.button !== 0 || e.target.closest('.mm-edit, .mm-nodebar, .mm-empty')) return;
    const nodeEl = e.target.closest('.mm-node');
    canvas.focus({ preventScroll: true });
    ptr = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, node: nodeEl ? Number(nodeEl.dataset.id) : null, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptr || ptr.id !== e.pointerId) return;
    const dx = e.clientX - ptr.sx; const dy = e.clientY - ptr.sy;
    if (!ptr.moved && Math.hypot(dx, dy) < 5) return;
    ptr.moved = true;
    const n = ptr.node && byId.get(ptr.node);
    if (n && n.parent_id !== null && editable()) {
      dragNode(e, n);
    } else {
      canvas.classList.add('panning');
      view.x = ptr.vx + dx; view.y = ptr.vy + dy;
      applyView();
    }
  });
  const endPtr = (e) => {
    if (!ptr || ptr.id !== e.pointerId) return;
    canvas.classList.remove('panning');
    const p = ptr;
    ptr = null;
    if (p.ghost) { finishDrag(p); return; }
    if (!p.moved) {
      if (p.node) select(p.node);
      else if (editing) commitEdit();
    }
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.mm-node');
    if (el && editable()) startEdit(Number(el.dataset.id));
  });

  function dragNode(e, n) {
    if (!ptr.ghost) {
      const src = world.querySelector(`.mm-node[data-id="${n.id}"]`);
      src?.classList.add('dragging');
      ptr.ghost = h('div', { class: 'mm-ghost' }, n.text || 'Topic');
      document.body.append(ptr.ghost);
    }
    ptr.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    ptr.lx = e.clientX;
    world.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    ptr.ghost.style.display = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mm-node');
    ptr.ghost.style.display = '';
    ptr.target = null;
    if (under && Number(under.dataset.id) !== n.id && !isDescendant(Number(under.dataset.id), n.id)) {
      under.classList.add('drop-target');
      ptr.target = Number(under.dataset.id);
    }
  }

  async function finishDrag(p) {
    p.ghost.remove();
    world.querySelectorAll('.dragging, .drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
    if (!p.target) return;
    const target = byId.get(p.target);
    const body = { parent_id: target.id };
    if (target.parent_id === null && S().layout === 'map') {
      const r = canvas.getBoundingClientRect();
      body.side = (p.lx ?? p.sx) < r.left + view.x ? 'left' : 'right';
    }
    await mutate(api.patch(`/mind-nodes/${p.node}`, body));
  }

  function isDescendant(id, ancestorId) {
    let cur = byId.get(id);
    while (cur && cur.parent_id !== null) {
      if (cur.parent_id === ancestorId) return true;
      cur = byId.get(cur.parent_id);
    }
    return false;
  }

  // ---------------------------------------------------------------- selection & editing

  function select(id) {
    if (editing && editing !== id) commitEdit();
    selected = id;
    world.querySelectorAll('.mm-node.selected').forEach((x) => x.classList.remove('selected'));
    world.querySelector(`.mm-node[data-id="${id}"]`)?.classList.add('selected');
    drawNodeBar();
  }

  const nodeBar = h('div', { class: 'mm-nodebar' });
  canvas.append(nodeBar);

  function drawNodeBar() {
    const n = selected && byId.get(selected);
    if (!n || !editable() || editing) { nodeBar.style.display = 'none'; return; }
    const isRoot = n.parent_id === null;
    mount(nodeBar,
      h('button', { class: 'icon-btn sm', title: 'Add sub-topic (Tab)', 'aria-label': 'Add sub-topic', onclick: () => addChild(n.id) }, icon('plus', 15)),
      !isRoot ? h('button', { class: 'icon-btn sm', title: 'Add topic below (Enter)', 'aria-label': 'Add sibling', onclick: () => addSibling(n) }, icon('arrow-right', 15)) : null,
      h('button', { class: 'icon-btn sm', title: 'Edit text (F2)', 'aria-label': 'Edit', onclick: () => startEdit(n.id) }, icon('edit', 15)),
      !isRoot ? h('button', { class: 'icon-btn sm', title: 'Color', 'aria-label': 'Color', onclick: (e) => colorMenu(e.currentTarget, n) },
        h('span', { class: 'swatch', style: { background: branchColor(n) } })) : null,
      h('button', { class: ['icon-btn', 'sm', n.note && 'active'], title: 'Note', 'aria-label': 'Note', onclick: () => editNote(n) }, icon('note', 15)),
      h('span', { class: 'mm-sep' }),
      n.task
        ? h('button', { class: 'btn btn-soft btn-sm', onclick: (e) => menu(e.currentTarget, [
          { label: `Open #${n.task.number}`, icon: 'external', onClick: () => openTask(n.task.id) },
          { label: 'Unlink task', icon: 'link', onClick: () => mutate(api.post(`/mind-nodes/${n.id}/unlink`)) },
        ]) }, icon('checklist', 13), `#${n.task.number}`)
        : h('button', { class: 'btn btn-soft btn-sm', onclick: (e) => taskMenu(e.currentTarget, n) }, icon('check-circle', 13), 'Make task'),
      !isRoot ? h('button', { class: 'icon-btn sm danger-hover', title: 'Delete (Del)', 'aria-label': 'Delete', onclick: () => remove(n) }, icon('trash', 15)) : null);
    nodeBar.style.display = 'flex';
  }

  function startEdit(id) {
    if (!editable()) return;
    const n = byId.get(id);
    const el = world.querySelector(`.mm-node[data-id="${id}"]`);
    if (!n || !el) return;
    editing = id;
    selected = id;
    drawNodeBar();
    const ta = h('textarea', { class: 'mm-edit', rows: 1, maxlength: 500, 'aria-label': 'Topic text' });
    ta.value = n.text;
    const span = el.querySelector('.mm-text');
    span.replaceWith(ta);
    el.classList.add('editing');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; ta.style.width = `${Math.min(320, Math.max(80, ta.value.length * 8 + 24))}px`; };
    grow();
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit({ then: n.parent_id === null ? 'child' : 'sibling' }); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit({ then: 'child' }); }
      else if (e.key === 'Escape') { e.preventDefault(); commitEdit(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (editing === id) commitEdit(); }, 80));
    ta.focus();
    ta.select();
  }

  async function commitEdit({ then } = {}) {
    const id = editing;
    if (!id) return;
    const ta = world.querySelector('.mm-edit');
    const n = byId.get(id);
    editing = null;
    const text = (ta?.value || '').trim();
    if (!n) return;
    if (!text && n.parent_id !== null && !n.task && !kids(n.id).length) {
      await mutate(api.del(`/mind-nodes/${id}`), byId.get(n.parent_id)?.id);
      return;
    }
    if (text && text !== n.text) {
      n.text = text;
      draw();
      try { await api.patch(`/mind-nodes/${id}`, { text }); } catch (err) { errorToast(err); }
    } else draw();
    if (then === 'child') await addChild(id);
    else if (then === 'sibling') await addSibling(n);
    else { canvas.focus({ preventScroll: true }); drawNodeBar(); }
    if (pendingRemote && !editing) { pendingRemote = false; refresh(); }
  }

  async function mutate(promise, selectAfter) {
    try {
      const res = await promise;
      await openMap(current.map.id);
      if (selectAfter && byId.has(selectAfter)) select(selectAfter);
      else drawNodeBar();
      return res;
    } catch (err) {
      errorToast(err);
      await openMap(current.map.id).catch(() => null);
      return null;
    }
  }

  async function addChild(parentId) {
    const node = await mutate(api.post(`/mindmaps/${current.map.id}/nodes`, { parent_id: parentId, text: '' }));
    if (node) { select(node.id); centerOn(byId.get(node.id), true); startEdit(node.id); }
  }

  async function addSibling(n) {
    if (n.parent_id === null) return addChild(n.id);
    const siblings = kids(n.parent_id);
    const index = siblings.findIndex((x) => x.id === n.id) + 1;
    const node = await mutate(api.post(`/mindmaps/${current.map.id}/nodes`, { parent_id: n.parent_id, text: '', index, side: n.side }));
    if (node) { select(node.id); centerOn(byId.get(node.id), true); startEdit(node.id); }
  }

  async function remove(n) {
    if (n.parent_id === null) return;
    const count = countDescendants(n.id);
    if (count && !await confirmDialog(`Delete “${n.text || 'this topic'}” and its ${count} sub-topic${count > 1 ? 's' : ''}?`, { title: 'Delete topic', confirmText: 'Delete', danger: true })) return;
    const siblings = kids(n.parent_id);
    const i = siblings.findIndex((x) => x.id === n.id);
    const next = siblings[i + 1] || siblings[i - 1] || byId.get(n.parent_id);
    await mutate(api.del(`/mind-nodes/${n.id}`), next?.id);
  }

  function countDescendants(id) {
    return kids(id).reduce((s, c) => s + 1 + countDescendants(c.id), 0);
  }

  async function toggleFold(n) {
    n.collapsed = !n.collapsed;
    draw();
    try { await api.patch(`/mind-nodes/${n.id}`, { collapsed: n.collapsed }); } catch (err) { errorToast(err); }
  }

  function colorMenu(anchor, n) {
    menu(anchor, [
      { label: 'Automatic', checked: !n.color, onClick: () => mutate(api.patch(`/mind-nodes/${n.id}`, { color: null }), n.id) },
      ...COLORS.slice(0, 10).map((c) => ({ label: c, swatch: c, checked: n.color === c, onClick: () => mutate(api.patch(`/mind-nodes/${n.id}`, { color: c }), n.id) })),
    ], { width: 180 });
  }

  function editNote(n) {
    const ta = h('textarea', { class: 'textarea', rows: 8, placeholder: 'Add details, links or ideas. Becomes the task description if you turn this topic into a task.', disabled: !editable() });
    ta.value = n.note || '';
    const dlg = openModal({
      title: `Note: ${n.text || 'Topic'}`, width: 520, content: ta,
      footer: editable() ? [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: () => { dlg.close(); mutate(api.patch(`/mind-nodes/${n.id}`, { note: ta.value }), n.id); } }, 'Save')] : null,
    });
    setTimeout(() => ta.focus(), 30);
  }

  async function taskMenu(anchor, n) {
    if (!state.board.sections.length) {
      if (!can('admin')) { toast('Ask a project admin to add a board, then topics can become tasks.'); return; }
      const added = await addBoardDialog();
      if (!added) return;
    }
    const childCount = kids(n.id).filter((c) => !c.task && c.text).length;
    menu(anchor, [
      { header: 'Turn into tasks' },
      { label: 'This topic', icon: 'check-circle', onClick: () => sectionMenu(anchor, 'single', n) },
      childCount ? { label: 'This topic, sub-topics as checklist', icon: 'checklist', onClick: () => sectionMenu(anchor, 'checklist', n) } : null,
      childCount ? { label: `Each sub-topic (${childCount})`, icon: 'layers', onClick: () => sectionMenu(anchor, 'children', n) } : null,
    ].filter(Boolean), { width: 280 });
  }

  function sectionMenu(anchor, mode, n) {
    setTimeout(() => menu(anchor, [
      { header: 'Add to section' },
      ...state.board.sections.map((s) => ({
        label: s.name, swatch: s.color, onClick: async () => {
          const res = await mutate(api.post(`/mind-nodes/${n.id}/to-task`, { section_id: s.id, mode }), n.id);
          if (res) {
            const c = res.created;
            toast(c.length === 1 ? `Created task #${c[0].number}` : `Created ${c.length} tasks in ${s.name}`, 'success',
              c.length === 1 ? { action: { label: 'Open', onClick: () => openTask(c[0].id) } } : {});
          }
        },
      })),
    ], { width: 240 }), 0);
  }

  // ---------------------------------------------------------------- keyboard

  canvas.addEventListener('keydown', (e) => {
    if (!current || editing || e.target !== canvas) return;
    const n = byId.get(selected);
    const k = e.key;
    if ((k === '+' || k === '=') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomBy(1.2); return; }
    if (k === '-' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (!n) { if (k.startsWith('Arrow') || k === 'Enter') { select(rootNode().id); e.preventDefault(); } return; }
    const ed = editable();
    if (k === 'Tab' && ed) { e.preventDefault(); addChild(n.id); }
    else if (k === 'Enter' && ed) { e.preventDefault(); addSibling(n); }
    else if ((k === 'F2' || (k === 'e' && !e.metaKey)) && ed) { e.preventDefault(); startEdit(n.id); }
    else if ((k === 'Delete' || k === 'Backspace') && ed) { e.preventDefault(); remove(n); }
    else if (k === ' ' && kids(n.id).length && n.parent_id !== null) { e.preventDefault(); toggleFold(n); }
    else if (k.startsWith('Arrow')) { e.preventDefault(); navigateKey(n, k); }
    else if (ed && k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(k)) {
      // start typing to replace the text, like in desktop mind map tools
      e.preventDefault();
      startEdit(n.id);
      const ta = world.querySelector('.mm-edit');
      if (ta) { ta.value = k; ta.dispatchEvent(new Event('input')); }
    }
  });

  function navigateKey(n, key) {
    const kind = S().layout;
    if (kind === 'map') return navigateBalanced(n, key);
    const isRoot = n.parent_id === null;
    // per layout: which arrow goes to the first child / the parent / previous & next sibling
    const keys = {
      logic: { child: 'ArrowRight', parent: 'ArrowLeft', prev: 'ArrowUp', next: 'ArrowDown' },
      radial: { child: 'ArrowRight', parent: 'ArrowLeft', prev: 'ArrowUp', next: 'ArrowDown' },
      org: { child: 'ArrowDown', parent: 'ArrowUp', prev: 'ArrowLeft', next: 'ArrowRight' },
      tree: { child: 'ArrowRight', parent: 'ArrowLeft', prev: 'ArrowUp', next: 'ArrowDown' },
    }[kind];
    let target = null;
    if (key === keys.child) {
      if (n.collapsed && !isRoot) { toggleFold(n); return; }
      target = visibleKids(n)[0];
    } else if (key === keys.parent) {
      target = isRoot ? null : byId.get(n.parent_id);
    } else if (kind === 'tree') {
      // the tree reads top to bottom, so up/down walk the visible outline
      const i = order.findIndex((x) => x.id === n.id);
      target = order[i + (key === keys.prev ? -1 : 1)];
    } else if (!isRoot) {
      const sib = kids(n.parent_id);
      const i = sib.findIndex((x) => x.id === n.id);
      target = sib[i + (key === keys.prev ? -1 : 1)];
    }
    if (target) { select(target.id); centerOn(target, true); }
  }

  function navigateBalanced(n, key) {
    const isRoot = n.parent_id === null;
    const side = isRoot ? null : sideOf(n);
    let target = null;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (isRoot) return;
      const sib = kids(n.parent_id).filter((x) => n.parent_id !== rootNode().id || (x.side || 'right') === (n.side || 'right'));
      const i = sib.findIndex((x) => x.id === n.id);
      target = sib[i + (key === 'ArrowUp' ? -1 : 1)];
    } else {
      const dir = key === 'ArrowRight' ? 'right' : 'left';
      if (isRoot) target = kids(n.id).find((c) => (c.side || 'right') === dir);
      else if (dir === side) {
        if (n.collapsed) { toggleFold(n); return; }
        target = kids(n.id)[0];
      } else target = byId.get(n.parent_id);
    }
    if (target) { select(target.id); centerOn(target, true); }
  }

  function sideOf(n) {
    let cur = n;
    while (byId.get(cur.parent_id)?.parent_id !== null) cur = byId.get(cur.parent_id);
    return cur.side || 'right';
  }

  // ---------------------------------------------------------------- live updates

  const offs = [
    on('ws', (msg) => {
      if (msg.project_id !== projectId || msg.actor_id === state.user.id) return;
      if (msg.type === 'mindmap.changed') {
        if (msg.data.map_id === current?.map.id && msg.data.deleted) { toast('This mind map was deleted'); current = null; loadMaps(); return; }
        if (msg.data.map_id === current?.map.id) refresh();
        else api.get(`/projects/${projectId}/mindmaps`).then((m) => { maps = m; drawToolbar(); }).catch(() => null);
      }
    }),
    on('board', () => {
      // task status/assignee changes show up on linked topics
      if (!current || editing) return;
      const linked = current.nodes.filter((n) => n.task);
      const changed = linked.some((n) => {
        const t = state.board.tasks.find((x) => x.id === n.task.id);
        return !t || t.status !== n.task.status || t.title !== n.task.title || t.assignee_id !== (n.task.assignee?.id ?? null);
      });
      if (changed) refresh();
    }),
  ];
  const onResize = debounce(() => current && applyView(), 100);
  window.addEventListener('resize', onResize);

  await loadMaps();
  canvas.focus({ preventScroll: true });
  drawNodeBar();

  return () => {
    offs.forEach((off) => off());
    window.removeEventListener('resize', onResize);
    shell.cleanup();
    document.querySelectorAll('.mm-ghost').forEach((g) => g.remove());
  };
}
