import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig, validateConfig, deepMerge, CONFIG_FILE, stateDir } from './config.js';
import { createProviders, preflightAsync, codexHealth } from './providers/index.js';
import { gatewayHealth } from './providers/remote.js';
import { loadGatewaySettings, saveGatewaySettings, publicGatewaySettings, normalizeUrl } from './gateway/settings.js';
import { Orchestrator, publicState } from './orchestrator.js';
import { serveStatic } from './static.js';
import { createCodeMapCache, graphData } from './codemap.js';
import { saveAttachment, listAttachments, readAttachment, deleteAttachment, copyAttachments, MAX_ATTACHMENT_BYTES } from './attachments.js';

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = MAX_ATTACHMENT_BYTES + 1024 * 1024; // base64 overhead

// Local web UI. Binds to 127.0.0.1 only. Every mutating request must carry the X-Agentci header
// (forces a CORS preflight that we never answer) and a localhost Host header (DNS-rebinding guard),
// so other websites open in your browser can't start agents on your machine.
export function createServer({ cwd: startCwd, port = 4317, host = '127.0.0.1', token = null, allowedHosts = [], lockDir = false, onOrchestrator, gateway: gatewayOverride } = {}) {
  // The working folder can be switched from the UI (history and config live inside it),
  // so it is a variable, not a constant.
  let cwd = path.resolve(startCwd);
  // Reachable from outside this machine – directly via --host, or through a reverse proxy
  // that forwards a public name (--allow-host). Both need a token: without one, anyone who
  // can reach the port could start agents that write files and run commands.
  const proxied = allowedHosts.some((h) => !isLoopbackName(h));
  const localOnly = isLoopback(host) && !proxied;
  if (!localOnly && (!token || token.length < 16)) {
    throw new Error('agentci ui needs a token of at least 16 characters when it is reachable from outside (--host / --allow-host)');
  }
  const tokenBuf = token ? Buffer.from(token) : null;
  const authed = (req, url) => {
    if (localOnly) return true;
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const buf = Buffer.from(given);
    return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
  };
  const clients = new Set();
  let current = null;       // running Orchestrator
  let buffer = [];          // events of the current/last run, replayed to new clients
  let starting = false;
  const providersInfo = detectProviders();
  let codeMapCache = createCodeMapCache();
  rememberFolder(cwd); // so you can always switch back to where you started
  // Tests (and embedders) can inject gateway settings instead of reading ~/.config/agentci.
  const gatewaySettings = () => gatewayOverride ?? loadGatewaySettings();

  async function gatewayInfo() {
    const s = gatewaySettings();
    const info = publicGatewaySettings(s);
    if (s.url && s.enabled) info.health = await gatewayHealth(s);
    return info;
  }

  const broadcast = (ev) => {
    if (ev.type !== 'state') buffer.push(ev);
    if (buffer.length > 5000) buffer = buffer.slice(-4000);
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  };

  async function start(kind, body) {
    if (current || starting) throw httpError(409, 'a run is already in progress');
    starting = true;
    let cfg; let gateway;
    try {
      cfg = buildConfig(cwd, body);
      gateway = gatewaySettings();
      await preflightAsync(cfg, gateway);
    } catch (e) {
      throw httpError(e.status || 400, e.message);
    } finally {
      starting = false;
    }
    const orch = new Orchestrator({ cwd, config: cfg, providers: createProviders(cfg, gateway), gateway: gateway.enabled ? gateway.url : null });
    if (kind === 'resume') {
      if (!orch.loadState()) throw httpError(404, 'no saved run found');
      for (const t of orch.state.todos) if (t.status === 'failed' || t.status === 'skipped') { t.status = 'pending'; t.notes = []; }
    }
    buffer = [];
    orch.on('event', broadcast);
    onOrchestrator?.(orch);
    current = orch;
    broadcast({ type: 'busy', busy: true, t: Date.now() });

    const job = kind === 'run' ? orch.run(body.task) : kind === 'plan' ? orch.plan(body.task) : orch.execute();
    job.catch(() => { /* already emitted as run.error */ }).finally(() => {
      current = null;
      broadcast({ type: 'busy', busy: false, t: Date.now() });
    });
    return { ok: true };
  }

  const routes = {
    'GET /api/status': async () => ({
      cwd, busy: Boolean(current), providers: providersInfo, gateway: await gatewayInfo(),
      recentFolders: recentFolders(cwd), canSwitchFolder: !lockDir,
      config: loadConfig(cwd), hasConfigFile: fs.existsSync(path.join(cwd, CONFIG_FILE)),
      state: current?.state ? publicState(current.state) : readLatestState(cwd),
    }),
    'GET /api/runs': () => listRuns(cwd),
    // Attachments: pasted screenshots, specs, logs – the agents read them from the project.
    'GET /api/attachments': () => listAttachments(cwd),
    'POST /api/attachments': (b) => {
      if (!b?.name || typeof b.data !== 'string') throw httpError(400, 'name and data required');
      return saveAttachment(cwd, b.name, Buffer.from(b.data, 'base64'));
    },
    // Switching the project folder – that is where .agentci (history, plan, config) lives.
    'POST /api/cwd': (b) => {
      if (lockDir) throw httpError(403, 'the folder is fixed for this server (--lock-dir)');
      if (current) throw httpError(409, 'not possible while a run is in progress');
      const next = resolveFolder(b?.path, cwd);
      // Attachments of an unsent draft move with the user instead of staying behind.
      const carried = next === cwd ? [] : copyAttachments(cwd, next, b?.carryAttachments || []);
      cwd = next;
      codeMapCache = createCodeMapCache();
      rememberFolder(cwd);
      broadcast({ type: 'cwd', cwd, t: Date.now() });
      return { cwd, recentFolders: recentFolders(cwd), carried, attachments: listAttachments(cwd) };
    },
    'GET /api/file': () => { throw httpError(400, 'path missing'); },
    // The dependency graph is computed here, not by an AI – same map the agents get in their prompts.
    'GET /api/codemap': () => {
      const cfg = loadConfig(cwd);
      const map = codeMapCache(cwd, cfg.ignore);
      const state = current?.state || readLatestState(cwd);
      const changed = [...new Set((state?.todos || []).flatMap((t) => t.changedFiles || []))];
      // Who touched what: coder always, tester when the file looks like a test.
      const touched = {};
      for (const t of state?.todos || []) {
        for (const f of t.changedFiles || []) {
          touched[f] = { todo: t.id, title: t.title, roles: /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\./.test(f) ? ['tester'] : ['coder'] };
        }
      }
      return { ...graphData(map, changed), builtAt: map.generatedAt, changed, touched, task: state?.task || null };
    },
    'GET /api/gateway': () => gatewayInfo(),
    'PUT /api/gateway': async (b) => {
      if (gatewayOverride) throw httpError(409, 'the gateway is fixed for this server');
      if (b?.enabled && b.url !== undefined) {
        const token = b.token || loadGatewaySettings().token;
        const h = await gatewayHealth({ url: normalizeUrl(b.url), token });
        if (!h.ok) throw httpError(400, `gateway: ${h.error}`);
      }
      saveGatewaySettings({ url: b?.url, token: b?.token, enabled: b?.enabled });
      return gatewayInfo();
    },
    'POST /api/run': (b) => { requireTask(b); return start('run', b); },
    'POST /api/plan': (b) => { requireTask(b); return start('plan', b); },
    'POST /api/resume': (b) => start('resume', b),
    'POST /api/stop': () => {
      if (!current) throw httpError(409, 'nothing is running');
      current.stop();
      return { ok: true };
    },
    'PUT /api/config': (b) => {
      const merged = validateConfig(deepMerge(loadConfig(cwd), b || {}));
      fs.writeFileSync(path.join(cwd, CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n');
      return merged;
    },
    'PUT /api/todos': (b) => {
      if (current) throw httpError(409, 'not possible while a run is in progress');
      const file = path.join(stateDir(cwd), 'state.json');
      if (!fs.existsSync(file)) throw httpError(404, 'no plan available');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(b?.todos)) throw httpError(400, 'todos missing');
      const byId = new Map(state.todos.map((t) => [t.id, t]));
      state.todos = b.todos.map((t, i) => ({
        ...(byId.get(t.id) || { status: 'pending', notes: [] }),
        id: String(t.id || `T${i + 1}`), title: String(t.title || ''), details: String(t.details || ''),
        acceptance: String(t.acceptance || ''), dependsOn: (t.dependsOn || []).map(String),
      }));
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
      fs.writeFileSync(path.join(stateDir(cwd), 'runs', `${state.runId}.state.json`), JSON.stringify(state, null, 2));
      return publicState(state);
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!hostAllowed(req.headers.host, localOnly, host, allowedHosts)) {
        const name = String(req.headers.host || '').replace(/:\d+$/, '');
        throw httpError(403, `host not allowed: ${name}. Behind a reverse proxy start agentci with: agentci ui --allow-host ${name}`);
      }
      // The page itself is static and harmless; every piece of data needs the token.
      if (!authed(req, url) && url.pathname.startsWith('/api/')) throw httpError(401, 'missing or wrong token');

      if (req.method === 'GET' && url.pathname === '/api/events') return sse(req, res);
      if (req.method === 'GET' && url.pathname === '/api/file' && url.searchParams.get('path')) {
        return json(res, 200, readProjectFile(cwd, url.searchParams.get('path')));
      }
      if (req.method === 'GET' && url.pathname === '/api/browse') {
        return json(res, 200, browseFolder(url.searchParams.get('path') || cwd));
      }
      const attRaw = url.pathname.match(/^\/api\/attachments\/(.+)$/);
      if (attRaw && req.method === 'GET') {
        const { buffer, entry } = readAttachment(cwd, decodeURIComponent(attRaw[1]));
        res.writeHead(200, { 'Content-Type': mimeFor(entry.name), 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=300' });
        return res.end(buffer);
      }
      if (attRaw && req.method === 'DELETE') {
        if (req.headers['x-agentci'] !== '1') throw httpError(403, 'missing X-Agentci header');
        deleteAttachment(cwd, decodeURIComponent(attRaw[1]));
        return json(res, 200, { ok: true, attachments: listAttachments(cwd) });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === 'GET' && runMatch) return json(res, 200, readRun(cwd, runMatch[1]));
      const diffMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/diff\/([^/]+)$/);
      if (req.method === 'GET' && diffMatch) return json(res, 200, readDiff(cwd, diffMatch[1], decodeURIComponent(diffMatch[2])));

      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        if (req.method !== 'GET' && req.headers['x-agentci'] !== '1') throw httpError(403, 'missing X-Agentci header');
        const body = req.method === 'GET' ? null : await readBody(req, url.pathname === '/api/attachments' ? MAX_UPLOAD : MAX_BODY);
        return json(res, 200, await route(body));
      }
      if (req.method === 'GET') return serveStatic(url.pathname, res);
      throw httpError(404, 'not found');
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });

  function sse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', busy: Boolean(current), t: Date.now() })}\n\n`);
    if (current) {
      for (const ev of buffer) res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
      if (current.state) res.write(`data: ${JSON.stringify({ type: 'state', state: publicState(current.state), t: Date.now() })}\n\n`);
    }
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => { for (const c of clients) c.end(); current?.stop(); return new Promise((r) => server.close(r)); },
  };
}

