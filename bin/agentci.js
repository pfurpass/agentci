#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, writeDefaultConfig, validateConfig, CONFIG_FILE, PROVIDERS } from '../src/config.js';
import { createProviders, preflightAsync, codexHealth } from '../src/providers/index.js';
import { gatewayHealth } from '../src/providers/remote.js';
import { createGateway, gatewayDataDir } from '../src/gateway/server.js';
import { loadGatewaySettings, saveGatewaySettings, settingsFile, normalizeUrl } from '../src/gateway/settings.js';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.js';
import { snapshot } from '../src/snapshot.js';
import { runChecks } from '../src/checker.js';
import { TerminalRenderer, renderTodoList, st as color, badge } from '../src/term.js';
import { createServer } from '../src/server.js';
import { packBundle, serveBundle, humanSize } from '../src/bundle.js';
import { installService, removeService, serviceStatus, unitText } from '../src/gateway/service.js';

const header = (title) => console.log(`\n${color.bold(title)}\n${color.faint('─'.repeat(Math.min(60, title.length + 8)))}`);

const ROLES = ['planner', 'coder', 'reviewer', 'tester', 'docs'];

const HELP = `${color.bold('agentci')} – multi-agent AI coder (planner · coder · checker · reviewer · tester)

${color.bold('Commands')}
  agentci run "<task>"        Plan, implement, check, review and test
  agentci plan "<task>"       Only create the todo list (.agentci/state.json, editable)
  agentci resume              Continue planned or interrupted todos
  agentci ui                  Start the web interface (http://localhost:4317)
  agentci ui --host 0.0.0.0   Expose the interface on the network (prints a token)
  agentci gateway             Start gateway + monitor (machine WITH internet + Claude/Codex)
  agentci gateway connect <url> --token <t>   Connect this machine to a gateway
  agentci gateway status|on|off               Check / enable / disable the gateway
  agentci gateway service install|remove|status   Run the gateway as a service (autostart)
  agentci bundle [--serve]    Package agentci for another machine (no internet, no git)
  agentci status              Show the todo list
  agentci check               Check syntax of all files + run tests (no AI)
  agentci init                Create ${CONFIG_FILE} with the defaults
  agentci doctor              Check whether claude / codex are installed and signed in
  agentci demo                Offline demo with a mock AI (free)

${color.bold('Options')}
  --dir <path>                Working directory (default: current)
  --planner|--coder|--reviewer|--tester|--docs <provider[:model]>
                              Override the AI per role, e.g. --coder codex --reviewer claude:opus
  --no-review                 Turn the reviewer off
  --no-tests                  Turn the tester off
  --docs                      Enable the docs agent at the end
  --fix-attempts <n>          Max fix attempts after failing checks (default 3)
  --port <n>                  Port for agentci ui (default 4317)
  --no-open                   Do not open the browser for agentci ui
  --no-ui                     Start the gateway without its monitor web interface
  --host <address>            for "ui"/"gateway": make it reachable on the network (e.g. 0.0.0.0)
  --serve                     for "bundle": offer it for download on the network
  --dir <path>                for "bundle": target folder for the package
  --local                     Ignore the gateway for this run (claude/codex run locally)
  --token / --host / --cert / --key   Options for agentci gateway

${color.bold('Providers')}  claude (Claude Pro/Max subscription via Claude Code) · codex (ChatGPT subscription via Codex CLI) · mock
`;

