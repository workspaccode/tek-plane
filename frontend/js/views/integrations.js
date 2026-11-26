// Integrations tab for software projects: GitHub (repo, pull requests, commits, issues → tasks),
// Slack and Discord (channel notifications).
import { api } from '../api.js';
import { projectShell } from '../components/projectShell.js';
import { openTask } from '../components/taskModal.js';
import { can, loadBoard, loadProjects, on, state } from '../store.js';
import {
  confirmDialog, emptyState, errorToast, fmtRelative, h, icon, mount, openModal, spinner, toast,
} from '../ui.js';

const APPS = {
  github: {
    name: 'GitHub', icon: 'github', tone: 'github',
    desc: 'See pull requests and commits, turn issues into tasks, and complete tasks when their issues close.',
  },
  slack: {
    name: 'Slack', icon: 'slack', tone: 'slack',
    desc: 'Post new, assigned and completed tasks and comments to a Slack channel.',
  },
  discord: {
    name: 'Discord', icon: 'message', tone: 'discord',
    desc: 'Post the same project updates to a Discord channel.',
  },
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ghAvatar(url, login, size = 20) {
  return url
    ? h('img', { class: 'in-gh-avatar', src: `${url}${url.includes('?') ? '&' : '?'}s=${size * 2}`, alt: '', width: size, height: size, loading: 'lazy', referrerpolicy: 'no-referrer', title: login || '' })
    : h('span', { class: 'in-gh-avatar in-gh-avatar-empty', style: { width: `${size}px`, height: `${size}px` } });
}

function labelChip(lb) {
  const c = /^[0-9a-f]{6}$/i.test(lb.color || '') ? `#${lb.color}` : 'var(--text-3)';
  return h('span', { class: 'in-label', style: { '--label': c } }, lb.name);
}

function statusPill(integ) {
  if (!integ) return h('span', { class: 'in-pill' }, 'Not connected');
  if (integ.last_error) return h('span', { class: 'in-pill in-pill-danger', title: integ.last_error }, icon('alert', 11), 'Needs attention');
  if (!integ.enabled) return h('span', { class: 'in-pill in-pill-warning' }, 'Paused');
  return h('span', { class: 'in-pill in-pill-success' }, h('span', { class: 'in-dot' }), 'Connected');
}

function appLogo(app, size = 40) {
  return h('span', { class: `in-logo in-logo-${app.tone}`, style: { width: `${size}px`, height: `${size}px` } }, icon(app.icon, Math.round(size * 0.5)));
}

// ------------------------------------------------------------------ connect / manage dialogs

function eventsPicker(events, selected, onChange) {
  const chosen = new Set(selected);
  return h('div', { class: 'in-events' }, Object.entries(events).map(([key, label]) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(key) });
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(key); else chosen.delete(key);
      onChange([...chosen]);
    });
    return h('label', { class: 'in-event' }, box, h('span', null, label));
  }));
}

const installHref = (projectId) => `/api/integrations/github/install?back=${encodeURIComponent(`/projects/${projectId}/integrations`)}`;

async function authorizeGithub(projectId, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api.post('/integrations/github/authorize', { project_id: projectId });
    location.assign(r.url);
  } catch (ex) { errorToast(ex); if (btn) btn.disabled = false; }
}

