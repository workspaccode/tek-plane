// Shared UI helpers: element builder, icons, overlays, formatting, markdown.

// ------------------------------------------------------------------ element builder

export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

// ------------------------------------------------------------------ icons (24x24 stroke)

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  home: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  board: 'M3 3h7v18H3zM14 3h7v11h-7z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  tag: 'M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4zM7.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z',
  paperclip: 'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  checklist: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  play: 'm6 3 14 9-14 9z',
  stop: 'M6 6h12v12H6z',
  star: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  cpu: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  slack: 'M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5zM20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5zM3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14zM14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5zM15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5zM8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z',
  'git-pull': 'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM13 6h3a2 2 0 0 1 2 2v7M6 9v12',
  'git-commit': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6',
  'git-branch': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  'eye-off': 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  server: 'M20 2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM20 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2zM6 6h.01M6 18h.01',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.93 4.93l14.14 14.14',
  timeline: 'M3 6h10M7 12h12M5 18h8',
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  'arrow-right': 'M5 12h14M12 5l7 7-7 7',
  menu: 'M3 12h18M3 6h18M3 18h18',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  circle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  'check-circle': 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  beaker: 'M9 3h6M10 3v6L4 20a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 20L14 9V3',
  bulb: 'M9 18h6M10 22h4M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14',
  pen: 'M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  repeat: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  'user-plus': 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6',
  layers: 'm12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
  rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
  briefcase: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  mindmap: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM4 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 5.5l4.3 4.3M18.5 5.5l-4.3 4.3M5.5 18.5l4.3-4.3M18.5 18.5l-4.3-4.3',
  minus: 'M5 12h14',
  maximize: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  keyboard: 'M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 17h10',
};

export const ICON_NAMES = Object.keys(ICONS);
export const PROJECT_ICONS = ['folder', 'mindmap', 'rocket', 'briefcase', 'code', 'cpu', 'globe', 'target', 'heart', 'star', 'flag',
  'bulb', 'layers', 'pen', 'chart', 'users', 'calendar', 'zap'];