function parseArgs(argv) {
  const out = { _: [], roles: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--no-review') out.noReview = true;
    else if (a === '--no-tests') out.noTests = true;
    else if (a === '--fix-attempts') out.fixAttempts = Number(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--no-ui') out.noUi = true;
    else if (a === '--serve') out.serve = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--local') out.local = true;
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--cert') out.cert = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--docs' && (!argv[i + 1] || argv[i + 1].startsWith('-') || !PROVIDERS.includes(argv[i + 1].split(':')[0]))) out.docs = true;
    else if (a.startsWith('--') && ROLES.includes(a.slice(2))) out.roles[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

function applyOverrides(cfg, args) {
  for (const [role, spec] of Object.entries(args.roles)) {
    if (!spec) throw new Error(`--${role} needs a value, e.g. claude:sonnet`);
    const [provider, model] = spec.split(':');
    cfg.roles[role] = { ...(cfg.roles[role] || {}), provider, model: model || null, enabled: true };
  }
  if (args.noReview) delete cfg.roles.reviewer;
  if (args.noTests) cfg.pipeline.writeTests = false;
  if (args.docs) cfg.roles.docs = { ...(cfg.roles.docs || { provider: 'claude' }), enabled: true };
  if (Number.isFinite(args.fixAttempts)) cfg.pipeline.maxFixAttempts = args.fixAttempts;
  if (cfg.roles.docs?.enabled === false) delete cfg.roles.docs;
  return validateConfig(cfg);
}

async function makeOrchestrator(cwd, args, cfgOverride, { check = true } = {}) {
  const cfg = applyOverrides(cfgOverride || loadConfig(cwd), args);
  const gateway = args.local ? null : loadGatewaySettings();
  if (check) await preflightAsync(cfg, gateway);
  const via = gateway?.enabled ? gateway.url : null;
  return new Orchestrator({ cwd, config: cfg, providers: createProviders(cfg, gateway), gateway: via });
}

// Attaches the terminal renderer and makes Ctrl+C stop gracefully (second Ctrl+C = hard exit).
async function runWithTerminal(orch, job) {
  const renderer = new TerminalRenderer().attach(orch);
  let stopping = false;
  const onSigint = () => {
    if (stopping) { renderer.detach(orch); process.exit(130); }
    stopping = true;
    renderer.print('', `${badge('system')} ${color.yellow('Stopping… (Ctrl+C again = exit now)')}`);
    orch.stop();
  };
  process.on('SIGINT', onSigint);
  try {
    return await job(orch);
  } finally {
    process.off('SIGINT', onSigint);
    renderer.detach(orch);
  }
}

async function ui(cwd, args) {
  const port = Number.isFinite(args.port) ? args.port : 4317;
  const host = args.host || '127.0.0.1';
  const remote = !['127.0.0.1', 'localhost', '::1'].includes(host);
  const token = remote ? (args.token || uiToken()) : null;
  let renderer = null;
  const srv = createServer({
    cwd, port, host, token,
    onOrchestrator(orch) {
      renderer?.detach();
      renderer = new TerminalRenderer({ showFooter: false }).attach(orch);
    },
  });
  let actual;
  try {
    actual = await srv.listen();
  } catch (e) {
    throw new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use – try --port ${port + 1}` : e.message);
  }
  const shown = remote ? (host === '0.0.0.0' || host === '::' ? lanAddresses()[0] || 'THIS-MACHINE' : host) : 'localhost';
  const url = `http://${shown}:${actual}`;
  const withToken = token ? `${url}/?token=${token}` : url;
  console.log(`\n  ${color.bold('◆ agentci')} ${color.gray('web interface')}\n`);
  console.log(`  ${color.gray('→')} ${color.bold(withToken)}`);
  console.log(`  ${color.gray('Folder')} ${cwd}`);
  if (remote) {
    console.log(`  ${color.gray('Token ')} ${token}`);
    console.log(`\n  ${color.yellow('Reachable on the network')} – token required. Anyone with it can start agents here.`);
    console.log(color.faint('  Local only: agentci ui   (localhost)'));
  }
  console.log(`\n  ${color.faint('Ctrl+C stops the server')}\n`);
  if (!args.noOpen && !remote) openBrowser(url);
  process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
}

// Packs agentci so it can be installed on a machine that has neither this folder nor internet.
async function bundleCmd(cwd, args) {
  if (args.serve) {
    const b = serveBundle({ outDir: undefined, port: Number.isFinite(args.port) ? args.port : 4319, host: args.host || '0.0.0.0' });
    const port = await b.listen();
    const ip = lanAddresses()[0] || 'THIS-MACHINE';
    console.log(`\n  ${color.bold('◆ agentci bundle')} ${color.gray(`${b.tgz} · ${humanSize(b.bytes)}`)}\n`);
    console.log(`  Run this on the ${color.bold('other')} machine:\n`);
    console.log(`    ${color.bold(`curl -fsSL http://${ip}:${port}/ | sh`)}`);
    console.log(`    ${color.gray(`or: wget -qO- http://${ip}:${port}/ | sh`)}\n`);
    console.log(color.faint('  That machine only needs Node 20+ and network access to this one – no internet, no git.'));
    console.log(color.faint('  Ctrl+C stops sharing.\n'));
    process.on('SIGINT', async () => { await b.close(); process.exit(0); });
    return;
  }
  const out = args.dir ? path.resolve(args.dir) : cwd;
  const { file, script, bytes } = packBundle(out);
  console.log(`\n  ${color.green('✔')} ${path.basename(file)} ${color.gray(`(${humanSize(bytes)})`)}`);
  console.log(`  ${color.green('✔')} ${path.basename(script)}\n`);
  console.log('  Copy both files to the other machine (USB, scp …) and run there:\n');
  console.log(`    ${color.bold('sh install-agentci.sh')}\n`);
  console.log(color.faint(`  Or share it over the network instead: ${color.bold('agentci bundle --serve')}\n`));
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
}

async function gatewayCmd([sub = 'start', ...rest], args) {
  if (sub === 'service') {
    const action = rest[0] || 'status';
    const port = Number.isFinite(args.port) ? args.port : 4318;
    const host = args.host || '0.0.0.0';
    if (action === 'install') {
      const r = installService({ port, host, dryRun: args.dryRun });
      if (r.dryRun) { console.log(color.gray(`Would write ${r.file}:\n`)); console.log(r.text); return; }
      if (!r.ok) {
        console.log(`${color.yellow('!')} Service not installed (${r.reason}).`);
        if (r.fallback) console.log(`  Start it manually instead:\n    ${color.bold(r.fallback)}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${color.green('✔')} Service installed and started (${r.file})`);
      console.log(color.gray('  Status: agentci gateway service status · logs: journalctl --user -u agentci-gateway -f'));
      return;
    }
    if (action === 'remove') {
      const r = removeService({ dryRun: args.dryRun });
      console.log(r.dryRun ? color.gray(`Would remove ${r.file}`) : `${color.green('✔')} Service removed${r.existed ? '' : ' (was not installed)'}`);
      return;
    }
    if (action === 'status') {
      const s = serviceStatus();
      if (!s.installed) return console.log(`No service installed. Install it with: ${color.bold('agentci gateway service install')}`);
      console.log(`Service ${s.active === 'active' ? color.green('running') : color.yellow(s.active || s.note || 'unknown')}${s.enabled ? color.gray(` · autostart: ${s.enabled}`) : ''}`);
      console.log(color.gray(`  ${s.file}`));
      return;
    }
    if (action === 'unit') return console.log(unitText({ port, host }));
    throw new Error('agentci gateway service install | remove | status');
  }
  if (sub === 'start') {
    const token = args.token || process.env.AGENTCI_GATEWAY_TOKEN || persistentToken();
    const gw = createGateway({ port: Number.isFinite(args.port) ? args.port : 4318, host: args.host || '0.0.0.0', token, cert: args.cert, key: args.key, ui: !args.noUi });
    let port;
    try { port = await gw.listen(); } catch (e) {
      throw new Error(e.code === 'EADDRINUSE' ? 'port in use – try --port 4319' : e.message);
    }
    const proto = gw.tls ? 'https' : 'http';
    const bindAll = !args.host || args.host === '0.0.0.0' || args.host === '::';
    const addrs = bindAll
      ? Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)
      : [args.host];
    const example = `${proto}://${addrs[0] || 'THIS-MACHINE'}:${port}`;
    console.log(`\n  ${color.bold('◆ agentci gateway')} ${color.gray('running')}\n`);
    console.log(`  ${color.gray('Addresses')} ${(addrs.length ? addrs : ['(no network address found)']).map((a) => `${proto}://${a}:${port}`).join('  ')}`);
    console.log(`  ${color.gray('Token    ')} ${token}`);
    console.log(`  ${color.gray('Data     ')} ${gatewayDataDir()}\n`);
    console.log(`  On the machine without internet:\n  ${color.bold(`agentci gateway connect ${example} --token ${token}`)}\n`);
    if (!args.noUi) console.log(`  ${color.gray('Monitor  ')} ${color.bold(`${example}/?token=${token}`)}  ${color.faint('(live view in the browser)')}\n`);
    if (!gw.tls) console.log(color.yellow('  Note: without TLS your code travels unencrypted. On untrusted networks use --cert/--key or an SSH tunnel.\n'));
    console.log(color.faint('  Anyone with the token can start Claude/Codex here with file access – share it only with machines you trust.\n'));
    // A long-running service must survive a bad request – log instead of crashing.
    process.on('unhandledRejection', (e) => console.error(color.red(`[gateway] ${new Date().toISOString()} ${e?.message || e}`)));
    process.on('SIGINT', async () => { await gw.close(); process.exit(0); });
    return;
  }
  if (sub === 'connect') {
    const url = rest[0];
    if (!url) throw new Error('please provide a URL: agentci gateway connect http://host:4318 --token …');
    const token = args.token || process.env.AGENTCI_GATEWAY_TOKEN;
    if (!token) throw new Error('please provide --token (printed when the gateway starts)');
    const h = await gatewayHealth({ url: normalizeUrl(url), token });
    if (!h.ok) throw new Error(`gateway ${normalizeUrl(url)}: ${h.error} – not saved`);
    const saved = saveGatewaySettings({ url, token, enabled: true });
    console.log(`${color.green('✔')} Connected to ${saved.url} ${color.gray(`(${h.host})`)} – claude/codex now run on the gateway.`);
    printGatewayProviders(h);
    console.log(color.faint(`  Saved in ${settingsFile()} · single local run: --local · turn off: agentci gateway off`));
    return;
  }
  if (sub === 'on' || sub === 'off') {
    const s = saveGatewaySettings({ enabled: sub === 'on' });
    console.log(`Gateway ${s.enabled ? color.green('enabled') : color.yellow('disabled')}${s.url ? color.gray(` (${s.url})`) : ''}`);
    return;
  }
  if (sub === 'status') {
    const s = loadGatewaySettings();
    if (!s.url) return console.log('No gateway configured. Connect with: agentci gateway connect <url> --token <token>');
    console.log(`Gateway ${s.url} · ${s.enabled ? color.green('on') : color.yellow('off')} ${color.gray(`(source: ${s.source})`)}`);
    const h = await gatewayHealth(s);
    if (!h.ok) { console.log(`  ${color.red('✗')} ${h.error}`); process.exitCode = 1; return; }
    console.log(`  ${color.green('✔')} reachable ${color.gray(`(${h.host})`)}`);
    printGatewayProviders(h);
    return;
  }
  throw new Error(`unknown: agentci gateway ${sub} (start | connect | status | on | off)`);
}

function printGatewayProviders(h) {
  const p = h.providers || {};
  const line = (name, i) => console.log(`  ${i.installed && i.loggedIn && i.toolsOk !== false ? color.green('✔') : color.red('✗')} ${name.padEnd(8)} ${color.gray(!i.installed ? 'not installed' : !i.loggedIn ? 'not signed in' : i.toolsOk === false ? i.problem : 'ready')}`);
  line('claude', p.claude || {});
  line('codex', p.codex || {});
}

// Stable token for the networked UI, so bookmarks keep working across restarts.
function uiToken() {
  const file = path.join(process.env.AGENTCI_HOME || path.join(os.homedir(), '.config', 'agentci'), 'ui-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

function persistentToken() {
  const file = path.join(gatewayDataDir(), 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(gatewayDataDir(), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

function openBrowser(url) {
  const cmds = process.platform === 'darwin' ? [['open', [url]]]
    : process.platform === 'win32' ? [['cmd', ['/c', 'start', '', url]]]
      : [['wslview', [url]], ['xdg-open', [url]], ['cmd.exe', ['/c', 'start', '', url]]];
  for (const [cmd, a] of cmds) {
    const r = spawnSync(cmd, a, { stdio: 'ignore', timeout: 5000 });
    if (!r.error && r.status === 0) return;
  }
}

function doctor(cwd) {
  header('agentci doctor');
  const check = (name, cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    const ok = r.status === 0;
    console.log(`  ${ok ? color.green('✔') : color.red('✗')} ${name.padEnd(22)} ${color.dim((r.stdout || r.stderr || r.error?.message || '').trim().split('\n')[0])}`);
    return ok;
  };
  check('node', process.execPath, ['--version']);
  const hasClaude = check('claude (Claude Code)', 'claude', ['--version']);
  const hasCodex = check('codex (Codex CLI)', 'codex', ['--version']);
  if (hasCodex) {
    check('codex login', 'codex', ['login', 'status']);
    const h = codexHealth();
    console.log(`  ${h.ok ? color.green('✔') : color.red('✗')} ${'codex tools'.padEnd(22)} ${h.ok ? color.dim('files/commands usable') : color.red(h.problem)}`);
    if (!h.ok) console.log(color.yellow(`    → Codex can only talk, not write files. Fix: npm i -g @openai/codex\n      (or place codex-code-mode-host from the npm package next to ${h.path})`));
  }
  if (hasClaude) {
    const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
    let info = null;
    try { info = JSON.parse(r.stdout); } catch { /* older CLI: plain text */ }
    const ok = info ? info.loggedIn === true : r.status === 0;
    const msg = info ? (info.loggedIn ? `signed in (${info.authMethod === 'claude.ai' ? 'subscription' : info.authMethod})` : 'not signed in – run `claude` and /login')
      : (r.stdout || r.stderr || '').trim().split('\n')[0];
    console.log(`  ${ok ? color.green('✔') : color.red('✗')} ${'claude login'.padEnd(22)} ${color.dim(msg)}`);
  }
  check('python3 (.py syntax)', 'python3', ['--version']);
  const gw = loadGatewaySettings();
  if (gw.url) console.log(`  ${gw.enabled ? color.green('●') : color.gray('○')} ${'gateway'.padEnd(22)} ${gw.url} ${color.dim(gw.enabled ? '(on – claude/codex run there, details: agentci gateway status)' : '(off)')}`);

  const cfg = loadConfig(cwd);
  console.log(`\n  ${color.bold('Roles')} ${fs.existsSync(path.join(cwd, CONFIG_FILE)) ? '' : color.dim('(defaults – run agentci init to customise)')}`);
  for (const [role, rc] of Object.entries(cfg.roles)) {
    const off = rc.enabled === false ? color.dim(' (off)') : '';
    const missing = (rc.provider === 'claude' && !hasClaude) || (rc.provider === 'codex' && !hasCodex);
    console.log(`  ${role.padEnd(10)} ${rc.provider}${rc.model ? ':' + rc.model : ''}${off}${missing ? color.red('  ← not installed') : ''}`);
  }
  if (ANTHROPIC_KEY_WARNING()) console.log(color.yellow('\n  Note: ANTHROPIC_API_KEY is set – claude will bill the API key instead of your subscription.'));
}

const ANTHROPIC_KEY_WARNING = () => Boolean(process.env.ANTHROPIC_API_KEY);

async function demo(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-demo-'));
  console.log(color.dim(`demo directory: ${dir}`));
  const cfg = loadConfig(dir);
  for (const r of Object.keys(cfg.roles)) cfg.roles[r] = { provider: 'mock', model: null };
  const orch = await makeOrchestrator(dir, args, cfg);
  await runWithTerminal(orch, (o) => o.run('Build a small math library with a CLI'));
  const r = spawnSync(process.execPath, ['calc.js', '2', '3'], { cwd: dir, encoding: 'utf8' });
  console.log(`\n  node calc.js 2 3 → ${color.bold(r.stdout.trim())}`);
}

// Which options make sense for which command – a typo should not be swallowed silently.
const FLAGS = {
  common: ['dir', 'help'],
  run: ['roles', 'noReview', 'noTests', 'docs', 'fixAttempts', 'local'],
  plan: ['roles', 'noReview', 'noTests', 'docs', 'fixAttempts', 'local'],
  resume: ['roles', 'noReview', 'noTests', 'docs', 'fixAttempts', 'local'],
  ui: ['port', 'host', 'token', 'noOpen', 'local'],
  gateway: ['port', 'host', 'token', 'cert', 'key', 'noUi', 'dryRun'],
  bundle: ['serve', 'port', 'host', 'dirOut'],
  demo: ['roles'],
  status: [], check: [], init: [], doctor: [],
};
const FLAG_NAMES = {
  port: '--port', host: '--host', token: '--token', cert: '--cert', key: '--key', noOpen: '--no-open',
  noUi: '--no-ui', serve: '--serve', local: '--local', noReview: '--no-review', noTests: '--no-tests',
  docs: '--docs', fixAttempts: '--fix-attempts', dryRun: '--dry-run', roles: '--planner/--coder/…', dirOut: '--dir',
};

function checkFlags(cmd, args) {
  const allowed = new Set([...(FLAGS.common || []), ...(FLAGS[cmd] || [])]);
  const used = Object.keys(args).filter((k) => !['_', 'dir', 'help', 'roles'].includes(k) && args[k] !== undefined && args[k] !== false);
  if (Object.keys(args.roles || {}).length) used.push('roles');
  for (const key of used) {
    if (key === 'roles' && allowed.has('roles')) continue;
    if (!allowed.has(key) && FLAG_NAMES[key]) {
      throw new Error(`${FLAG_NAMES[key]} does not exist for "agentci ${cmd}".`
        + (key === 'serve' ? ' Did you mean: agentci bundle --serve (share the package) or agentci ui --host <address> (interface on the network)?' : '')
        + (key === 'host' && cmd === 'ui' ? '' : ''));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  if (args.help || !cmd) return console.log(HELP);
  if (FLAGS[cmd]) checkFlags(cmd, args);
  const cwd = path.resolve(args.dir || process.cwd());
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  switch (cmd) {
    case 'run': case 'plan': {
      const task = rest.join(' ').trim();
      if (!task) throw new Error(`please provide a task: agentci ${cmd} "Build ..."`);
      const orch = await makeOrchestrator(cwd, args);
      if (cmd === 'plan') {
        await runWithTerminal(orch, (o) => o.plan(task));
        console.log(color.gray('\n  Adjust the todos (agentci ui or .agentci/state.json), then: agentci resume\n'));
      } else {
        await runWithTerminal(orch, (o) => o.run(task));
      }
      break;
    }
    case 'resume': {
      const orch = await makeOrchestrator(cwd, args);
      if (!orch.loadState()) throw new Error('no saved run found (.agentci/state.json)');
      const st = orch.state;
      for (const t of st.todos) if (t.status === 'failed' || t.status === 'skipped') { t.status = 'pending'; t.notes = []; }
      await runWithTerminal(orch, (o) => o.execute());
      break;
    }
    case 'status': {
      const orch = await makeOrchestrator(cwd, args, null, { check: false });
      if (!orch.loadState()) return console.log('No run available.');
      header(orch.state.task);
      console.log(renderTodoList(orch.state.todos));
      console.log(color.gray(`\n  phase: ${orch.state.phase}${orch.state.costUsd ? ` · ≈ $${orch.state.costUsd.toFixed(2)}` : ''}`));
      break;
    }
    case 'check': {
      const cfg = loadConfig(cwd);
      const files = [...snapshot(cwd, cfg.ignore).keys()];
      const res = runChecks(cwd, files, { ...cfg.checks, syntax: true });
      const checked = res.syntax.filter((s) => !s.skipped);
      console.log(`Syntax: ${checked.filter((s) => s.ok).length}/${checked.length} files ok`);
      for (const c of res.commands) console.log(`${c.ok ? color.green('✔') : color.red('✗')} ${c.cmd}`);
      if (!res.ok) { console.log('\n' + res.report); process.exitCode = 1; }
      break;
    }
    case 'init': {
      if (fs.existsSync(path.join(cwd, CONFIG_FILE))) throw new Error(`${CONFIG_FILE} already exists`);
      console.log(`Created: ${writeDefaultConfig(cwd)}`);
      break;
    }
    case 'doctor': doctor(cwd); break;
    case 'demo': await demo(args); break;
    case 'ui': await ui(cwd, args); break;
    case 'gateway': await gatewayCmd(rest, args); break;
    case 'bundle': await bundleCmd(cwd, args); break;
    default: throw new Error(`unknown command "${cmd}" – agentci --help`);
  }
}

main().catch((e) => {
  console.error(color.red(`✗ ${e.message}`));
  process.exitCode = 1;
});
