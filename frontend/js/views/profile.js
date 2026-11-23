// Profile & settings: name, title, avatar color, password, theme.
import { api } from '../api.js';
import { emit, state } from '../store.js';
import { avatar, colorSwatches, errorToast, h, icon, mount, toast } from '../ui.js';

function currentThemePref() {
  try { return localStorage.getItem('tp-theme') || 'system'; } catch (_) { return 'system'; }
}

function applyTheme(pref) {
  try {
    if (pref === 'system') localStorage.removeItem('tp-theme');
    else localStorage.setItem('tp-theme', pref);
  } catch (_) {}
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
}

export default async function render(root) {
  const u = state.user;
  let color = u.avatar_color;
  const preview = h('div', { class: 'pf-avatar' });
  const name = h('input', { class: 'input', id: 'pf-name', value: u.name, maxlength: 120, autocomplete: 'name' });
  const title = h('input', { class: 'input', id: 'pf-title', value: u.title || '', maxlength: 120, placeholder: 'e.g. Product designer' });
  const drawPreview = () => mount(preview, avatar({ name: name.value || u.name, avatar_color: color }, 72, { title: false }));
  name.addEventListener('input', drawPreview);
  drawPreview();

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile');
  const profileForm = h('form', { class: 'card card-pad pf-card' },
    h('h2', { class: 'card-title pf-title' }, 'Profile'),
    h('div', { class: 'pf-identity' },
      preview,
      h('div', { class: 'grow' },
        h('div', { class: 'pf-name' }, u.name),
        h('div', { class: 'muted' }, u.email))),
    h('div', { class: 'pf-fields' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pf-name' }, 'Full name'), name),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pf-title' }, 'Job title'), title)),
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'Email'), h('input', { class: 'input', value: u.email, disabled: true }),
      h('span', { class: 'hint' }, 'Your email is your login and cannot be changed here.')),
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'Avatar color'), colorSwatches(color, (c) => { color = c; drawPreview(); })),
    h('div', { class: 'pf-actions' }, saveBtn));
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { name.focus(); return; }
    saveBtn.disabled = true;
    try {
      state.user = await api.patch('/me', { name: name.value.trim(), title: title.value.trim(), avatar_color: color });
      emit('user', state.user);
      profileForm.querySelector('.pf-name').textContent = state.user.name;
      toast('Profile saved', 'success');
    } catch (err) { errorToast(err); }
    saveBtn.disabled = false;
  });

  const cur = h('input', { class: 'input', id: 'pf-cur', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'pf-new', type: 'password', autocomplete: 'new-password', minlength: 6 });
  const confirm = h('input', { class: 'input', id: 'pf-confirm', type: 'password', autocomplete: 'new-password' });
  const pwError = h('div', { class: 'form-error', role: 'alert' });
  const pwBtn = h('button', { class: 'btn btn-secondary', type: 'submit' }, 'Update password');
  const pwForm = h('form', { class: 'card card-pad pf-card' },
    h('h2', { class: 'card-title pf-title' }, 'Password'),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'pf-cur' }, 'Current password'), cur),
    h('div', { class: 'pf-fields' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pf-new' }, 'New password'), next),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pf-confirm' }, 'Confirm new password'), confirm)),
    pwError,
    h('div', { class: 'pf-actions' }, pwBtn));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwError.textContent = '';
    if (next.value.length < 6) { pwError.textContent = 'The new password must be at least 6 characters.'; return; }
    if (next.value !== confirm.value) { pwError.textContent = 'The new passwords do not match.'; return; }
    pwBtn.disabled = true;
    try {
      await api.patch('/me', { current_password: cur.value, new_password: next.value });
      pwForm.reset();
      toast('Password updated', 'success');
    } catch (err) { pwError.textContent = err.message; }
    pwBtn.disabled = false;
  });

  const themeSeg = h('div', { class: 'seg pf-theme' });
  const drawTheme = () => {
    const pref = currentThemePref();
    mount(themeSeg, [['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'settings', 'System']].map(([v, ic, l]) => h('button', {
      class: pref === v && 'active', 'aria-pressed': String(pref === v), onclick: () => { applyTheme(v); drawTheme(); },
    }, icon(ic, 14), l)));
  };
  drawTheme();
  const appearance = h('div', { class: 'card card-pad pf-card' },
    h('h2', { class: 'card-title pf-title' }, 'Appearance'),
    h('div', { class: 'pf-pref' },
      h('div', null, h('div', { class: 'pf-pref-label' }, 'Theme'), h('div', { class: 'hint' }, 'System follows your device setting.')),
      themeSeg));

  mount(root, h('div', { class: 'page pf-page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Profile & settings'),
        h('p', { class: 'page-sub' }, 'How you appear to your teammates, and how tek-plane looks for you.'))),
    h('div', { class: 'pf-stack' }, profileForm, appearance, pwForm)));
}
