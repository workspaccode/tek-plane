// Mind map layout engine: node positions + branch paths for 15 layouts. Pure geometry, no DOM.
//
// layout(root, children, size, opts) → Map(id → pos) with an `extras` array (spines, braces)
//   children(node) → visible child nodes (already respects collapsed state)
//   size(id) → { w, h } measured node box
//   opts: { layout, spacingX, spacingY }
// pos: { x, y, w, h, depth, side, link, fold, dir?, angle?, r?, attach?, rib?, fromRoot? }
//   link: how the branch *into* this node is drawn (h | v | tree | radial | axis | spine | bone | rib | straight | none)
//   fold: where its expand/collapse toggle sits (left | right | below | above | outward)
// branchPath(lines, parentPos, childPos, { underline, prev }) → SVG path "d"

export const LAYOUTS = {
  map: { label: 'Mind Map', hint: 'Balanced on both sides of the central topic', group: 'Maps' },
  logic: { label: 'Logic Chart', hint: 'Everything flows to the right', group: 'Maps' },
  left: { label: 'Left Logic', hint: 'Everything flows to the left', group: 'Maps' },
  vmap: { label: 'Vertical Map', hint: 'Balanced above and below the centre', group: 'Maps' },
  radial: { label: 'Radial', hint: 'Topics in rings around the centre', group: 'Maps' },
  bubble: { label: 'Bubble Map', hint: 'Circles clustered around their parent', group: 'Maps' },
  org: { label: 'Org Chart', hint: 'Top-down hierarchy', group: 'Charts' },
  orgup: { label: 'Org Chart Up', hint: 'Bottom-up hierarchy', group: 'Charts' },
  brace: { label: 'Brace Map', hint: 'Curly braces group the parts of each topic', group: 'Charts' },
  fishbone: { label: 'Fishbone', hint: 'Cause and effect (Ishikawa)', group: 'Charts' },
  timeline: { label: 'Timeline', hint: 'Main branches along a horizontal axis', group: 'Charts' },
  vtimeline: { label: 'Vertical Timeline', hint: 'A spine with branches left and right', group: 'Charts' },
  tree: { label: 'Tree', hint: 'Indented outline, like folders', group: 'Lists' },
  columns: { label: 'Columns', hint: 'Main branches as columns, like a board', group: 'Lists' },
  outline: { label: 'Outline', hint: 'Numbered document: 1, 1.1, 1.1.1', group: 'Lists' },
};

export const PALETTES = {
  vibrant: { label: 'Vibrant', colors: ['#3d6bff', '#e64a9e', '#2fb67c', '#f57c3a', '#9b6bff', '#00a3bf', '#f5a623', '#ef5350'] },
  pastel: { label: 'Pastel', colors: ['#8fb3ff', '#f7a8cc', '#93dcb9', '#ffbf8f', '#c3b1ff', '#86d8e6', '#ffd97a', '#ff9e9e'] },
  ocean: { label: 'Ocean', colors: ['#0b6bcb', '#0096c7', '#2a9d8f', '#3a86ff', '#4361ee', '#00b4d8', '#1d7874', '#5e60ce'] },
  sunset: { label: 'Sunset', colors: ['#ef476f', '#f78c6b', '#e09f3e', '#d62828', '#c44569', '#f3722c', '#9e2a2b', '#e76f51'] },
  mono: { label: 'Mono', colors: ['#5b6578'] },
};

export const DEFAULT_SETTINGS = {
  layout: 'map',
  lines: 'curved',
  shape: 'rounded',
  palette: 'vibrant',
  background: 'dots',
  spacing_x: 56,
  spacing_y: 12,
  font_scale: 1,
  line_width: 3,
  show_tasks: true,
  show_notes: true,
};

/** Arrow-key scheme per layout: which key goes to first child / parent / previous / next sibling. */
export function keyScheme(kind, pos) {
  const H = { child: 'ArrowRight', parent: 'ArrowLeft', prev: 'ArrowUp', next: 'ArrowDown' };
  const L = { child: 'ArrowLeft', parent: 'ArrowRight', prev: 'ArrowUp', next: 'ArrowDown' };
  const D = { child: 'ArrowDown', parent: 'ArrowUp', prev: 'ArrowLeft', next: 'ArrowRight' };
  const U = { child: 'ArrowUp', parent: 'ArrowDown', prev: 'ArrowLeft', next: 'ArrowRight' };
  switch (kind) {
    case 'left': case 'fishbone': return L;
    case 'org': return D;
    case 'orgup': return U;
    case 'vmap': return pos?.side === 'up' ? U : D;
    case 'vtimeline': return pos?.side === 'left' ? L : H;
    case 'timeline': return pos?.dir === 'up' ? U : D;
    case 'tree': case 'outline': case 'columns': return { ...H, linear: true };
    default: return H;
  }
}

