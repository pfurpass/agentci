// agentci web UI – vanilla JS, no build step. Renders from the same event stream as the terminal.

import { ringSvg, animDelay, SPIN_MS } from '/phase.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;

const ICONS = {
  planner: '<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>',
  coder: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  reviewer: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8.5 11l2 2 3.5-4"/>',
  tester: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
  checker: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  docs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<path d="M6 12h12"/>',
  loop: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
  play: '<path d="M7 5l11 7-11 7z"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
};

const ROLES = [
  { key: 'planner', name: 'Planner', desc: 'Splits the task into todos', fixed: true },
  { key: 'coder', name: 'Coder', desc: 'Implements todos, fixes errors', fixed: true },
  { key: 'reviewer', name: 'Reviewer', desc: 'Reviews every diff critically' },
  { key: 'tester', name: 'Tester', desc: 'Writes tests, in parallel with the review' },
  { key: 'docs', name: 'Docs', desc: 'Updates the README at the end' },
];
const ROLE_NAME = { planner: 'Planner', coder: 'Coder', reviewer: 'Reviewer', tester: 'Tester', docs: 'Docs', checker: 'Checker', system: 'agentci' };
const PROVIDERS = [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }, { key: 'mock', label: 'Demo' }];
const MODELS = { claude: ['opus', 'sonnet', 'haiku'], codex: [], mock: [] };
const PHASE = { plan: 'planning', implement: 'implementing', fix: 'fixing', review: 'reviewing', test: 'writing tests', docs: 'writing docs' };
const TOOL_EDIT = /Edit|Write/;
const PHASE_LABEL = {
  planning: ['Planning', 'running'], planned: ['Planned', 'stopped'], executing: ['Running', 'running'],
  finished: ['Done', 'done'], stopped: ['Stopped', 'stopped'], error: ['Error', 'error'],
};

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

// ---------------- app state ----------------
const app = {
  status: null,         // /api/status
  runs: [],
  busy: false,
  view: 'compose',      // compose | run
  viewingRunId: null,   // run shown in run view
  live: false,          // run view follows the live stream
  state: null,          // run state shown
  agents: new Map(),    // id -> agent info
  openTodos: new Set(),
  editing: null,        // todo id being edited
  form: { roles: {}, writeTests: true, fixAttempts: 3 },
};

// ---------------- api ----------------
// Only needed when the UI is served to the network (agentci ui --host …); locally it stays empty.
let authToken = '';
function loadToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { localStorage.setItem('agentci-ui-token', fromUrl); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  try { return localStorage.getItem('agentci-ui-token') || ''; } catch { return ''; }
}

