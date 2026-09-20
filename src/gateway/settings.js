import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Gateway connection settings live in the user's home, not in the project,
// so the token never ends up in a repository.
export function settingsFile() {
  const base = process.env.AGENTCI_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentci');
  return path.join(base, 'gateway.json');
}

export function loadGatewaySettings() {
  if (process.env.AGENTCI_GATEWAY_URL) {
    return { url: process.env.AGENTCI_GATEWAY_URL, token: process.env.AGENTCI_GATEWAY_TOKEN || '', enabled: process.env.AGENTCI_GATEWAY !== 'off', source: 'env' };
  }
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { url: s.url || '', token: s.token || '', enabled: Boolean(s.enabled && s.url), source: 'file' };
  } catch {
    return { url: '', token: '', enabled: false, source: 'none' };
  }
}

export function saveGatewaySettings({ url, token, enabled }) {
  const file = settingsFile();
  const prev = loadGatewaySettings();
  const next = {
    url: url !== undefined ? normalizeUrl(url) : prev.url,
    token: token !== undefined && token !== '' ? token : prev.token,
    enabled: enabled !== undefined ? Boolean(enabled) : prev.enabled,
  };
  if (next.enabled && !next.url) throw new Error('gateway URL missing');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '4318';
  return parsed.toString().replace(/\/+$/, '');
}

// For UIs: never hand the token itself around.
export function publicGatewaySettings(s = loadGatewaySettings()) {
  return { url: s.url, enabled: s.enabled, hasToken: Boolean(s.token), source: s.source };
}
