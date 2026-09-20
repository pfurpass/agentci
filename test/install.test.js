import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-inst-'));

function sh(script, args, env = {}) {
  const home = env.HOME || tmp();
  const r = spawnSync('bash', [path.join(ROOT, script), ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, NO_COLOR: '1', ...env },
  });
  return { ...r, out: `${r.stdout}${r.stderr}`, home };
}

test('installers print help without touching anything', () => {
  for (const script of ['install.sh', 'install-gateway.sh']) {
    const r = sh(script, ['--help']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /bash install/);
    assert.ok(!r.out.includes('ROOT='), 'help shows only the comment block');
  }
});

test('unknown options fail loudly instead of doing something unexpected', () => {
  const r = sh('install.sh', ['--was-auch-immer']);
  assert.equal(r.status, 1);
  assert.match(r.out, /Unknown option/);
});

test('client dry-run explains every step and installs nothing', () => {
  const r = sh('install.sh', ['--dry-run', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Dry run/);
  assert.match(r.out, /\[dry run\] npm install -g/);
  assert.match(r.out, /agentci demo/);
  assert.match(r.out, /agentci ui/);
  assert.ok(!r.out.includes('Self-test'), 'no self-test in dry-run');
});

test('gateway dry-run creates no token file and prints the connect command', () => {
  const home = tmp();
  const r = sh('install-gateway.sh', ['--dry-run', '--yes', '--port', '4399'], { HOME: home });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /agentci gateway connect http:\/\/.+:4399 --token \S+/);
  assert.match(r.out, /Monitor/);
  assert.match(r.out, /(ufw allow 4399|firewall-cmd --add-port=4399|open port 4399)/);
  assert.ok(!fs.existsSync(path.join(home, '.agentci-gateway', 'token')), 'dry-run writes no token');
});

test('gateway dry-run --service shows the exact systemd unit', () => {
  const r = sh('install-gateway.sh', ['--dry-run', '--yes', '--service', '--port', '4400', '--host', '127.0.0.1']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /systemd\/user\/agentci-gateway\.service/);
  assert.match(r.out, /ExecStart=.*gateway --port 4400 --host 127\.0\.0\.1/);
  assert.match(r.out, /Restart=always/);
  assert.ok(!fs.existsSync(path.join(r.home, '.config/systemd/user/agentci-gateway.service')));
});

test('gateway installer creates and reuses a strong token', () => {
  const home = tmp();
  const env = { HOME: home, AGENTCI_GATEWAY_HOME: path.join(home, 'gw'), PATH: `${path.join(home, 'fakebin')}:${process.env.PATH}` };
  // fake npm/claude/codex so the installer does not touch the real system
  fs.mkdirSync(path.join(home, 'fakebin'), { recursive: true });
  for (const name of ['npm', 'claude', 'codex']) {
    fs.writeFileSync(path.join(home, 'fakebin', name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(home, 'fakebin', name), 0o755);
  }
  const first = sh('install-gateway.sh', ['--yes'], env);
  assert.equal(first.status, 0, first.out);
  const tokenFile = path.join(home, 'gw', 'token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.ok(token.length >= 24, `token too short: ${token}`);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'token file is private');
  assert.match(first.out, new RegExp(`--token ${token}`));

  const second = sh('install-gateway.sh', ['--yes'], env);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token, 'a second run keeps the token');
  assert.match(second.out, /Reusing the existing token/);

  const custom = sh('install-gateway.sh', ['--yes', '--token', 'mein-eigenes-token-1234'], env);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'mein-eigenes-token-1234');
  assert.match(custom.out, /own token saved/);

  const tooShort = sh('install-gateway.sh', ['--yes', '--token', 'kurz'], env);
  assert.equal(tooShort.status, 1);
  assert.match(tooShort.out, /at least 16 characters/);
});

test('gateway installer recognises logins even when a CLI writes to stderr', () => {
  const home = tmp();
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  // claude answers on stdout, codex on stderr – exactly like the real CLIs
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = "auth" ] && echo \'{ "loggedIn": true }\'\nexit 0\n');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n[ "$1" = "login" ] && echo "Logged in using ChatGPT" >&2\nexit 0\n');
  for (const f of ['npm', 'claude', 'codex']) fs.chmodSync(path.join(bin, f), 0o755);
  const r = sh('install-gateway.sh', ['--yes'], { HOME: home, AGENTCI_GATEWAY_HOME: path.join(home, 'gw'), PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Claude is signed in/);
  assert.match(r.out, /Codex is signed in/);
  assert.ok(!/not signed in/.test(r.out), r.out);
});
