// Mind map layout engine: node positions + branch paths for 5 layouts. Pure geometry, no DOM.
//
// layout(root, children, size, opts) → Map(id → { x, y, w, h, side, depth, angle })
//   children(node) → visible child nodes (already respects collapsed state)
//   size(id) → { w, h } measured node box
//   opts: { layout, spacingX, spacingY }
// branchPath(layout, lines, parentPos, childPos, { underline }) → SVG path "d"

export const LAYOUTS = {
  map: { label: 'Mind Map', hint: 'Balanced on both sides of the central topic' },
  logic: { label: 'Logic Chart', hint: 'Everything flows to the right' },
  org: { label: 'Org Chart', hint: 'Top-down hierarchy' },
  tree: { label: 'Tree', hint: 'Indented outline, like folders' },
  radial: { label: 'Radial', hint: 'Topics in rings around the centre' },
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

/** Readable text color (white or near-black) on top of a hex color. */
export function inkFor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.42 ? '#1f2430' : '#fff';
}

// ------------------------------------------------------------------ layouts

export function layout(root, children, size, opts) {
  const fn = { map: layoutMap, logic: layoutLogic, org: layoutOrg, tree: layoutTree, radial: layoutRadial }[opts.layout] || layoutMap;
  return fn(root, children, size, opts);
}

function horizontal(root, children, size, opts, sideOf) {
  const HG = opts.spacingX;
  const VG = opts.spacingY;
  const pos = new Map();
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
    const cy = top + subtreeH(n) / 2;
    const x = side === 'right' ? edgeX : edgeX - sz.w;
    pos.set(n.id, { x, y: cy - sz.h / 2, w: sz.w, h: sz.h, side, depth });
    const ch = children(n);
    if (!ch.length) return;
    const total = ch.reduce((s, c) => s + subtreeH(c), 0) + VG * (ch.length - 1);
    let y = cy - total / 2;
    const next = side === 'right' ? x + sz.w + HG : x - HG;
    for (const c of ch) { place(c, side, next, y, depth + 1); y += subtreeH(c) + VG; }
  };
  const rs = size(root.id);
  const rootX = sideOf ? -rs.w / 2 : -rs.w;
  pos.set(root.id, { x: rootX, y: -rs.h / 2, w: rs.w, h: rs.h, side: 'root', depth: 0 });
  for (const side of ['right', 'left']) {
    const ch = children(root).filter((c) => (sideOf ? sideOf(c) : 'right') === side);
    if (!ch.length) continue;
    const gap = VG * 2;
    const total = ch.reduce((s, c) => s + subtreeH(c), 0) + gap * (ch.length - 1);
    let y = -total / 2;
    const edge = side === 'right' ? rootX + rs.w + HG * 1.3 : rootX - HG * 1.3;
    for (const c of ch) { place(c, side, edge, y, 1); y += subtreeH(c) + gap; }
  }
  return pos;
}

function layoutMap(root, children, size, opts) {
  return horizontal(root, children, size, opts, (c) => c.side || 'right');
}

function layoutLogic(root, children, size, opts) {
  return horizontal(root, children, size, opts, null);
}

function layoutOrg(root, children, size, opts) {
  const gapX = 14 + opts.spacingX * 0.35;
  const gapY = 26 + opts.spacingY * 2.2;
  const pos = new Map();
  // all topics at the same depth share a row
  const rowH = [];
  const measure = (n, d) => {
    rowH[d] = Math.max(rowH[d] || 0, size(n.id).h);
    children(n).forEach((c) => measure(c, d + 1));
  };
  measure(root, 0);
  const rowY = [0];
  for (let d = 1; d < rowH.length; d++) rowY[d] = rowY[d - 1] + rowH[d - 1] + gapY;
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
    const sw = subtreeW(n);
    const cx = left + sw / 2;
    pos.set(n.id, { x: cx - sz.w / 2, y: rowY[d] + (rowH[d] - sz.h) / 2, w: sz.w, h: sz.h, side: 'down', depth: d });
    const ch = children(n);
    const total = ch.reduce((s, c) => s + subtreeW(c), 0) + gapX * Math.max(0, ch.length - 1);
    let x = cx - total / 2;
    for (const c of ch) { place(c, x, d + 1); x += subtreeW(c) + gapX; }
  };
  place(root, -subtreeW(root) / 2, 0);
  return pos;
}

function layoutTree(root, children, size, opts) {
  const indent = 22 + opts.spacingX * 0.45;
  const gapY = 4 + opts.spacingY * 0.7;
  const pos = new Map();
  let y = 0;
  const place = (n, d) => {
    const sz = size(n.id);
    pos.set(n.id, { x: d * indent, y, w: sz.w, h: sz.h, side: 'tree', depth: d });
    y += sz.h + gapY;
    children(n).forEach((c) => place(c, d + 1));
  };
  place(root, 0);
  return pos;
}

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
  // ring radii: far enough apart for the widest topics on adjacent rings
  const radius = [0];
  for (let d = 1; d <= maxDepth; d++) {
    radius[d] = radius[d - 1] + Math.max(110, (maxDiag[d - 1] + maxDiag[d]) * 0.42 + opts.spacingX * 0.9);
  }
  // make the outer ring long enough to fit every leaf side by side
  const avgH = 34 + opts.spacingY;
  const needed = (leaves.get(root.id) * (avgH + 8)) / (2 * Math.PI);
  if (maxDepth && radius[maxDepth] < needed) {
    const f = needed / radius[maxDepth];
    for (let d = 1; d <= maxDepth; d++) radius[d] *= f;
  }
  const assign = (n, a0, a1, d) => {
    const sz = size(n.id);
    const a = (a0 + a1) / 2;
    const r = radius[d];
    const cx = d ? r * Math.cos(a) : 0;
    const cy = d ? r * Math.sin(a) : 0;
    pos.set(n.id, { x: cx - sz.w / 2, y: cy - sz.h / 2, w: sz.w, h: sz.h, side: Math.cos(a) >= 0 ? 'right' : 'left', depth: d, angle: a, r });
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

// ------------------------------------------------------------------ branches

const cx = (p) => p.x + p.w / 2;
const cy = (p) => p.y + p.h / 2;

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
  return `M${x1},${y1} V${my - r} Q${x1},${my} ${x1 + sx * r},${my} H${x2 - sx * r} Q${x2},${my} ${x2},${my + r} V${y2}`;
}