function showGate(error) {
  $('#gate').hidden = false;
  $('#gateError').hidden = !error;
  $('#gateError').textContent = error || '';
  setTimeout(() => $('#tokenInput')?.focus(), 50);
}

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Agentci': '1' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { showGate(authToken ? 'token rejected' : ''); throw new Error('token required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const withToken = (url) => (authToken ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}` : url);

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3800);
  setTimeout(() => el.remove(), 4200);
}

// ---------------- theme ----------------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('agentci-theme'); } catch { /* storage blocked */ }
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('agentci-theme', next); } catch { /* ignore */ }
  };
}

// ---------------- sidebar ----------------
function renderRuns() {
  const el = $('#runs');
  if (!app.runs.length) { el.innerHTML = '<div class="runs-empty">No runs yet</div>'; return; }
  el.innerHTML = app.runs.map((r) => {
    const active = app.view === 'run' && app.viewingRunId === r.runId ? ' active' : '';
    const dot = r.failed && r.phase === 'finished' ? 'failed' : r.phase;
    return `<button class="run-item${active}" data-run="${esc(r.runId)}">
      <span class="dot ${esc(dot)}"></span>
      <span class="t">${esc(r.task)}</span>
      <span class="s"><span>${r.total ? `${r.done}/${r.total} todos` : 'planning'}</span><span>${ago(r.startedAt)}</span></span>
    </button>`;
  }).join('');
}

// When the gateway is on, availability comes from the gateway machine, not from here.
function providerInfo() {
  const gw = app.status?.gateway;
  if (gw?.enabled && gw.health?.ok) return gw.health.providers || {};
  if (gw?.enabled) return { claude: { installed: false }, codex: { installed: false }, mock: { installed: true, loggedIn: true } };
  return app.status?.providers || {};
}

function renderProviders() {
  const p = providerInfo();
  const gw = app.status?.gateway;
  const on = Boolean(gw?.enabled);
  const row = (key, label) => {
    const info = p[key] || {};
    const broken = info.toolsOk === false;
    const cls = !info.installed ? '' : broken || !info.loggedIn ? 'warn' : 'ok';
    const where = on ? 'on the gateway' : 'local';
    const txt = !info.installed ? `not installed (${where})` : broken ? 'read-only – incomplete install'
      : info.loggedIn ? `subscription ${where}` : `not signed in (${where})`;
    return `<div class="prov ${cls}${on ? ' sub' : ''}" title="${esc(info.problem || '')}"><i></i><b>${label}</b><span>${txt}</span></div>`;
  };
  const head = on
    ? `<div class="prov ${gw.health?.ok ? 'ok' : 'warn'}" title="${esc(gw.url)}"><i></i><b>Gateway</b><span>${gw.health?.ok ? esc(gw.health.host || 'connected') : esc(gw.health?.error || 'not reachable')}</span></div>`
    : '<div class="prov-title">Local</div>';
  $('#providers').innerHTML = head + row('claude', 'Claude') + row('codex', 'Codex')
    + (on ? '<div class="prov-note">Only checks &amp; tests run here.</div>' : '');
}

async function refreshRuns() {
  try { app.runs = await api('GET', '/api/runs'); } catch { app.runs = []; }
  renderRuns();
}

// ---------------- compose ----------------
function initForm() {
  const cfg = app.status.config;
  for (const r of ROLES) {
    const rc = cfg.roles[r.key] || { provider: 'claude', model: null, enabled: false };
    let enabled = r.fixed ? true : rc.enabled !== false;
    if (r.key === 'tester') enabled = enabled && cfg.pipeline.writeTests !== false;
    app.form.roles[r.key] = { provider: rc.provider, model: rc.model || '', enabled };
  }
  app.form.fixAttempts = cfg.pipeline.maxFixAttempts ?? 3;
  renderTeam();
  $('#fixAttempts').value = app.form.fixAttempts;
}

function renderTeam() {
  const prov = providerInfo();
  const gw = app.status?.gateway;
  const note = $('#teamNote');
  if (note) {
    note.innerHTML = gw?.enabled
      ? `<span class="gw-badge">⇄ running on the gateway${gw.health?.ok && gw.health.host ? ' · ' + esc(gw.health.host) : ''}</span>`
      : 'Every role can use a different AI';
  }
  $('#teamGrid').innerHTML = ROLES.map((r) => {
    const f = app.form.roles[r.key];
    const seg = PROVIDERS.map((p) => {
      const info = prov[p.key] || {};
      const editing = ['coder', 'tester', 'docs'].includes(r.key);
      const broken = editing && info.toolsOk === false;
      const ok = p.key === 'mock' || (info.installed && info.loggedIn && !broken);
      const tip = broken ? 'Codex cannot write files here (codex-code-mode-host missing)' : ok ? '' : 'not available';
      return `<button type="button" class="${f.provider === p.key ? 'on' : ''}" data-role="${r.key}" data-provider="${p.key}" title="${tip}">${p.key === 'mock' ? '' : `<i class="${ok ? 'ok' : broken ? 'warn' : ''}"></i>`}${p.label}</button>`;
    }).join('');
    return `<div class="role-card${f.enabled ? '' : ' off'}" style="--role: var(--${r.key})">
      <div class="role-top">
        <div class="role-icon">${icon(ICONS[r.key])}</div>
        <div><div class="role-name">${r.name}</div><div class="role-desc">${r.desc}</div></div>
        ${r.fixed ? '' : `<label class="switch" title="${f.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-toggle="${r.key}" ${f.enabled ? 'checked' : ''}><span></span></label>`}
      </div>
      <div class="role-controls">
        <div class="seg">${seg}</div>
        ${f.provider === 'codex' && ['coder', 'tester', 'docs'].includes(r.key) && prov.codex?.toolsOk === false ? '<div class="role-warn">Codex install incomplete: cannot write files. <code>npm i -g @openai/codex</code></div>' : ''}
        <input class="model-input" data-model="${r.key}" value="${esc(f.model)}" placeholder="default model" list="models-${f.provider}" ${f.provider === 'mock' ? 'disabled' : ''} aria-label="Model for ${r.name}">
      </div>
    </div>`;
  }).join('') + Object.entries(MODELS).map(([p, ms]) => `<datalist id="models-${p}">${ms.map((m) => `<option value="${m}">`).join('')}</datalist>`).join('');
}

function renderGateway() {
  const gw = app.status?.gateway || {};
  const on = Boolean(gw.enabled);
  const h = gw.health;
  const state = !gw.url ? '<span class="gw-state">not configured</span>'
    : !on ? '<span class="gw-state">off – Claude &amp; Codex run locally</span>'
      : h?.ok ? `<span class="gw-state ok">connected to <b>${esc(h.host)}</b></span>`
        : `<span class="gw-state bad">${esc(h?.error || 'not reachable')}</span>`;
  $('#gatewayCard').innerHTML = `
    <div class="gw-top">
      <div class="role-icon" style="--role: var(--tester)">${icon('<path d="M4 12h16M14 6l6 6-6 6M10 18l-6-6 6-6"/>')}</div>
      <div class="gw-text"><div class="role-name">Run via gateway</div>${state}</div>
      <label class="switch" style="--role: var(--tester)"><input type="checkbox" id="gwToggle" ${on ? 'checked' : ''} ${gw.url ? '' : 'disabled'}><span></span></label>
    </div>
    <div class="gw-fields">
      <input class="model-input" id="gwUrl" placeholder="http://gateway-host:4318" value="${esc(gw.url || '')}" aria-label="Gateway URL">
      <input class="model-input" id="gwToken" type="password" placeholder="${gw.hasToken ? 'token saved – leave empty to keep' : 'token (shown when the gateway starts)'}" aria-label="Gateway token" autocomplete="off">
      <button type="button" class="btn btn-sm" id="gwConnect">Connect</button>
    </div>
    <div class="gw-hint">On the machine with internet: run <code>agentci gateway</code>. Checks &amp; tests still run here.</div>`;
}

async function saveGateway(body, okMsg) {
  try {
    app.status.gateway = await api('PUT', '/api/gateway', body);
    renderGateway(); renderProviders(); renderTeam();
    if (okMsg) toast(okMsg, 'success');
  } catch (e) { toast(e.message, 'error'); renderGateway(); }
}

function bindGateway() {
  $('#gatewayCard').addEventListener('click', (e) => {
    if (e.target.id !== 'gwConnect') return;
    const url = $('#gwUrl').value.trim();
    if (!url) { toast('Please enter the gateway URL', 'error'); return; }
    e.target.disabled = true; e.target.textContent = 'Checking…';
    saveGateway({ url, token: $('#gwToken').value.trim() || undefined, enabled: true }, 'Gateway connected');
  });
  $('#gatewayCard').addEventListener('change', (e) => {
    if (e.target.id === 'gwToggle') saveGateway({ enabled: e.target.checked }, e.target.checked ? 'Gateway on' : 'Gateway off – running locally');
  });
}

function formBody(task) {
  const roles = {};
  for (const [k, f] of Object.entries(app.form.roles)) roles[k] = { provider: f.provider, model: f.model.trim() || null, enabled: f.enabled };
  return { task, roles, writeTests: app.form.roles.tester.enabled, maxFixAttempts: app.form.fixAttempts };
}

async function startRun(kind) {
  const task = $('#task').value.trim();
  if (!task) { $('#task').focus(); toast('Please describe the task first', 'error'); return; }
  try {
    resetRun();
    app.view = 'run'; app.live = true; app.viewingRunId = null;
    showView();
    await api('POST', kind === 'plan' ? '/api/plan' : '/api/run', formBody(task));
  } catch (e) {
    toast(e.message, 'error');
    app.view = 'compose'; showView();
  }
}

function bindCompose() {
  $('#composeForm').addEventListener('submit', (e) => { e.preventDefault(); startRun('run'); });
  // Enter in a small input (model, gateway) must not start a run.
  $('#composeForm').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    if (e.target.id === 'gwUrl' || e.target.id === 'gwToken') $('#gwConnect')?.click();
  });
  $('#planBtn').onclick = () => startRun('plan');
  $('#task').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startRun('run'); }
  });
  $('#teamGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-provider]');
    if (!b) return;
    const f = app.form.roles[b.dataset.role];
    if (f.provider !== b.dataset.provider) { f.provider = b.dataset.provider; f.model = ''; renderTeam(); }
  });
  $('#teamGrid').addEventListener('change', (e) => {
    const t = e.target.dataset.toggle;
    if (t) { app.form.roles[t].enabled = e.target.checked; renderTeam(); }
  });
  $('#teamGrid').addEventListener('input', (e) => {
    const m = e.target.dataset.model;
    if (m) app.form.roles[m].model = e.target.value;
  });
  document.querySelectorAll('.stepper button').forEach((b) => {
    b.onclick = () => {
      app.form.fixAttempts = Math.max(0, Math.min(10, app.form.fixAttempts + Number(b.dataset.step)));
      $('#fixAttempts').value = app.form.fixAttempts;
    };
  });
  $('#saveDefaultsBtn').onclick = async () => {
    const b = formBody('');
    try {
      await api('PUT', '/api/config', { roles: b.roles, pipeline: { writeTests: b.writeTests, maxFixAttempts: b.maxFixAttempts } });
      toast('Saved as default (agentci.config.json)', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
}

// ---------------- views ----------------
function showView() {
  $('#composeView').hidden = app.view !== 'compose';
  $('#runView').hidden = app.view !== 'run';
  $('#graphView').hidden = app.view !== 'graph';
  $('#graphBtn').classList.toggle('active', app.view === 'graph');
  if (app.view === 'compose') setTimeout(() => $('#task').focus(), 30);
  renderRuns();
  renderTop();
  closeSidebar();
}

function renderTop() {
  const pill = $('#statusPill');
  const st = app.view === 'run' ? app.state : null;
  let [label, cls] = ['Ready', ''];
  if (app.busy && app.live) [label, cls] = st ? PHASE_LABEL[st.phase] || ['Running', 'running'] : ['Starting…', 'running'];
  else if (app.busy) [label, cls] = ['Running in background', 'running'];
  else if (st) [label, cls] = PHASE_LABEL[st.phase] || ['Ready', ''];
  pill.className = `status-pill ${cls}`;
  pill.querySelector('span').textContent = label;
  $('#stopBtn').hidden = !app.busy;
  const showMeta = app.view === 'run' && app.state;
  $('#liveMeta').hidden = !showMeta;
  if (showMeta) {
    const s = app.state;
    const end = app.busy && app.live ? Date.now() : (s.finishedAt || Date.now());
    $('#metaTime').textContent = clock(end - s.startedAt);
    $('#metaCostWrap').hidden = !s.costUsd;
    $('#metaCost').textContent = s.costUsd ? `≈ $${s.costUsd.toFixed(2)}` : '';
    $('#metaCostWrap').title = 'API value – billed to your subscription';
  }
}

// ---------------- run view ----------------
function resetRun() {
  app.state = null;
  app.agents.clear();
  app.openTodos.clear();
  app.editing = null;
  $('#feed').innerHTML = '<div class="feed-empty">Waiting for the first agents…</div>';
  renderRun();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderRun(); });
}

function renderRun() {
  const s = app.state;
  const [label] = s ? PHASE_LABEL[s.phase] || [s.phase] : ['Startet'];
  $('#runEyebrow').innerHTML = s ? `${esc(label)} · ${new Date(s.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}${s.gateway ? ` · <span class="gw-badge" title="${esc(s.gateway)}">⇄ via gateway</span>` : ''}` : 'Starting…';
  $('#runTask').textContent = s?.task || $('#task').value.trim() || '…';
  $('#runSummary').textContent = s?.summary || '';
  $('#runSummary').hidden = !s?.summary;
  if (s?.error && s.phase === 'error') $('#runSummary').innerHTML = `<span style="color:var(--danger)">${esc(s.error)}</span>`, $('#runSummary').hidden = false;

  const todos = s?.todos || [];
  $('#progress').innerHTML = todos.length
    ? todos.map((t) => `<div class="seg-bar ${t.status}" title="${esc(t.id)} · ${esc(t.title)}"></div>`).join('')
    : `<div class="seg-bar ${app.busy && app.live ? 'in_progress' : ''}"></div>`;
  const done = todos.filter((t) => t.status === 'done').length;
  $('#todoCount').textContent = todos.length ? `${done} of ${todos.length} done` : '';
  renderTodos();
  renderLanes();
  renderActions();
  renderTop();
}

function renderActions() {
  const s = app.state;
  const el = $('#runActions');
  if (!s || app.busy) { el.innerHTML = ''; return; }
  const latest = app.runs[0]?.runId === s.runId;
  const btns = [];
  if (latest && s.phase === 'planned') {
    btns.push(`<button class="btn btn-ghost" data-act="add">+ Todo</button>`);
    btns.push(`<button class="btn btn-primary" data-act="resume">${icon(ICONS.play)}Run plan</button>`);
  } else if (latest && (['stopped', 'error'].includes(s.phase) || s.todos.some((t) => ['failed', 'skipped', 'pending'].includes(t.status)))) {
    btns.push(`<button class="btn btn-primary" data-act="resume">${icon(ICONS.loop)}Continue</button>`);
  }
  btns.push(`<button class="btn btn-ghost" data-act="again">Run again, adjusted</button>`);
  el.innerHTML = btns.join('');
}

function todoChips(t) {
  const c = [];
  if (t.checksOk === true) c.push(`<span class="chip ok">${icon(ICONS.check)}Checks</span>`);
  else if (t.checksOk === false) c.push(`<span class="chip bad">${icon(ICONS.x)}Checks</span>`);
  if (t.fixAttempts) c.push(`<span class="chip warn">${icon(ICONS.loop)}${t.fixAttempts}× fix</span>`);
  if (t.unreviewed) c.push(`<span class="chip warn">${icon(ICONS.warn)}unreviewed</span>`);
  if (t.testsMissing) c.push(`<span class="chip warn">${icon(ICONS.warn)}untested</span>`);
  if (t.review) c.push(t.review.approved ? `<span class="chip ok">${icon(ICONS.check)}Review</span>` : `<span class="chip warn">${icon(ICONS.warn)}Review</span>`);
  if (t.changedFiles?.length) c.push(`<span class="chip">${icon(ICONS.file)}${t.changedFiles.length} ${t.changedFiles.length === 1 ? 'file' : 'files'}</span>`);
  if (t.dependsOn?.length) c.push(`<span class="chip">after ${t.dependsOn.map(esc).join(', ')}</span>`);
  return c.length ? `<div class="chips">${c.join('')}</div>` : '';
}

function renderTodos() {
  const s = app.state;
  const el = $('#todos');
  if (!s?.todos?.length) {
    el.innerHTML = `<div class="feed-empty">${app.busy ? 'The planner is creating the todo list…' : 'No todos'}</div>`;
    return;
  }
  const editable = !app.busy && s.phase === 'planned' && app.runs[0]?.runId === s.runId;
  el.innerHTML = s.todos.map((t) => {
    const open = app.openTodos.has(t.id) || app.editing === t.id;
    const statusSvg = { done: ICONS.check, failed: ICONS.x, skipped: ICONS.minus }[t.status];
    const time = t.startedAt ? clock((t.finishedAt || (app.busy && app.live ? Date.now() : t.startedAt)) - t.startedAt) : '';
    let body;
    if (app.editing === t.id) {
      body = `<div class="todo-edit" data-edit="${esc(t.id)}">
        <input name="title" value="${esc(t.title)}" placeholder="Title">
        <textarea name="details" placeholder="Details">${esc(t.details)}</textarea>
        <input name="acceptance" value="${esc(t.acceptance)}" placeholder="Acceptance criterion">
        <div class="todo-edit-actions">
          <button class="btn btn-sm btn-ghost" data-act="delete" data-id="${esc(t.id)}" style="color:var(--danger);margin-right:auto">Delete</button>
          <button class="btn btn-sm btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-sm btn-primary" data-act="save" data-id="${esc(t.id)}">Save</button>
        </div></div>`;
    } else {
      body = `<dl>
        ${t.details ? `<dt>Details</dt><dd>${esc(t.details)}</dd>` : ''}
        ${t.acceptance ? `<dt>Acceptance</dt><dd>${esc(t.acceptance)}</dd>` : ''}
        ${t.review?.summary ? `<dt>Review</dt><dd>${esc(t.review.summary)}</dd>` : ''}
      </dl>
      ${(t.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
      ${t.changedFiles?.length ? `<div class="files">${t.changedFiles.map((f) => `<span class="file" data-diff="${esc(t.id)}" data-file="${esc(f)}">${esc(f)}</span>`).join('')}</div>` : ''}
      <div style="display:flex;gap:8px">
        ${t.hasDiff ? `<button class="btn btn-sm" data-diff="${esc(t.id)}">${icon(ICONS.file)}View diff</button>` : ''}
        ${editable ? `<button class="btn btn-sm btn-ghost" data-act="edit" data-id="${esc(t.id)}">Edit</button>` : ''}
      </div>`;
    }
    return `<div class="todo ${t.status}${open ? ' open' : ''}">
      <div class="todo-row" data-todo="${esc(t.id)}">
        <span class="status-icon ${t.status}"${t.status === 'in_progress' ? ` style="animation-delay:${animDelay(t.startedAt, SPIN_MS)}"` : ''}>${statusSvg ? icon(statusSvg) : ''}</span>
        <div class="todo-main">
          <div class="todo-title"><span class="todo-id">${esc(t.id)}</span><span class="tt">${esc(t.title)}</span></div>
          ${todoChips(t)}
        </div>
        <span class="todo-time">${time}</span>
      </div>
      <div class="todo-body">${body}</div>
    </div>`;
  }).join('');
}

function renderLanes() {
  const team = app.state?.team || {};
  const active = [...app.agents.values()].filter((a) => !a.done);
  $('#teamActive').textContent = active.length ? `${active.length} active` : '';
  const lanes = [...ROLES.map((r) => r.key)];
  $('#lanes').innerHTML = lanes.map((role) => {
    const model = team[role];
    const mine = [...app.agents.values()].filter((a) => a.role === role);
    const cur = mine.filter((a) => !a.done).at(-1);
    const calls = mine.length;
    const totalMs = mine.reduce((sum, a) => sum + (a.ms || (a.done ? 0 : Date.now() - a.t)), 0);
    let status;
    if (cur) {
      const last = cur.tools.at(-1);
      status = `${esc(PHASE[cur.phase] || cur.phase)}${cur.todo ? ' ' + esc(cur.todo) : ''}${last ? ` · <span class="tool">${esc(last.name)} ${esc(last.detail)}</span>` : ' · thinking…'}`;
    } else if (!model) status = 'not in the team';
    else status = calls ? `${calls} ${calls === 1 ? 'call' : 'calls'}` : 'waiting';
    const right = cur ? clock(Date.now() - cur.t) : calls ? clock(totalMs) : '';
    return `<div class="lane${cur ? ' busy' : ''}${model ? '' : ' off'}" style="--role: var(--${role})">
      <div class="lane-avatar">${icon(ICONS[role])}${cur ? ringSvg(cur.t) : ''}</div>
      <div style="min-width:0">
        <div class="lane-name">${ROLE_NAME[role]} <span class="lane-model">${esc(model || '')}</span></div>
        <div class="lane-status">${status}</div>
      </div>
      <div class="lane-right">${right}</div>
    </div>`;
  }).join('');
}

// ---------------- activity feed ----------------
function feedEl() { return $('#feed'); }
function feedAppend(html) {
  const feed = feedEl();
  feed.querySelector('.feed-empty')?.remove();
  feed.insertAdjacentHTML('beforeend', html);
  if ($('#followFeed').checked) feed.scrollTop = feed.scrollHeight;
  return feed.lastElementChild;
}
const evRow = (role, inner, cls = '') => `<div class="ev ${cls}" style="--role: var(--${role})"><span class="mark"></span>${inner}</div>`;
const section = (title, role = 'system') => feedAppend(evRow(role, `<div class="ev-title">${esc(title)}</div>`, 'section'));

function toolLine(t) {
  return `<div class="tool-line${TOOL_EDIT.test(t.name) ? ' edit' : ''}"><b>${esc(t.name)}</b><span>${esc(t.detail)}</span></div>`;
}

function renderAgentTools(a) {
  const el = document.getElementById(`ag-${a.id}`);
  if (!el) return;
  const box = el.querySelector('.tools');
  const MAX = 6;
  const hidden = a.showAll ? 0 : Math.max(0, a.tools.length - MAX);
  box.innerHTML = (hidden ? `<button class="tools-more" data-more="${a.id}">+ ${hidden} earlier actions</button>` : '')
    + a.tools.slice(hidden).map(toolLine).join('');
}

function agentHeader(a) {
  const state = a.error && a.done ? `<span style="color:var(--danger)">✗ ${esc(a.error)}</span>`
    : a.done ? `<span class="ev-meta">✓ ${clock(a.ms || 0)}${a.tools.length ? ` · ${a.tools.length} ${a.tools.length === 1 ? 'Aktion' : 'Aktionen'}` : ''}${a.costUsd ? ` · $${a.costUsd.toFixed(2)}` : ''}</span>`
      : '<span class="spinner"></span>';
  return `<span class="ev-role">${ROLE_NAME[a.role]}</span><span>${esc(PHASE[a.phase] || a.phase)}${a.todo ? ` <span class="ev-meta">${esc(a.todo)}</span>` : ''}</span>${state}`;
}

function applyEvent(ev) {
  switch (ev.type) {
    case 'run.start':
      section('Planning', 'planner');
      break;
    case 'run.resume':
      if (!feedEl().querySelector('.ev')) section('Execution', 'system');
      break;
    case 'plan':
      feedAppend(evRow('planner', `<div class="ev-title"><span class="ev-role">Planner</span><span>created ${ev.todos.length} todos</span></div><div class="ev-text">${esc(ev.summary)}</div>`));
      break;
    case 'todo.start':
      section(`${ev.todo.id} · ${ev.todo.title}`, 'coder');
      break;
    case 'docs.start':
      section('Documentation', 'docs');
      break;
    case 'agent.start': {
      const a = { ...ev, tools: [], done: false };
      app.agents.set(ev.id, a);
      feedAppend(`<div class="ev" id="ag-${ev.id}" style="--role: var(--${ev.role})"><span class="mark"></span>
        <div class="ev-title">${agentHeader(a)}</div><div class="tools"></div><div class="ev-text" hidden></div></div>`);
      break;
    }
    case 'agent.tool': {
      const a = app.agents.get(ev.id);
      if (!a) break;
      a.tools.push({ name: ev.name, detail: ev.detail });
      renderAgentTools(a);
      if ($('#followFeed').checked) feedEl().scrollTop = feedEl().scrollHeight;
      break;
    }
    case 'agent.done':
    case 'agent.error': {
      const a = app.agents.get(ev.id);
      if (!a) break;
      if (ev.type === 'agent.error') {
        if (ev.willRetry) { a.tools.push({ name: 'Fehler', detail: `${ev.error} → neuer Versuch` }); renderAgentTools(a); break; }
        a.error = ev.error;
      } else {
        Object.assign(a, { ms: ev.ms, costUsd: ev.costUsd, text: ev.text });
      }
      a.done = true;
      const el = document.getElementById(`ag-${ev.id}`);
      if (el) {
        el.querySelector('.ev-title').innerHTML = agentHeader(a);
        if (a.text) { const t = el.querySelector('.ev-text'); t.textContent = a.text; t.hidden = false; }
      }
      break;
    }
    case 'checks': {
      const syn = ev.syntax.filter((s) => !s.skipped);
      const bad = syn.filter((s) => !s.ok);
      const chips = [];
      if (syn.length) chips.push(bad.length ? `<span class="chip bad">${icon(ICONS.x)}syntax ${bad.length}/${syn.length}</span>` : `<span class="chip ok">${icon(ICONS.check)}syntax · ${syn.length} ${syn.length === 1 ? 'file' : 'files'}</span>`);
      for (const c of ev.commands) chips.push(`<span class="chip ${c.ok ? 'ok' : 'bad'}">${icon(c.ok ? ICONS.check : ICONS.x)}<span class="mono">${esc(c.cmd)}</span></span>`);
      if (!chips.length) chips.push('<span class="chip">nothing to check</span>');
      const outs = [...bad.map((s) => s.output), ...ev.commands.filter((c) => !c.ok).map((c) => c.output)]
        .filter(Boolean).map((o) => `<pre class="out bad">${esc(o)}</pre>`).join('');
      feedAppend(evRow('checker', `<div class="ev-title"><span class="ev-role">Checker</span></div><div class="check-row">${chips.join('')}</div>${outs}`));
      break;
    }
    case 'fix':
      feedAppend(evRow('checker', `<div class="ev-title"><span class="ev-role">Checker</span><span style="color:var(--warn)">back to the coder · fix attempt ${ev.attempt}/${ev.max}</span></div>`));
      break;
    case 'review': {
      const verdict = ev.approved ? '<span class="chip ok">✓ approved</span>' : ev.blocking ? '<span class="chip warn">changes needed</span>' : '<span class="chip ok">✓ ok, nitpicks only</span>';
      const issues = (ev.issues || []).map((i) => `<div class="issue"><span class="sev ${esc(i.severity)}">${esc(i.severity)}</span><div><code>${esc(i.file)}</code> ${esc(i.description)}</div></div>`).join('');
      feedAppend(evRow('reviewer', `<div class="ev-title"><span class="ev-role">Reviewer</span>${verdict}${ev.round > 1 ? `<span class="ev-meta">round ${ev.round}</span>` : ''}</div><div class="ev-text">${esc(ev.summary)}</div>${issues}`));
      break;
    }
    case 'note':
      feedAppend(evRow('reviewer', `<div class="ev-title" style="color:var(--warn)">${esc(ev.text)}</div>`));
      break;
    case 'todo.done': {
      const t = ev.todo;
      const map = { done: ['done', 'ok'], failed: ['failed', 'bad'], skipped: ['skipped', ''], pending: ['interrupted', 'warn'] };
      const [txt, cls] = map[t.status] || [t.status, ''];
      feedAppend(evRow('system', `<div class="ev-title"><span class="chip ${cls}">${esc(t.id)} ${txt}</span></div>`));
      break;
    }
    case 'run.done':
      section('Finished', 'checker');
      break;
    case 'run.stopped':
      section('Stopped', 'reviewer');
      break;
    case 'run.error':
      feedAppend(evRow('system', `<div class="ev-title" style="color:var(--danger)">Error: ${esc(ev.error)}</div>`));
      break;
    default:
  }
}

function finalizeAgents() {
  // In history (or after a stop) agents without a done-event are not running anymore.
  for (const a of app.agents.values()) {
    if (a.done) continue;
    a.done = true; a.error = 'aborted';
    const el = document.getElementById(`ag-${a.id}`);
    if (el) el.querySelector('.ev-title').innerHTML = agentHeader(a);
  }
}

// ---------------- live stream ----------------
let stream = null;
let firstHello = true;

// (Re)connects. The server answers with 'hello' and, if a run is active, replays its events –
// so a reconnect simply rebuilds the live view from scratch.
function connect() {
  stream?.close();
  stream = new EventSource(withToken('/api/events'));
  stream.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'hello') {
      app.busy = ev.busy;
      if (ev.busy && (firstHello || app.live)) {
        resetRun();
        app.live = true;
        if (firstHello) { app.view = 'run'; showView(); }
      }
      firstHello = false;
      renderTop();
      return;
    }
    if (ev.type === 'busy') {
      app.busy = ev.busy;
      if (!ev.busy) finalizeAgents();
      refreshRuns().then(() => { if (app.live) scheduleRender(); });
      scheduleRender();
      return;
    }
    if (!app.live) return;
    if (ev.type === 'state') {
      app.state = ev.state;
      app.viewingRunId = ev.state.runId;
      scheduleRender();
      return;
    }
    if (['run.start', 'plan', 'todo.done'].includes(ev.type) && !ev.replay) refreshRuns();
    applyEvent(ev);
    if (ev.type.startsWith('agent.')) renderLanes();
    if (ev.type === 'run.done' && !ev.replay) toast('Job finished', 'success');
    if (ev.type === 'run.error' && !ev.replay) toast(ev.error, 'error');
  };
}

async function openRun(runId) {
  if (app.busy && app.live && app.state?.runId === runId) { app.view = 'run'; showView(); return; }
  try {
    const data = await api('GET', `/api/runs/${encodeURIComponent(runId)}`);
    resetRun();
    app.live = false;
    app.view = 'run';
    app.viewingRunId = runId;
    app.state = data.state;
    for (const ev of data.events) applyEvent({ ...ev, replay: true });
    finalizeAgents();
    if (!data.events.length) feedAppend('<div class="feed-empty">No activity log</div>');
    showView();
    renderRun();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------- diff drawer ----------------
function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) {
      cur = { name: line.replace(/^--- (a\/)?/, ''), lines: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('+++ ')) continue;
    if (line.startsWith('+')) cur.add++;
    else if (line.startsWith('-')) cur.del++;
    cur.lines.push(line);
  }
  return files;
}

async function openDiff(todoId, fileName) {
  const runId = app.state?.runId;
  if (!runId) return;
  try {
    const { diff } = await api('GET', `/api/runs/${encodeURIComponent(runId)}/diff/${encodeURIComponent(todoId)}`);
    const files = parseDiff(diff || '');
    const todo = app.state.todos.find((t) => t.id === todoId);
    $('#drawerEyebrow').textContent = `${todoId} · ${files.length} ${files.length === 1 ? 'file' : 'files'}`;
    $('#drawerTitle').textContent = todo?.title || 'Changes';
    const show = (name) => {
      $('#fileTabs').innerHTML = [{ name: null }, ...files].map((f) => `<button data-file="${esc(f.name ?? '')}" class="${(f.name ?? null) === name ? 'on' : ''}">${f.name ? esc(f.name) + `<span class="n add">+${f.add}</span><span class="n del">−${f.del}</span>` : 'All'}</button>`).join('');
      const list = name ? files.filter((f) => f.name === name) : files;
      $('#diffBody').innerHTML = list.length ? list.map((f) => `<div class="dl file-h"><span></span><span>${esc(f.name)}</span></div>` + f.lines.map((l) => {
        const c = l[0];
        if (l.startsWith('@@')) return `<div class="dl hunk"><span></span><span>⋯</span></div>`;
        const cls = c === '+' ? 'add' : c === '-' ? 'del' : '';
        return `<div class="dl ${cls}"><span class="sign">${c === '+' || c === '-' ? c : ''}</span><span>${esc(l.slice(1))}</span></div>`;
      }).join('')).join('') : '<div class="diff-empty">No changes recorded.</div>';
      $('#fileTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.file || null); };
    };
    show(fileName && files.some((f) => f.name === fileName) ? fileName : null);
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerScrim').hidden = false;
  } catch (e) { toast(e.message, 'error'); }
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawerScrim').hidden = true;
}

// ---------------- run view interactions ----------------
async function saveTodos(todos) {
  try {
    app.state = await api('PUT', '/api/todos', { todos });
    app.editing = null;
    renderRun();
  } catch (e) { toast(e.message, 'error'); }
}

function bindRunView() {
  $('#todos').addEventListener('click', (e) => {
    const diffBtn = e.target.closest('[data-diff]');
    if (diffBtn) { openDiff(diffBtn.dataset.diff, diffBtn.dataset.file); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const todos = app.state.todos.map((t) => ({ ...t }));
      const id = act.dataset.id;
      if (act.dataset.act === 'edit') { app.editing = id; renderTodos(); }
      if (act.dataset.act === 'cancel') { app.editing = null; renderTodos(); }
      if (act.dataset.act === 'delete') saveTodos(todos.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })));
      if (act.dataset.act === 'save') {
        const form = act.closest('[data-edit]');
        const t = todos.find((x) => x.id === id);
        for (const k of ['title', 'details', 'acceptance']) t[k] = form.querySelector(`[name=${k}]`).value;
        saveTodos(todos);
      }
      return;
    }
    if (e.target.closest('.todo-body')) return;
    const row = e.target.closest('[data-todo]');
    if (row) {
      const id = row.dataset.todo;
      app.openTodos.has(id) ? app.openTodos.delete(id) : app.openTodos.add(id);
      renderTodos();
    }
  });
  $('#runActions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'resume') {
      try {
        app.live = true;
        await api('POST', '/api/resume', formBody(app.state.task));
      } catch (err) { toast(err.message, 'error'); }
    }
    if (b.dataset.act === 'again') {
      $('#task').value = app.state.task;
      app.view = 'compose'; app.live = false; showView();
    }
    if (b.dataset.act === 'add') {
      const ids = new Set(app.state.todos.map((t) => t.id));
      let n = app.state.todos.length + 1;
      while (ids.has(`T${n}`)) n++;
      const todos = [...app.state.todos, { id: `T${n}`, title: 'Neues Todo', details: '', acceptance: '', dependsOn: [] }];
      await saveTodos(todos);
      app.editing = `T${n}`;
      renderTodos();
    }
  });
  $('#feed').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { const a = app.agents.get(Number(more.dataset.more)); a.showAll = true; renderAgentTools(a); return; }
    const txt = e.target.closest('.ev-text');
    if (txt) txt.classList.toggle('expanded');
  });
}

// ---------------- chrome ----------------
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }

function bindChrome() {
  $('#newBtn').onclick = () => { app.view = 'compose'; app.live = false; showView(); };
  $('#brand').onclick = (e) => { e.preventDefault(); $('#newBtn').click(); };
  $('#runs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    const isLive = app.busy && app.runs[0]?.runId === b.dataset.run;
    if (isLive) {
      app.view = 'run';
      if (!app.live) { app.live = true; connect(); }
      showView();
    } else openRun(b.dataset.run);
  });
  $('#stopBtn').onclick = async () => {
    try { await api('POST', '/api/stop'); toast('Stopping…'); } catch (e) { toast(e.message, 'error'); }
  };
  $('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); };
  $('#scrim').onclick = closeSidebar;
  $('#drawerClose').onclick = closeDrawer;
  $('#drawerScrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

// ---------------- boot ----------------
async function boot() {
  initTheme();
  authToken = loadToken();
  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    authToken = $('#tokenInput').value.trim();
    try { localStorage.setItem('agentci-ui-token', authToken); } catch { /* private mode */ }
    $('#gate').hidden = true;
    boot();
  });
  bindChrome();
  bindCompose();
  bindRunView();
  bindGraph();
  try {
    app.status = await api('GET', '/api/status');
  } catch (e) {
    if (e.message !== 'token required') toast(`Server not reachable: ${e.message}`, 'error');
    return; // the gate is already showing
  }
  $('#workspace').textContent = app.status.cwd;
  $('#workspace').title = `Working directory: ${app.status.cwd}`;
  app.busy = app.status.busy;
  renderProviders();
  initForm();
  renderGateway();
  bindGateway();
  await refreshRuns();
  showView();
  connect();
  setInterval(() => {
    if (app.view === 'run' && app.busy && app.live) { renderLanes(); renderTop(); }
  }, 1000);
}

boot();

// ---------------- project graph (built by agentci, not by an AI) ----------------
const LANG_COLOR = { js: 'var(--coder)', ts: 'var(--accent-2)', py: 'var(--tester)', go: 'var(--checker)', rs: 'var(--reviewer)', rb: 'var(--danger)', php: 'var(--planner)' };
const graph = { data: null, view: { x: 0, y: 0, k: 1 }, focus: null, layout: null, collapsed: new Set(), base: null };
const isTestFile = (p) => /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\./.test(p);

async function loadGraph(force) {
  if (graph.data && !force) return renderGraph();
  $('#graphStats').textContent = 'scanning…';
  try {
    graph.data = await api('GET', '/api/codemap');
    // Folders with many files start collapsed so the picture stays readable.
    if (!graph.collapsedInit) {
      graph.collapsedInit = true;
      const perDir = new Map();
      for (const n of graph.data.nodes) perDir.set(n.dir, (perDir.get(n.dir) || 0) + 1);
      for (const [dir, count] of perDir) if (count > 10) graph.collapsed.add(dir);
    }
    renderGraph();
  } catch (e) {
    $('#graphStats').textContent = e.message;
  }
}

function layoutGraph(data, maxWidth = 1500) {
  const byDir = new Map();
  for (const n of data.nodes) {
    if (!byDir.has(n.dir)) byDir.set(n.dir, []);
    byDir.get(n.dir).push(n);
  }
  const NH = 26; const GAP = 7; const PAD = 12; const HEAD = 24;
  const groups = [...byDir].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, list]) => {
    list.sort((a, b) => b.dependents - a.dependents || a.name.localeCompare(b.name));
    const w = Math.max(150, ...list.map((n) => Math.min(260, 26 + n.name.length * 7.3)), dir.length * 6.5 + 20) + PAD * 2;
    return { dir, list, w, h: HEAD + PAD + list.length * (NH + GAP) + PAD };
  });
  let x = 0; let y = 0; let rowH = 0;
  for (const g of groups) {
    if (x + g.w > maxWidth && x > 0) { x = 0; y += rowH + 26; rowH = 0; }
    g.x = x; g.y = y;
    g.list.forEach((n, i) => {
      n.w = g.w - PAD * 2; n.h = NH;
      n.x = g.x + PAD; n.y = g.y + HEAD + PAD + i * (NH + GAP);
    });
    x += g.w + 26;
    rowH = Math.max(rowH, g.h);
  }
  const width = Math.max(...groups.map((g) => g.x + g.w), 300) + 20;
  const height = y + rowH + 20;
  return { groups, width, height, byId: new Map(data.nodes.map((n) => [n.id, n])) };
}

function visibleData() {
  const d = graph.data;
  if (!d) return null;
  const hideTests = $('#graphHideTests')?.checked;
  let nodes = d.nodes.filter((n) => !(hideTests && isTestFile(n.id)));

  // Collapsed folders become a single node so big projects stay readable.
  const alias = new Map();
  const folders = new Map();
  nodes = nodes.filter((n) => {
    if (!graph.collapsed.has(n.dir)) return true;
    const id = `dir:${n.dir}`;
    alias.set(n.id, id);
    const f = folders.get(id) || { id, dir: n.dir, name: n.dir || '/', lang: 'dir', loc: 0, exports: [], deps: 0, dependents: 0, changed: false, folder: true, count: 0 };
    f.count++;
    f.loc += n.loc || 0;
    f.changed = f.changed || n.changed;
    folders.set(id, f);
    return false;
  });
  for (const f of folders.values()) f.name = `${f.dir || '/'} · ${f.count}`;
  nodes = [...nodes, ...folders.values()];

  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const edges = [];
  for (const e of d.edges) {
    const from = alias.get(e.from) || e.from;
    const to = alias.get(e.to) || e.to;
    const key = `${from}->${to}`;
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  for (const n of nodes) {
    if (!n.folder) continue;
    n.deps = edges.filter((e) => e.from === n.id).length;
    n.dependents = edges.filter((e) => e.to === n.id).length;
  }
  return { ...d, nodes, edges };
}

function renderGraph() {
  const data = visibleData();
  const svg = $('#graphSvg');
  if (!data?.nodes?.length) {
    svg.innerHTML = '';
    $('#graphStats').textContent = 'No code files found.';
    $('#graphLegend').innerHTML = '';
    return;
  }
  const box = $('#graphSvg').getBoundingClientRect();
  const target = box.width && box.height ? box.width / box.height : 2;
  // layoutGraph writes x/y onto the node objects, so pick the width first, then lay out once.
  let best = { w: 1100, score: Infinity };
  for (const w of [700, 900, 1100, 1300, 1600, 2000, 2500]) {
    const cand = layoutGraph(data, w);
    const score = Math.abs(cand.width / cand.height - target);
    if (score < best.score) best = { w, score };
  }
  const L = layoutGraph(data, best.w);
  graph.layout = L;
  const q = $('#graphSearch').value.trim().toLowerCase();
  const neighbours = new Set();
  if (graph.focus) {
    neighbours.add(graph.focus);
    for (const e of data.edges) {
      if (e.from === graph.focus) neighbours.add(e.to);
      if (e.to === graph.focus) neighbours.add(e.from);
    }
  }
  const dim = (id) => (graph.focus && !neighbours.has(id)) || (q && !id.toLowerCase().includes(q));

  const edges = data.edges.map((e) => {
    const a = L.byId.get(e.from); const b = L.byId.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + a.w; const y1 = a.y + a.h / 2;
    const x2 = b.x; const y2 = b.y + b.h / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.4);
    const on = graph.focus && (e.from === graph.focus || e.to === graph.focus);
    if ($('#graphOnlySel')?.checked && !on) return '';
    return `<path class="gedge${on ? ' on' : ''}${dim(e.from) && dim(e.to) ? ' dim' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#arrow${on ? '-on' : ''})"/>`;
  }).join('');

  const groupBoxes = L.groups.map((g) => `
    <g class="ggroup" data-dir="${esc(g.dir)}">
      <rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="12"/>
      <text class="gdir" x="${g.x + 12}" y="${g.y + 17}">${esc(g.dir || '/')}${g.list.length > 1 ? ` ▾` : ''}</text>
    </g>`).join('');

  const touched = graph.data.touched || {};
  const nodes = L.groups.flatMap((g) => g.list).map((n) => {
    const t = touched[n.id];
    const right = t ? `<text class="gtodo" x="${n.w - 8}" y="${n.h / 2 + 4}">${esc(t.todo)}</text>`
      : n.dependents ? `<text class="gcount" x="${n.w - 8}" y="${n.h / 2 + 4}">${n.dependents}←</text>` : '';
    return `
    <g class="gnode${dim(n.id) ? ' dim' : ''}${n.changed ? ' changed' : ''}${graph.focus === n.id ? ' focus' : ''}${n.folder ? ' folder' : ''}" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})">
      <rect width="${n.w}" height="${n.h}" rx="8" style="--lang: ${LANG_COLOR[n.lang] || 'var(--docs)'}"/>
      ${n.folder
        ? `<path class="gfolder" d="M7,${n.h / 2 - 4} h4 l1.5,2 h4 v6 h-9.5 z" />`
        : `<circle cx="11" cy="${n.h / 2}" r="3.5" style="fill: ${LANG_COLOR[n.lang] || 'var(--docs)'}"/>`}
      <text x="22" y="${n.h / 2 + 4}">${esc(n.name)}</text>
      ${right}
    </g>`;
  }).join('');

  svg.innerHTML = `<defs>
      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,1 L7,4 L0,7 z"/></marker>
      <marker id="arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path class="on" d="M0,1 L7,4 L0,7 z"/></marker>
    </defs>
    <g id="gviewport">${groupBoxes}${edges}${nodes}</g>`;
  // Measure what was actually drawn – node labels and edges can reach past the computed boxes.
  const bb = document.getElementById('gviewport').getBBox();
  const pad = 16;
  graph.base = { x: bb.x - pad, y: bb.y - pad, w: bb.width + pad * 2, h: bb.height + pad * 2 };
  applyTransform();

  const touchedList = Object.entries(graph.data.touched || {});
  const roles = [...new Set(touchedList.flatMap(([, t]) => t.roles || []))];
  $('#graphStats').innerHTML = `${graph.data.nodes.length} code files · ${graph.data.edges.length} dependencies`
    + (graph.collapsed.size ? ` · ${graph.collapsed.size} folder(s) collapsed (click the folder name)` : '')
    + (touchedList.length ? ` · <span style="color:var(--success)">${touchedList.length} files changed in the last run</span>` : '')
    + ' · click a file to see its code';
  const langs = [...new Set(data.nodes.map((n) => n.lang))].filter((l) => l !== 'dir').sort();
  $('#graphLegend').innerHTML = langs.map((l) => `<span class="glegend"><i style="background:${LANG_COLOR[l] || 'var(--docs)'}"></i>${esc(l)}</span>`).join('')
    + (touchedList.length ? `<span class="glegend"><i class="ring"></i>changed by ${roles.map((r) => ROLE_NAME[r] || r).join(' & ') || 'agents'}</span>` : '')
    + (graph.collapsed.size ? '<span class="glegend"><i style="background:var(--docs)"></i>collapsed folder</span>' : '');
}

function applyTransform() {
  // Zoom/pan by moving the viewBox, not by transforming a <g>: a scaled transform makes
  // Chrome rasterise the subtree, which is what made the labels look blurry.
  const svg = $('#graphSvg');
  const base = graph.base;
  if (!svg || !base) return;
  const k = graph.view.k;
  const w = base.w / k;
  const h = base.h / k;
  const cx = base.x + base.w / 2 - graph.view.x / k;
  const cy = base.y + base.h / 2 - graph.view.y / k;
  svg.setAttribute('viewBox', `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
}

