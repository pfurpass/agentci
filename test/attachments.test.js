import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAttachment, listAttachments, readAttachment, deleteAttachment, attachFromDisk, formatAttachments, kindOf } from '../src/attachments.js';
import { Orchestrator } from '../src/orchestrator.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { codexProvider } from '../src/providers/codex.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-att-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' + '0'.repeat(41), 'hex');

test('attachments are stored in the project, listed and removable', () => {
  const cwd = tmp();
  assert.deepEqual(listAttachments(cwd), []);
  const a = saveAttachment(cwd, 'screenshot 1.png', PNG);
  assert.equal(a.kind, 'image');
  assert.equal(a.name, 'screenshot 1.png');
  assert.match(a.path, /^\.agentci\/attachments\//);
  assert.ok(fs.existsSync(path.join(cwd, a.path)), 'file is inside the project');
  const b = saveAttachment(cwd, 'spec.md', Buffer.from('# spec'));
  assert.equal(b.kind, 'text');
  assert.deepEqual(listAttachments(cwd).map((x) => x.name), ['screenshot 1.png', 'spec.md']);
  assert.equal(readAttachment(cwd, a.id).buffer.length, PNG.length);
  deleteAttachment(cwd, a.id);
  assert.deepEqual(listAttachments(cwd).map((x) => x.name), ['spec.md']);
});

test('attachment names are sanitised and oversized files rejected', () => {
  const cwd = tmp();
  const evil = saveAttachment(cwd, '../../etc/passwd', Buffer.from('x'));
  assert.ok(!evil.id.includes('/') && !evil.id.includes('..'), evil.id);
  assert.equal(listAttachments(cwd).length, 1);
  assert.throws(() => saveAttachment(cwd, 'big.bin', Buffer.alloc(26 * 1024 * 1024)), /larger than/);
  assert.equal(kindOf('a.pdf'), 'document');
  assert.equal(kindOf('a.zip'), 'file');
});

test('--attach style copies from disk, prompt block lists every attachment', () => {
  const cwd = tmp();
  const src = path.join(tmp(), 'notes.txt');
  fs.writeFileSync(src, 'hello');
  const a = attachFromDisk(cwd, src);
  assert.equal(a.name, 'notes.txt');
  assert.match(formatAttachments([a]), /ATTACHMENTS[\s\S]*\.agentci\/attachments\/.*notes\.txt {2}\(text, 1 kB\)/);
  assert.equal(formatAttachments([]), '');
  assert.throws(() => attachFromDisk(cwd, '/nope/nope.txt'), /attachment not found/);
});

test('every agent gets the attachments in its prompt and the state records them', async () => {
  const cwd = tmp();
  saveAttachment(cwd, 'design.png', PNG);
  saveAttachment(cwd, 'spec.md', Buffer.from('# spec'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'fake', model: null };
  delete cfg.roles.docs;
  const prompts = [];
  const seen = [];
  const fake = {
    async run(opts) {
      prompts.push(`${opts.role}:${opts.prompt}`);
      seen.push(opts.attachments?.map((a) => a.name) || []);
      if (opts.phase === 'plan') return { data: { summary: 's', todos: [{ id: 'T1', title: 'a', details: '', dependsOn: [], acceptance: '' }] }, text: '' };
      if (opts.phase === 'review') return { data: { approved: true, summary: 'ok', issues: [] }, text: '' };
      if (opts.canEdit) fs.writeFileSync(path.join(opts.cwd, `${opts.role}.js`), 'module.exports = 1;\n');
      return { text: 'ok', data: null };
    },
  };
  const orch = new Orchestrator({ cwd, config: cfg, providers: { fake } });
  const st = await orch.run('use the screenshot');
  assert.deepEqual(st.attachments.map((a) => a.name), ['design.png', 'spec.md']);
  assert.ok(prompts.every((p) => p.includes('design.png') && p.includes('spec.md')), 'planner, coder, reviewer and tester all see them');
  assert.ok(prompts.some((p) => p.startsWith('reviewer:') && p.includes('ATTACHMENTS')));
  assert.ok(seen.every((names) => names.includes('design.png')), 'providers receive them as structured data too');
});

test('codex gets images as real image inputs', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'fake-codex');
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.readFileSync(0);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const out = process.argv[process.argv.indexOf('-o') + 1];
fs.writeFileSync(out, 'done');
console.log(JSON.stringify({ type: 'turn.completed' }));`);
  fs.chmodSync(bin, 0o755);
  const img = saveAttachment(dir, 'shot.png', PNG);
  const doc = saveAttachment(dir, 'spec.md', Buffer.from('# spec'));
  await codexProvider({ bin }).run({ prompt: 'x', cwd: dir, canEdit: true, timeoutMs: 10_000, attachments: [img, doc] });
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const images = args.filter((a, i) => args[i - 1] === '-i');
  assert.deepEqual(images, [path.join(dir, img.path)], 'only the image is passed with -i');
});