// ---------- helpers ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function requireTask(b) {
  if (!b?.task || !String(b.task).trim()) throw httpError(400, 'please enter a task');
  b.task = String(b.task).trim();
}

function isLoopback(addr = '') {
  return ['127.0.0.1', 'localhost', '::1', ''].includes(String(addr));
}

const isLoopbackName = (h) => ['localhost', '127.0.0.1', '::1'].includes(String(h).replace(/:\d+$/, ''));

// DNS-rebinding guard: only answer to the names/addresses this server is actually reachable under.
export function hostAllowed(hostHeader = '', localOnly = true, bindHost = '127.0.0.1', allowedHosts = []) {
  const name = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(name)) return true;
  // Names explicitly allowed for a reverse proxy (nginx, Caddy, Cloudflare tunnel …)
  if (allowedHosts.map((h) => String(h).replace(/:\d+$/, '')).includes(name)) return true;
  if (localOnly) return false;
  if (bindHost !== '0.0.0.0' && bindHost !== '::') return name === bindHost;
  // bound to every interface: accept this machine's own addresses and hostname
  const own = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((n) => n.address);
  return own.includes(name) || name === os.hostname() || /^[\w.-]+$/.test(name);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};
const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(httpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Per-run overrides from the web form:
// { roles: { coder: { provider, model, enabled } }, writeTests, maxFixAttempts }
export function buildConfig(cwd, body = {}) {
  const cfg = loadConfig(cwd);
  for (const [role, rc] of Object.entries(body.roles || {})) {
    if (!rc || !cfg.roles[role]) continue;
    cfg.roles[role] = {
      ...cfg.roles[role],
      provider: rc.provider || cfg.roles[role].provider,
      model: rc.model || null,
      enabled: role === 'planner' || role === 'coder' ? true : rc.enabled !== false,
    };
  }
  if (typeof body.writeTests === 'boolean') cfg.pipeline.writeTests = body.writeTests;
  if (Number.isFinite(body.maxFixAttempts)) cfg.pipeline.maxFixAttempts = Math.max(0, Math.min(10, body.maxFixAttempts));
  return validateConfig(cfg);
}

const MAX_FILE_VIEW = 400 * 1024;
const RECENT_FILE = () => path.join(process.env.AGENTCI_HOME || path.join(os.homedir(), '.config', 'agentci'), 'recent-folders.json');
const MAX_RECENT = 12;

// Lists subfolders so the UI can offer a simple picker. Never returns file contents.
export function browseFolder(dir) {
  const full = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw httpError(404, `no such folder: ${full}`);
  let entries = [];
  try {
    entries = fs.readdirSync(full, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort().slice(0, 500);
  } catch { throw httpError(403, `cannot read folder: ${full}`); }
  return {
    path: full,
    parent: path.dirname(full) === full ? null : path.dirname(full),
    folders: entries,
    isProject: fs.existsSync(path.join(full, '.agentci')),
  };
}

export function resolveFolder(input, fallback) {
  if (!input || typeof input !== 'string') throw httpError(400, 'path missing');
  const full = path.resolve(fallback, input.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(full)) throw httpError(404, `no such folder: ${full}`);
  if (!fs.statSync(full).isDirectory()) throw httpError(400, `not a folder: ${full}`);
  try { fs.accessSync(full, fs.constants.R_OK | fs.constants.W_OK); } catch { throw httpError(403, `no write access: ${full}`); }
  return full;
}

// Recently used folders, plus every folder that already has agentci history.
export function recentFolders(current) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(RECENT_FILE(), 'utf8')); } catch { /* none yet */ }
  const all = [current, ...list.filter((p) => p !== current)];
  return all.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .slice(0, MAX_RECENT)
    .map((p) => ({ path: p, name: path.basename(p) || p, hasHistory: fs.existsSync(path.join(p, '.agentci', 'runs')) }));
}

