import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, buildConfig } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-srv-'));

function request(port, method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text: data, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

const MOCK_ROLES = Object.fromEntries(['planner', 'coder', 'reviewer', 'tester', 'docs'].map((r) => [r, { provider: 'mock' }]));

async function withServer(fn) {
  const cwd = tmp();
  const srv = createServer({ cwd, port: 0 });
  const port = await srv.listen();
  try { await fn({ cwd, port }); } finally { await srv.close(); }
}

test('server: serves the UI and status', () => withServer(async ({ port, cwd }) => {
  const page = await request(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /agentci/);
  const st = await request(port, 'GET', '/api/status');
  assert.equal(st.json.cwd, cwd);
  assert.equal(st.json.busy, false);
  assert.ok(st.json.config.roles.coder);
}));

test('server: blocks foreign hosts, missing CSRF header and path traversal', () => withServer(async ({ port }) => {
  const rebinding = await request(port, 'GET', '/api/status', { headers: { Host: 'evil.example:80' } });
  assert.equal(rebinding.status, 403);
  const noHeader = await request(port, 'POST', '/api/run', { body: { task: 'x' } });
  assert.equal(noHeader.status, 403);
  const traversal = await request(port, 'GET', '/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404);
  const badRun = await request(port, 'GET', '/api/runs/..%2f..');
  assert.equal(badRun.status, 404);
}));

test('server: full mock run over HTTP, streamed via SSE, with history and diff', () => withServer(async ({ port }) => {
  const events = [];
  const done = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `localhost:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          const ev = JSON.parse(chunk.slice(6));
          events.push(ev);
          if (ev.type === 'busy' && ev.busy === false) { req.destroy(); resolve(); }
        }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  await new Promise((r) => setTimeout(r, 100));

  const start = await request(port, 'POST', '/api/run', { body: { task: 'demo', roles: MOCK_ROLES }, headers: { 'X-Agentci': '1', 'Content-Type': 'application/json' } });
  assert.equal(start.status, 200, start.text);
  const again = await request(port, 'POST', '/api/run', { body: { task: 'demo', roles: MOCK_ROLES }, headers: { 'X-Agentci': '1' } });
  assert.equal(again.status, 409, 'only one run at a time');
  await done;

  const types = events.map((e) => e.type);
  for (const t of ['hello', 'run.start', 'plan', 'todo.start', 'agent.start', 'agent.tool', 'checks', 'fix', 'review', 'todo.done', 'run.done']) {
    assert.ok(types.includes(t), `missing event ${t}`);
  }
  const runs = (await request(port, 'GET', '/api/runs')).json;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].done, 2);
  const run = (await request(port, 'GET', `/api/runs/${runs[0].runId}`)).json;
  assert.ok(run.events.length > 10);
  assert.equal(run.state.todos[0].diff, undefined, 'diffs are not part of the streamed state');
  const diff = (await request(port, 'GET', `/api/runs/${runs[0].runId}/diff/T1`)).json;
  assert.match(diff.diff, /\+export function add/);
}));

test('server: plan → edit todos → resume', () => withServer(async ({ port }) => {
  const h = { 'X-Agentci': '1' };
  await request(port, 'POST', '/api/plan', { body: { task: 'demo', roles: MOCK_ROLES }, headers: h });
  for (let i = 0; i < 50 && (await request(port, 'GET', '/api/status')).json.busy; i++) await new Promise((r) => setTimeout(r, 50));
  const st = (await request(port, 'GET', '/api/status')).json.state;
  assert.equal(st.phase, 'planned');
  const edited = await request(port, 'PUT', '/api/todos', { body: { todos: [st.todos[0]] }, headers: h });
  assert.equal(edited.json.todos.length, 1);
  await request(port, 'POST', '/api/resume', { body: { roles: MOCK_ROLES }, headers: h });
  for (let i = 0; i < 100 && (await request(port, 'GET', '/api/status')).json.busy; i++) await new Promise((r) => setTimeout(r, 50));
  const final = (await request(port, 'GET', '/api/status')).json.state;
  assert.equal(final.phase, 'finished');
  assert.deepEqual(final.todos.map((t) => t.status), ['done']);
}));

test('buildConfig: web form overrides roles and toggles', () => {
  const cwd = tmp();
  const cfg = buildConfig(cwd, { roles: { coder: { provider: 'codex', model: 'gpt-x' }, reviewer: { provider: 'claude', enabled: false }, planner: { provider: 'claude', enabled: false } }, writeTests: false, maxFixAttempts: 99 });
  assert.equal(cfg.roles.coder.provider, 'codex');
  assert.equal(cfg.roles.coder.model, 'gpt-x');
  assert.equal(cfg.roles.reviewer.enabled, false);
  assert.equal(cfg.roles.planner.enabled, true, 'planner cannot be disabled');
  assert.equal(cfg.pipeline.writeTests, false);
  assert.equal(cfg.pipeline.maxFixAttempts, 10);
  assert.throws(() => buildConfig(cwd, { roles: { coder: { provider: 'nope' } } }), /unknown provider/);
});

test('web UI: a run started in the browser goes through the gateway', async () => {
  // The gateway answers with a stub "claude" so we can prove the call really left this machine.
  const { createGateway } = await import('../src/gateway/server.js');
  const seen = [];
  const stubClaude = {
    async run({ phase, cwd, canEdit, onEvent }) {
      seen.push(phase);
      if (phase === 'plan') return { data: { summary: 'remote', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] }, text: '' };
      if (canEdit) {
        fs.writeFileSync(path.join(cwd, 'remote.js'), 'module.exports = 1;\n');
        onEvent?.({ type: 'tool', name: 'Write', detail: path.join(cwd, 'remote.js') });
      }
      return { text: 'fertig', data: phase === 'review' ? { approved: true, summary: 'ok', issues: [] } : null, costUsd: 0.02 };
    },
  };
  const token = 'gateway-token-0123456789';
  const gwDir = tmp();
  const gw = createGateway({ port: 0, host: '127.0.0.1', token, dataDir: gwDir, providers: { claude: stubClaude } });
  const gwPort = await gw.listen();

  const cwd = tmp();
  const srv = createServer({ cwd, port: 0, gateway: { enabled: true, url: `http://127.0.0.1:${gwPort}`, token } });
  const port = await srv.listen();
  try {
    const claudeRoles = Object.fromEntries(['planner', 'coder', 'reviewer', 'tester'].map((r) => [r, { provider: 'claude' }]));
    const res = await request(port, 'POST', '/api/run', { body: { task: 'remote', roles: claudeRoles, writeTests: false }, headers: { 'X-Agentci': '1' } });
    assert.equal(res.status, 200, res.text);
    for (let i = 0; i < 200 && (await request(port, 'GET', '/api/status')).json.busy; i++) await new Promise((r) => setTimeout(r, 50));
    const status = (await request(port, 'GET', '/api/status')).json;
    assert.equal(status.state.phase, 'finished');
    assert.equal(status.state.gateway, `http://127.0.0.1:${gwPort}`, 'the run is marked as running via the gateway');
    assert.ok(seen.includes('plan') && seen.includes('implement'), 'planner and coder ran ON the gateway');
    assert.equal(fs.readFileSync(path.join(cwd, 'remote.js'), 'utf8'), 'module.exports = 1;\n', 'the file came back to the local project');
    const mon = await (await fetch(`http://127.0.0.1:${gwPort}/v1/monitor`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(mon.stats.total >= 2, 'the gateway monitor counted the calls');
  } finally {
    await srv.close();
    await gw.close();
  }
});

test('web UI: an unreachable gateway blocks the start with a clear message', async () => {
  const cwd = tmp();
  const srv = createServer({ cwd, port: 0, gateway: { enabled: true, url: 'http://127.0.0.1:9', token: 'x'.repeat(20) } });
  const port = await srv.listen();
  try {
    const res = await request(port, 'POST', '/api/run', { body: { task: 'x', roles: { coder: { provider: 'claude' } } }, headers: { 'X-Agentci': '1' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /gateway .*not reachable/);
    assert.equal((await request(port, 'GET', '/api/status')).json.busy, false, 'no run was started');
  } finally { await srv.close(); }
});

test('server: /api/codemap returns the dependency graph agentci built itself', () => withServer(async ({ port, cwd }) => {
  fs.writeFileSync(path.join(cwd, 'a.js'), "import './b.js';\nexport function a() {}\n");
  fs.writeFileSync(path.join(cwd, 'b.js'), 'export const b = 1;\n');
  const g = (await request(port, 'GET', '/api/codemap')).json;
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a.js', 'b.js']);
  assert.deepEqual(g.edges, [{ from: 'a.js', to: 'b.js' }]);
  assert.equal(g.nodes.find((n) => n.id === 'a.js').exports[0], 'a');
}));

test('server: /api/file serves project files and refuses to escape the project', () => withServer(async ({ port, cwd }) => {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/a.js'), 'export const a = 1;\n');
  const ok = (await request(port, 'GET', '/api/file?path=src%2Fa.js')).json;
  assert.equal(ok.content, 'export const a = 1;\n');
  assert.equal(ok.truncated, false);
  assert.equal((await request(port, 'GET', '/api/file?path=..%2F..%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await request(port, 'GET', '/api/file?path=%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await request(port, 'GET', '/api/file?path=nix.js')).status, 404);
  assert.equal((await request(port, 'GET', '/api/file')).status, 400);
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 0, 2]));
  assert.equal((await request(port, 'GET', '/api/file?path=bin.dat')).status, 415);
}));

test('server: codemap says which agent touched which file', () => withServer(async ({ port, cwd }) => {
  fs.writeFileSync(path.join(cwd, 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(cwd, 'a.test.js'), "import './a.js';\n");
  fs.mkdirSync(path.join(cwd, '.agentci', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.agentci', 'state.json'), JSON.stringify({
    runId: 'r1', task: 'x', todos: [{ id: 'T1', title: 'a bauen', status: 'done', changedFiles: ['a.js', 'a.test.js'], notes: [], dependsOn: [] }], startedAt: Date.now(), costUsd: 0,
  }));
  const g = (await request(port, 'GET', '/api/codemap')).json;
  assert.deepEqual(g.touched['a.js'], { todo: 'T1', title: 'a bauen', roles: ['coder'] });
  assert.deepEqual(g.touched['a.test.js'].roles, ['tester']);
  assert.ok(g.nodes.find((n) => n.id === 'a.js').changed);
}));

test('web UI on the network: token required for data, page stays public', async () => {
  const cwd = tmp();
  const token = 'netz-token-0123456789';
  assert.throws(() => createServer({ cwd, port: 0, host: '0.0.0.0' }), /token of at least 16 characters/);
  const srv = createServer({ cwd, port: 0, host: '0.0.0.0', token });
  const port = await srv.listen();
  try {
    assert.equal((await request(port, 'GET', '/api/status')).status, 401);
    assert.equal((await request(port, 'GET', '/api/status', { headers: { Authorization: 'Bearer falsch-falsch-falsch' } })).status, 401);
    assert.equal((await request(port, 'GET', `/api/status?token=${token}`)).status, 200, 'EventSource-style query token works');
    assert.equal((await request(port, 'GET', '/api/status', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /token/i, 'the page ships the login gate');
    // a run may not be started without the token
    assert.equal((await request(port, 'POST', '/api/run', { body: { task: 'x' }, headers: { 'X-Agentci': '1' } })).status, 401);
  } finally { await srv.close(); }
});

test('local UI keeps working without any token and refuses foreign hosts', () => withServer(async ({ port }) => {
  assert.equal((await request(port, 'GET', '/api/status')).status, 200);
  assert.equal((await request(port, 'GET', '/api/status', { headers: { Host: '10.0.0.5:4317' } })).status, 403);
}));

test('reverse proxy: --allow-host accepts that Host header and demands a token', async () => {
  const cwd = tmp();
  const token = 'proxy-token-0123456789';
  const domain = 'test-agent.example.work';
  // a public name behind a proxy is as exposed as --host, so a token is required
  assert.throws(() => createServer({ cwd, port: 0, allowedHosts: [domain] }), /token of at least 16 characters/);

  const srv = createServer({ cwd, port: 0, host: '127.0.0.1', token, allowedHosts: [domain] });
  const port = await srv.listen();
  try {
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await request(port, 'GET', '/api/status', { headers: { Host: domain, ...auth } })).status, 200);
    assert.equal((await request(port, 'GET', '/api/status', { headers: { Host: `${domain}:443`, ...auth } })).status, 200, 'port in the Host header is ignored');
    assert.equal((await request(port, 'GET', '/api/status', { headers: { Host: domain } })).status, 401, 'still needs the token');
    const foreign = await request(port, 'GET', '/api/status', { headers: { Host: 'evil.example', ...auth } });
    assert.equal(foreign.status, 403);
    assert.match(foreign.json.error, /--allow-host evil\.example/, 'the error says how to allow it');
    assert.equal((await request(port, 'GET', '/api/status', { headers: auth })).status, 200, 'localhost keeps working');
  } finally { await srv.close(); }
});

test('folder switching: history follows the folder, and it is blocked while busy', async () => {
  const home = tmp();
  const a = tmp();
  const b = tmp();
  // folder b already has a finished run
  fs.mkdirSync(path.join(b, '.agentci', 'runs'), { recursive: true });
  const old = { runId: 'r9', task: 'older work', phase: 'finished', startedAt: Date.now() - 5000, costUsd: 0, todos: [{ id: 'T1', title: 'x', status: 'done', notes: [], dependsOn: [] }] };
  fs.writeFileSync(path.join(b, '.agentci', 'runs', 'r9.state.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(b, '.agentci', 'state.json'), JSON.stringify(old));

  const prevHome = process.env.AGENTCI_HOME;
  process.env.AGENTCI_HOME = home;
  const srv = createServer({ cwd: a, port: 0 });
  const port = await srv.listen();
  const h = { 'X-Agentci': '1' };
  try {
    assert.equal((await request(port, 'GET', '/api/status')).json.cwd, a);
    assert.deepEqual((await request(port, 'GET', '/api/runs')).json, []);

    const switched = await request(port, 'PUT', '/api/cwd', { body: { path: b }, headers: h });
    assert.equal(switched.status, 404, 'only POST switches');
    const res = await request(port, 'POST', '/api/cwd', { body: { path: b }, headers: h });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.cwd, b);

    const status = (await request(port, 'GET', '/api/status')).json;
    assert.equal(status.cwd, b);
    assert.equal(status.state.task, 'older work', 'the plan of the new folder is loaded');
    assert.equal((await request(port, 'GET', '/api/runs')).json[0].task, 'older work', 'its history is back');
    assert.deepEqual(status.recentFolders.map((f) => f.path), [b, a], 'recent folders are remembered');
    assert.equal(status.recentFolders[0].hasHistory, true);

    // bad targets
    assert.equal((await request(port, 'POST', '/api/cwd', { body: { path: path.join(b, 'nope') }, headers: h })).status, 404);
    fs.writeFileSync(path.join(b, 'file.txt'), 'x');
    assert.equal((await request(port, 'POST', '/api/cwd', { body: { path: path.join(b, 'file.txt') }, headers: h })).status, 400);
    assert.equal((await request(port, 'POST', '/api/cwd', { body: {} , headers: h })).status, 400);

    // busy: a run in the old folder must not be pulled out from under itself
    await request(port, 'POST', '/api/run', { body: { task: 'demo', roles: MOCK_ROLES }, headers: h });
    const whileBusy = await request(port, 'POST', '/api/cwd', { body: { path: a }, headers: h });
    assert.equal(whileBusy.status, 409);
    for (let i = 0; i < 200 && (await request(port, 'GET', '/api/status')).json.busy; i++) await new Promise((r) => setTimeout(r, 50));
  } finally {
    await srv.close();
    if (prevHome === undefined) delete process.env.AGENTCI_HOME; else process.env.AGENTCI_HOME = prevHome;
  }
});

test('folder browsing lists subfolders only, and --lock-dir pins the folder', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  const srv = createServer({ cwd: root, port: 0, lockDir: true });
  const port = await srv.listen();
  try {
    const d = (await request(port, 'GET', `/api/browse?path=${encodeURIComponent(root)}`)).json;
    assert.deepEqual(d.folders, ['src'], 'files and dotfolders are not listed');
    assert.equal(d.parent, path.dirname(root));
    assert.equal((await request(port, 'GET', '/api/browse?path=/does/not/exist')).status, 404);
    assert.equal((await request(port, 'GET', '/api/status')).json.canSwitchFolder, false);
    const locked = await request(port, 'POST', '/api/cwd', { body: { path: path.join(root, 'src') }, headers: { 'X-Agentci': '1' } });
    assert.equal(locked.status, 403);
  } finally { await srv.close(); }
});

test('attachments over HTTP: upload, list, fetch, delete', () => withServer(async ({ port, cwd }) => {
  const h = { 'X-Agentci': '1' };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await request(port, 'POST', '/api/attachments', { body: { name: 'shot.png', data: png.toString('base64') }, headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.kind, 'image');
  assert.ok(fs.existsSync(path.join(cwd, up.json.path)), 'stored inside the project');

  const list = (await request(port, 'GET', '/api/attachments')).json;
  assert.deepEqual(list.map((a) => a.name), ['shot.png']);

  const raw = await request(port, 'GET', `/api/attachments/${encodeURIComponent(up.json.id)}`);
  assert.equal(raw.status, 200);
  assert.match(raw.type, /image\/png/);

  assert.equal((await request(port, 'POST', '/api/attachments', { body: { name: 'x' }, headers: h })).status, 400);
  assert.equal((await request(port, 'GET', '/api/attachments/does-not-exist')).status, 404);

  const del = await request(port, 'DELETE', `/api/attachments/${encodeURIComponent(up.json.id)}`, { headers: h });
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.attachments, []);
  assert.equal((await request(port, 'DELETE', `/api/attachments/${encodeURIComponent(up.json.id)}`)).status, 403, 'needs the CSRF header');
}));

test('switching folders takes the draft attachments along', () => withServer(async ({ port, cwd }) => {
  const h = { 'X-Agentci': '1' };
  const other = tmp();
  const up = (await request(port, 'POST', '/api/attachments', { body: { name: 'shot.png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }, headers: h })).json;
  const keep = (await request(port, 'POST', '/api/attachments', { body: { name: 'stays.md', data: Buffer.from('x').toString('base64') }, headers: h })).json;

  const res = await request(port, 'POST', '/api/cwd', { body: { path: other, carryAttachments: [up.id] }, headers: h });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.carried.map((a) => a.name), ['shot.png'], 'the pasted screenshot moved along');
  assert.deepEqual(res.json.attachments.map((a) => a.name), ['shot.png'], 'and is listed in the new folder');
  assert.ok(fs.existsSync(path.join(other, up.path)));
  assert.ok(fs.existsSync(path.join(cwd, keep.path)), 'the untouched one stays behind in the old folder');
  assert.ok(fs.existsSync(path.join(cwd, up.path)), 'the original is copied, not moved away');
}));