/** Readable text color (white or near-black) on top of a hex color. */
export function inkFor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.42 ? '#1f2430' : '#fff';
}

const cx = (p) => p.x + p.w / 2;
const cy = (p) => p.y + p.h / 2;

// ------------------------------------------------------------------ entry

export function layout(root, children, size, opts) {
  const fn = {
    map: layoutMap, logic: layoutLogic, left: layoutLeft, vmap: layoutVMap, radial: layoutRadial, bubble: layoutBubble,
    org: (r, c, s, o) => layoutVertical(r, c, s, o, 'down'), orgup: (r, c, s, o) => layoutVertical(r, c, s, o, 'up'),
    brace: layoutBrace, fishbone: layoutFishbone, timeline: layoutTimeline, vtimeline: layoutVTimeline,
    tree: layoutTree, columns: layoutColumns, outline: layoutTree,
  }[opts.layout] || layoutMap;
  const pos = fn(root, children, size, opts);
  pos.extras = pos.extras || [];
  return pos;
}

// ------------------------------------------------------------------ building blocks

/** Horizontal sub-trees (children to the right or left of their parent). */
function hEngine(children, size, HG, VG, pos) {
  const memo = new Map();
  const subtreeH = (n) => {
    if (memo.has(n.id)) return memo.get(n.id);
    const ch = children(n);
    const own = size(n.id).h;
    const v = ch.length ? Math.max(own, ch.reduce((s, c) => s + subtreeH(c), 0) + VG * (ch.length - 1)) : own;
    memo.set(n.id, v);
    return v;
  };
  const place = (n, side, edgeX, top, depth) => {
    const sz = size(n.id);
    const mid = top + subtreeH(n) / 2;
    const x = side === 'right' ? edgeX : edgeX - sz.w;
    pos.set(n.id, { x, y: mid - sz.h / 2, w: sz.w, h: sz.h, side, depth, link: 'h', fold: side });
    const ch = children(n);
    if (!ch.length) return;
    const total = ch.reduce((s, c) => s + subtreeH(c), 0) + VG * (ch.length - 1);
    let y = mid - total / 2;
    const next = side === 'right' ? x + sz.w + HG : x - HG;
    for (const c of ch) { place(c, side, next, y, depth + 1); y += subtreeH(c) + VG; }
  };
  return { subtreeH, place };
}

function rootPos(size, root, x, y) {
  const rs = size(root.id);
  return { x: x ?? -rs.w / 2, y: y ?? -rs.h / 2, w: rs.w, h: rs.h, side: 'root', depth: 0, link: 'none' };
}

function horizontal(root, children, size, opts, sideOf, fromRoot) {
  const pos = new Map();
  const eng = hEngine(children, size, opts.spacingX, opts.spacingY, pos);
  const rp = rootPos(size, root);
  pos.set(root.id, rp);
  for (const side of ['right', 'left']) {
    const ch = children(root).filter((c) => sideOf(c) === side);
    if (!ch.length) continue;
    const gap = opts.spacingY * 2;
    const total = ch.reduce((s, c) => s + eng.subtreeH(c), 0) + gap * (ch.length - 1);
    let y = -total / 2;
    const edge = side === 'right' ? rp.w / 2 + opts.spacingX * 1.3 : -rp.w / 2 - opts.spacingX * 1.3;
    for (const c of ch) {
      eng.place(c, side, edge, y, 1);
      pos.get(c.id).fromRoot = fromRoot;
      y += eng.subtreeH(c) + gap;
    }
  }
  return pos;
}

const layoutMap = (r, c, s, o) => horizontal(r, c, s, o, (n) => n.side || 'right', 'center');
const layoutLogic = (r, c, s, o) => horizontal(r, c, s, o, () => 'right', 'edge');
const layoutLeft = (r, c, s, o) => horizontal(r, c, s, o, () => 'left', 'edge');

