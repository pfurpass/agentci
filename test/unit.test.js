import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJson } from '../src/providers/proc.js';
import { normalizeTodos } from '../src/orchestrator.js';
import { checkFileSyntax, runChecks, detectTestCommands } from '../src/checker.js';
import { snapshot, diffSnapshots, unifiedDiff } from '../src/snapshot.js';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-test-'));

test('extractJson: plain, fenced, embedded in prose, invalid', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('result {"a":"}{"} done'), { a: '}{' });
  assert.equal(extractJson('no json'), null);
});

test('normalizeTodos: fills ids, dedupes, drops unknown and forward deps', () => {
  const todos = normalizeTodos([
    { id: 'T1', title: 'a', dependsOn: ['T2'] },
    { id: 'T1', title: 'b', dependsOn: ['T1', 'X9'] },
    { title: 'c' },
  ]);
  assert.deepEqual(todos.map((t) => t.id), ['T1', "T1'", 'T3']);
  assert.deepEqual(todos[0].dependsOn, []);
  assert.deepEqual(todos[1].dependsOn, ['T1']);
  assert.ok(todos.every((t) => t.status === 'pending'));
});

test('checker: detects syntax errors per language', () => {
  const d = tmp();
  const files = {
    'good.js': 'export const a = 1;\n',
    'bad-esm.js': 'export function f() {\n  return 1\n\nexport const g = 2;\n',
    'bad-cjs.js': 'function x( {\n',
    'good.cjs': 'module.exports = 1;\n',
    'good.py': 'def f():\n    return 1\n',
    'bad.py': 'def f(:\n  pass\n',
    'bad.json': '{"a": }',
    'good.json': '{"a": 1}',
    'bad.sh': 'if then fi fi\n',
    'notes.txt': 'whatever',
  };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  const r = Object.fromEntries(Object.keys(files).map((f) => [f, checkFileSyntax(d, f)]));
  assert.equal(r['good.js'].ok, true);
  assert.equal(r['bad-esm.js'].ok, false, 'broken ESM must fail (node --check alone misses it)');
  assert.equal(r['bad-cjs.js'].ok, false);
  assert.equal(r['good.cjs'].ok, true);
  assert.equal(r['good.py'].ok, true);
  assert.equal(r['bad.py'].ok, false);
  assert.equal(r['bad.json'].ok, false);
  assert.equal(r['good.json'].ok, true);
  assert.equal(r['bad.sh'].ok, false);
  assert.ok(r['notes.txt'].skipped);
  assert.match(r['bad-esm.js'].output, /bad-esm\.js/, 'error mentions the real file, not the temp copy');
});

test('checker: detects and runs node tests', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => assert.equal(1, 2));\n");
  assert.deepEqual(detectTestCommands(d), ['node --test']);
  const res = runChecks(d, ['a.test.js'], { syntax: true, commands: [], autoDetectTests: true });
  assert.equal(res.ok, false);
  assert.match(res.report, /COMMAND FAILED: node --test/);
});

test('snapshot: tracks added, modified, deleted; ignores dirs', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), '1');
  fs.writeFileSync(path.join(d, 'b.txt'), '1');
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'node_modules', 'x.js'), '');
  const before = snapshot(d, ['node_modules']);
  fs.writeFileSync(path.join(d, 'a.txt'), '2');
  fs.rmSync(path.join(d, 'b.txt'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'c.txt'), '3');
  const ch = diffSnapshots(before, snapshot(d, ['node_modules']));
  assert.deepEqual(ch, { added: ['src/c.txt'], modified: ['a.txt'], deleted: ['b.txt'], changed: ['src/c.txt', 'a.txt'] });
});

test('unifiedDiff shows changed lines', () => {
  const diff = unifiedDiff('f.js', 'a\nb\nc', 'a\nB\nc');
  assert.match(diff, /^-b$/m);
  assert.match(diff, /^\+B$/m);
});

test('config: user file is deep-merged over defaults and validated', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'agentci.config.json'), JSON.stringify({ roles: { coder: { provider: 'codex' } }, pipeline: { maxFixAttempts: 5 } }));
  const cfg = loadConfig(d);
  assert.equal(cfg.roles.coder.provider, 'codex');
  assert.equal(cfg.roles.planner.provider, DEFAULT_CONFIG.roles.planner.provider);
  assert.equal(cfg.pipeline.maxFixAttempts, 5);
  assert.equal(cfg.pipeline.maxReviewRounds, DEFAULT_CONFIG.pipeline.maxReviewRounds);
  fs.writeFileSync(path.join(d, 'agentci.config.json'), JSON.stringify({ roles: { coder: { provider: 'gpt99' } } }));
  assert.throws(() => loadConfig(d), /unknown provider/);
});
