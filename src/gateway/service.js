import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gatewayDataDir } from './server.js';

// Runs the gateway as a systemd user service, so it comes back after a reboot.
// Everything lives in the user's home – no root, no system-wide unit.

export function unitPath() {
  const base = process.env.AGENTCI_SYSTEMD_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
  return path.join(base, 'agentci-gateway.service');
}

export function unitText({ port = 4318, host = '0.0.0.0', bin = process.env.AGENTCI_BIN || 'agentci' } = {}) {
  return `[Unit]
Description=agentci gateway (Claude/Codex for machines without internet)
After=network-online.target

[Service]
ExecStart=${bin} gateway --port ${port} --host ${host}
Environment=AGENTCI_GATEWAY_HOME=${gatewayDataDir()}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function systemdAvailable() {
  if (process.env.AGENTCI_FAKE_SYSTEMD === 'off') return false;
  if (process.env.AGENTCI_FAKE_SYSTEMD === 'on') return true;
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { timeout: 8000, stdio: 'ignore' });
  return !r.error && r.status === 0;
}

const systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 20_000 });

export function installService({ port = 4318, host = '0.0.0.0', dryRun = false } = {}) {
  const file = unitPath();
  const text = unitText({ port, host, bin: resolveBin() });
  if (!systemdAvailable()) {
    return { ok: false, reason: 'no systemd (user)', file, text, fallback: `nohup agentci gateway --port ${port} --host ${host} >~/agentci-gateway.log 2>&1 &` };
  }
  if (dryRun) return { ok: true, dryRun: true, file, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  systemctl('daemon-reload');
  const r = systemctl('enable', '--now', 'agentci-gateway.service');
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || '').trim().slice(-300), file, text };
  spawnSync('loginctl', ['enable-linger', os.userInfo().username], { timeout: 8000, stdio: 'ignore' });
  return { ok: true, file, text };
}

export function removeService({ dryRun = false } = {}) {
  const file = unitPath();
  if (dryRun) return { ok: true, dryRun: true, file };
  if (systemdAvailable()) systemctl('disable', '--now', 'agentci-gateway.service');
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  if (systemdAvailable()) systemctl('daemon-reload');
  return { ok: true, existed, file };
}

export function serviceStatus() {
  const file = unitPath();
  const installed = fs.existsSync(file);
  if (!installed) return { installed: false, file };
  if (!systemdAvailable()) return { installed: true, file, active: null, note: 'systemd (user) not available' };
  const active = systemctl('is-active', 'agentci-gateway.service').stdout.trim();
  const enabled = systemctl('is-enabled', 'agentci-gateway.service').stdout.trim();
  return { installed: true, file, active, enabled };
}

function resolveBin() {
  if (process.env.AGENTCI_BIN) return process.env.AGENTCI_BIN;
  const r = spawnSync('sh', ['-c', 'command -v agentci'], { encoding: 'utf8', timeout: 5000 });
  return r.stdout.trim() || 'agentci';
}
