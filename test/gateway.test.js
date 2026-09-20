import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/gateway/server.js';
import { remoteProvider, gatewayHealth, applyChanges, sessionId } from '../src/providers/remote.js';
import { mockProvider } from '../src/providers/mock.js';
import { Orchestrator } from '../src/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { preflightAsync } from '../src/providers/index.js';
import { normalizeUrl } from '../src/gateway/settings.js';

const tmp = (p = 'agentci-gw-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'test-token-0123456789abcdef';

async function withGateway(fn, providers) {
  const dataDir = tmp('agentci-gwdata-');
  const gw = createGateway({ port: 0, host: '127.0.0.1', token: TOKEN, dataDir, providers: providers || { mock: mockProvider() } });
  const port = await gw.listen();
  try { await fn({ url: `http://127.0.0.1:${port}`, dataDir }); } finally { await gw.close(); }
}

test('gateway: rejects missing/wrong token, reports health with token', () => withGateway(async ({ url }) => {
  assert.equal((await fetch(`${url}/v1/health`)).status, 401);
  assert.equal((await fetch(`${url}/v1/health`, { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status, 401);
  const h = await gatewayHealth({ url, token: TOKEN });
  assert.equal(h.ok, true);
  assert.ok(h.providers.claude && h.providers.codex);
  assert.equal((await gatewayHealth({ url, token: 'nope-nope-nope-nope' })).error, 'wrong token');
  assert.match((await gatewayHealth({ url: 'http://127.0.0.1:1', token: TOKEN })).error, /not reachable/);
}));

test('gateway: full pipeline runs remotely and changes land locally', () => withGateway(async ({ url, dataDir }) => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'existing.txt'), 'bleibt\n');
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'mock', model: null };
  const remote = remoteProvider({ url, token: TOKEN, target: 'mock', ignore: cfg.ignore });
  const tools = [];
  const orch = new Orchestrator({ cwd, config: cfg, providers: { mock: remote }, gateway: url });
  orch.on('event', (e) => { if (e.type === 'agent.tool') tools.push(e.detail); });
  const st = await orch.run('demo via gateway');
  assert.deepEqual(st.todos.map((t) => t.status), ['done', 'done']);
  assert.equal(st.gateway, url);
  for (const f of ['math.js', 'calc.js', 'math.test.js', 'README.md']) assert.ok(fs.existsSync(path.join(cwd, f)), `${f} fehlt lokal`);
  assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /return a \+ b;/, 'fix from the gateway arrived');
  assert.ok(tools.includes('math.js'), 'tool events are streamed without the gateway workspace path');
  // the gateway mirrored the project, including the file that was already there
  const ws = path.join(dataDir, 'workspaces', sessionId(cwd), 'edit');
  assert.equal(fs.readFileSync(path.join(ws, 'existing.txt'), 'utf8'), 'bleibt\n');
}));

test('gateway: only missing files are uploaded, deletions are mirrored', () => withGateway(async ({ url, dataDir }) => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'b');
  const seen = [];
  const recorder = { async run({ cwd: ws }) { seen.push(fs.readdirSync(ws).sort()); return { text: 'ok', data: null }; } };
  await withGateway(async ({ url: u2 }) => {
    const p = remoteProvider({ url: u2, token: TOKEN, target: 'rec', ignore: [] });
    await p.run({ prompt: 'x', cwd, canEdit: true, timeoutMs: 10_000 });
    fs.rmSync(path.join(cwd, 'b.txt'));
    const sync = await fetch(`${u2}/v1/sync`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sessionId(cwd), slot: 'edit', manifest: { 'a.txt': 'x'.repeat(40) } }) });
    assert.deepEqual((await sync.json()).need, ['a.txt'], 'hash mismatch → file is requested');
    await p.run({ prompt: 'x', cwd, canEdit: true, timeoutMs: 10_000 });
  }, { rec: recorder });
  assert.deepEqual(seen, [['a.txt', 'b.txt'], ['a.txt']]);
}));

test('gateway: rejects path traversal and never writes through planted symlinks', () => withGateway(async ({ url, dataDir }) => {
  const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const session = 'p' + 'a'.repeat(32);
  const bad = await fetch(`${url}/v1/run`, { method: 'POST', headers: h, body: JSON.stringify({ session, provider: 'mock', manifest: { '../evil.txt': 'x' }, files: { '../evil.txt': Buffer.from('x').toString('base64') } }) });
  assert.equal(bad.status, 400);
  assert.ok(!fs.existsSync(path.join(dataDir, 'workspaces', session, 'evil.txt')));

  // an agent planted a symlink "out" → outside dir; a later sync must not write through it
  const outside = tmp('agentci-outside-');
  const ws = path.join(dataDir, 'workspaces', session, 'edit');
  fs.mkdirSync(ws, { recursive: true });
  fs.symlinkSync(outside, path.join(ws, 'out'));
  const res = await fetch(`${url}/v1/run`, { method: 'POST', headers: h, body: JSON.stringify({ session, provider: 'mock', manifest: { 'out/pwned.txt': 'x' }, files: { 'out/pwned.txt': Buffer.from('x').toString('base64') } }) });
  assert.equal(res.status, 400);
  assert.deepEqual(fs.readdirSync(outside), []);
}));