export function branchPath(kind, lines, P, C, { underline = false, prev = null } = {}) {
  if (kind === 'org') {
    const x1 = cx(P); const y1 = P.y + P.h; const x2 = cx(C); const y2 = C.y;
    if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
    if (lines === 'elbow') return elbowV(x1, y1, x2, y2);
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  if (kind === 'tree') {
    const x1 = P.x + Math.min(16, P.w / 2);
    const y2 = underline && C.depth ? C.y + C.h : cy(C);
    const y1 = prev ? (underline ? prev.y + prev.h : cy(prev)) : P.y + P.h;
    const x2 = C.x;
    if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
    const r = Math.min(lines === 'curved' ? 14 : 6, Math.abs(y2 - y1), Math.abs(x2 - x1));
    return `M${x1},${y1} V${y2 - r} Q${x1},${y2} ${x1 + r},${y2} H${x2}`;
  }
  if (kind === 'radial') {
    const x1 = cx(P); const y1 = cy(P); const x2 = cx(C); const y2 = cy(C);
    if (lines === 'straight' || !P.depth) return `M${x1},${y1} L${x2},${y2}`;
    if (lines === 'elbow') {
      // follow the parent's ring, then go straight out along the child's angle
      const ex = P.r * Math.cos(C.angle); const ey = P.r * Math.sin(C.angle);
      return `M${x1},${y1} L${ex},${ey} L${x2},${y2}`;
    }
    const mid = (P.r + C.r) / 2;
    const c1x = mid * Math.cos(P.angle); const c1y = mid * Math.sin(P.angle);
    const c2x = mid * Math.cos(C.angle); const c2y = mid * Math.sin(C.angle);
    return `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
  }
  // map / logic: horizontal branches
  const right = C.side !== 'left';
  const fromRoot = P.side === 'root';
  const x1 = fromRoot ? (kind === 'logic' ? P.x + P.w : cx(P)) : right ? P.x + P.w : P.x;
  const y1 = underline && !fromRoot ? P.y + P.h : cy(P);
  const x2 = right ? C.x : C.x + C.w;
  const y2 = underline ? C.y + C.h : cy(C);
  if (lines === 'straight') return `M${x1},${y1} L${x2},${y2}`;
  if (lines === 'elbow') return elbowH(x1, y1, x2, y2);
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** Where to draw a node's fold toggle (top-left of an 18px circle). */
export function foldPoint(kind, p) {
  if (kind === 'org') return { x: cx(p) - 9, y: p.y + p.h + 3 };
  if (kind === 'tree') return { x: p.x - 22, y: cy(p) - 9 };
  if (kind === 'radial') {
    const d = Math.abs(Math.cos(p.angle)) * (p.w / 2) + Math.abs(Math.sin(p.angle)) * (p.h / 2) + 10;
    return { x: cx(p) + Math.cos(p.angle) * d - 9, y: cy(p) + Math.sin(p.angle) * d - 9 };
  }
  return { x: p.side === 'left' ? p.x - 24 : p.x + p.w + 6, y: cy(p) - 9 };
}

/** Small pictogram for a layout (SVG markup, 24×24, uses currentColor). */
export function layoutGlyph(kind) {
  const g = {
    map: '<rect x="8.5" y="9.5" width="7" height="5" rx="1.6"/><path d="M8.5 12H5.5M15.5 12h3M5.5 6.5v11M18.5 6.5v11M5.5 6.5H2.5M5.5 17.5H2.5M18.5 6.5h3M18.5 17.5h3"/>',
    logic: '<rect x="2" y="9.5" width="6" height="5" rx="1.5"/><path d="M8 12h3M11 5.5v13M11 5.5h3M11 12h3M11 18.5h3"/><rect x="14" y="4" width="7.5" height="3" rx="1"/><rect x="14" y="10.5" width="7.5" height="3" rx="1"/><rect x="14" y="17" width="7.5" height="3" rx="1"/>',
    org: '<rect x="8.5" y="2" width="7" height="4.5" rx="1.5"/><path d="M12 6.5v3.5M5 10h14M5 10v3M12 10v3M19 10v3"/><rect x="2.5" y="13" width="5" height="4.5" rx="1"/><rect x="9.5" y="13" width="5" height="4.5" rx="1"/><rect x="16.5" y="13" width="5" height="4.5" rx="1"/>',
    tree: '<rect x="2" y="2.5" width="9" height="4" rx="1.4"/><path d="M5 6.5v12M5 11.5h4M5 18.5h4"/><rect x="9" y="9.5" width="12.5" height="4" rx="1.4"/><rect x="9" y="16.5" width="12.5" height="4" rx="1.4"/>',
    radial: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="3.5" r="1.8"/><circle cx="20" cy="9" r="1.8"/><circle cx="17" cy="19.5" r="1.8"/><circle cx="7" cy="19.5" r="1.8"/><circle cx="4" cy="9" r="1.8"/><path d="M12 9V5.3M14.8 11l3.5-1.3M13.8 14.4l2.2 3.3M10.2 14.4 8 17.7M9.2 11 5.7 9.7"/>',
  }[kind];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = g;
  return svg;
}