/** One direction of a top-down (or bottom-up) hierarchy; rows share a baseline per depth. */
function vHalf(rp, kids, children, size, opts, dir, pos) {
  if (!kids.length) return;
  const gapX = 14 + opts.spacingX * 0.35;
  const gapY = 26 + opts.spacingY * 2.2;
  const rowH = [];
  const measure = (n, d) => {
    rowH[d] = Math.max(rowH[d] || 0, size(n.id).h);
    children(n).forEach((c) => measure(c, d + 1));
  };
  kids.forEach((k) => measure(k, 1));
  const rowTop = [];
  if (dir === 'down') {
    let y = rp.y + rp.h + gapY;
    for (let d = 1; d < rowH.length; d++) { rowTop[d] = y; y += rowH[d] + gapY; }
  } else {
    let y = rp.y - gapY;
    for (let d = 1; d < rowH.length; d++) { rowTop[d] = y - rowH[d]; y = rowTop[d] - gapY; }
  }
  const memo = new Map();
  const subtreeW = (n) => {
    if (memo.has(n.id)) return memo.get(n.id);
    const ch = children(n);
    const own = size(n.id).w;
    const v = ch.length ? Math.max(own, ch.reduce((s, c) => s + subtreeW(c), 0) + gapX * (ch.length - 1)) : own;
    memo.set(n.id, v);
    return v;
  };
  const place = (n, left, d) => {
    const sz = size(n.id);
    const center = left + subtreeW(n) / 2;
    pos.set(n.id, { x: center - sz.w / 2, y: rowTop[d] + (rowH[d] - sz.h) / 2, w: sz.w, h: sz.h, side: dir, depth: d,
      link: 'v', fold: dir === 'down' ? 'below' : 'above' });
    const ch = children(n);
    const total = ch.reduce((s, c) => s + subtreeW(c), 0) + gapX * Math.max(0, ch.length - 1);
    let x = center - total / 2;
    for (const c of ch) { place(c, x, d + 1); x += subtreeW(c) + gapX; }
  };
  const total = kids.reduce((s, c) => s + subtreeW(c), 0) + gapX * (kids.length - 1);
  let x = cx(rp) - total / 2;
  for (const k of kids) { place(k, x, 1); x += subtreeW(k) + gapX; }
}

function layoutVertical(root, children, size, opts, dir) {
  const pos = new Map();
  const rp = rootPos(size, root);
  pos.set(root.id, rp);
  vHalf(rp, children(root), children, size, opts, dir, pos);
  return pos;
}

function layoutVMap(root, children, size, opts) {
  const pos = new Map();
  const rp = rootPos(size, root);
  pos.set(root.id, rp);
  const kids = children(root);
  vHalf(rp, kids.filter((k) => (k.side || 'right') === 'right'), children, size, opts, 'down', pos);
  vHalf(rp, kids.filter((k) => k.side === 'left'), children, size, opts, 'up', pos);
  return pos;
}

// ------------------------------------------------------------------ lists

function layoutTree(root, children, size, opts) {
  const indent = 22 + opts.spacingX * 0.45;
  const gapY = 4 + opts.spacingY * 0.7;
  const pos = new Map();
  let y = 0;
  const place = (n, d) => {
    const sz = size(n.id);
    pos.set(n.id, { x: d * indent, y, w: sz.w, h: sz.h, side: 'right', depth: d, link: d ? 'tree' : 'none', fold: 'left' });
    y += sz.h + gapY;
    children(n).forEach((c) => place(c, d + 1));
  };
  place(root, 0);
  return pos;
}

function layoutColumns(root, children, size, opts) {
  const pos = new Map();
  const indent = 18 + opts.spacingX * 0.3;
  const gapY = 4 + opts.spacingY * 0.6;
  const colGap = 18 + opts.spacingX * 0.5;
  const headGap = 26 + opts.spacingY * 2;
  const rp = rootPos(size, root, undefined, 0);
  pos.set(root.id, rp);
  const cols = children(root).map((hd) => {
    const items = [];
    const walk = (n, d) => children(n).forEach((c) => { items.push([c, d]); walk(c, d + 1); });
    walk(hd, 1);
    const width = Math.max(size(hd.id).w, ...items.map(([n, d]) => d * indent + size(n.id).w));
    return { hd, items, width };
  });
  const total = cols.reduce((s, c) => s + c.width, 0) + colGap * Math.max(0, cols.length - 1);
  const headTop = rp.y + rp.h + headGap;
  let x = -total / 2;
  for (const col of cols) {
    const hs = size(col.hd.id);
    const hp = { x, y: headTop, w: hs.w, h: hs.h, side: 'down', depth: 1, link: 'v', fold: 'left' };
    pos.set(col.hd.id, hp);
    let y = headTop + hs.h + gapY * 2;
    const place = (n, d) => children(n).forEach((c) => {
      const sz = size(c.id);
      pos.set(c.id, { x: x + d * indent, y, w: sz.w, h: sz.h, side: 'right', depth: d + 1, link: 'tree', fold: 'left' });
      y += sz.h + gapY;
      place(c, d + 1);
    });
    place(col.hd, 1);
    x += col.width + colGap;
  }
  return pos;
}

