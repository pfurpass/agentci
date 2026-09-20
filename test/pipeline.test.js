import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { claudeProvider } from '../src/providers/claude.js';
import { codexProvider } from '../src/providers/codex.js';
import { preflight } from '../src/providers/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-pipe-'));

function config(overrides = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'fake', model: null };
  delete cfg.roles.docs;
  cfg.pipeline = { ...cfg.pipeline, ...overrides };
  return cfg;
}

// Scripted provider: handlers[phase] receives the call options and returns { data?, text? }.
function fake(handlers) {
  const calls = [];
  return {
    calls,
    provider: {
      name: 'fake',
      async run(opts) {
        calls.push(`${opts.role}:${opts.phase}:${opts.todo?.id ?? '-'}`);
        const out = (await handlers[opts.phase]?.(opts)) || {};
        return { text: out.text ?? 'ok', data: out.data ?? null, costUsd: 0.01, durationMs: 1 };
      },
    },
  };
}

test('reviewer rejection leads to a fix round, then approval', async () => {
  const cwd = tmp();
  let reviews = 0;
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] } }),
    implement: ({ cwd: c }) => { fs.writeFileSync(path.join(c, 'a.js'), 'module.exports = 1;\n'); },
    fix: ({ cwd: c, prompt }) => {
      assert.match(prompt, /off-by-one/);
      fs.writeFileSync(path.join(c, 'a.js'), 'module.exports = 2;\n');
    },
    review: ({ prompt }) => {
      reviews++;
      assert.match(prompt, /a\.js/);
      return reviews === 1
        ? { data: { approved: false, summary: 'no', issues: [{ severity: 'major', file: 'a.js', description: 'off-by-one' }] } }
        : { data: { approved: true, summary: 'yes', issues: [] } };
    },
  });
  const orch = new Orchestrator({ cwd, config: config({ writeTests: false }), providers: { fake: f.provider }, quiet: true });
  const st = await orch.run('task');
  assert.equal(st.todos[0].status, 'done');
  assert.deepEqual(f.calls, ['planner:plan:-', 'coder:implement:T1', 'reviewer:review:T1', 'coder:fix:T1', 'reviewer:review:T1']);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.js'), 'utf8'), 'module.exports = 2;\n');
  assert.ok(Math.abs(st.costUsd - 0.05) < 1e-9);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.agentci', 'state.json'), 'utf8')).todos[0].changedFiles, ['a.js']);
});

test('persistent syntax errors fail the todo and skip dependents', async () => {
  const cwd = tmp();
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [
      { id: 'T1', title: 'broken', details: '', dependsOn: [], acceptance: '' },
      { id: 'T2', title: 'dependent', details: '', dependsOn: ['T1'], acceptance: '' },
    ] } }),
    implement: ({ cwd: c }) => { fs.writeFileSync(path.join(c, 'x.py'), 'def f(:\n'); },
    fix: ({ prompt }) => { assert.match(prompt, /SYNTAX ERROR in x\.py/); },
  });
  const orch = new Orchestrator({ cwd, config: config({ maxFixAttempts: 2 }), providers: { fake: f.provider }, quiet: true });
  const st = await orch.run('task');
  assert.deepEqual(st.todos.map((t) => t.status), ['failed', 'skipped']);
  assert.equal(f.calls.filter((c) => c === 'coder:fix:T1').length, 2);
  assert.ok(!f.calls.some((c) => c.includes('T2')));
});

test('tester runs in parallel with reviewer and failing tests go back to the coder', async () => {
  const cwd = tmp();
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [{ id: 'T1', title: 'add', details: '', dependsOn: [], acceptance: '' }] } }),
    implement: ({ cwd: c }) => { fs.writeFileSync(path.join(c, 'm.mjs'), 'export const add = (a, b) => a - b;\n'); },
    test: ({ cwd: c }) => {
      fs.writeFileSync(path.join(c, 'm.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './m.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
    },
    fix: ({ cwd: c, prompt }) => {
      assert.match(prompt, /node --test/);
      fs.writeFileSync(path.join(c, 'm.mjs'), 'export const add = (a, b) => a + b;\n');
    },
    review: () => ({ data: { approved: true, summary: 'ok', issues: [] } }),
  });
  // node --test is detected only for *.test.js/-mjs at top level
  const orch = new Orchestrator({ cwd, config: config(), providers: { fake: f.provider }, quiet: true });
  const st = await orch.run('task');
  assert.equal(st.todos[0].status, 'done');
  assert.ok(f.calls.includes('tester:test:T1'));
  assert.ok(f.calls.includes('coder:fix:T1'));
});