function connectGithub(projectId, current, done, appInfo = {}) {
  const appReady = !!appInfo.configured;
  let account = appInfo.account || null;
  let method = current?.auth === 'token' || current?.auth === 'none' || !appReady ? 'token' : 'app';
  let picked = null;
  let repos = null;
  let reposError = null;
  let loadedAt = 0;
  const repo = h('input', { class: 'input', placeholder: 'owner/repository or https://github.com/owner/repository', value: current?.repo || '', spellcheck: 'false' });
  const token = h('input', { class: 'input', type: 'password', placeholder: 'github_pat_… (optional for public repositories)', autocomplete: 'off', spellcheck: 'false' });
  const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search repositories', spellcheck: 'false', 'aria-label': 'Search repositories' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn btn-primary' }, icon('github', 15), current ? 'Switch repository' : 'Connect');
  const methodBox = h('div');
  const listBox = h('div', { class: 'in-repo-box' });

  const loadRepos = async () => {
    loadedAt = Date.now();
    reposError = null;
    try {
      repos = await api.get('/integrations/github/repos');
      account = repos.account;
      if (picked && !repos.installations.some((g) => g.repos.some((r) => r.full_name === picked && r.can_link))) picked = null;
    } catch (ex) {
      repos = null;
      reposError = ex.message;
      if (ex.status === 409) account = null; // expired or revoked: connect again
    }
    if (method === 'app') drawMethod();
  };

  const disconnectAccount = async () => {
    if (!await confirmDialog('Repositories you already linked keep working through the app. To link more, connect your account again.',
      { title: `Disconnect @${account.login}?`, confirmText: 'Disconnect', danger: true })) return;
    try {
      await api.del('/integrations/github/account');
      account = null; repos = null; picked = null;
      toast('GitHub account disconnected', 'success');
      drawMethod();
    } catch (ex) { errorToast(ex); }
  };

  function drawList() {
    const q = search.value.trim().toLowerCase();
    if (reposError) { mount(listBox, h('div', { class: 'in-error' }, icon('alert', 14), reposError)); return; }
    if (!repos) { mount(listBox, h('div', { class: 'in-repo-loading' }, spinner())); return; }
    const total = repos.installations.reduce((n, g) => n + g.repos.length, 0);
    if (!total) {
      mount(listBox, h('div', { class: 'in-repo-empty' }, icon('github', 20),
        h('strong', null, 'No repositories yet'),
        h('span', null, 'Install the app on GitHub and choose which repositories it can use. This list refreshes when you come back.'),
        h('a', { class: 'btn btn-secondary btn-sm', href: installHref(projectId), target: '_blank', rel: 'noopener' }, icon('plus', 14), 'Install on GitHub')));
      return;
    }
    const groups = repos.installations
      .map((g) => ({ ...g, repos: g.repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)) }))
      .filter((g) => g.repos.length);
    mount(listBox, h('div', { class: 'in-repo-list', role: 'listbox', 'aria-label': 'Repositories' },
      groups.length ? groups.map((g) => [
        repos.installations.length > 1 ? h('div', { class: 'in-repo-group' }, ghAvatar(g.avatar_url, g.account, 16), g.account) : null,
        g.repos.map((r) => h('button', {
          type: 'button', role: 'option', class: ['in-repo', picked === r.full_name && 'active'],
          'aria-selected': String(picked === r.full_name), disabled: !r.can_link,
          title: r.can_link ? r.full_name : 'You need triage access or more on GitHub to link this repository',
          onclick: () => { picked = r.full_name; err.textContent = ''; drawList(); syncButton(); },
          ondblclick: () => { picked = r.full_name; save(); },
        },
        h('span', { class: 'in-repo-icon' }, icon(r.private ? 'lock' : 'github', 14)),
        h('span', { class: 'in-repo-text' },
          h('span', { class: 'in-repo-name' }, r.full_name),
          r.description ? h('span', { class: 'in-repo-desc' }, r.description) : null),
        r.private ? h('span', { class: 'in-pill' }, 'Private') : null,
        r.can_link ? null : h('span', { class: 'in-pill' }, 'Read only'),
        h('span', { class: 'in-repo-check' }, picked === r.full_name ? icon('check', 15) : null))),
      ]) : h('div', { class: 'in-repo-none' }, `No repository matches “${search.value.trim()}”.`)));
  }

  function appSection() {
    if (!appInfo.oauth_ready) {
      return h('div', { class: 'in-steps' }, icon('alert', 14), ' Connecting through the GitHub App needs GitHub sign-in on this server. ',
        'An admin adds GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to .env. Use a personal token until then.');
    }
    if (!account) {
      const go = h('button', { class: 'btn btn-primary btn-sm' }, icon('github', 14), 'Connect GitHub account');
      go.addEventListener('click', () => authorizeGithub(projectId, go));
      return h('div', { class: 'in-account-cta' },
        h('span', { class: 'in-method-icon' }, icon('github', 18)),
        h('div', { class: 'grow' },
          h('strong', null, 'Connect your GitHub account'),
          h('span', null, 'GitHub asks you to authorize 6dx. You can then link the repositories you have access to where the app is installed.')),
        go);
    }
    const refresh = h('button', { class: 'icon-btn', title: 'Refresh the list', 'aria-label': 'Refresh the list' }, icon('refresh', 15));
    refresh.addEventListener('click', loadRepos);
    return [
      h('div', { class: 'in-account' }, ghAvatar(account.avatar_url, account.login, 30),
        h('div', { class: 'grow' },
          h('div', { class: 'in-account-name' }, account.name || account.login),
          h('a', { class: 'small muted', href: account.html_url, target: '_blank', rel: 'noopener noreferrer' }, `Connected as @${account.login}`)),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: disconnectAccount }, 'Disconnect')),
      h('div', { class: 'in-repo-search' }, search, refresh),
      listBox,
      h('p', { class: 'hint in-app-hint' }, 'Missing a repository? ',
        h('a', { href: installHref(projectId), target: '_blank', rel: 'noopener' }, 'Add it to the app on GitHub'),
        ', then come back. Everyone in this project will see its issues, pull requests and commits.'),
    ];
  }

  function syncButton() {
    btn.disabled = method === 'app' && (!account || !picked);
  }

  const choice = (id, ic, title, text, badge) => h('button', {
    type: 'button', role: 'radio', class: ['in-method', method === id && 'active'], 'aria-checked': String(method === id),
    onclick: () => { method = id; err.textContent = ''; drawMethod(); if (id === 'app' && account && !repos) loadRepos(); },
  }, h('span', { class: 'in-method-icon' }, icon(ic, 16)),
  h('span', { class: 'grow' }, h('strong', null, title, badge ? h('span', { class: 'in-pill in-pill-success' }, badge) : null), h('span', null, text)));

  function drawMethod() {
    mount(methodBox,
      appReady ? h('div', { class: 'field' }, h('label', { class: 'label' }, 'Connect with'),
        h('div', { class: 'in-methods', role: 'radiogroup' },
          choice('app', 'shield', 'GitHub App', 'Sign in with GitHub, then pick a repository. Short-lived tokens, can close issues.', 'Recommended'),
          choice('token', 'key', 'Personal token', 'Type the repository and use your own access token, or none if it’s public.'))) : null,
      method === 'app'
        ? appSection()
        : [
          h('div', { class: 'field' }, h('label', { class: 'label' }, 'Repository'), repo),
          h('div', { class: 'field' }, h('label', { class: 'label' }, 'Access token'), token,
            h('span', { class: 'hint' }, 'Needed for private repositories, and gives a much higher hourly limit. ',
              h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'Create a fine-grained token'),
              ' with access to Contents (read), Issues, Pull requests and Metadata. It’s stored encrypted and never shown again.')),
        ]);
    if (method === 'app' && account) drawList();
    syncButton();
  }

  async function save() {
    err.textContent = '';
    const name = method === 'app' ? picked : repo.value.trim();
    if (!name) { err.textContent = method === 'app' ? 'Pick a repository.' : 'Enter a repository.'; if (method !== 'app') repo.focus(); return; }
    btn.disabled = true;
    try {
      const r = await api.post(`/projects/${projectId}/integrations/github`, {
        repo: name, method, token: method === 'token' ? (token.value.trim() || null) : null,
      });
      dlg.close();
      toast(`Connected to ${r.repo}${r.auth === 'app' ? ' through the GitHub App' : ''}`, 'success');
      done();
    } catch (ex) {
      if (method === 'app' && ex.status === 409 && /Connect your GitHub account/i.test(ex.message)) { account = null; repos = null; drawMethod(); }
      err.replaceChildren(ex.message, method === 'app' && /install/i.test(ex.message)
        ? [' ', h('a', { href: installHref(projectId), target: '_blank', rel: 'noopener' }, 'Install the app')] : '');
      syncButton();
      if (method !== 'app') btn.disabled = false;
    }
  }

  search.addEventListener('input', drawList);
  btn.addEventListener('click', save);
  repo.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  // back from installing the app in another tab: show the new repositories
  const onFocus = () => { if (method === 'app' && account && Date.now() - loadedAt > 3000) loadRepos(); };
  window.addEventListener('focus', onFocus);
  drawMethod();
  if (method === 'app' && account) loadRepos();
  const dlg = openModal({
    title: current ? 'Switch GitHub repository' : 'Connect GitHub',
    width: 580,
    content: h('div', null, methodBox, err),
    footer: [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, 'Cancel'), btn],
    onClose: () => window.removeEventListener('focus', onFocus),
  });
  if (method === 'token') repo.focus();
}