// ------------------------------------------------------------------ charts

function bracePath(x0, y0, childX, top, bot) {
  const tip = x0 + 6;
  if (bot - top < 2) return `M${x0},${y0} L${childX - 4},${top}`;
  const span = Math.max(8, childX - 6 - tip);
  const xm = tip + span / 2; const xr = tip + span;
  const ym = (top + bot) / 2;
  const r = Math.min(10, (bot - top) / 4);
  return `M${x0},${y0} L${tip},${ym} M${xr},${top} Q${xm},${top} ${xm},${top + r} L${xm},${ym - r} Q${xm},${ym} ${tip},${ym}`
    + ` Q${xm},${ym} ${xm},${ym + r} L${xm},${bot - r} Q${xm},${bot} ${xr},${bot}`;
}

function layoutBrace(root, children, size, opts) {
  const HG = Math.max(40, opts.spacingX);
  const pos = new Map();
  const eng = hEngine(children, size, HG, opts.spacingY, pos);
  const rp = rootPos(size, root, -size(root.id).w);
  pos.set(root.id, rp);
  const kids = children(root);
  const total = kids.reduce((s, c) => s + eng.subtreeH(c), 0) + opts.spacingY * Math.max(0, kids.length - 1);
  let y = -total / 2;
  for (const k of kids) { eng.place(k, 'right', HG, y, 1); y += eng.subtreeH(k) + opts.spacingY; }
  // one brace per parent groups its children, instead of individual lines
  for (const p of pos.values()) p.link = 'none';
  pos.extras = [];
  const walk = (n) => {
    const ch = children(n);
    if (!ch.length) return;
    const P = pos.get(n.id);
    const ys = ch.map((c) => cy(pos.get(c.id)));
    pos.extras.push({ d: bracePath(P.x + P.w, cy(P), pos.get(ch[0].id).x, Math.min(...ys), Math.max(...ys)),
      colorOf: n.parent_id === null ? null : n.id });
    ch.forEach(walk);
  };
  walk(root);
  return pos;
}

function layoutTimeline(root, children, size, opts) {
  const pos = new Map();
  const indent = 18 + opts.spacingX * 0.3;
  const gapY = 6 + opts.spacingY * 0.6;
  const colGap = 22 + opts.spacingX * 0.6;
  const rp = rootPos(size, root, -size(root.id).w);
  pos.set(root.id, rp);
  let x = opts.spacingX * 0.8;
  children(root).forEach((hd, i) => {
    const dir = i % 2 === 0 ? 'down' : 'up';
    const hs = size(hd.id);
    pos.set(hd.id, { x, y: -hs.h / 2, w: hs.w, h: hs.h, side: 'right', depth: 1, link: 'axis', dir,
      fold: dir === 'down' ? 'below' : 'above' });
    let right = x + hs.w;
    let yc = dir === 'down' ? hs.h / 2 + gapY * 2 : -hs.h / 2 - gapY * 2;
    const walk = (n) => children(n).forEach((c) => {
      const sz = size(c.id);
      const parent = pos.get(n.id);
      const px = parent.x + indent;
      let y;
      if (dir === 'down') { y = yc; yc += sz.h + gapY; } else { y = yc - sz.h; yc = y - gapY; }
      pos.set(c.id, { x: px, y, w: sz.w, h: sz.h, side: 'right', depth: parent.depth + 1, link: 'tree', dir, fold: 'left' });
      right = Math.max(right, px + sz.w);
      walk(c);
    });
    walk(hd);
    x = right + colGap;
  });
  pos.extras = [{ d: `M${rp.x + rp.w},0 L${x - colGap + 24},0`, colorOf: null, width: 1.3 }];
  return pos;
}

function layoutVTimeline(root, children, size, opts) {
  const pos = new Map();
  const eng = hEngine(children, size, opts.spacingX, opts.spacingY, pos);
  const rs = size(root.id);
  const rp = rootPos(size, root, -rs.w / 2, -rs.h - 26);
  pos.set(root.id, rp);
  const spineGap = 24 + opts.spacingX * 0.5;
  let y = 8;
  children(root).forEach((k, i) => {
    const side = i % 2 === 0 ? 'right' : 'left';
    eng.place(k, side, side === 'right' ? spineGap : -spineGap, y, 1);
    pos.get(k.id).link = 'spine';
    y += eng.subtreeH(k) + 16 + opts.spacingY * 1.5;
  });
  pos.extras = [{ d: `M0,${rp.y + rp.h} L0,${y + 10}`, colorOf: null, width: 1.2 }];
  return pos;
}