test('client: applyChanges refuses to leave the project', () => {
  const cwd = tmp();
  assert.throws(() => applyChanges(cwd, { written: { '../x.txt': 'eA==' } }), /invalid path/);
  assert.throws(() => applyChanges(cwd, { written: { '/etc/x': 'eA==' } }), /invalid path/);
  applyChanges(cwd, { written: { 'node_modules/x.js': 'eA==', 'src/ok.js': 'eA==' } }, ['node_modules']);
  assert.ok(!fs.existsSync(path.join(cwd, 'node_modules')), 'ignored dirs are never written');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/ok.js'), 'utf8'), 'x');
});

test('stop on the client aborts the agent on the gateway', async () => {
  let aborted = false;
  const slow = { run: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve({ text: '' }); }); }) };
  await withGateway(async ({ url }) => {
    const p = remoteProvider({ url, token: TOKEN, target: 'slow', ignore: [] });
    const ac = new AbortController();
    const job = p.run({ prompt: 'x', cwd: tmp(), canEdit: true, timeoutMs: 60_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await assert.rejects(job);
    for (let i = 0; i < 40 && !aborted; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(aborted, true);
  }, { slow });
});

test('preflightAsync: unreachable gateway fails fast with a clear message', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  await assert.rejects(preflightAsync(cfg, { enabled: true, url: 'http://127.0.0.1:1', token: TOKEN }), /gateway http:\/\/127\.0\.0\.1:1: not reachable/);
  const mockOnly = structuredClone(cfg);
  for (const r of Object.keys(mockOnly.roles)) mockOnly.roles[r] = { provider: 'mock' };
  await preflightAsync(mockOnly, { enabled: true, url: 'http://127.0.0.1:1', token: TOKEN }); // nothing routed → no check
});

test('normalizeUrl adds scheme and default port', () => {
  assert.equal(normalizeUrl('10.0.0.5'), 'http://10.0.0.5:4318');
  assert.equal(normalizeUrl('https://gw.example.com'), 'https://gw.example.com');
  assert.equal(normalizeUrl('http://h:9000/'), 'http://h:9000');
});

test('gateway: tool events never reveal the internal workspace path', () => withGateway(async ({ url }) => {
  const peek = { async run({ cwd: ws, onEvent }) {
    onEvent({ type: 'tool', name: 'Read', detail: ws });
    onEvent({ type: 'tool', name: 'Read', detail: path.join(ws, 'src', 'a.js') });
    return { text: 'ok' };
  } };
  await withGateway(async ({ url: u }) => {
    const seen = [];
    const p = remoteProvider({ url: u, token: TOKEN, target: 'peek', ignore: [] });
    await p.run({ prompt: 'x', cwd: tmp(), canEdit: false, timeoutMs: 10_000, onEvent: (e) => seen.push(e.detail) });
    assert.deepEqual(seen, ['.', 'src/a.js']);
  }, { peek });
}));

// ---------- monitor ----------
const auth = { Authorization: `Bearer ${TOKEN}` };