function bindGraph() {
  const svg = $('#graphSvg');
  // Dragging captures the pointer, which would swallow a normal click event – so decide
  // between "click" and "drag" ourselves from the pointer down/up pair.
  const handleClick = (target) => {
    const node = target.closest?.('.gnode');
    if (node) {
      const id = node.dataset.id;
      if (id.startsWith('dir:')) { graph.collapsed.delete(id.slice(4)); renderGraph(); return; }
      graph.focus = graph.focus === id ? null : id;
      renderGraph();
      openCode(id);
      return;
    }
    const dir = target.closest?.('.ggroup');
    if (dir) {
      const d = dir.dataset.dir;
      graph.collapsed.has(d) ? graph.collapsed.delete(d) : graph.collapsed.add(d);
      renderGraph();
    }
  };
  svg.addEventListener('mousemove', (e) => {
    const node = e.target.closest('.gnode');
    const tip = $('#graphTip');
    if (!node) { tip.hidden = true; return; }
    const n = graph.layout?.byId.get(node.dataset.id);
    if (!n) return;
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(n.id)}</b><br>${n.loc} lines · ${n.deps} imports · ${n.dependents} dependents`
      + (n.exports.length ? `<br><span class="muted">exports: ${esc(n.exports.slice(0, 8).join(', '))}</span>` : '');
    const box = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - 260)}px`;
    tip.style.top = `${e.clientY - box.top + 14}px`;
  });
  svg.addEventListener('mouseleave', () => { $('#graphTip').hidden = true; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = Math.min(3, Math.max(0.2, graph.view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    graph.view.k = k;
    applyTransform();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    drag = { px: e.clientX, py: e.clientY, vx: graph.view.x, vy: graph.view.y, target: e.target, moved: 0 };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py));
    if (drag.moved > 3) svg.classList.add('dragging');
    const box = svg.getBoundingClientRect();
    const unitsPerPx = graph.base ? (graph.base.w / graph.view.k) / box.width : 1;
    graph.view.x = drag.vx + (e.clientX - drag.px) * unitsPerPx * graph.view.k;
    graph.view.y = drag.vy + (e.clientY - drag.py) * unitsPerPx * graph.view.k;
    applyTransform();
  });
  const endDrag = () => {
    if (drag && drag.moved <= 3) handleClick(drag.target);
    drag = null;
    svg.classList.remove('dragging');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  $('#graphFit').onclick = () => { graph.view = { x: 0, y: 0, k: 1 }; applyTransform(); };
  $('#graphReload').onclick = () => loadGraph(true);
  $('#graphSearch').addEventListener('input', () => renderGraph());
  $('#graphHideTests').addEventListener('change', () => renderGraph());
  $('#graphOnlySel').addEventListener('change', () => renderGraph());
  $('#graphBtn').onclick = () => { app.view = 'graph'; showView(); loadGraph(); };
}