function layoutFishbone(root, children, size, opts) {
  const pos = new Map();
  const eng = hEngine(children, size, Math.max(24, opts.spacingX * 0.6), opts.spacingY, pos);
  pos.set(root.id, rootPos(size, root, 0));
  const COT = 1 / Math.tan(Math.PI / 3); // bones lean back at 60°
  const ribGap = 8 + opts.spacingY;
  let attach = -36 - opts.spacingX * 0.4;
  const bones = children(root);
  const subtreeIds = (n, out = []) => { out.push(n.id); children(n).forEach((c) => subtreeIds(c, out)); return out; };
  for (let i = 0; i < bones.length; i += 2) {
    let minX = attach;
    bones.slice(i, i + 2).forEach((b, j) => {
      const up = j === 0;
      const ribs = children(b);
      const extent = Math.max(46, ribs.reduce((s, r) => s + eng.subtreeH(r), 0) + ribGap * Math.max(0, ribs.length - 1) + 36);
      const endX = attach - extent * COT;
      const bs = size(b.id);
      pos.set(b.id, { x: endX - bs.w / 2, y: up ? -extent - 6 - bs.h : extent + 6, w: bs.w, h: bs.h, side: up ? 'up' : 'down',
        depth: 1, link: 'bone', attach: { x: attach, y: 0 }, fold: up ? 'above' : 'below' });
      // ribs: from the bone's far end inward, each sticking out to the left
      let v = extent - 18;
      for (const r of ribs) {
        const hgt = eng.subtreeH(r);
        const mid = v - hgt / 2;
        const bx = attach - mid * COT;
        const yMid = up ? -mid : mid;
        eng.place(r, 'left', bx - 14, yMid - hgt / 2, 2);
        Object.assign(pos.get(r.id), { link: 'rib', rib: { x: bx, y: yMid } });
        v -= hgt + ribGap;
      }
      for (const id of subtreeIds(b)) minX = Math.min(minX, pos.get(id).x);
    });
    attach = minX - 40 - opts.spacingX * 0.5;
  }
  const tail = bones.length ? attach + 30 : -60;
  pos.extras = [{ d: `M${tail},0 L0,0`, colorOf: null, width: 1.8 }];
  return pos;
}

// ------------------------------------------------------------------ circular

function layoutRadial(root, children, size, opts) {
  const pos = new Map();
  const leaves = new Map();
  const maxDiag = [];
  let maxDepth = 0;
  const count = (n, d) => {
    maxDepth = Math.max(maxDepth, d);
    const sz = size(n.id);
    maxDiag[d] = Math.max(maxDiag[d] || 0, Math.hypot(sz.w, sz.h));
    const ch = children(n);
    const v = ch.length ? ch.reduce((s, c) => s + count(c, d + 1), 0) : 1;
    leaves.set(n.id, v);
    return v;
  };
  count(root, 0);
  const radius = [0];
  for (let d = 1; d <= maxDepth; d++) {
    radius[d] = radius[d - 1] + Math.max(110, (maxDiag[d - 1] + maxDiag[d]) * 0.42 + opts.spacingX * 0.9);
  }
  const needed = (leaves.get(root.id) * (34 + opts.spacingY + 8)) / (2 * Math.PI);
  if (maxDepth && radius[maxDepth] < needed) {
    const f = needed / radius[maxDepth];
    for (let d = 1; d <= maxDepth; d++) radius[d] *= f;
  }
  const assign = (n, a0, a1, d) => {
    const sz = size(n.id);
    const a = (a0 + a1) / 2;
    const r = radius[d];
    const x0 = d ? r * Math.cos(a) : 0;
    const y0 = d ? r * Math.sin(a) : 0;
    pos.set(n.id, { x: x0 - sz.w / 2, y: y0 - sz.h / 2, w: sz.w, h: sz.h, side: Math.cos(a) >= 0 ? 'right' : 'left',
      depth: d, angle: a, r, link: d ? 'radial' : 'none', fold: 'outward' });
    const ch = children(n);
    const total = ch.reduce((s, c) => s + leaves.get(c.id), 0);
    let start = a0;
    for (const c of ch) {
      const span = ((a1 - a0) * leaves.get(c.id)) / total;
      assign(c, start, start + span, d + 1);
      start += span;
    }
  };
  assign(root, -Math.PI / 2, (3 * Math.PI) / 2, 0);
  return pos;
}

