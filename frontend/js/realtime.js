// WebSocket client with auto-reconnect. Every server message is emitted as `ws` and `ws:<type>`.
import { getToken } from './api.js';
import { emit } from './store.js';

let socket = null;
let retry = 0;
let pingTimer = null;
let stopped = false;

export function connectRealtime() {
  stopped = false;
  const token = getToken();
  if (!token || socket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener('open', () => {
    retry = 0;
    emit('ws:status', 'online');
    pingTimer = setInterval(() => socket?.readyState === 1 && socket.send('ping'), 25000);
  });
  socket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === 'pong') return;
    emit('ws', msg);
    emit(`ws:${msg.type}`, msg);
  });
  socket.addEventListener('close', (e) => {
    clearInterval(pingTimer);
    socket = null;
    emit('ws:status', 'offline');
    if (stopped || e.code === 4401) return;
    const delay = Math.min(15000, 500 * 2 ** retry++);
    setTimeout(connectRealtime, delay);
  });
}

export function disconnectRealtime() {
  stopped = true;
  socket?.close();
  socket = null;
}
