// History-API router. Routes: [{ path: '/projects/:id', load: () => import(...), ... }]
const routes = [];
let notFound = null;
let handler = null;

export function defineRoutes(list, fallback) {
  routes.length = 0;
  for (const r of list) {
    const keys = [];
    const pattern = new RegExp(`^${r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    routes.push({ ...r, pattern, keys });
  }
  notFound = fallback;
}

export function onRoute(fn) {
  handler = fn;
}

export function match(pathname) {
  for (const r of routes) {
    const m = pathname.match(r.pattern);
    if (m) {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { route: r, params };
    }
  }
  return { route: notFound, params: {} };
}

export function currentQuery() {
  return Object.fromEntries(new URLSearchParams(location.search));
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  resolve();
}

/** Change only the query string without re-rendering the view. */
export function setQuery(params) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  history.replaceState({}, '', `${location.pathname}${s ? `?${s}` : ''}`);
}

let lastPath = null;

export function resolve({ force = false } = {}) {
  const path = location.pathname;
  if (!force && path === lastPath) {
    handler?.({ samePath: true, ...match(path), query: currentQuery() });
    return;
  }
  lastPath = path;
  handler?.({ samePath: false, ...match(path), query: currentQuery() });
}

window.addEventListener('popstate', () => resolve());

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/static/')) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});