export function icon(name, size = 16, extraClass = '') {
  const svg = h('svg', {
    class: ['icon', extraClass].filter(Boolean).join(' '), width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  svg.appendChild(h('path', { d: ICONS[name] || ICONS.circle }));
  return svg;
}

// ------------------------------------------------------------------ constants

export const COLORS = ['#3d6bff', '#9b6bff', '#e64a9e', '#ef5350', '#f57c3a', '#f5a623', '#2fb67c', '#00a3bf',
  '#3c8dbc', '#6d7a8c', '#8792a2', '#1d2433'];

export const PRIORITIES = {
  none: { label: 'No priority', color: 'var(--text-3)', rank: 0 },
  low: { label: 'Low', color: '#00a3bf', rank: 1 },
  medium: { label: 'Medium', color: '#f5a623', rank: 2 },
  high: { label: 'High', color: '#f57c3a', rank: 3 },
  urgent: { label: 'Urgent', color: '#ef5350', rank: 4 },
};

export const ROLES = {
  owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer',
};

// ------------------------------------------------------------------ escaping & text

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** What to show under a name: the email, or @username for admin accounts without a real email. */
export function userHandle(u) {
  return u?.username && /\.invalid$/i.test(u.email || '') ? `@${u.username}` : (u?.email || '');
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Safe mini-markdown: escapes first, then applies a small set of formats. Mentions: @[Name](id) */
export function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];
  let text = escapeHtml(src).replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/@\[([^\]]+)\]\((\d+)\)/g, '<span class="mention" data-user="$2">@$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const lines = text.split('\n');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s*[-*] \[( |x)\] (.*)$/i))) {
      if (list !== 'ul') { closeList(); out.push('<ul class="md-tasks">'); list = 'ul'; }
      out.push(`<li><span class="md-check ${m[1].trim() ? 'done' : ''}"></span>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*] (.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\. (.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      if ((m = line.match(/^(#{1,3}) (.*)$/))) out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
      else if ((m = line.match(/^&gt; ?(.*)$/))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      else if (/^\u0000\d+\u0000$/.test(line.trim())) out.push(line.trim());
      else if (line.trim() === '') out.push('<div class="md-gap"></div>');
      else out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/** Plain-text preview of markdown, with mentions resolved to @Name. */
export function plainText(src = '') {
  return src.replace(/@\[([^\]]+)\]\(\d+\)/g, '@$1').replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ dates & durations

const DAY = 86400000;

export function parseDate(iso) {
  return iso ? new Date(iso) : null;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function fmtDate(iso, opts = {}) {
  const d = parseDate(iso);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...opts });
}

export function fmtDateTime(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  return `${fmtDate(iso)}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtRelative(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return fmtDate(iso);
}

/** Due-date label + urgency class: overdue | today | soon | '' */
export function dueInfo(iso, completed = false) {
  const d = parseDate(iso);
  if (!d) return null;
  const today = startOfDay(new Date());
  const days = Math.round((startOfDay(d) - today) / DAY);
  let text;
  if (days === 0) text = 'Today';
  else if (days === 1) text = 'Tomorrow';
  else if (days === -1) text = 'Yesterday';
  else if (days > 1 && days < 7) text = d.toLocaleDateString(undefined, { weekday: 'short' });
  else text = fmtDate(iso);
  let cls = '';
  if (!completed) {
    if (d < new Date() && days <= 0) cls = days === 0 ? 'today' : 'overdue';
    else if (days === 0) cls = 'today';
    else if (days <= 2) cls = 'soon';
  }
  return { text, cls, days };
}

export function fmtDuration(seconds, { short = false } = {}) {
  seconds = Math.max(0, Math.round(seconds || 0));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (short) return hrs ? `${hrs}h ${mins}m` : `${mins}m`;
  const secs = seconds % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** yyyy-mm-dd for <input type=date> from an ISO string (local time). */
export function toDateInput(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO string at local 17:00 (due) or 09:00 (start) from yyyy-mm-dd. */
export function fromDateInput(value, hour = 17) {
  if (!value) return null;
  const [y, mo, d] = value.split('-').map(Number);
  return new Date(y, mo - 1, d, hour, 0, 0).toISOString();
}

// ------------------------------------------------------------------ avatars

export function avatar(user, size = 28, { title = true } = {}) {
  if (!user) {
    return h('span', { class: 'avatar avatar-empty', style: { width: `${size}px`, height: `${size}px` }, title: title ? 'Unassigned' : null },
      icon('user', Math.round(size * 0.55)));
  }
  const el = h('span', {
    class: 'avatar',
    style: { width: `${size}px`, height: `${size}px`, background: user.avatar_color, fontSize: `${Math.round(size * 0.4)}px` },
    title: title ? user.name : null,
  }, initials(user.name));
  if (user.avatar_url) {
    // profile photo (e.g. from Google); falls back to initials if it can't load
    const img = h('img', { class: 'avatar-img', src: user.avatar_url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', draggable: 'false' });
    img.addEventListener('error', () => img.remove());
    el.appendChild(img);
  }
  return el;
}

export function avatarStack(users, size = 26, max = 4) {
  const shown = users.slice(0, max);
  return h('span', { class: 'avatar-stack' },
    shown.map((u) => avatar(u, size)),
    users.length > max ? h('span', { class: 'avatar avatar-more', style: { width: `${size}px`, height: `${size}px` } },
      `+${users.length - max}`) : null);
}

// ------------------------------------------------------------------ toasts

export function toast(message, type = 'info', { action, timeout = 3500 } = {}) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${type}`, role: 'status' },
    icon(type === 'error' ? 'alert' : type === 'success' ? 'check-circle' : 'bell', 16),
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { class: 'toast-action', onclick: () => { action.onClick(); dismiss(); } }, action.label) : null);
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  root.appendChild(el);
  setTimeout(dismiss, timeout);
  return dismiss;
}

export function errorToast(err) {
  toast(err?.message || 'Something went wrong', 'error');
}

// ------------------------------------------------------------------ modal

const modalStack = [];

export function openModal({ title, content, width = 520, className = '', onClose, footer, closeOnBackdrop = true } = {}) {
  const overlays = document.getElementById('overlays');
  const previousFocus = document.activeElement;
  const body = h('div', { class: 'modal-body' });
  const dialog = h('div', {
    class: ['modal', className], role: 'dialog', 'aria-modal': 'true', style: { maxWidth: `${width}px` },
    tabindex: '-1',
  },
  title !== undefined ? h('div', { class: 'modal-head' },
    h('h2', { class: 'modal-title' }, title),
    h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('x', 18))) : null,
  body,
  footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && closeOnBackdrop) close();
  });
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    const i = modalStack.indexOf(handle);
    if (i >= 0) modalStack.splice(i, 1);
    backdrop.classList.add('leaving');
    setTimeout(() => backdrop.remove(), 160);
    onClose?.(result);
    previousFocus?.focus?.();
  }
  const handle = { el: dialog, body, close, backdrop };
  if (typeof content === 'function') content(body, handle);
  else if (content) mount(body, content);
  overlays.appendChild(backdrop);
  modalStack.push(handle);
  requestAnimationFrame(() => {
    const auto = dialog.querySelector('[autofocus]') || dialog;
    auto.focus();
  });
  return handle;
}

export function topModal() {
  return modalStack[modalStack.length - 1];
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (closePopover()) { e.stopPropagation(); return; }
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) {
      // Let the field's own handler run first; if nothing handled it, just leave the field.
      setTimeout(() => { if (!e.cancelBubble && !e.defaultPrevented) t.blur?.(); }, 0);
      return;
    }
    const top = topModal();
    if (top) {
      e.stopPropagation();
      top.close();
    }
  }
}, true);

export function confirmDialog(message, { title = 'Are you sure?', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title,
      width: 420,
      content: h('p', { class: 'confirm-text' }, message),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, autofocus: true,
          onclick: () => { result = true; m.close(); } }, confirmText),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title, { value = '', placeholder = '', confirmText = 'Save', label } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', value, placeholder, autofocus: true });
    const submit = () => { result = input.value.trim() || null; m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const m = openModal({
      title,
      width: 420,
      content: h('div', { class: 'field' }, label ? h('label', { class: 'label' }, label) : null, input),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: submit }, confirmText),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => input.select(), 30);
  });
}

// ------------------------------------------------------------------ popovers & menus

let activePopover = null;

export function closePopover() {
  if (!activePopover) return false;
  const p = activePopover;
  activePopover = null;
  p.el.remove();
  document.removeEventListener('mousedown', p.outside, true);
  window.removeEventListener('resize', p.reposition);
  p.onClose?.();
  return true;
}

/** Anchored floating panel. content: Node or (panel, close) => Node */
export function popover(anchor, content, { align = 'start', width, className = '', onClose } = {}) {
  closePopover();
  const el = h('div', { class: ['popover', className], style: width ? { width: `${width}px` } : null });
  const close = () => { if (activePopover?.el === el) closePopover(); };
  const node = typeof content === 'function' ? content(el, close) : content;
  if (node) el.appendChild(node);
  document.getElementById('overlays').appendChild(el);
  const reposition = () => {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  activePopover = { el, outside, reposition, onClose };
  reposition();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  window.addEventListener('resize', reposition);
  el.querySelector('input, [autofocus]')?.focus();
  return { el, close, reposition };
}

/** items: [{label, icon, onClick, danger, disabled, checked, hint}] | 'divider' | {header} */
export function menu(anchor, items, opts = {}) {
  return popover(anchor, (_, close) => h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) => {
      if (it === 'divider') return h('div', { class: 'menu-divider' });
      if (it.header) return h('div', { class: 'menu-header' }, it.header);
      return h('button', {
        class: ['menu-item', it.danger && 'danger', it.checked && 'checked'], role: 'menuitem', disabled: it.disabled,
        onclick: () => { close(); it.onClick?.(); },
      },
      it.icon ? icon(it.icon, 15) : it.swatch ? h('span', { class: 'swatch', style: { background: it.swatch } }) : null,
      it.avatar ? avatar(it.avatar, 20) : null,
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
      it.checked ? icon('check', 14, 'menu-check') : null);
    })), opts);
}

/** Searchable single/multi-select list in a popover. */
export function pickerPopover(anchor, { items, selected = [], multi = false, placeholder = 'Search…', onChange, render, footer }) {
  let current = new Set(selected);
  return popover(anchor, (_, close) => {
    const list = h('div', { class: 'picker-list' });
    const input = h('input', { class: 'input input-sm', placeholder });
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const shown = items.filter((it) => !q || it.label.toLowerCase().includes(q));
      mount(list, shown.length ? shown.map((it) => h('button', {
        class: ['menu-item', current.has(it.value) && 'checked'],
        onclick: () => {
          if (multi) {
            current.has(it.value) ? current.delete(it.value) : current.add(it.value);
            onChange([...current]);
            draw();
          } else {
            current = new Set([it.value]);
            close();
            onChange(it.value);
          }
        },
      }, render ? render(it) : it.label, current.has(it.value) ? icon('check', 14, 'menu-check') : null))
        : h('div', { class: 'picker-empty' }, 'No matches'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') list.querySelector('.menu-item')?.click();
    });
    draw();
    return h('div', { class: 'picker' }, items.length > 6 ? input : null, list,
      footer ? footer(close) : null);
  }, { width: 260 });
}

// ------------------------------------------------------------------ misc widgets

export function colorSwatches(selected, onPick) {
  const wrap = h('div', { class: 'swatches' });
  const draw = (sel) => mount(wrap, COLORS.map((c) => h('button', {
    type: 'button', class: ['swatch-btn', c === sel && 'active'], style: { background: c }, 'aria-label': c,
    onclick: () => { draw(c); onPick(c); },
  })));
  draw(selected);
  return wrap;
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(iconName, 28)),
    h('h3', null, title),
    text ? h('p', null, text) : null,
    action || null);
}

export function spinner() {
  return h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }));
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
