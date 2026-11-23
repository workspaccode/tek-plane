import { api, setToken } from '../api.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import { h, icon } from '../ui.js';

export default function render(root, { mode }) {
  const isLogin = mode === 'login';
  const error = h('div', { class: 'form-error', role: 'alert' });
  const fields = {
    name: h('input', { class: 'input', name: 'name', autocomplete: 'name', required: true, placeholder: 'Ada Lovelace' }),
    email: h('input', { class: 'input', name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' }),
    password: h('input', {
      class: 'input', name: 'password', type: 'password', required: true, minlength: 6,
      autocomplete: isLogin ? 'current-password' : 'new-password', placeholder: isLogin ? '••••••••' : 'At least 6 characters',
    }),
  };
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, isLogin ? 'Log in' : 'Create account');

  const form = h('form', { class: 'auth-form', novalidate: true },
    h('h2', null, isLogin ? 'Welcome back' : 'Create your account'),
    h('p', { class: 'page-sub' }, isLogin ? 'Log in to pick up where your team left off.' : 'Start organizing projects with your team in minutes.'),
    isLogin ? null : h('div', { class: 'field' }, h('label', { class: 'label', for: 'f-name' }, 'Full name'), Object.assign(fields.name, { id: 'f-name' })),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'f-email' }, 'Email'), Object.assign(fields.email, { id: 'f-email' })),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'f-pass' }, 'Password'), Object.assign(fields.password, { id: 'f-pass' })),
    error,
    submit,
    h('p', { class: 'auth-switch' }, isLogin ? 'New to tek-plane? ' : 'Already have an account? ',
      h('a', { href: isLogin ? '/register' : '/login' }, isLogin ? 'Create an account' : 'Log in')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const body = { email: fields.email.value.trim(), password: fields.password.value };
    if (!isLogin) body.name = fields.name.value.trim();
    if (!body.email || !body.password || (!isLogin && !body.name)) {
      error.textContent = 'Please fill in all fields.';
      return;
    }
    submit.disabled = true;
    submit.textContent = isLogin ? 'Logging in…' : 'Creating account…';
    try {
      const res = await api.post(isLogin ? '/auth/login' : '/auth/register', body);
      setToken(res.token);
      state.user = null; // force bootstrap
      const next = new URLSearchParams(location.search).get('next');
      navigate(next && next.startsWith('/') ? next : '/dashboard', { replace: true });
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.textContent = isLogin ? 'Log in' : 'Create account';
    }
  });

  const col = (color, n) => h('div', { class: 'hero-col' }, h('div', { class: 'hero-col-head', style: { background: color } }),
    Array.from({ length: n }, () => h('div', { class: 'hero-card' })));

  root.appendChild(h('div', { class: 'auth-page' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'brand', style: { padding: 0 } }, h('span', { class: 'brand-mark' }, icon('layers', 16)), 'tek-plane'),
      h('div', null,
        h('h1', null, 'Plan, track and ship work together.'),
        h('p', null, 'Kanban boards, automations, time tracking, timelines and a personal agenda. Everything your team needs in one calm place.'),
        h('div', { class: 'hero-board', 'aria-hidden': 'true' }, col('#8792a2', 3), col('#3d6bff', 2), col('#f5a623', 3), col('#2fb67c', 1))),
      h('p', { style: { fontSize: '13px', color: '#7d879b' } }, '© tek-plane')),
    h('section', { class: 'auth-panel' }, form)));
  (isLogin ? fields.email : fields.name).focus();
}
