import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
const hasCache = new Map();
const available = (bin) => {
  if (!hasCache.has(bin)) hasCache.set(bin, has(bin));
  return hasCache.get(bin);
};

function run(cmd, args, cwd, timeout = 60_000) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

const PY_PARSE = 'import ast,sys\nfor f in sys.argv[1:]:\n    ast.parse(open(f,encoding="utf-8").read(), f)';

// Returns { file, ok, skipped?, output } per file. Pure syntax – no code is executed.
export function checkFileSyntax(cwd, file) {
  const full = path.join(cwd, file);
  if (!fs.existsSync(full)) return { file, ok: true, skipped: 'deleted' };
  const ext = path.extname(file).toLowerCase();

  switch (ext) {
    case '.mjs': case '.cjs':
      return { file, ...run(process.execPath, ['--check', full], cwd) };
    case '.js':
      return { file, ...checkPlainJs(cwd, full) };
    case '.ts': case '.mts': case '.cts':
      return { file, ...checkTypeScript(cwd, full) };
    case '.json': {
      try {
        JSON.parse(fs.readFileSync(full, 'utf8'));
        return { file, ok: true, output: '' };
      } catch (e) {
        return { file, ok: false, output: `${file}: ${e.message}` };
      }
    }
    case '.py':
      if (!available('python3')) return { file, ok: true, skipped: 'python3 missing' };
      return { file, ...run('python3', ['-c', PY_PARSE, full], cwd) };
    case '.sh': case '.bash':
      return { file, ...run('bash', ['-n', full], cwd) };
    case '.go':
      if (!available('gofmt')) return { file, ok: true, skipped: 'gofmt missing' };
      return { file, ...run('gofmt', ['-e', '-l', full], cwd) };
    case '.rb':
      if (!available('ruby')) return { file, ok: true, skipped: 'ruby missing' };
      return { file, ...run('ruby', ['-c', full], cwd) };
    case '.php':
      if (!available('php')) return { file, ok: true, skipped: 'php missing' };
      return { file, ...run('php', ['-l', full], cwd) };
    default:
      return { file, ok: true, skipped: 'no syntax check for this file type' };
  }
}

