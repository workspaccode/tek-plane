// Sign in: "Continue with Google" or email + one-time code. New users pick a display name afterwards.
import { api, setToken } from '../api.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import { h, icon, mount } from '../ui.js';

const GOOGLE_LOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function nextPath() {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard';
}

export default async function render(root, { mode }) {
  let callbackUser = null;
  if (mode === 'callback') {
    const res = await handleCallback();
    if (!res) return;
    callbackUser = res; // new account from a link: ask for a name first
  }

  let cfg = { google: false, email_delivery: 'console', otp_length: 6, resend_seconds: 30 };
  try { cfg = await api.get('/auth/config'); } catch (_) {}
  const hashError = new URLSearchParams(location.hash.slice(1)).get('error');
  if (hashError) history.replaceState({}, '', location.pathname + location.search);

  let email = '';
  let isNew = false;
  let resendTimer = null;
  const panel = h('div', { class: 'auth-form' });

  const errorBox = (msg) => h('div', { class: 'form-error', role: 'alert' }, msg || '');

  function stepEmail(initialError) {
    clearInterval(resendTimer);
    const input = h('input', { class: 'input input-lg', id: 'f-email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com', value: email, required: true });
    const err = errorBox(initialError);
    const btn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Continue with email');
    const form = h('form', { novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'f-email' }, 'Email'), input),
      err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const value = input.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { err.textContent = 'Enter a valid email address.'; input.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'Sending code…';
      try {
        const res = await api.post('/auth/otp/request', { email: value });
        email = value.toLowerCase();
        isNew = res.is_new;
        stepCode();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Continue with email';
      }
    });
    mount(panel,
      h('div', { class: 'auth-logo' }, h('span', { class: 'brand-mark' }, icon('layers', 18))),
      h('h2', null, 'Sign in to tek-plane'),
      h('p', { class: 'page-sub' }, 'New here? Signing in creates your account.'),
      cfg.google ? [
        h('a', { class: 'btn btn-google btn-lg btn-block', href: `/api/auth/google/start?next=${encodeURIComponent(nextPath())}` },
          h('span', { html: GOOGLE_LOGO, style: { display: 'inline-flex' } }), 'Continue with Google'),
        h('div', { class: 'auth-divider' }, h('span', null, 'or')),
      ] : null,
      form,
      h('p', { class: 'auth-fine' }, 'We’ll email you a 6-digit code and a one-click link. No password needed.'));
    setTimeout(() => input.focus(), 0);
  }

  function stepCode() {
    const len = cfg.otp_length || 6;
    const boxes = Array.from({ length: len }, (_, i) => h('input', {
      class: 'otp-box', inputmode: 'numeric', autocomplete: i === 0 ? 'one-time-code' : 'off', maxlength: len, 'aria-label': `Digit ${i + 1}`,
    }));
    const err = errorBox();
    const btn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Verify & sign in');
    const resend = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' });
    const code = () => boxes.map((b) => b.value).join('');

    const fill = (digits, from = 0) => {
      digits.split('').forEach((d, j) => { if (boxes[from + j]) boxes[from + j].value = d; });
      const nextEmpty = boxes.find((b) => !b.value);
      (nextEmpty || boxes[len - 1]).focus();
      if (code().length === len) form.requestSubmit();
    };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        const digits = b.value.replace(/\D/g, '');
        b.value = '';
        if (digits) fill(digits, i);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
        if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        if (e.key === 'ArrowRight' && i < len - 1) boxes[i + 1].focus();
      });
      b.addEventListener('paste', (e) => {
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, len);
        if (digits) { e.preventDefault(); boxes.forEach((x) => { x.value = ''; }); fill(digits, 0); }
      });
      b.addEventListener('focus', () => b.select());
    });

    let left = cfg.resend_seconds || 30;
    const tick = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
      left -= 1;
    };
    tick();
    clearInterval(resendTimer);
    resendTimer = setInterval(tick, 1000);
    resend.addEventListener('click', async () => {
      err.textContent = '';
      try {
        await api.post('/auth/otp/request', { email });
        left = cfg.resend_seconds || 30;
        tick();
        boxes.forEach((x) => { x.value = ''; });
        boxes[0].focus();
      } catch (ex) { err.textContent = ex.message; }
    });

    const form = h('form', { novalidate: true }, h('div', { class: 'otp-row' }, boxes), err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (code().length !== len) { err.textContent = `Enter all ${len} digits.`; return; }
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        const res = await api.post('/auth/otp/verify', { email, code: code() });
        clearInterval(resendTimer);
        setToken(res.token);
        state.user = null;
        if (res.is_new) stepName(res.user);
        else navigate(nextPath(), { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Verify & sign in';
        boxes.forEach((x) => { x.value = ''; });
        boxes[0].focus();
      }
    });

    mount(panel,
      h('div', { class: 'auth-logo' }, h('span', { class: 'brand-mark' }, icon('message', 18))),
      h('h2', null, 'Check your email'),
      h('p', { class: 'page-sub' }, 'We sent a 6-digit code and a one-click ', isNew ? 'activation' : 'sign-in',
        ' link to ', h('strong', null, email), '. Both expire in 10 minutes.'),
      cfg.email_delivery === 'console' ? h('div', { class: 'auth-callout' }, icon('alert', 15),
        h('span', null, 'Email sending isn’t configured on this server yet, so the code and link were printed in the server terminal.')) : null,
      form,
      h('div', { class: 'auth-row' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => stepEmail() }, icon('chevron-left', 14), 'Use a different email'),
        resend));
    setTimeout(() => boxes[0].focus(), 0);
  }

  function stepName(user) {
    const input = h('input', { class: 'input input-lg', id: 'f-name', autocomplete: 'name', placeholder: 'Your full name', value: '', maxlength: 120 });
    const err = errorBox();
    const btn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Get started');
    const form = h('form', { novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'f-name' }, 'What should your teammates call you?'), input), err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { err.textContent = 'Please enter your name.'; input.focus(); return; }
      btn.disabled = true;
      try {
        await api.patch('/me', { name });
        navigate(nextPath(), { replace: true });
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    mount(panel,
      h('div', { class: 'auth-logo' }, h('span', { class: 'brand-mark' }, icon('user', 18))),
      h('h2', null, 'Welcome aboard'),
      h('p', { class: 'page-sub' }, `Your account for ${user.email} is ready.`),
      form,
      h('button', { class: 'btn btn-ghost btn-sm', style: { marginTop: '10px' }, onclick: () => navigate(nextPath(), { replace: true }) }, 'Skip for now'));
    setTimeout(() => input.focus(), 0);
  }

  const col = (color, n) => h('div', { class: 'hero-col' }, h('div', { class: 'hero-col-head', style: { background: color } }),
    Array.from({ length: n }, () => h('div', { class: 'hero-card' })));

  root.appendChild(h('div', { class: 'auth-page' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'brand', style: { padding: 0 } }, h('span', { class: 'brand-mark' }, icon('layers', 16)), 'tek-plane'),
      h('div', null,
        h('h1', null, 'Plan, map and ship work together.'),
        h('p', null, 'Kanban boards, mind maps, automations, time tracking and a personal agenda, in one calm place.'),
        h('div', { class: 'hero-board', 'aria-hidden': 'true' }, col('#8792a2', 3), col('#3d6bff', 2), col('#f5a623', 3), col('#2fb67c', 1))),
      h('p', { style: { fontSize: '13px', opacity: 0.6 } }, '© tek-plane')),
    h('section', { class: 'auth-panel' }, panel)));
  if (callbackUser) stepName(callbackUser);
  else stepEmail(hashError);
  return () => clearInterval(resendTimer);
}

/** Google / email-link sign-in lands here with #token=…&next=…&new=1. Returns the user when a name is still needed. */
async function handleCallback() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  if (!token) { navigate('/login#error=Sign-in failed', { replace: true }); return null; }
  setToken(token);
  state.user = null;
  if (params.get('new') === '1') {
    history.replaceState({}, '', `/auth/callback?next=${encodeURIComponent(safeNext)}`);
    try { return await api.get('/me'); } catch (_) { /* fall through */ }
  }
  navigate(safeNext, { replace: true });
  return null;
}
