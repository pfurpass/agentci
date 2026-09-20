import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalRenderer, fit, vlen, clock } from '../src/term.js';
import { Orchestrator, cleanOutput } from '../src/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { mockProvider } from '../src/providers/mock.js';

test('fit / vlen handle ANSI codes', () => {
  const s = '\x1b[31mhallo welt\x1b[0m';
  assert.equal(vlen(s), 10);
  assert.equal(vlen(fit(s, 6)), 6);
  assert.equal(fit('kurz', 10), 'kurz');
  assert.equal(clock(65_000), '1:05');
  assert.equal(clock(3_725_000), '1:02:05');
});

test('cleanOutput strips project paths and node internals', () => {
  const out = cleanOutput('/p/x/a.js:3\nSyntaxError: boom\n    at wrapSafe (node:internal/modules/cjs/loader:1:1)\nNode.js v22.0.0', '/p/x');
  assert.equal(out, 'a.js:3\nSyntaxError: boom');
});

test('renderer prints a full mock run without crashing (non-TTY)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-term-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'mock', model: null };
  const orch = new Orchestrator({ cwd, config: cfg, providers: { mock: mockProvider() } });

  const written = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    const r = new TerminalRenderer({ showFooter: false }).attach(orch);
    await orch.run('demo');
    r.detach(orch);
  } finally {
    process.stdout.write = orig;
  }
  const text = written.join('');
  for (const s of ['agentci', 'Planning', 'T1', 'syntax', 'fix attempt 1/3', 'approved', 'Done', '2/2 todos']) {
    assert.ok(text.includes(s), `output misses "${s}"`);
  }
  assert.ok(!/\x1b\[/.test(text), 'no ANSI escapes when not a TTY');
});

test('stop() aborts a running pipeline and marks the run as stopped', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-stop-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'slow', model: null };
  const slow = {
    async run({ phase, signal }) {
      if (phase === 'plan') return { data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] }, text: '' };
      await new Promise((resolve) => { const t = setTimeout(resolve, 5000); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }); });
      throw new Error('killed');
    },
  };
  const orch = new Orchestrator({ cwd, config: cfg, providers: { slow } });
  const types = [];
  orch.on('event', (e) => types.push(e.type));
  const job = orch.run('x');
  await new Promise((r) => setTimeout(r, 100));
  orch.stop();
  const st = await job;
  assert.equal(st.phase, 'stopped');
  assert.equal(st.todos[0].status, 'pending', 'interrupted todo can be resumed');
  assert.ok(types.includes('run.stopped'));
});