function layoutBubble(root, children, size, opts) {
  const pos = new Map();
  const R = (id) => Math.max(size(id).w, size(id).h) / 2;
  const put = (n, x0, y0, depth, angle) => {
    const sz = size(n.id);
    pos.set(n.id, { x: x0 - sz.w / 2, y: y0 - sz.h / 2, w: sz.w, h: sz.h, depth, angle, r: Math.hypot(x0, y0),
      side: Math.cos(angle) >= 0 ? 'right' : 'left', link: depth ? 'straight' : 'none', fold: 'outward' });
  };
  const leafCount = (n) => { const ch = children(n); return ch.length ? ch.reduce((s, c) => s + leafCount(c), 0) : 1; };
  function around(n, angle, depth, room) {
    const ch = children(n);
    if (!ch.length) return;
    const P = pos.get(n.id);
    const spread = Math.min(room * 0.9, Math.max(0.6, ch.length * 0.55), 2.6);
    const need = ch.reduce((s, c) => s + 2 * R(c.id) + 10, 0);
    const maxR = Math.max(...ch.map((c) => R(c.id)));
    const dist = Math.max(R(n.id) + maxR + 14 + opts.spacingX * 0.3, need / Math.max(spread, 0.6));
    ch.forEach((c, j) => {
      const t = ch.length === 1 ? 0 : -spread / 2 + (spread * j) / (ch.length - 1);
      const ang = angle + t;
      put(c, cx(P) + dist * Math.cos(ang), cy(P) + dist * Math.sin(ang), depth, ang);
      around(c, ang, depth + 1, spread / Math.max(1, ch.length) + 0.6);
    });
  }
  put(root, 0, 0, 0, 0);
  const kids = children(root);
  const maxKid = Math.max(0, ...kids.map((k) => R(k.id)));
  const ring = Math.max(R(root.id) + maxKid + 26 + opts.spacingX * 0.6,
    kids.reduce((s, k) => s + 2 * R(k.id) + 14, 0) / (2 * Math.PI));
  const weights = kids.map(leafCount);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let a = -Math.PI / 2;
  kids.forEach((k, i) => {
    const span = (2 * Math.PI * weights[i]) / sum;
    const mid = a + span / 2;
    put(k, ring * Math.cos(mid), ring * Math.sin(mid), 1, mid);
    around(k, mid, 2, span);
    a += span;
  });
  return pos;
}

// ------------------------------------------------------------------ branches

function elbowH(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  const r = Math.min(10, Math.abs(y2 - y1) / 2, Math.abs(mx - x1));
  if (r < 1) return `M${x1},${y1} L${x2},${y2}`;
  const sx = Math.sign(x2 - x1) || 1;
  const sy = Math.sign(y2 - y1) || 1;
  return `M${x1},${y1} H${mx - sx * r} Q${mx},${y1} ${mx},${y1 + sy * r} V${y2 - sy * r} Q${mx},${y2} ${mx + sx * r},${y2} H${x2}`;
}

function elbowV(x1, y1, x2, y2) {
  const my = (y1 + y2) / 2;
  const r = Math.min(10, Math.abs(x2 - x1) / 2, Math.abs(my - y1));
  if (r < 1) return `M${x1},${y1} L${x2},${y2}`;
  const sx = Math.sign(x2 - x1) || 1;
  const sy = Math.sign(y2 - y1) || 1;
  return `M${x1},${y1} V${my - sy * r} Q${x1},${my} ${x1 + sx * r},${my} H${x2 - sx * r} Q${x2},${my} ${x2},${my + sy * r} V${y2}`;
}

/** Vertical stem then horizontal into the child (tree style), going up or down. */
function stem(x1, y1, x2, y2, lines) {
  if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
  const sy = Math.sign(y2 - y1) || 1;
  const r = Math.min(lines === 'curved' ? 14 : 6, Math.abs(y2 - y1), Math.abs(x2 - x1));
  return `M${x1},${y1} V${y2 - sy * r} Q${x1},${y2} ${x1 + r},${y2} H${x2}`;
}

