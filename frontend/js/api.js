const TOKEN_KEY = 'tp-token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {}
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function detailMessage(body, status) {
  if (!body) return `Request failed (${status})`;
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.detail) && body.detail.length) {
    const d = body.detail[0];
    const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : '';
    return field ? `${field}: ${d.msg}` : d.msg;
  }
  return `Request failed (${status})`;
}

async function request(method, path, body, { raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    clearToken();
    window.dispatchEvent(new CustomEvent('tp:unauthorized'));
  }
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(detailMessage(data, res.status), res.status);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  upload(path, file) {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', path, fd);
  },
  /** URL usable in <img src>/<a href> (adds the token as a query param). */
  fileUrl(url, { inline = false } = {}) {
    const params = new URLSearchParams({ token: getToken() || '' });
    if (inline) params.set('inline', 'true');
    return `${url}?${params}`;
  },
};