test('monitor: page is public, data needs the token', () => withGateway(async ({ url }) => {
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Gateway monitor/);
  assert.equal((await fetch(`${url}/style.css`)).status, 200);
  assert.equal((await fetch(`${url}/v1/monitor`)).status, 401);
  assert.equal((await fetch(`${url}/v1/monitor`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${url}/../package.json`)).status, 404);
}));

test('monitor: records calls, clients, stats and streams events', () => withGateway(async ({ url }) => {
  const events = [];
  const ac = new AbortController();
  const stream = (async () => {
    const res = await fetch(`${url}/v1/monitor/stream`, { headers: auth, signal: ac.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) events.push(JSON.parse(line));
      }
    }
  })().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));

  const cwd = tmp();
  const p = remoteProvider({ url, token: TOKEN, target: 'mock', ignore: [] });
  await p.run({ role: 'coder', phase: 'implement', prompt: 'x', cwd, canEdit: true, timeoutMs: 20_000, todo: { id: 'T1', title: 'a' } });
  await fetch(`${url}/v1/monitor`, { headers: { Authorization: 'Bearer falsch-falsch-falsch' } }); // auth failure counter

  const m = await (await fetch(`${url}/v1/monitor`, { headers: auth })).json();
  assert.equal(m.stats.total, 1);
  assert.equal(m.stats.failed, 0);
  assert.equal(m.stats.authFailures, 1);
  assert.ok(m.stats.bytesIn > 0);
  assert.equal(m.active.length, 0);
  assert.equal(m.recent.length, 1);
  assert.equal(m.recent[0].role, 'coder');
  assert.equal(m.recent[0].todo, 'T1');
  assert.equal(m.recent[0].ok, true);
  assert.equal(m.recent[0].project, path.basename(cwd));
  assert.ok(m.recent[0].toolCount >= 1, 'tool calls are counted');
  assert.equal(m.clients.length, 1);
  assert.equal(m.clients[0].calls, 1);
  assert.equal(m.workspaces.length, 1);
  assert.ok(m.workspaces[0].files > 0);
  assert.ok(m.providers.claude, 'health is part of the monitor payload');

  ac.abort();
  await stream;
  const types = events.map((e) => e.type);
  assert.ok(types.includes('call.start') && types.includes('call.tool') && types.includes('call.end'));
  const end = events.find((e) => e.type === 'call.end');
  assert.equal(end.call.ok, true);
}));

test('monitor: a failing call is recorded as failed', () => withGateway(async ({ url }) => {
  const p = remoteProvider({ url, token: TOKEN, target: 'boom', ignore: [] });
  await assert.rejects(p.run({ role: 'tester', phase: 'test', prompt: 'x', cwd: tmp(), canEdit: true, timeoutMs: 10_000 }));
  const m = await (await fetch(`${url}/v1/monitor`, { headers: auth })).json();
  assert.equal(m.stats.failed, 1);
  assert.equal(m.recent[0].ok, false);
  assert.match(m.recent[0].error, /broken/);
}, { boom: { async run() { throw new Error('everything broken'); } } }));

test('monitor: workspaces can be deleted, bad ids are rejected', () => withGateway(async ({ url, dataDir }) => {
  const cwd = tmp();
  const p = remoteProvider({ url, token: TOKEN, target: 'mock', ignore: [] });
  await p.run({ role: 'coder', phase: 'implement', prompt: 'x', cwd, canEdit: true, timeoutMs: 20_000, todo: { id: 'T1', title: 'a' } });
  const id = sessionId(cwd);
  assert.ok(fs.existsSync(path.join(dataDir, 'workspaces', id)));
  assert.equal((await fetch(`${url}/v1/monitor/workspaces/${id}`, { method: 'DELETE' })).status, 401);
  const res = await fetch(`${url}/v1/monitor/workspaces/${id}`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).workspaces, []);
  assert.ok(!fs.existsSync(path.join(dataDir, 'workspaces', id)));
  assert.equal((await fetch(`${url}/v1/monitor/workspaces/..`, { method: 'DELETE', headers: auth })).status, 404);
}));

test('monitor: workspace size separates the mirror from what agents installed there', () => withGateway(async ({ url, dataDir }) => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'app.js'), 'x'.repeat(500));
  const p = remoteProvider({ url, token: TOKEN, target: 'installer', ignore: ['node_modules'] });
  await p.run({ role: 'coder', phase: 'implement', prompt: 'x', cwd, canEdit: true, timeoutMs: 10_000 });
  const m = await (await fetch(`${url}/v1/monitor`, { headers: auth })).json();
  const w = m.workspaces[0];
  assert.equal(w.mirrorFiles, 1, 'only the project file counts as mirrored');
  assert.ok(w.files > 1, 'node_modules still counts towards disk usage');
  assert.ok(w.bytes > w.mirrorBytes);
}, {
  installer: {
    async run({ cwd }) {
      // pretend the agent ran `npm install`
      fs.mkdirSync(path.join(cwd, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', 'left-pad', 'index.js'), 'y'.repeat(5000));
      return { text: 'ok' };
    },
  },
}));

test('gateway: attachments are shipped even though .agentci is ignored', () => withGateway(async ({ url, dataDir }) => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'app.js'), 'x');
  const { saveAttachment } = await import('../src/attachments.js');
  const shot = saveAttachment(cwd, 'shot.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  let seenOnGateway = null;
  await withGateway(async ({ url: u, dataDir: dir }) => {
    const p = remoteProvider({ url: u, token: TOKEN, target: 'peek', ignore: ['.agentci', 'node_modules'] });
    await p.run({ prompt: 'x', cwd, canEdit: true, timeoutMs: 10_000, attachments: [shot] });
    const ws = path.join(dir, 'workspaces', sessionId(cwd), 'edit');
    assert.ok(fs.existsSync(path.join(ws, shot.path)), 'the attachment reached the gateway workspace');
    assert.deepEqual(seenOnGateway, ['shot.png'], 'and the provider there got it as data');
  }, {
    peek: {
      async run({ attachments }) {
        seenOnGateway = (attachments || []).map((a) => a.name);
        return { text: 'ok' };
      },
    },
  });
}));