// `node --check x.js` silently passes broken ESM files (module-type detection), so we check an
// explicit .mjs/.cjs copy instead: valid as either module type = ok.
function checkPlainJs(cwd, full) {
  const src = fs.readFileSync(full, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-js-'));
  try {
    const looksEsm = /^\s*(import|export)\b/m.test(src) || nearestPkgType(full) === 'module';
    const order = looksEsm ? ['.mjs', '.cjs'] : ['.cjs', '.mjs'];
    let first;
    for (const ext of order) {
      const tmp = path.join(tmpDir, 'check' + ext);
      fs.writeFileSync(tmp, src);
      const r = run(process.execPath, ['--check', tmp], cwd);
      if (r.ok) return r;
      first ??= { ok: false, output: r.output.split(tmp).join(full) };
    }
    return first;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function nearestPkgType(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try { return JSON.parse(fs.readFileSync(pkg, 'utf8')).type || 'commonjs'; } catch { return 'commonjs'; }
    }
    if (path.dirname(dir) === dir) return 'commonjs';
  }
}

// Strip types with Node's built-in stripper, then syntax-check the JS. Exit 3 = Node has no TS support.
const TS_CHECK = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { spawnSync } = require('node:child_process');
let js;
try { js = stripTypeScriptTypes(fs.readFileSync(process.argv[1], 'utf8')); }
catch (e) { if (e.code === 'ERR_NO_TYPESCRIPT') process.exit(3); console.error(process.argv[1] + ': ' + e.message); process.exit(1); }
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-ts-')), 'check.mjs');
fs.writeFileSync(tmp, js);
const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
process.stderr.write((r.stderr || '').split(tmp).join(process.argv[1]));
process.exit(r.status);`;

function checkTypeScript(cwd, full) {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', TS_CHECK, full], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 3) return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  // Projects with typescript + tsconfig get `tsc --noEmit` via detectTestCommands anyway.
  return { ok: true, skipped: 'Node without TS support – tsc runs at project level (or add "npx tsc --noEmit" to checks.commands)' };
}

// Detects the project's test command(s).
export function detectTestCommands(cwd) {
  const cmds = [];
  const pkgFile = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const t = pkg.scripts?.test;
      if (t && !/no test specified/.test(t)) cmds.push('npm test --silent');
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) cmds.unshift('npx --no-install tsc --noEmit');
      }
    } catch { /* invalid package.json is reported by the syntax check */ }
  }
  if (!cmds.some((c) => c.startsWith('npm test')) && hasNodeTests(cwd)) cmds.push('node --test');
  if (fs.existsSync(path.join(cwd, 'go.mod'))) cmds.push('go test ./...');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) cmds.push('cargo test --quiet');
  if (hasPyTests(cwd) && available('pytest')) cmds.push('pytest -q');
  else if (hasPyTests(cwd)) cmds.push('python3 -m unittest discover -q');
  return cmds;
}

function listTop(cwd, sub = '') {
  try { return fs.readdirSync(path.join(cwd, sub)); } catch { return []; }
}

function hasNodeTests(cwd) {
  const re = /\.test\.(m?js|cjs)$/;
  return listTop(cwd).some((f) => re.test(f)) || listTop(cwd, 'test').some((f) => /\.(m?js|cjs)$/.test(f));
}

function hasPyTests(cwd) {
  const re = /^test_.*\.py$|_test\.py$/;
  return listTop(cwd).some((f) => re.test(f)) || listTop(cwd, 'tests').some((f) => re.test(f));
}

export function runCommand(cwd, cmd, timeoutMs = 10 * 60_000) {
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT; // otherwise a nested `node --test` reports to our runner and always exits 0
  const r = spawnSync('sh', ['-c', cmd], {
    cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { cmd, ok: r.status === 0 && !timedOut, output: timedOut ? `${output}\n(timed out)` : output };
}

// Missing tooling is not a coding mistake – the coder cannot fix "jest: not found",
// especially when the agents run on a gateway where node_modules stays behind.
const TOOLING_MISSING = [
  /\b(\w[\w.-]*): not found/i,
  /command not found/i,
  /Cannot find module '(jest|vitest|mocha|ts-node|tsx|@[\w./-]+)'/i,
  /ModuleNotFoundError: No module named '(pytest|unittest2)'/i,
  /ENOENT.*spawn/i,
  /npm ERR! (code E404|missing script)/i,
];

export function isToolingFailure(output = '') {
  return TOOLING_MISSING.some((re) => re.test(output));
}

// Installs project dependencies once when a test command needs them – no AI involved.
export function ensureDependencies(cwd, commands, { install = true } = {}) {
  if (!install) return null;
  const needsNode = commands.some((c) => /^(npm|npx|yarn|pnpm|node --test)/.test(c));
  const hasPkg = fs.existsSync(path.join(cwd, 'package.json'));
  const hasModules = fs.existsSync(path.join(cwd, 'node_modules'));
  if (!needsNode || !hasPkg || hasModules) return null;
  let deps = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch { /* the syntax check reports a broken package.json */ }
  if (!Object.keys(deps).length) return null;
  const cmd = fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
  const r = runCommand(cwd, cmd, 10 * 60_000);
  return { cmd, ok: r.ok, output: tail(r.output, 1500) };
}

// Full check: syntax of changed files + configured/detected commands.
export function runChecks(cwd, changedFiles, checksCfg) {
  const syntax = checksCfg.syntax ? changedFiles.map((f) => checkFileSyntax(cwd, f)) : [];
  const commands = [...(checksCfg.commands || [])];
  if (checksCfg.autoDetectTests) {
    for (const c of detectTestCommands(cwd)) if (!commands.includes(c)) commands.push(c);
  }
  const install = ensureDependencies(cwd, commands, { install: checksCfg.autoInstall !== false });
  const cmdResults = commands.map((c) => runCommand(cwd, c));
  const failures = [
    ...syntax.filter((s) => !s.ok).map((s) => `SYNTAX ERROR in ${s.file}:\n${tail(s.output)}`),
    ...cmdResults.filter((r) => !r.ok).map((r) => `COMMAND FAILED: ${r.cmd}\n${tail(r.output)}`),
  ];
  const tooling = cmdResults.filter((r) => !r.ok).length > 0
    && cmdResults.filter((r) => !r.ok).every((r) => isToolingFailure(r.output))
    && syntax.every((s) => s.ok);
  return {
    ok: failures.length === 0, syntax, commands: cmdResults, failures, install,
    tooling, // every failure is "tool missing", not broken code
    report: failures.join('\n\n'),
  };
}

function tail(s, max = 4000) {
  s = String(s || '');
  return s.length > max ? '…' + s.slice(-max) : s;
}