export function branchPath(lines, P, C, { underline = false, prev = null } = {}) {
  const uy = (p) => (underline && p.depth ? p.y + p.h : cy(p)); // underline shape: anchor on the bottom edge
  switch (C.link) {
    case 'none':
      return '';
    case 'v': {
      const up = C.side === 'up';
      const x1 = cx(P); const y1 = up ? P.y : P.y + P.h; const x2 = cx(C); const y2 = up ? C.y + C.h : C.y;
      if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
      if (lines === 'elbow') return elbowV(x1, y1, x2, y2);
      const my = (y1 + y2) / 2;
      return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    case 'tree': {
      const up = C.dir === 'up';
      const x1 = P.x + Math.min(16, P.w / 2);
      const y1 = prev ? uy(prev) : up ? P.y : P.y + P.h;
      return stem(x1, y1, C.x, uy(C), lines);
    }
    case 'axis': {
      const x1 = prev ? prev.x + prev.w : P.x + P.w;
      return `M${x1},${cy(C)} L${C.x},${cy(C)}`;
    }
    case 'spine': {
      const y1 = prev ? cy(prev) : P.y + P.h;
      const x2 = C.side === 'left' ? C.x + C.w : C.x;
      const y2 = uy(C);
      if (lines === 'straight') return `M0,${y1} L0,${y2} L${x2},${y2}`;
      const r = Math.min(12, Math.abs(y2 - y1), Math.abs(x2));
      const sx = Math.sign(x2) || 1;
      return `M0,${y1} V${y2 - r} Q0,${y2} ${sx * r},${y2} H${x2}`;
    }
    case 'bone':
      return `M${C.attach.x},${C.attach.y} L${cx(C)},${C.side === 'up' ? C.y + C.h : C.y}`;
    case 'rib':
      return `M${C.rib.x},${C.rib.y} L${C.x + C.w + 4},${uy(C)}`;
    case 'straight':
      return `M${cx(P)},${cy(P)} L${cx(C)},${cy(C)}`;
    case 'radial': {
      const x1 = cx(P); const y1 = cy(P); const x2 = cx(C); const y2 = cy(C);
      if (lines === 'straight' || !P.depth) return `M${x1},${y1} L${x2},${y2}`;
      if (lines === 'elbow') {
        return `M${x1},${y1} L${P.r * Math.cos(C.angle)},${P.r * Math.sin(C.angle)} L${x2},${y2}`;
      }
      const mid = (P.r + C.r) / 2;
      return `M${x1},${y1} C${mid * Math.cos(P.angle)},${mid * Math.sin(P.angle)} ${mid * Math.cos(C.angle)},${mid * Math.sin(C.angle)} ${x2},${y2}`;
    }
    default: { // 'h': horizontal branches (map, logic, left, vertical timeline, fishbone details)
      const right = C.side !== 'left';
      let x1;
      if (P.side === 'root') x1 = C.fromRoot === 'center' ? cx(P) : right ? P.x + P.w : P.x;
      else x1 = right ? P.x + P.w : P.x;
      const y1 = P.side === 'root' ? cy(P) : uy(P);
      const x2 = right ? C.x : C.x + C.w;
      const y2 = uy(C);
      if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
      if (lines === 'elbow') return elbowH(x1, y1, x2, y2);
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
  }
}

/** Where to draw a node's fold toggle (top-left of an 18px circle). */
export function foldPoint(p) {
  switch (p.fold) {
    case 'below': return { x: cx(p) - 9, y: p.y + p.h + 3 };
    case 'above': return { x: cx(p) - 9, y: p.y - 21 };
    case 'left': return { x: p.x - 22, y: cy(p) - 9 };
    case 'outward': {
      const a = p.angle || 0;
      const d = Math.abs(Math.cos(a)) * (p.w / 2) + Math.abs(Math.sin(a)) * (p.h / 2) + 10;
      return { x: cx(p) + Math.cos(a) * d - 9, y: cy(p) + Math.sin(a) * d - 9 };
    }
    default: return { x: p.side === 'left' ? p.x - 24 : p.x + p.w + 6, y: cy(p) - 9 };
  }
}

// ------------------------------------------------------------------ pictograms

const GLYPHS = {
  map: '<rect x="8.5" y="9.5" width="7" height="5" rx="1.6"/><path d="M8.5 12H5.5M15.5 12h3M5.5 6.5v11M18.5 6.5v11M5.5 6.5H2.5M5.5 17.5H2.5M18.5 6.5h3M18.5 17.5h3"/>',
  logic: '<rect x="2" y="9.5" width="6" height="5" rx="1.5"/><path d="M8 12h3M11 5.5v13M11 5.5h3M11 12h3M11 18.5h3"/><rect x="14" y="4" width="7.5" height="3" rx="1"/><rect x="14" y="10.5" width="7.5" height="3" rx="1"/><rect x="14" y="17" width="7.5" height="3" rx="1"/>',
  left: '<rect x="16" y="9.5" width="6" height="5" rx="1.5"/><path d="M16 12h-3M13 5.5v13M13 5.5h-3M13 12h-3M13 18.5h-3"/><rect x="2.5" y="4" width="7.5" height="3" rx="1"/><rect x="2.5" y="10.5" width="7.5" height="3" rx="1"/><rect x="2.5" y="17" width="7.5" height="3" rx="1"/>',
  vmap: '<rect x="8.5" y="9.5" width="7" height="5" rx="1.6"/><path d="M12 9.5V6.5M12 14.5v3M6 6.5h12M6 17.5h12M6 6.5V3.5M18 6.5V3.5M6 17.5v3M18 17.5v3"/>',
  radial: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="3.5" r="1.8"/><circle cx="20" cy="9" r="1.8"/><circle cx="17" cy="19.5" r="1.8"/><circle cx="7" cy="19.5" r="1.8"/><circle cx="4" cy="9" r="1.8"/><path d="M12 9V5.3M14.8 11l3.5-1.3M13.8 14.4l2.2 3.3M10.2 14.4 8 17.7M9.2 11 5.7 9.7"/>',
  bubble: '<circle cx="11" cy="12" r="4.2"/><circle cx="18.5" cy="6.5" r="2.6"/><circle cx="19" cy="16.5" r="2.2"/><circle cx="4.6" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.6"/>',
  org: '<rect x="8.5" y="2" width="7" height="4.5" rx="1.5"/><path d="M12 6.5v3.5M5 10h14M5 10v3M12 10v3M19 10v3"/><rect x="2.5" y="13" width="5" height="4.5" rx="1"/><rect x="9.5" y="13" width="5" height="4.5" rx="1"/><rect x="16.5" y="13" width="5" height="4.5" rx="1"/>',
  orgup: '<rect x="8.5" y="17.5" width="7" height="4.5" rx="1.5"/><path d="M12 17.5V14M5 14h14M5 14v-3M12 14v-3M19 14v-3"/><rect x="2.5" y="6.5" width="5" height="4.5" rx="1"/><rect x="9.5" y="6.5" width="5" height="4.5" rx="1"/><rect x="16.5" y="6.5" width="5" height="4.5" rx="1"/>',
  brace: '<rect x="1.5" y="9.5" width="6" height="5" rx="1.5"/><path d="M13 4.5c-1.5 0-2 .5-2 2v3.5l-1.5 2 1.5 2v3.5c0 1.5.5 2 2 2"/><rect x="14.5" y="3.5" width="8" height="3" rx="1"/><rect x="14.5" y="10.5" width="8" height="3" rx="1"/><rect x="14.5" y="17.5" width="8" height="3" rx="1"/>',
  fishbone: '<path d="M2 12h15M5 12l3-6M11 12l3-6M5 12l3 6M11 12l3 6"/><path d="M17 9.5l5 2.5-5 2.5z"/>',
  timeline: '<path d="M2 12h20"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><path d="M6 13.5v3M12 10.5v-3M18 13.5v3"/><rect x="3.5" y="16.5" width="5" height="3" rx="1"/><rect x="9.5" y="4.5" width="5" height="3" rx="1"/><rect x="15.5" y="16.5" width="5" height="3" rx="1"/>',
  vtimeline: '<path d="M12 2v20"/><path d="M12 6h3M12 12H9M12 18h3"/><rect x="15" y="4.5" width="7" height="3" rx="1"/><rect x="2" y="10.5" width="7" height="3" rx="1"/><rect x="15" y="16.5" width="7" height="3" rx="1"/>',
  tree: '<rect x="2" y="2.5" width="9" height="4" rx="1.4"/><path d="M5 6.5v12M5 11.5h4M5 18.5h4"/><rect x="9" y="9.5" width="12.5" height="4" rx="1.4"/><rect x="9" y="16.5" width="12.5" height="4" rx="1.4"/>',
  columns: '<rect x="8" y="2" width="8" height="3.5" rx="1.2"/><rect x="2" y="8" width="5.5" height="3" rx="1"/><rect x="9.25" y="8" width="5.5" height="3" rx="1"/><rect x="16.5" y="8" width="5.5" height="3" rx="1"/><path d="M3.5 13.5h3.5M3.5 17h3.5M10.75 13.5h3.5M18 13.5h3.5M18 17h3.5M18 20.5h3.5"/>',
  outline: '<path d="M2.5 5h2M7 5h14M5 10h2M9.5 10h11.5M5 15h2M9.5 15h9M2.5 20h2M7 20h12"/>',
};

/** Small pictogram for a layout (SVG, 24×24, uses currentColor). */
export function layoutGlyph(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = GLYPHS[kind] || GLYPHS.map;
  return svg;
}
