import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'agentci.config.json';
export const STATE_DIR = '.agentci';

// Each role can run on a different AI. provider: claude | codex | mock
export const DEFAULT_CONFIG = {
  roles: {
    planner: { provider: 'claude', model: 'opus', effort: 'high' },
    coder: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    reviewer: { provider: 'codex', model: null, fallback: 'claude:sonnet' }, // fallback: used when codex fails or hits its limit
    tester: { provider: 'claude', model: 'sonnet', effort: 'medium', fallback: 'claude:sonnet' },
    docs: { provider: 'claude', model: 'haiku', enabled: false },
  },
  pipeline: {
    maxFixAttempts: 3,      // how often the coder may retry after failed checks
    maxReviewRounds: 2,     // reviewer ↔ coder rounds per todo (0 = no review)
    reviewStrictness: 'normal', // which issues block: lenient = critical · normal = + major · strict = everything
    maxTodos: 8,            // upper limit for the planner's todo list
    writeTests: true,       // tester role writes tests per todo
    skipTesterIfTested: true, // save a whole agent call when the coder already wrote tests
    timeoutMinutes: 20,     // per agent call
    projectMap: true,       // send agentci's own static project map in the prompts (saves tokens)
  },
  checks: {
    syntax: true,           // built-in syntax checker for all changed files
    commands: [],           // extra shell commands, e.g. ["npm run lint", "npm test"]
    autoDetectTests: true,  // npm test / pytest / go test / cargo test when detected
    autoInstall: true,      // run npm install once when a test command needs node_modules
  },
  permissions: {
    // claude: acceptEdits = files ok, shell only for allowed commands; bypassPermissions = everything
    claudeMode: 'acceptEdits',
    claudeAllowedTools: [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(pnpm *)', 'Bash(yarn *)',
      'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pytest *)',
      'Bash(go *)', 'Bash(cargo *)', 'Bash(ls *)', 'Bash(mkdir *)', 'Bash(cat *)',
    ],
    // codex: read-only | workspace-write | danger-full-access
    codexSandbox: 'workspace-write',
  },
  // House rules every agent gets, e.g. "TypeScript only, no new dependencies".
  // Per role: roles.<role>.instructions (e.g. a reviewer that also checks accessibility).
  instructions: '',
  ignore: ['node_modules', '.git', '.agentci', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target', '.next',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'coverage', '.nyc_output', '.gradle', '.idea', '.vscode'],
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(cwd) {
  const file = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  return validateConfig(deepMerge(structuredClone(DEFAULT_CONFIG), user));
}

export const PROVIDERS = ['claude', 'codex', 'mock'];
export const STRICTNESS = ['lenient', 'normal', 'strict'];

const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateConfig(cfg) {
  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (!PROVIDERS.includes(rc.provider)) {
      throw new Error(`role "${role}": unknown provider "${rc.provider}" (allowed: ${PROVIDERS.join(', ')})`);
    }
  }
  for (const r of ['planner', 'coder']) {
    if (!cfg.roles[r]) throw new Error(`role "${r}" is missing from the configuration`);
  }
  const p = cfg.pipeline;
  if (!intIn(p.maxReviewRounds, 0, 10)) throw new Error(`pipeline.maxReviewRounds must be a whole number from 0 to 10 (got ${p.maxReviewRounds})`);
  if (!intIn(p.maxFixAttempts, 0, 10)) throw new Error(`pipeline.maxFixAttempts must be a whole number from 0 to 10 (got ${p.maxFixAttempts})`);
  if (!intIn(p.maxTodos, 1, 30)) throw new Error(`pipeline.maxTodos must be a whole number from 1 to 30 (got ${p.maxTodos})`);
  if (!STRICTNESS.includes(p.reviewStrictness)) {
    throw new Error(`pipeline.reviewStrictness must be one of ${STRICTNESS.join(', ')} (got "${p.reviewStrictness}")`);
  }
  if (!(Number(p.timeoutMinutes) > 0)) throw new Error(`pipeline.timeoutMinutes must be a positive number (got ${p.timeoutMinutes})`);
  return cfg;
}

export function writeDefaultConfig(cwd, overrides = {}) {
  const file = path.join(cwd, CONFIG_FILE);
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), overrides);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

export function stateDir(cwd) {
  const dir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}
