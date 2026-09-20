import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodeMap, formatCodeMap, graphData, resolveImport, createCodeMapCache } from '../src/codemap.js';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-map-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('codemap: finds imports and exports in JS/TS and links files', () => {
  const dir = project({
    'src/index.js': "import { add } from './math.js';\nimport express from 'express';\nconst { log } = require('./util/log.cjs');\nexport default function main() {}\n",
    'src/math.ts': 'export const add = (a: number, b: number) => a + b;\nexport class Calc {}\n',
    'src/util/log.cjs': 'module.exports = { log, warn };\nfunction log() {}\nfunction warn() {}\n',
    'node_modules/pkg/i.js': 'nope',
  });
  const map = buildCodeMap(dir, ['node_modules']);
  const byPath = Object.fromEntries(map.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['src/index.js', 'src/math.ts', 'src/util/log.cjs']);
  assert.deepEqual(byPath['src/index.js'].deps.sort(), ['src/math.ts', 'src/util/log.cjs'], './math.js resolves to math.ts');
  assert.deepEqual(byPath['src/index.js'].external, ['express']);
  assert.deepEqual(byPath['src/index.js'].exports, ['main', 'default']);
  assert.deepEqual(byPath['src/math.ts'].exports.sort(), ['Calc', 'add']);
  assert.deepEqual(byPath['src/util/log.cjs'].exports.sort(), ['log', 'warn']);
  assert.deepEqual(byPath['src/math.ts'].dependents, ['src/index.js']);
  assert.equal(map.edges.length, 2);
});

test('codemap: python packages and relative imports', () => {
  const dir = project({
    'app/main.py': 'from .core import run\nimport os\nfrom app.helpers import helper\n\ndef start():\n    pass\n',
    'app/core.py': 'def run():\n    pass\n\nclass Engine:\n    pass\n\ndef _private():\n    pass\n',
    'app/helpers.py': 'def helper():\n    pass\n',
  });
  const map = buildCodeMap(dir, []);
  const main = map.files.find((f) => f.path === 'app/main.py');
  assert.deepEqual(main.deps.sort(), ['app/core.py', 'app/helpers.py']);
  assert.deepEqual(main.external, ['os']);
  const core = map.files.find((f) => f.path === 'app/core.py');
  assert.deepEqual(core.exports, ['run', 'Engine'], 'private names are skipped');
});

test('codemap: prompt text is compact, marks changed files and is capped', () => {
  const dir = project({ 'a.js': "import './b.js';\nexport function a() {}\n", 'b.js': 'export const b = 1;\n' });
  const map = buildCodeMap(dir, []);
  const text = formatCodeMap(map, { changed: ['a.js'] });
  assert.match(text, /PROJECT MAP \(2 files/);
  assert.match(text, /a\.js – 3L \| exports: a \| imports: b\.js \| CHANGED IN THIS RUN/);
  assert.ok(text.length < 400, 'stays small');
  assert.ok(formatCodeMap(map, { maxChars: 80 }).length <= 160);
  assert.match(formatCodeMap(map, { maxChars: 80 }), /truncated/);
});

test('codemap: graph payload only contains project-internal edges', () => {
  const dir = project({ 'a.js': "import './b.js';\nimport 'react';\n", 'b.js': 'export const b = 1;\n', 'README.md': '# hi' });
  const g = graphData(buildCodeMap(dir, []), ['b.js']);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a.js', 'b.js']);
  assert.deepEqual(g.edges, [{ from: 'a.js', to: 'b.js' }]);
  assert.equal(g.nodes.find((n) => n.id === 'b.js').changed, true);
});

test('resolveImport: index files, extensions, packages', () => {
  const files = new Set(['src/a.js', 'src/dir/index.ts', 'src/b.ts']);
  assert.equal(resolveImport('src/x.js', './a', files), 'src/a.js');
  assert.equal(resolveImport('src/x.js', './dir', files), 'src/dir/index.ts');
  assert.equal(resolveImport('src/x.js', './b.js', files), 'src/b.ts');
  assert.equal(resolveImport('src/x.js', 'express', files), null);
});

test('codemap cache rebuilds only after a change', () => {
  const dir = project({ 'a.js': 'export const a = 1;\n' });
  const cache = createCodeMapCache();
  const first = cache(dir, []);
  assert.equal(cache(dir, []), first, 'same object while nothing changed');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 2;\n');
  const second = cache(dir, []);
  assert.notEqual(second, first);
  assert.equal(second.files.length, 1);
});
