// Monitor for the agentci gateway: who is connected, what is running right now, what ran before.
// Read-only except for deleting a mirrored workspace.

import { ringSvg } from '/phase.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;

const ICONS = {
  planner: '<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>',
  coder: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  reviewer: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8.5 11l2 2 3.5-4"/>',
  tester: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
  docs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const PHASE = { plan: 'planning', implement: 'implementing', fix: 'fixing', review: 'reviewing', test: 'writing tests', docs: 'writing docs' };
const ROLE_NAME = { planner: 'Planner', coder: 'Coder', reviewer: 'Reviewer', tester: 'Tester', docs: 'Docs' };

const state = { token: '', data: null, log: [], stream: null, timer: null };

// ---------- helpers ----------
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const uptime = (ms) => {
  const d = Math.floor(ms / 86400000);
  return d ? `${d} d ${clock(ms % 86400000)}` : clock(ms);
};
const bytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(method, path) {
  const res = await fetch(path, { method, headers: { Authorization: `Bearer ${state.token}` } });
  if (res.status === 401) { showGate('token rejected'); throw new Error('401'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ---------- token gate ----------
function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { localStorage.setItem('agentci-gw-token', fromUrl); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname); // keep the token out of the address bar
    return fromUrl;
  }
  try { return localStorage.getItem('agentci-gw-token') || ''; } catch { return ''; }
}

function showGate(error) {
  state.stream?.abort();
  clearInterval(state.timer);
  $('#gate').hidden = false;
  $('#main').hidden = true;
  $('#logout').hidden = true;
  $('#gateError').hidden = !error;
  $('#gateError').textContent = error || '';
  setPill('', 'not signed in');
  setTimeout(() => $('#tokenInput').focus(), 50);
}

function setPill(cls, text) {
  $('#pill').className = `status-pill ${cls}`;
  $('#pill').querySelector('span').textContent = text;
}

// ---------- rendering ----------
function render() {
  const d = state.data;
  if (!d) return;
  $('#hostChip').hidden = false;
  $('#hostChip').textContent = `${d.host} · ${d.tls ? 'TLS' : 'HTTP'}`;
  $('#meta').hidden = false;
  $('#uptime').textContent = uptime(d.stats.uptimeMs);

  const s = d.stats;
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  $('#kpis').innerHTML = [
    kpi('Calls', s.total, s.failed ? `<span class="bad">${s.failed} failed</span>` : 'all succeeded'),
    kpi('Active', d.active.length, d.active.length ? 'working right now' : 'idle'),
    kpi('Clients', d.clients.length, d.clients.length ? `last ${ago(d.clients[0].lastSeen)}` : 'none'),
    kpi('API value', `$${s.costUsd.toFixed(2)}`, 'billed to the subscriptions here'),
    kpi('Transferred', `${bytes(s.bytesIn)} ↑`, `${bytes(s.bytesOut)} ↓ back`),
    kpi('Rejected', s.authFailures, 'wrong token'),
  ].join('');

  renderActive();
  $('#recentCount').textContent = d.recent.length ? `${d.recent.length} stored` : '';
  $('#recent').innerHTML = d.recent.length
    ? d.recent.slice(0, 40).map(callRow).join('')
    : '<div class="empty">Nothing has run yet.</div>';

  const p = d.providers || {};
  const hrow = (name, i) => {
    const ok = i.installed && i.loggedIn && i.toolsOk !== false;
    const txt = !i.installed ? 'not installed' : !i.loggedIn ? 'not signed in' : i.toolsOk === false ? i.problem : (i.apiKeyOverride ? 'API key active' : 'subscription connected');
    return `<div class="hrow ${ok ? 'ok' : 'bad'}"><i></i><b>${name}</b><span>${esc(txt)}</span></div>`;
  };
  $('#health').innerHTML = hrow('Claude', p.claude || {}) + hrow('Codex', p.codex || {})
    + `<div class="hrow ${d.tls ? 'ok' : 'warn'}"><i></i><b>Transport</b><span>${d.tls ? 'TLS active' : 'HTTP – trusted networks only'}</span></div>`
    + `<div class="hrow"><b>Data</b><span class="mono">${esc(d.dataDir)}</span></div>`;

  $('#clientCount').textContent = d.clients.length || '';
  $('#clients').innerHTML = d.clients.length ? d.clients.map((c) => `
    <div class="client">
      <div class="client-main">
        <div class="client-name">${esc(c.project || 'project?')} <span class="muted">${esc(c.client || c.ip)}</span></div>
        <div class="client-sub">${c.calls} calls · $${(c.costUsd || 0).toFixed(2)} · ${ago(c.lastSeen)}</div>
      </div>
      <span class="mono ip">${esc(c.ip || '')}</span>
    </div>`).join('') : '<div class="empty">No client connected yet.</div>';

  const ws = d.workspaces || [];
  $('#wsTotal').textContent = ws.length ? `${bytes(ws.reduce((n, w) => n + w.mirrorBytes, 0))} mirrored · ${bytes(ws.reduce((n, w) => n + w.bytes, 0))} on disk` : '';
  $('#workspaces').innerHTML = ws.length ? ws.map((w) => `
    <div class="ws">
      <div>
        <div class="mono ws-id">${esc(w.session.slice(0, 16))}…</div>
        <div class="client-sub" title="${w.mirrorFiles} files were mirrored; the rest are dependencies and build folders the agents created here.">${w.mirrorFiles} files mirrored (${bytes(w.mirrorBytes)}) · ${bytes(w.bytes)} total · ${ago(w.lastUsed)}</div>
      </div>
      <button class="icon-btn" data-del="${esc(w.session)}" title="Delete mirror">${icon(ICONS.trash)}</button>
    </div>`).join('') : '<div class="empty">No mirrored projects.</div>';
}

function renderActive() {
  const list = state.data?.active || [];
  $('#activeCount').textContent = list.length ? `${list.length} active` : '';
  $('#active').innerHTML = list.length ? list.map((c) => `
    <div class="acall${c.waiting ? ' waiting' : ''}" style="--role: var(--${c.role || 'coder'})">
      <div class="acall-icon">${icon(ICONS[c.role] || ICONS.coder)}${ringSvg(c.startedAt || c.queuedAt)}</div>
      <div class="acall-main">
        <div class="acall-title">
          <b>${ROLE_NAME[c.role] || c.role || 'Agent'}</b> ${esc(PHASE[c.phase] || c.phase || '')}
          ${c.todo ? `<span class="chip">${esc(c.todo)}</span>` : ''}
          <span class="chip">${esc(c.provider)}${c.model ? ':' + esc(c.model) : ''}</span>
          ${c.canEdit ? '' : '<span class="chip">read-only</span>'}
        </div>
        <div class="acall-sub">${esc(c.project || '–')} <span class="muted">· ${esc(c.client || c.ip)}</span></div>
        <div class="acall-tool mono">${c.waiting ? 'waiting for the workspace (another call is writing)' : c.lastTool ? `${esc(c.lastTool.name)} ${esc(c.lastTool.detail)}` : 'thinking…'}</div>
      </div>
      <div class="acall-time">${c.waiting ? `⏳ ${clock(Date.now() - c.queuedAt)}` : clock(Date.now() - c.startedAt)}</div>
    </div>`).join('') : '<div class="empty">Nothing is running.</div>';
}

function callRow(c) {
  const status = c.ok ? '<span class="chip ok">ok</span>' : `<span class="chip bad" title="${esc(c.error || '')}">error</span>`;
  return `<div class="call">
    <span class="call-dot" style="background: var(--${c.role || 'docs'})"></span>
    <div class="call-main">
      <div class="call-title">${ROLE_NAME[c.role] || c.role || '–'} <span class="muted">${esc(PHASE[c.phase] || c.phase || '')}</span> ${status}</div>
      <div class="client-sub">${esc(c.project || '–')} · ${esc(c.provider)}${c.model ? ':' + esc(c.model) : ''} · ${c.toolCount} actions${c.bytesOut ? ` · ${bytes(c.bytesOut)} back` : ''}${c.error ? ` · <span class="bad">${esc(String(c.error).slice(0, 80))}</span>` : ''}</div>
    </div>
    <div class="call-right">${c.ms != null ? clock(c.ms) : ''}<div class="client-sub">${c.costUsd ? `$${c.costUsd.toFixed(2)}` : ''}</div></div>
  </div>`;
}

function addLog(ev) {
  const text = {
    'call.start': () => `${ROLE_NAME[ev.call.role] || ev.call.role || 'Agent'} ${PHASE[ev.call.phase] || ev.call.phase || ''} · ${ev.call.project || ev.call.client || ev.call.ip}`,
    'call.end': () => `${ROLE_NAME[ev.call.role] || ev.call.role || 'Agent'} ${ev.call.ok ? 'finished' : 'error: ' + (ev.call.error || '')} · ${clock(ev.call.ms || 0)}`,
    'auth.failure': () => `Rejected: wrong token from ${ev.ip}`,
    note: () => ev.text,
  }[ev.type];
  if (!text) return;
  const cls = ev.type === 'auth.failure' ? 'bad' : ev.type === 'call.end' && !ev.call.ok ? 'bad' : ev.type === 'call.start' ? 'start' : '';
  const el = document.createElement('div');
  el.className = `logline ${cls}`;
  el.innerHTML = `<span class="mono t">${time(ev.t)}</span> ${esc(text())}`;
  $('#log').append(el);
  while ($('#log').childElementCount > 300) $('#log').firstElementChild.remove();
  if ($('#followLog').checked) $('#log').scrollTop = $('#log').scrollHeight;
}

// ---------- live stream ----------
async function connectStream() {
  state.stream?.abort();
  const ac = new AbortController();
  state.stream = ac;
  try {
    const res = await fetch('/v1/monitor/stream', { headers: { Authorization: `Bearer ${state.token}` }, signal: ac.signal });
    if (res.status === 401) return showGate('Token abgelehnt');
    setPill('running', 'live');
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'ping' || ev.type === 'hello') continue;
        addLog(ev);
        if (ev.type === 'call.tool' && state.data) {
          const c = state.data.active.find((a) => a.id === ev.id);
          if (c) { c.lastTool = ev.tool; c.toolCount++; renderActive(); }
        }
        if (['call.start', 'call.begin', 'call.end'].includes(ev.type)) refresh();
      }
    }
    if (!ac.signal.aborted) throw new Error('stream ended');
  } catch (e) {
    if (ac.signal.aborted) return;
    setPill('error', 'disconnected');
    setTimeout(() => { if (state.token) connectStream(); }, 3000);
  }
}

