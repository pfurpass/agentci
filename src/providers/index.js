import { claudeProvider } from './claude.js';
import { codexProvider, codexHealth } from './codex.js';
import { mockProvider } from './mock.js';
import { remoteProvider, gatewayHealth } from './remote.js';
import { loadGatewaySettings } from '../gateway/settings.js';

// Providers that run the CLIs on this machine (also what the gateway itself uses).
export function createLocalProviders(config) {
  const opts = { permissions: config.permissions };
  return {
    claude: claudeProvider({ ...opts, bin: process.env.AGENTCI_CLAUDE_BIN || 'claude' }),
    codex: codexProvider({ ...opts, bin: process.env.AGENTCI_CODEX_BIN || 'codex' }),
    mock: mockProvider(),
  };
}

// With an enabled gateway, claude + codex calls are forwarded to it; mock always stays local.
export function createProviders(config, gateway = loadGatewaySettings()) {
  const local = createLocalProviders(config);
  if (!gateway?.enabled || !gateway.url) return local;
  const remote = (target) => remoteProvider({ url: gateway.url, token: gateway.token, target, ignore: config.ignore });
  return { ...local, claude: remote('claude'), codex: remote('codex') };
}

const EDITING_ROLES = ['coder', 'tester', 'docs'];

function editingCodexRoles(config) {
  return EDITING_ROLES.filter((r) => {
    const rc = config.roles[r];
    if (!rc || rc.enabled === false || rc.provider !== 'codex') return false;
    return r !== 'tester' || config.pipeline.writeTests !== false;
  });
}

function codexError(bad, problem) {
  return new Error(`${bad.join(', ')} ${bad.length === 1 ? 'runs' : 'run'} on Codex, but ${problem}. `
    + 'Codex cannot write files like this. Fix: install Codex via npm (npm i -g @openai/codex) or switch that role to Claude.');
}

// Fails fast before a run if a role that must edit files is assigned to a Codex install that can't.
export function preflight(config, health = codexHealth(process.env.AGENTCI_CODEX_BIN || 'codex')) {
  const bad = editingCodexRoles(config);
  if (bad.length && !health.ok) throw codexError(bad, health.problem);
}

// Same check, but aware of the gateway: then the gateway must be reachable and ITS codex must work.
export async function preflightAsync(config, gateway = loadGatewaySettings()) {
  if (!gateway?.enabled || !gateway.url) return preflight(config);
  const usesGateway = Object.values(config.roles).some((rc) => rc && rc.enabled !== false && ['claude', 'codex'].includes(rc.provider));
  if (!usesGateway) return;
  const h = await gatewayHealth(gateway);
  if (!h.ok) throw new Error(`gateway ${gateway.url}: ${h.error}. Check with: agentci gateway status`);
  const bad = editingCodexRoles(config);
  const cx = h.providers?.codex || {};
  if (bad.length && cx.toolsOk === false) throw codexError(bad, `on the gateway: ${cx.problem}`);
}

export { codexHealth };