test('claude provider: builds CLI args and reads structured_output from stream-json', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'fake-claude');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x.js' } }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: '{"approved":true}', structured_output: { approved: true, summary: 's', issues: [] }, total_cost_usd: 0.5 });
`);
  fs.chmodSync(bin, 0o755);
  const events = [];
  const p = claudeProvider({ bin, permissions: { claudeMode: 'acceptEdits', claudeAllowedTools: ['Edit', 'Bash(npm *)'] } });
  const res = await p.run({ prompt: 'PROMPT', systemPrompt: 'SYS', cwd: dir, model: 'sonnet', effort: 'high', schema: { type: 'object' }, canEdit: true, timeoutMs: 10_000, onEvent: (e) => events.push(e) });
  const { args, stdin } = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(stdin, 'PROMPT');
  assert.ok(!args.includes('--bare'), 'bare mode would bypass the subscription login');
  for (const a of ['-p', '--append-system-prompt', 'SYS', '--model', 'sonnet', '--effort', 'high', '--json-schema', 'acceptEdits', 'Bash(npm *)']) assert.ok(args.includes(a), a);
  assert.deepEqual(res.data, { approved: true, summary: 's', issues: [] });
  assert.equal(res.costUsd, 0.5);
  assert.deepEqual(events, [{ type: 'tool', name: 'Edit', detail: 'x.js' }]);
});

test('claude provider: surfaces errors from the CLI', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' }));`);
  fs.chmodSync(bin, 0o755);
  const p = claudeProvider({ bin });
  await assert.rejects(p.run({ prompt: 'x', cwd: dir, canEdit: false, timeoutMs: 10_000 }), /Not logged in/);
});

test('coder that changes no file gets a second chance, then the todo fails', async () => {
  const cwd = tmp();
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] } }),
    implement: () => ({ text: 'Sorry, I could not write any files.' }),
    fix: ({ prompt }) => { assert.match(prompt, /NO file/); },
  });
  const orch = new Orchestrator({ cwd, config: config(), providers: { fake: f.provider } });
  const st = await orch.run('task');
  assert.equal(st.todos[0].status, 'failed');
  assert.match(st.todos[0].notes.join(), /did not change a single file/);
  assert.ok(!f.calls.some((c) => c.startsWith('reviewer')), 'no review of an empty change');
});

test('tester that writes nothing marks the todo as untested', async () => {
  const cwd = tmp();
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] } }),
    implement: ({ cwd: c }) => { fs.writeFileSync(path.join(c, 'a.js'), 'module.exports = 1;\n'); },
    test: () => ({ text: 'I could not write any tests.' }),
    review: () => ({ data: { approved: true, summary: 'ok', issues: [] } }),
  });
  const orch = new Orchestrator({ cwd, config: config(), providers: { fake: f.provider } });
  const notes = [];
  orch.on('event', (e) => { if (e.type === 'note') notes.push(e.text); });
  const st = await orch.run('task');
  assert.equal(st.todos[0].status, 'done');
  assert.equal(st.todos[0].testsMissing, true);
  assert.match(notes.join(), /untested/);
});

test('codex provider: missing code-mode host is an error, not a silent success', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'fake-codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.readFileSync(0);
fs.writeFileSync(a[a.indexOf('-o') + 1], 'I could not write any tests.');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because failed to spawn code-mode host' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));`);
  fs.chmodSync(bin, 0o755);
  const p = codexProvider({ bin });
  await assert.rejects(p.run({ prompt: 'x', cwd: dir, canEdit: true, timeoutMs: 10_000 }), /codex-code-mode-host/);
  const ro = await p.run({ prompt: 'x', cwd: dir, canEdit: false, timeoutMs: 10_000 });
  assert.match(ro.text, /could not write any tests/, 'read-only roles still get the answer');
});