async function refresh() {
  try {
    state.data = await api('GET', '/v1/monitor');
    render();
  } catch (e) {
    if (e.message !== '401') setPill('error', 'error');
  }
}

// ---------- boot ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('agentci-theme'); } catch { /* blocked */ }
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('agentci-theme', next); } catch { /* blocked */ }
  };
}

async function start(token) {
  state.token = token;
  try {
    state.data = await api('GET', '/v1/monitor');
  } catch (e) {
    if (e.message === '401') return;
    showGate(e.message);
    return;
  }
  try { localStorage.setItem('agentci-gw-token', token); } catch { /* blocked */ }
  $('#gate').hidden = true;
  $('#main').hidden = false;
  $('#logout').hidden = false;
  render();
  connectStream();
  clearInterval(state.timer);
  state.timer = setInterval(() => { renderActive(); if (document.visibilityState === 'visible') refresh(); }, 5000);
}

function bind() {
  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#tokenInput').value.trim();
    if (t) start(t);
  });
  $('#logout').onclick = () => {
    try { localStorage.removeItem('agentci-gw-token'); } catch { /* blocked */ }
    state.token = '';
    $('#tokenInput').value = '';
    showGate();
  };
  $('#refreshHealth').onclick = async () => {
    try { await api('GET', '/v1/health?refresh=1'); await refresh(); toast('Status refreshed', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  $('#workspaces').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm('Delete the mirrored files of this session on the gateway?')) return;
    try {
      await api('DELETE', `/v1/monitor/workspaces/${encodeURIComponent(b.dataset.del)}`);
      toast('Workspace deleted', 'success');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

initTheme();
bind();
const token = readToken();
if (token) start(token); else showGate();