function connectWebhook(projectId, provider, events, done) {
  const app = APPS[provider];
  let chosen = ['task.created', 'task.completed', 'comment.added'];
  const url = h('input', { class: 'input', type: 'url', autofocus: true, spellcheck: 'false', autocomplete: 'off',
    placeholder: provider === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://discord.com/api/webhooks/…' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn btn-primary' }, icon(app.icon, 15), 'Connect');
  const steps = provider === 'slack'
    ? ['In Slack, open ', h('a', { href: 'https://api.slack.com/apps?new_app=1', target: '_blank', rel: 'noopener noreferrer' }, 'Your apps'),
      ', create an app, turn on Incoming Webhooks and add one for your channel. Copy its URL here.']
    : ['In Discord, open the channel’s settings → Integrations → Webhooks → New Webhook, then Copy Webhook URL and paste it here.'];
  btn.addEventListener('click', async () => {
    err.textContent = '';
    if (!url.value.trim()) { err.textContent = 'Paste the webhook URL.'; url.focus(); return; }
    if (!chosen.length) { err.textContent = 'Pick at least one kind of update.'; return; }
    btn.disabled = true;
    try {
      const r = await api.post(`/projects/${projectId}/integrations/${provider}`, { url: url.value.trim(), events: chosen });
      dlg.close();
      try {
        await api.post(`/projects/${projectId}/integrations/${r.id}/test`);
        toast(`${app.name} connected. A test message was sent to your channel.`, 'success');
      } catch (ex) { toast(`${app.name} connected, but the test message failed: ${ex.message}`, 'error'); }
      done();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  const dlg = openModal({
    title: `Connect ${app.name}`,
    width: 540,
    content: h('div', null,
      h('p', { class: 'in-steps' }, steps),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Webhook URL'), url,
        h('span', { class: 'hint' }, 'Anyone with this URL can post to the channel, so it’s stored encrypted and never shown again.')),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Send these updates'), eventsPicker(events, chosen, (v) => { chosen = v; })),
      err),
    footer: [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, 'Cancel'), btn],
  });
}

function manageIntegration(projectId, integ, events, done, appInfo = {}) {
  const app = APPS[integ.provider];
  const isGithub = integ.provider === 'github';
  const body = h('div', { class: 'in-manage' });
  const switchFor = (on, onChange, label) => h('button', {
    class: ['toggle', on && 'on'], role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick: () => onChange(!on),
  });
  const row = (label, ...value) => h('div', { class: 'in-manage-row' }, h('span', { class: 'in-manage-label' }, label), h('div', { class: 'in-manage-value' }, value));
  const patch = async (data, msg) => {
    try { Object.assign(integ, await api.patch(`/projects/${projectId}/integrations/${integ.id}`, data)); if (msg) toast(msg, 'success'); draw(); done(); } catch (ex) { errorToast(ex); }
  };
  const test = async (btn) => {
    btn.disabled = true;
    try {
      await api.post(`/projects/${projectId}/integrations/${integ.id}/test`);
      integ.last_error = null;
      toast(isGithub ? `GitHub can read ${integ.repo}` : 'Test message sent', 'success');
      draw(); done();
    } catch (ex) { integ.last_error = ex.message; draw(); errorToast(ex); }
    btn.disabled = false;
  };

  function draw() {
    const testBtn = h('button', { class: 'btn btn-secondary btn-sm' }, icon(isGithub ? 'refresh' : 'message', 14), isGithub ? 'Check connection' : 'Send test message');
    testBtn.addEventListener('click', () => test(testBtn));
    const items = [
      h('div', { class: 'in-manage-head' }, appLogo(app, 44),
        h('div', { class: 'grow' }, h('div', { class: 'in-card-name' }, app.name), statusPill(integ)), testBtn),
      integ.last_error ? h('div', { class: 'in-error' }, icon('alert', 14), integ.last_error) : null,
    ];
    if (isGithub) {
      const tokenInput = h('input', { class: 'input input-sm', type: 'password', placeholder: 'New token', autocomplete: 'off' });
      items.push(
        row('Repository', h('a', { href: integ.html_url, target: '_blank', rel: 'noopener noreferrer' }, integ.repo),
          integ.private ? h('span', { class: 'in-pill' }, 'Private') : null,
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { dlg.close(); connectGithub(projectId, integ, done, appInfo); } }, 'Switch')),
        integ.auth === 'app'
          ? row('Connected with', h('span', { class: 'in-pill in-pill-success' }, icon('shield', 11), 'GitHub App'),
            h('span', { class: 'small muted' }, integ.linked_by ? `Linked by @${integ.linked_by}. Short-lived tokens.` : 'Short-lived tokens, no personal access needed.'))
          : [
            row('Access token', integ.has_token ? h('span', { class: 'in-pill in-pill-success' }, icon('check', 11), 'Saved') : h('span', { class: 'in-pill' }, 'None'),
              integ.has_token ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => patch({ token: '' }, 'Token removed') }, 'Remove') : null,
              appInfo.configured ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { dlg.close(); connectGithub(projectId, { ...integ, auth: 'app' }, done, appInfo); } }, 'Use the GitHub App') : null),
            row(integ.has_token ? 'Replace token' : 'Add a token', h('div', { class: 'in-inline' }, tokenInput,
              h('button', { class: 'btn btn-secondary btn-sm', onclick: () => tokenInput.value.trim() && patch({ token: tokenInput.value.trim() }, 'Token saved') }, 'Save'))),
          ],
        row('Close issues', switchFor(integ.close_issues, (v) => patch({ close_issues: v }, v ? 'Issues will close with their tasks' : 'Issues stay as they are'),
          'Close issues with their tasks'), h('span', { class: 'small muted' }, 'When a linked task is completed here, close its issue on GitHub (and reopen it if the task reopens).')),
        row('New issues', switchFor(integ.auto_import, (v) => patch({ auto_import: v }, v ? 'New issues will become tasks' : 'Auto-import off'),
          'Turn new issues into tasks'), h('span', { class: 'small muted' },
          appInfo.webhook_ready ? 'Needs GitHub to reach this server: add the webhook URL below to your GitHub App.' : 'Needs the GitHub App webhook (GITHUB_WEBHOOK_SECRET) and a public address.')),
        appInfo.webhook_ready ? row('Webhook URL', h('code', { class: 'in-code' }, appInfo.webhook_url)) : null);
    } else {
      const urlInput = h('input', { class: 'input input-sm', type: 'url', placeholder: 'New webhook URL', autocomplete: 'off' });
      const toggle = h('button', {
        class: ['toggle', integ.enabled && 'on'], role: 'switch', 'aria-checked': String(integ.enabled), 'aria-label': 'Send updates',
        onclick: () => patch({ enabled: !integ.enabled }, integ.enabled ? 'Paused' : 'Resumed'),
      });
      items.push(
        row('Channel', h('code', { class: 'in-code' }, integ.hint || 'Webhook')),
        row('Send updates', toggle),
        row('Updates', eventsPicker(events, integ.events, (v) => patch({ events: v }))),
        row('Replace URL', h('div', { class: 'in-inline' }, urlInput,
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => urlInput.value.trim() && patch({ url: urlInput.value.trim() }, 'Webhook updated') }, 'Save'))));
    }
    items.push(row('Last used', integ.last_used_at ? fmtRelative(integ.last_used_at) : 'Not yet'));
    mount(body, items);
  }
  draw();
  const dlg = openModal({
    title: `${app.name} settings`,
    width: 560,
    content: body,
    footer: [
      h('button', {
        class: 'btn btn-ghost in-disconnect',
        onclick: async () => {
          if (!await confirmDialog(isGithub
            ? `Imported tasks stay, but they won’t sync with ${integ.repo} any more.`
            : `${app.name} will stop receiving updates from this project.`, { title: `Disconnect ${app.name}?`, confirmText: 'Disconnect', danger: true })) return;
          try { await api.del(`/projects/${projectId}/integrations/${integ.id}`); dlg.close(); toast(`${app.name} disconnected`, 'success'); done(); } catch (ex) { errorToast(ex); }
        },
      }, icon('trash', 14), 'Disconnect'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, 'Done'),
    ],
  });
}