export function rememberFolder(dir) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(RECENT_FILE(), 'utf8')); } catch { /* none yet */ }
  const next = [dir, ...list.filter((p) => p !== dir)].slice(0, MAX_RECENT);
  try {
    fs.mkdirSync(path.dirname(RECENT_FILE()), { recursive: true });
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(next, null, 2));
  } catch { /* not fatal */ }
}

// Serves one project file to the UI's code viewer – never outside the project.
function readProjectFile(cwd, rel) {
  const safe = String(rel).replace(/\\/g, '/');
  if (!safe || safe.startsWith('/') || safe.split('/').some((p) => p === '..' || p === '')) throw httpError(400, 'invalid path');
  const full = path.resolve(cwd, safe);
  const root = fs.realpathSync(cwd);
  if (!full.startsWith(root + path.sep)) throw httpError(400, 'path is outside the project');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw httpError(404, 'file not found');
  const size = fs.statSync(full).size;
  const buf = fs.readFileSync(full, { encoding: null }).subarray(0, MAX_FILE_VIEW);
  if (buf.includes(0)) throw httpError(415, 'binary file');
  return { path: safe, size, truncated: size > MAX_FILE_VIEW, content: buf.toString('utf8') };
}

function readLatestState(cwd) {
  const file = path.join(cwd, '.agentci', 'state.json');
  if (!fs.existsSync(file)) return null;
  try { return publicState(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function listRuns(cwd) {
  const dir = path.join(cwd, '.agentci', 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.state.json')).map((f) => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        runId: s.runId, task: s.task, phase: s.phase, startedAt: s.startedAt, finishedAt: s.finishedAt || null,
        costUsd: s.costUsd || 0, total: s.todos.length, done: s.todos.filter((t) => t.status === 'done').length,
        failed: s.todos.filter((t) => t.status === 'failed').length,
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
}

function safeRunFile(cwd, runId, suffix) {
  if (!/^[\w-]+$/.test(runId)) throw httpError(400, 'invalid run id');
  const file = path.join(cwd, '.agentci', 'runs', runId + suffix);
  if (!fs.existsSync(file)) throw httpError(404, 'run not found');
  return file;
}

function readRun(cwd, runId) {
  const state = JSON.parse(fs.readFileSync(safeRunFile(cwd, runId, '.state.json'), 'utf8'));
  let events = [];
  try {
    events = fs.readFileSync(safeRunFile(cwd, runId, '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* no event log */ }
  return { state: publicState(state), events: events.slice(-3000) };
}

function readDiff(cwd, runId, todoId) {
  const state = JSON.parse(fs.readFileSync(safeRunFile(cwd, runId, '.state.json'), 'utf8'));
  const todo = state.todos.find((t) => t.id === todoId);
  if (!todo) throw httpError(404, 'todo not found');
  return { todo: todoId, diff: todo.diff || '', files: todo.changedFiles || [] };
}

function detectProviders() {
  const probe = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
    return { installed: !r.error, ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const claude = probe('claude', ['auth', 'status']);
  let claudeLogin = claude.ok;
  try { claudeLogin = JSON.parse(claude.out).loggedIn === true; } catch { /* plain text */ }
  const codex = probe('codex', ['login', 'status']);
  const health = codexHealth();
  return {
    claude: { installed: claude.installed, loggedIn: claudeLogin, apiKeyOverride: Boolean(process.env.ANTHROPIC_API_KEY) },
    codex: { installed: codex.installed, loggedIn: codex.ok && /logged in/i.test(codex.out), toolsOk: health.ok, problem: health.ok ? null : health.problem },
    mock: { installed: true, loggedIn: true },
  };
}