// ---------------- code viewer ----------------
const KEYWORDS = /^(const|let|var|function|class|extends|return|if|else|for|while|do|switch|case|break|continue|import|from|export|default|await|async|new|try|catch|finally|throw|typeof|instanceof|delete|in|of|this|null|undefined|true|false|void|yield|static|get|set|def|elif|lambda|None|True|False|self|pass|raise|with|as|not|and|or|print|func|package|type|struct|interface|range|go|defer|nil)$/;
const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

function highlight(code) {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, num, word] = m;
    if (comment) out += `<span class="c-com">${esc(tok)}</span>`;
    else if (str) out += `<span class="c-str">${esc(tok)}</span>`;
    else if (num) out += `<span class="c-num">${esc(tok)}</span>`;
    else if (word && KEYWORDS.test(word)) out += `<span class="c-kw">${esc(tok)}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

async function openCode(file) {
  const node = graph.layout?.byId.get(file) || graph.data?.nodes.find((n) => n.id === file);
  const touched = graph.data?.touched?.[file];
  $('#drawerEyebrow').innerHTML = touched
    ? `${esc(touched.todo)} · changed by ${esc((touched.roles || []).map((r) => ROLE_NAME[r] || r).join(' & '))}`
    : 'File from the project map';
  $('#drawerTitle').textContent = file;
  $('#fileTabs').innerHTML = node
    ? `<span class="tab-info">${node.loc || 0} lines · ${node.deps} imports · ${node.dependents} dependents${node.exports?.length ? ` · exports: ${esc(node.exports.slice(0, 6).join(', '))}` : ''}</span>`
    : '';
  $('#diffBody').innerHTML = '<div class="diff-empty">loading…</div>';
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawerScrim').hidden = false;
  try {
    const data = await api('GET', `/api/file?path=${encodeURIComponent(file)}`);
    const lines = data.content.split('\n');
    $('#diffBody').innerHTML = `<div class="code">${lines.map((l, i) => `<div class="cl"><span class="ln">${i + 1}</span><span class="lc">${highlight(l) || '&nbsp;'}</span></div>`).join('')}</div>`
      + (data.truncated ? '<div class="diff-empty">… file truncated</div>' : '');
  } catch (e) {
    $('#diffBody').innerHTML = `<div class="diff-empty">${esc(e.message)}</div>`;
  }
}
