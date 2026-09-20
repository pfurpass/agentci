import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packBundle, serveBundle, installerScript } from '../src/bundle.js';
import { unitText, installService, removeService, serviceStatus, unitPath } from '../src/gateway/service.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-bundle-'));

test('bundle packs a self-contained tarball plus an installer', () => {
  const out = tmp();
  const { file, script, bytes } = packBundle(out);
  assert.match(path.basename(file), /^agentci-\d+\.\d+\.\d+\.tgz$/);
  assert.ok(bytes > 20_000 && bytes < 5_000_000, `unexpected size ${bytes}`);
  const listing = execFileSync('tar', ['tzf', file], { encoding: 'utf8' }).split('\n');
  for (const f of ['package/bin/agentci.js', 'package/src/orchestrator.js', 'package/web/app.js', 'package/web/gateway.html', 'package/install-gateway.sh']) {
    assert.ok(listing.includes(f), `${f} missing from the bundle`);
  }
  assert.ok(!listing.some((f) => f.startsWith('package/test/')), 'tests are not shipped');
  assert.ok(!listing.some((f) => f.includes('node_modules')), 'no dependencies to ship');
  assert.equal(fs.statSync(script).mode & 0o111, 0o111, 'installer is executable');
  assert.match(fs.readFileSync(script, 'utf8'), /npm install -g/);
});

test('installer script downloads when given a URL and refuses old Node', () => {
  const withUrl = installerScript('agentci-1.0.0.tgz', 'http://10.0.0.5:4319');
  assert.match(withUrl, /curl -fsSL "\$URL\/\$TGZ"/);
  assert.match(withUrl, /wget -q "\$URL\/\$TGZ"/);
  assert.match(withUrl, /-ge 20/);
  const local = installerScript('agentci-1.0.0.tgz');
  assert.match(local, /URL=""/);
  assert.match(local, /package \$TGZ not found/);
});

test('bundle --serve hands out the installer and the tarball', async () => {
  const b = serveBundle({ outDir: tmp(), port: 0, host: '127.0.0.1' });
  const port = await b.listen();
  try {
    const script = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(script.status, 200);
    const text = await script.text();
    assert.match(text, new RegExp(`URL="http://127.0.0.1:${port}"`));
    assert.match(text, new RegExp(b.tgz.replace(/\./g, '\\.')));
    const tgz = await fetch(`http://127.0.0.1:${port}/${b.tgz}`);
    assert.equal(tgz.status, 200);
    assert.equal(tgz.headers.get('content-type'), 'application/gzip');
    assert.equal((await tgz.arrayBuffer()).byteLength, b.bytes);
    assert.equal((await fetch(`http://127.0.0.1:${port}/etwas`)).status, 404);
  } finally {
    await b.close();
  }
});

test('gateway service: unit text, dry run and removal without systemd', () => {
  const dir = tmp();
  process.env.AGENTCI_SYSTEMD_DIR = dir;
  process.env.AGENTCI_BIN = '/usr/local/bin/agentci';
  try {
    const text = unitText({ port: 4444, host: '127.0.0.1', bin: '/usr/local/bin/agentci' });
    assert.match(text, /ExecStart=\/usr\/local\/bin\/agentci gateway --port 4444 --host 127\.0\.0\.1/);
    assert.match(text, /Restart=always/);
    assert.match(text, /WantedBy=default\.target/);

    process.env.AGENTCI_FAKE_SYSTEMD = 'on';
    const dry = installService({ port: 4444, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(!fs.existsSync(unitPath()), 'dry run writes nothing');

    process.env.AGENTCI_FAKE_SYSTEMD = 'off';
    const noSystemd = installService({ port: 4444 });
    assert.equal(noSystemd.ok, false);
    assert.match(noSystemd.fallback, /nohup agentci gateway --port 4444/);
    assert.equal(serviceStatus().installed, false);
    assert.equal(removeService().existed, false);
  } finally {
    delete process.env.AGENTCI_SYSTEMD_DIR;
    delete process.env.AGENTCI_BIN;
    delete process.env.AGENTCI_FAKE_SYSTEMD;
  }
});
