import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { createLocalProviders } from '../providers/index.js';
import { codexHealth } from '../providers/codex.js';
import { snapshot, diffSnapshots } from '../snapshot.js';
import { spawnSync } from 'node:child_process';
import { safeRel } from './paths.js';
import { createMonitor } from './monitor.js';
import { serveStatic } from '../static.js';

// agentci gateway: runs Claude/Codex on a machine WITH internet on behalf of agentci instances
// that have none. Each agent call ships the project (only files the gateway doesn't already have),
// runs the CLI in a mirrored workspace and streams events + the resulting file changes back.

const MAX_BODY = 512 * 1024 * 1024;
const MAX_FILE_RETURN = 25 * 1024 * 1024;
const WORKSPACE_TTL_MS = 7 * 24 * 3600 * 1000;

export function gatewayDataDir() {
  return process.env.AGENTCI_GATEWAY_HOME || path.join(os.homedir(), '.agentci-gateway');
}

export function createGateway({ port = 4318, host = '0.0.0.0', token, cert, key, dataDir = gatewayDataDir(), providers, ui = true } = {}) {
  if (!token || token.length < 16) throw new Error('the gateway needs a token of at least 16 characters');
  const wsRoot = path.join(dataDir, 'workspaces');
  fs.mkdirSync(wsRoot, { recursive: true });
  cleanupOldWorkspaces(wsRoot);
  // The gateway uses ITS OWN permission settings – clients can't widen what the agents may do here.
  const gwConfig = loadConfig(dataDir);
  const provs = providers || createLocalProviders(gwConfig);
  const locks = new Map();
  const tokenBuf = Buffer.from(token);
  const monitor = createMonitor();
  let healthCache = { at: 0, data: null };

  const authed = (req) => {
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
  };

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://gateway');
      if (url.pathname === '/v1/ping') return json(res, 200, { ok: true, service: 'agentci-gateway' });
      // The monitor page itself is static and harmless; every piece of data below needs the token.
      if (ui && req.method === 'GET' && !url.pathname.startsWith('/v1/')) {
        return serveStatic(url.pathname, res, { index: 'gateway.html' });
      }
      if (!authed(req)) {
        monitor.authFailure(clientIp(req), url.pathname);
        return json(res, 401, { error: 'missing or invalid gateway token' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, health(url.searchParams.has('refresh')));
      if (req.method === 'GET' && url.pathname === '/v1/monitor') {
        return json(res, 200, { ...monitor.snapshot(), ...health(), tls: Boolean(cert && key), dataDir, workspaces: listWorkspaces(wsRoot) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/monitor/stream') return monitorStream(req, res);
      const wsDel = url.pathname.match(/^\/v1\/monitor\/workspaces\/([a-zA-Z0-9_-]{8,80})$/);
      if (req.method === 'DELETE' && wsDel) {
        if (monitor.isBusy(wsDel[1])) throw httpError(409, 'a run is in progress for this session');
        fs.rmSync(path.join(wsRoot, wsDel[1]), { recursive: true, force: true });
        monitor.note(`workspace ${wsDel[1].slice(0, 12)}… deleted`, 'warn');
        return json(res, 200, { ok: true, workspaces: listWorkspaces(wsRoot) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync') {
        const body = await readJson(req);
        const ws = workspaceFor(wsRoot, body.session, body.slot);
        return json(res, 200, { need: missingFiles(ws, body.manifest || {}) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/run') return await run(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end(JSON.stringify({ type: 'error', message: e.message }) + '\n');
    }
  };

  function monitorStream(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(JSON.stringify({ type: 'hello', t: Date.now() }) + '\n');
    const unsubscribe = monitor.subscribe((ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); });
    const ping = setInterval(() => { if (!res.writableEnded) res.write(JSON.stringify({ type: 'ping', t: Date.now() }) + '\n'); }, 20_000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  }

  async function run(req, res) {
    const body = await readJson(req);
    const target = provs[body.provider];
    if (!target || body.provider === 'remote') throw httpError(400, `provider "${body.provider}" does not exist on the gateway`);
    const ws = workspaceFor(wsRoot, body.session, body.slot);
    const call = monitor.startCall({
      ip: clientIp(req), session: body.session, slot: body.slot === 'ro' ? 'ro' : 'edit',
      project: String(body.project || '').slice(0, 80) || null, client: String(body.client || '').slice(0, 80) || null,
      provider: body.provider, model: body.model || null, role: body.role || null, phase: body.phase || null,
      todo: body.todo?.id || null, canEdit: Boolean(body.canEdit), bytesIn: req.bytesReadJson || 0,
    });
    let bytesOut = 0;

    // One call per workspace at a time. Editing and read-only calls use separate slots,
    // so reviewer (read-only) and tester (editing) can still run in parallel.
    const release = await lock(locks, ws);
    call.begin();
    const abort = new AbortController();
    let heartbeat = null;
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      applySync(ws, body.manifest || {}, body.files || {}, body.ignore || []);
      const need = missingFiles(ws, body.manifest || {});
      if (need.length) throw httpError(409, `workspace incomplete (${need.length} files missing) – please re-sync`);

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      res.flushHeaders();
      const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
      // Keeps proxies and the client's fetch (5 min body timeout) from dropping long, quiet agent calls.
      heartbeat = setInterval(() => send({ type: 'ping' }), 25_000);
      const ignore = body.ignore || [];
      const before = snapshot(ws, ignore);
      const result = await target.run({
        role: body.role, phase: body.phase, prompt: body.prompt, systemPrompt: body.systemPrompt,
        schema: body.schema || undefined, canEdit: Boolean(body.canEdit), model: body.model || undefined,
        effort: body.effort || undefined, timeoutMs: Math.min(Number(body.timeoutMs) || 20 * 60_000, 60 * 60_000),
        cwd: ws, todo: body.todo || undefined, signal: abort.signal,
        onEvent: (ev) => {
          const event = { ...ev, detail: hidePath(ev.detail, ws) };
          if (event.type === 'tool') call.tool(event);
          send({ type: 'event', event });
        },
      });
      const changes = body.canEdit ? collectChanges(ws, before, snapshot(ws, ignore)) : { written: {}, deleted: [], skipped: [] };
      bytesOut = Object.values(changes.written).reduce((n, b64) => n + b64.length, 0);
      send({ type: 'result', text: result.text, data: result.data, costUsd: result.costUsd, durationMs: result.durationMs, changes });
      res.end();
      call.end({ ok: true, costUsd: result.costUsd || 0, bytesOut });
    } catch (e) {
      call.end({ ok: false, error: e.message, bytesOut });
      if (!res.headersSent) throw e;
      res.end(JSON.stringify({ type: 'error', message: e.message }) + '\n');
    } finally {
      clearInterval(heartbeat);
      release();
    }
  }

  function health(refresh = false) {
    if (!refresh && healthCache.data && Date.now() - healthCache.at < 30_000) return healthCache.data;
    const probe = (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
      return { installed: !r.error, ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
    };
    const c = probe('claude', ['auth', 'status']);
    let claudeLogin = c.ok;
    try { claudeLogin = JSON.parse(c.out).loggedIn === true; } catch { /* plain text */ }
    const x = probe('codex', ['login', 'status']);
    const h = codexHealth();
    healthCache = { at: Date.now(), data: {
      service: 'agentci-gateway', host: os.hostname(),
      providers: {
        claude: { installed: c.installed, loggedIn: claudeLogin, apiKeyOverride: Boolean(process.env.ANTHROPIC_API_KEY) },
        codex: { installed: x.installed, loggedIn: x.ok && /logged in/i.test(x.out), toolsOk: h.ok, problem: h.ok ? null : h.problem },
        mock: { installed: true, loggedIn: true },
      },
    } };
    return healthCache.data;
  }

  const server = cert && key
    ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 0; // agent calls can take many minutes

  return {
    server,
    tls: Boolean(cert && key),
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

// ---------- workspace sync ----------
function workspaceFor(root, session, slot) {
  const id = String(session || '');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw httpError(400, 'invalid session id');
  const s = slot === 'ro' ? 'ro' : 'edit';
  const dir = path.join(root, id, s);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  fs.utimesSync(path.join(root, id), now, now);
  return dir;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function missingFiles(ws, manifest) {
  const need = [];
  for (const [rel, hash] of Object.entries(manifest)) {
    const full = path.join(ws, safeRel(rel));
    let ok = false;
    try { ok = sha1(fs.readFileSync(full)) === hash; } catch { /* missing */ }
    if (!ok) need.push(rel);
  }
  return need;
}

function applySync(ws, manifest, files, ignore) {
  for (const [rel, b64] of Object.entries(files)) {
    const safe = safeRel(rel);
    if (!(safe in manifest)) throw httpError(400, `file ${rel} is missing from the manifest`);
    const full = path.join(ws, safe);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // An agent could have planted a symlink in the workspace – never write through one.
    const realWs = fs.realpathSync(ws);
    const realParent = fs.realpathSync(path.dirname(full));
    if (realParent !== realWs && !realParent.startsWith(realWs + path.sep)) throw httpError(400, `path escapes the workspace: ${rel}`);
    if (fs.lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(full);
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
  }
  // Remove files that no longer exist on the client (ignored dirs like node_modules stay).
  for (const rel of snapshot(ws, ignore).keys()) {
    if (!(rel in manifest)) fs.rmSync(path.join(ws, rel), { force: true });
  }
}

function collectChanges(ws, before, after) {
  const d = diffSnapshots(before, after);
  const written = {}; const skipped = [];
  for (const rel of d.changed) {
    const full = path.join(ws, rel);
    const size = fs.statSync(full).size;
    if (size > MAX_FILE_RETURN) { skipped.push(rel); continue; }
    written[rel] = fs.readFileSync(full).toString('base64');
  }
  return { written, deleted: d.deleted, skipped };
}

function cleanupOldWorkspaces(root) {
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > WORKSPACE_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// ---------- helpers ----------
// Tool details must show project paths, never the gateway's internal workspace location.
function hidePath(detail, ws) {
  let d = String(detail || '');
  let real = ws;
  try { real = fs.realpathSync(ws); } catch { /* keep */ }
  for (const p of new Set([ws, real])) d = d.split(p + path.sep).join('').split(p).join('.');
  return d;
}

function lock(locks, key) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  const chained = prev.then(() => next);
  locks.set(key, chained);
  return prev.then(() => () => {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  });
}

function clientIp(req) {
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function listWorkspaces(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.map((session) => {
    const dir = path.join(root, session);
    let stat;
    try { stat = fs.statSync(dir); } catch { return null; }
    const mirror = dirSize(path.join(dir, 'edit'), { left: 20_000 }, IGNORE_IN_MIRROR);
    const ro = dirSize(path.join(dir, 'ro'), { left: 20_000 }, IGNORE_IN_MIRROR);
    const { bytes, files } = dirSize(dir);
    return {
      session, lastUsed: stat.mtimeMs, bytes, files,
      // What actually came from the client – the rest is what agents installed//built here.
      mirrorBytes: Math.max(mirror.bytes, ro.bytes), mirrorFiles: Math.max(mirror.files, ro.files),
    };
  }).filter(Boolean).sort((a, b) => b.lastUsed - a.lastUsed);
}

const IGNORE_IN_MIRROR = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target', '.next', 'coverage', '.pytest_cache']);

function dirSize(dir, budget = { left: 20_000 }, skip = null) {
  let bytes = 0; let files = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    if (skip?.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirSize(full, budget, skip);
      bytes += sub.bytes; files += sub.files;
    } else if (e.isFile()) {
      try { bytes += fs.statSync(full).size; files++; } catch { /* vanished */ }
    }
  }
  return { bytes, files };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'project too large for the gateway')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      req.bytesReadJson = size;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}