// ------------------------------------------------------------------ GitHub panel

function githubPanel(projectId, integ) {
  const panel = h('section', { class: 'card in-gh' }, spinner());
  let tab = 'issues';
  let data = null;
  const selected = new Set();
  let sectionId = state.board.sections[0]?.id || null;

  const load = async (refresh = false) => {
    try {
      data = await api.get(`/projects/${projectId}/github${refresh ? '?refresh=true' : ''}`);
      draw();
    } catch (ex) {
      mount(panel, h('div', { class: 'in-gh-error' }, emptyState('alert', 'Couldn’t load GitHub', ex.message,
        h('button', { class: 'btn btn-secondary', onclick: () => { mount(panel, spinner()); load(true); } }, icon('refresh', 14), 'Try again'))));
    }
  };

  const importIssues = async (numbers, btn) => {
    if (btn) btn.disabled = true;
    try {
      const r = await api.post(`/projects/${projectId}/github/import`, { numbers, section_id: sectionId });
      numbers.forEach((n) => selected.delete(n));
      toast(r.imported ? `Imported ${plural(r.imported, 'issue')} as tasks` : 'Those issues are already tasks', 'success');
      await load();
    } catch (ex) { errorToast(ex); if (btn) btn.disabled = false; }
  };

  const sync = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api.post(`/projects/${projectId}/github/sync`);
      toast(r.completed ? `${plural(r.completed, 'task')} completed: their issues were closed on GitHub`
        : `Checked ${plural(r.checked, 'linked task')}. Nothing to update.`, 'success');
      await load(true);
    } catch (ex) { errorToast(ex); btn.disabled = false; }
  };

  function issuesList() {
    const canImport = can('member') && state.board.sections.length > 0;
    const importable = data.issues.filter((x) => !x.task);
    const importSel = h('button', { class: 'btn btn-primary btn-sm', disabled: !selected.size },
      icon('download', 14), selected.size ? `Import ${plural(selected.size, 'issue')}` : 'Import selected');
    importSel.addEventListener('click', () => importIssues([...selected], importSel));
    const sectionSel = h('select', { class: 'select input-sm', 'aria-label': 'Import into section' },
      state.board.sections.map((s) => h('option', { value: s.id, selected: s.id === sectionId }, s.name)));
    sectionSel.addEventListener('change', () => { sectionId = Number(sectionSel.value); });
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all issues', checked: importable.length > 0 && importable.every((x) => selected.has(x.number)), disabled: !importable.length });
    all.addEventListener('change', () => { importable.forEach((x) => (all.checked ? selected.add(x.number) : selected.delete(x.number))); draw(); });
    if (!data.issues.length) return h('div', { class: 'db-empty' }, icon('check-circle', 18), 'No open issues on GitHub.');
    return [
      canImport ? h('div', { class: 'in-toolbar' }, h('label', { class: 'in-check' }, all, h('span', null, 'Select all')),
        h('div', { class: 'grow' }), h('span', { class: 'small muted' }, 'into'), sectionSel, importSel) : null,
      h('ul', { class: 'in-list' }, data.issues.map((x) => {
        const box = canImport && !x.task ? h('input', { type: 'checkbox', checked: selected.has(x.number), 'aria-label': `Select issue #${x.number}` }) : null;
        box?.addEventListener('change', () => { if (box.checked) selected.add(x.number); else selected.delete(x.number); draw(); });
        return h('li', { class: 'in-item' },
          canImport ? h('span', { class: 'in-item-check' }, box) : null,
          h('span', { class: 'in-item-icon in-issue' }, icon('circle', 15)),
          h('div', { class: 'grow' },
            h('div', { class: 'in-item-title' },
              h('a', { href: x.html_url, target: '_blank', rel: 'noopener noreferrer' }, x.title),
              x.labels.map(labelChip)),
            h('div', { class: 'in-item-meta' }, `#${x.number} opened ${fmtRelative(x.created_at)} by ${x.user || 'someone'}`,
              x.comments ? [' · ', icon('message', 11), ` ${x.comments}`] : null)),
          x.task
            ? h('button', { class: ['btn', 'btn-ghost', 'btn-sm', 'in-task-link', x.task.status === 'completed' && 'done'], onclick: () => openTask(x.task.id) },
              icon(x.task.status === 'completed' ? 'check-circle' : 'check', 13), `Task #${x.task.number}`)
            : canImport ? h('button', { class: 'btn btn-secondary btn-sm', onclick: (e) => importIssues([x.number], e.currentTarget) }, 'Import') : null);
      })),
    ];
  }

  function pullsList() {
    if (!data.pulls.length) return h('div', { class: 'db-empty' }, icon('git-pull', 18), 'No open pull requests.');
    return h('ul', { class: 'in-list' }, data.pulls.map((p) => h('li', { class: 'in-item' },
      h('span', { class: ['in-item-icon', p.draft ? 'in-draft' : 'in-pr'] }, icon('git-pull', 15)),
      h('div', { class: 'grow' },
        h('div', { class: 'in-item-title' }, h('a', { href: p.html_url, target: '_blank', rel: 'noopener noreferrer' }, p.title),
          p.draft ? h('span', { class: 'in-pill' }, 'Draft') : null),
        h('div', { class: 'in-item-meta' }, `#${p.number} by ${p.user || 'someone'} · `,
          h('code', { class: 'in-branch' }, p.head), ' → ', h('code', { class: 'in-branch' }, p.base), ` · updated ${fmtRelative(p.updated_at)}`)),
      ghAvatar(p.avatar_url, p.user, 22))));
  }

  function commitsList() {
    if (!data.commits.length) return h('div', { class: 'db-empty' }, icon('git-commit', 18), 'No commits yet.');
    return h('ul', { class: 'in-list' }, data.commits.map((c) => h('li', { class: 'in-item' },
      ghAvatar(c.avatar_url, c.login, 22),
      h('div', { class: 'grow' },
        h('div', { class: 'in-item-title' }, h('a', { href: c.html_url, target: '_blank', rel: 'noopener noreferrer' }, c.message)),
        h('div', { class: 'in-item-meta' }, `${c.author || c.login || 'Someone'} committed ${fmtRelative(c.date)}`)),
      h('a', { class: 'in-sha', href: c.html_url, target: '_blank', rel: 'noopener noreferrer' }, c.sha))));
  }

  function draw() {
    const r = data.repo;
    const seg = h('div', { class: 'seg seg-sm in-tabs', role: 'tablist' },
      [['issues', `Issues · ${data.issues.length}`], ['pulls', `Pull requests · ${data.pulls.length}`], ['commits', 'Commits']]
        .map(([k, label]) => h('button', { role: 'tab', class: tab === k && 'active', 'aria-selected': String(tab === k), onclick: () => { tab = k; draw(); } }, label)));
    const syncBtn = h('button', { class: 'btn btn-secondary btn-sm', title: 'Complete tasks whose issues were closed on GitHub' },
      icon('repeat', 14), data.linked_open ? `Sync ${plural(data.linked_open, 'task')}` : 'Sync');
    syncBtn.addEventListener('click', () => sync(syncBtn));
    const refresh = h('button', { class: 'icon-btn', title: 'Refresh from GitHub', 'aria-label': 'Refresh from GitHub' }, icon('refresh', 16));
    refresh.addEventListener('click', async () => { refresh.disabled = true; await load(true); toast('Updated from GitHub', 'success', { timeout: 1200 }); });
    const stat = (ic, text) => h('span', { class: 'in-stat' }, icon(ic, 13), text);
    mount(panel,
      h('div', { class: 'in-gh-head' },
        appLogo(APPS.github, 40),
        h('div', { class: 'grow' },
          h('div', { class: 'in-gh-name' },
            h('a', { href: r.html_url, target: '_blank', rel: 'noopener noreferrer' }, r.full_name),
            h('span', { class: 'in-pill' }, r.private ? 'Private' : 'Public')),
          r.description ? h('div', { class: 'in-gh-desc' }, r.description) : null,
          h('div', { class: 'in-stats' },
            stat('star', `${r.stars}`), stat('git-branch', r.default_branch || 'main'), stat('repeat', `${r.forks} forks`),
            r.language ? stat('code', r.language) : null,
            r.pushed_at ? stat('clock', `pushed ${fmtRelative(r.pushed_at)}`) : null)),
        h('div', { class: 'in-gh-actions' }, can('member') ? syncBtn : null, refresh)),
      h('div', { class: 'in-gh-tabs' }, seg),
      h('div', { class: 'in-gh-body' }, tab === 'issues' ? issuesList() : tab === 'pulls' ? pullsList() : commitsList()));
  }

  load();
  return { el: panel, reload: () => load() };
}