test('preflight blocks editing roles on a broken codex install', () => {
  const cfg = config();
  cfg.roles.tester = { provider: 'codex' };
  const broken = { ok: false, problem: 'codex-code-mode-host missing' };
  assert.throws(() => preflight(cfg, broken), /tester runs on Codex/);
  cfg.pipeline.writeTests = false;
  assert.doesNotThrow(() => preflight(cfg, broken));
  cfg.roles.reviewer = { provider: 'codex' };
  assert.doesNotThrow(() => preflight(cfg, broken), 'read-only reviewer is fine');
  cfg.roles.coder = { provider: 'codex' };
  assert.doesNotThrow(() => preflight(cfg, { ok: true }));
});

test('usage limit: no pointless retries, fallback provider takes over, and is remembered', async () => {
  const cwd = tmp();
  let codexCalls = 0;
  const codexLike = { async run() { codexCalls++; throw new Error("You've hit your usage limit. Upgrade to Plus"); } };
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [
      { id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' },
      { id: 'T2', title: 'b', details: '', dependsOn: [], acceptance: '' },
    ] } }),
    implement: ({ cwd: c, todo }) => { fs.writeFileSync(path.join(c, `${todo.id}.js`), 'module.exports = 1;\n'); },
    review: () => ({ data: { approved: true, summary: 'ok', issues: [] } }),
  });
  const cfg = config({ writeTests: false });
  cfg.roles.reviewer = { provider: 'limited', fallback: 'fake' };
  const orch = new Orchestrator({ cwd, config: cfg, providers: { fake: f.provider, limited: codexLike } });
  const st = await orch.run('task');
  assert.deepEqual(st.todos.map((t) => t.status), ['done', 'done']);
  assert.equal(codexCalls, 1, 'limited provider is called once, never retried, then skipped');
  assert.equal(f.calls.filter((c) => c.startsWith('reviewer')).length, 2, 'fallback reviewed both todos');
});

test('failing reviewer/tester without fallback degrade the todo instead of failing it', async () => {
  const cwd = tmp();
  const broken = { async run() { throw new Error('rate limit exceeded (429)'); } };
  const f = fake({
    plan: () => ({ data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] } }),
    implement: ({ cwd: c }) => { fs.writeFileSync(path.join(c, 'a.js'), 'module.exports = 1;\n'); },
  });
  const cfg = config();
  cfg.roles.reviewer = { provider: 'broken' };
  cfg.roles.tester = { provider: 'broken' };
  const orch = new Orchestrator({ cwd, config: cfg, providers: { fake: f.provider, broken } });
  const st = await orch.run('task');
  const t = st.todos[0];
  assert.equal(t.status, 'done');
  assert.equal(t.unreviewed, true);
  assert.equal(t.testsMissing, true);
});

test('prompts carry the project map so agents need not explore the tree', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'app.js'), "import './lib.js';\nexport function start() {}\n");
  fs.writeFileSync(path.join(cwd, 'lib.js'), 'export const helper = 1;\n');
  const prompts = [];
  const f = fake({
    plan: ({ prompt }) => { prompts.push(prompt); return { data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] } }; },
    implement: ({ prompt, cwd: c }) => { prompts.push(prompt); fs.writeFileSync(path.join(c, 'neu.js'), 'export const x = 1;\n'); },
    review: () => ({ data: { approved: true, summary: 'ok', issues: [] } }),
    test: ({ prompt, cwd: c }) => { prompts.push(prompt); fs.writeFileSync(path.join(c, 'neu.test.js'), "import test from 'node:test';\ntest('x', () => {});\n"); },
  });
  const orch = new Orchestrator({ cwd, config: config(), providers: { fake: f.provider } });
  await orch.run('task');
  assert.ok(prompts.every((p) => p.includes('PROJECT MAP')), 'every agent gets the map');
  assert.match(prompts[0], /app\.js – 3L \| exports: start \| imports: lib\.js/);
  assert.match(prompts.at(-1), /neu\.js – 2L \| exports: x \| CHANGED IN THIS RUN/, 'the tester sees what changed');
  assert.ok(!prompts[0].includes('node_modules'));

  const off = config();
  off.pipeline.projectMap = false;
  const orch2 = new Orchestrator({ cwd: tmp(), config: off, providers: { fake: fake({ plan: ({ prompt }) => { assert.ok(!prompt.includes('PROJECT MAP')); return { data: { summary: 's', todos: [] } }; } }).provider } });
  await assert.rejects(orch2.run('x'), /no todos/);
});