// ------------------------------------------------------------------ page

export default async function render(root, { params }) {
  const projectId = Number(params.id);
  const shell = await projectShell(root, projectId, 'integrations', () => {});
  const page = h('div', { class: 'in-page' });
  mount(shell.body, page);
  let data = null;
  let gh = null;

  function notSoftware() {
    mount(page, h('div', { class: 'card' }, emptyState('plug', 'Integrations are for software projects',
      'Make this a Software project to connect GitHub, Slack and Discord.',
      can('admin') ? h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await api.patch(`/projects/${projectId}`, { category: 'software' });
            await Promise.all([loadBoard(projectId), loadProjects()]);
            load();
          } catch (ex) { errorToast(ex); }
        },
      }, icon('code', 15), 'Make it a software project') : null)));
  }

  async function load() {
    if (state.board?.project.category !== 'software') { notSoftware(); return; }
    try { data = await api.get(`/projects/${projectId}/integrations`); } catch (ex) {
      mount(page, h('div', { class: 'card' }, emptyState('alert', 'Couldn’t load integrations', ex.message)));
      return;
    }
    draw();
  }

  function card(provider) {
    const app = APPS[provider];
    const integ = data.connected.find((i) => i.provider === provider);
    const detail = integ
      ? (provider === 'github'
        ? h('a', { class: 'in-card-detail', href: integ.html_url, target: '_blank', rel: 'noopener noreferrer' },
          icon(integ.auth === 'app' ? 'shield' : 'github', 12), integ.repo, integ.auth === 'app' ? ' · App' : '')
        : h('span', { class: 'in-card-detail' }, `${plural(integ.events.length, 'kind')} of update · ${integ.hint || ''}`))
      : null;
    const action = data.can_manage
      ? h('button', {
        class: ['btn', 'btn-sm', integ ? 'btn-secondary' : 'btn-primary'],
        onclick: () => {
          if (integ) manageIntegration(projectId, integ, data.events, load, data.github_app);
          else if (provider === 'github') connectGithub(projectId, null, load, data.github_app);
          else connectWebhook(projectId, provider, data.events, load);
        },
      }, integ ? 'Manage' : 'Connect')
      : (integ ? null : h('span', { class: 'small muted' }, 'A project admin can connect it'));
    return h('div', { class: ['card', 'in-card', integ && 'connected'] },
      h('div', { class: 'in-card-top' }, appLogo(app), statusPill(integ)),
      h('div', { class: 'in-card-name' }, app.name),
      h('p', { class: 'in-card-desc' }, app.desc),
      h('div', { class: 'in-card-foot' }, detail || h('span'), action));
  }

  function draw() {
    const github = data.connected.find((i) => i.provider === 'github');
    if (!github) gh = null;
    else if (!gh || gh.repo !== github.repo) gh = { ...githubPanel(projectId, github), repo: github.repo };
    mount(page,
      h('div', { class: 'in-head' },
        h('h2', { class: 'in-title' }, 'Integrations'),
        h('p', { class: 'page-sub' }, 'Connect the tools your team already uses. Tokens and webhook URLs are stored encrypted.')),
      h('div', { class: 'in-grid' }, Object.keys(APPS).map(card)),
      gh ? gh.el : null);
  }

  // back from GitHub (account authorized, or the app installed)
  const back = new URLSearchParams(location.hash.slice(1));
  if (back.has('github') || back.has('github_error')) history.replaceState(history.state, '', location.pathname + location.search);
  await load();
  if (back.get('github_error')) toast(back.get('github_error'), 'error');
  else if (back.get('github') === 'requested') toast('Install request sent. An owner of the organization has to approve it on GitHub.', 'success');
  else if (['connected', 'installed'].includes(back.get('github')) && data) {
    toast(back.get('github') === 'connected' ? 'GitHub account connected. Pick a repository.' : 'GitHub App installed. Pick a repository.', 'success');
    const linked = data.connected.find((i) => i.provider === 'github');
    if (data.can_manage) connectGithub(projectId, linked ? { ...linked, auth: 'app' } : null, load, data.github_app);
  }
  const offs = [
    on('ws', (msg) => {
      if (msg.project_id !== projectId) return;
      if (msg.type === 'integrations.changed') load();
      if (msg.type === 'project.updated') load();
    }),
  ];
  return () => { offs.forEach((off) => off()); shell.cleanup?.(); };
}
