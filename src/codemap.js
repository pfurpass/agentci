import fs from 'node:fs';
import path from 'node:path';
import { snapshot } from './snapshot.js';

// Static project map built WITHOUT an LLM: files, their imports and their exported symbols.
// It goes into the prompts so agents don't have to burn tokens exploring the tree,
// and it feeds the dependency graph in the web UI.

const LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'ts',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.rb': 'rb', '.php': 'php',
  '.java': 'java', '.cs': 'cs', '.css': 'css', '.html': 'html',
  '.json': 'json', '.md': 'md', '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'sh',
};
const CODE = new Set(['js', 'ts', 'py', 'go', 'rs', 'rb', 'php', 'java', 'cs']);
const MAX_PARSE_BYTES = 400 * 1024;

const RE = {
  jsImport: /(?:^|\n)\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|(?:^|[^\w.])require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
  jsExport: /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)|(?:^|\n)\s*export\s*\{([^}]*)\}|(?:^|\n)\s*module\.exports\s*=\s*\{([^}]*)\}|(?:^|\n)\s*exports\.([A-Za-z_$][\w$]*)\s*=/g,
  pyImport: /(?:^|\n)\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g,
  pyExport: /(?:^|\n)(?:def|class)\s+([A-Za-z_]\w*)/g,
  goImport: /(?:^|\n)\s*(?:import\s+"([^"]+)"|\s+"([^"]+)")/g,
  goExport: /(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|(?:^|\n)type\s+([A-Z]\w*)/g,
};

export function buildCodeMap(cwd, ignore = [], snap = snapshot(cwd, ignore)) {
  const files = [];
  for (const [rel, v] of snap) {
    const ext = path.extname(rel).toLowerCase();
    const lang = LANG[ext] || null;
    const content = v.content;
    const file = {
      path: rel, lang, bytes: byteLength(content, v),
      loc: content ? content.split('\n').length : null,
      imports: [], exports: [], external: [],
    };
    if (content && content.length <= MAX_PARSE_BYTES && CODE.has(lang)) parse(file, content);
    files.push(file);
  }
  const byPath = new Set(files.map((f) => f.path));
  const edges = [];
  for (const f of files) {
    const resolved = new Set();
    for (const spec of f.imports) {
      const target = resolveImport(f.path, spec, byPath, f.lang);
      if (target && target !== f.path) resolved.add(target);
      else if (!target && isExternal(spec)) f.external.push(spec);
    }
    f.deps = [...resolved];
    for (const to of f.deps) edges.push({ from: f.path, to });
  }
  for (const f of files) f.dependents = edges.filter((e) => e.to === f.path).map((e) => e.from);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: cwd, files, edges, generatedAt: Date.now() };
}

function byteLength(content, v) {
  return content != null ? Buffer.byteLength(content) : (v.bytes ?? null);
}

function parse(file, src) {
  const add = (arr, val) => { if (val && !arr.includes(val)) arr.push(val); };
  if (file.lang === 'js' || file.lang === 'ts') {
    for (const m of src.matchAll(RE.jsImport)) add(file.imports, m[1] || m[2] || m[3] || m[4]);
    for (const m of src.matchAll(RE.jsExport)) {
      if (m[2]) add(file.exports, m[2]);
      for (const part of (m[3] || m[4] || '').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) add(file.exports, name);
      }
      if (m[5]) add(file.exports, m[5]);
    }
    if (/(^|\n)\s*export\s+default\s/.test(src)) add(file.exports, 'default');
  } else if (file.lang === 'py') {
    for (const m of src.matchAll(RE.pyImport)) add(file.imports, m[1] || m[2]);
    for (const m of src.matchAll(RE.pyExport)) if (!m[1].startsWith('_')) add(file.exports, m[1]);
  } else if (file.lang === 'go') {
    for (const m of src.matchAll(RE.goImport)) add(file.imports, m[1] || m[2]);
    for (const m of src.matchAll(RE.goExport)) add(file.exports, m[1] || m[2]);
  }
}

const JS_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json'];

export function resolveImport(from, spec, files, lang) {
  if (!spec) return null;
  if (lang === 'py') {
    if (!spec.startsWith('.')) {
      const guess = spec.replaceAll('.', '/');
      for (const cand of [`${guess}.py`, `${guess}/__init__.py`]) if (files.has(cand)) return cand;
      return null;
    }
    const up = spec.match(/^\.+/)[0].length - 1;
    const rest = spec.slice(up + 1).replaceAll('.', '/');
    let dir = path.posix.dirname(from);
    for (let i = 0; i < up; i++) dir = path.posix.dirname(dir);
    for (const cand of [`${rest}.py`, `${rest}/__init__.py`]) {
      const p = path.posix.normalize(path.posix.join(dir, cand));
      if (files.has(p)) return p;
    }
    return null;
  }
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // package, not a project file
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (files.has(base)) return base;
  for (const ext of JS_EXT) {
    if (files.has(base + ext)) return base + ext;
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  // TS often imports "./x.js" but the file is "./x.ts"
  const noExt = base.replace(/\.[cm]?js$/, '');
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(noExt + ext)) return noExt + ext;
  return null;
}

function isExternal(spec) {
  return Boolean(spec) && !spec.startsWith('.') && !spec.startsWith('/');
}

// Compact, token-cheap rendering for prompts.
export function formatCodeMap(map, { maxChars = 12_000, changed = [] } = {}) {
  const dirs = new Map();
  for (const f of map.files) {
    const dir = path.posix.dirname(f.path) === '.' ? '/' : path.posix.dirname(f.path);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  const lines = [`PROJECT MAP (${map.files.length} files, built by agentci – no need to list or grep the tree):`];
  for (const [dir, list] of [...dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir}/`);
    for (const f of list) {
      const name = path.posix.basename(f.path);
      const parts = [];
      if (f.loc) parts.push(`${f.loc}L`);
      if (f.exports.length) parts.push(`exports: ${f.exports.slice(0, 12).join(', ')}${f.exports.length > 12 ? ', …' : ''}`);
      if (f.deps?.length) parts.push(`imports: ${f.deps.map((d) => path.posix.basename(d)).slice(0, 8).join(', ')}${f.deps.length > 8 ? ', …' : ''}`);
      if (changed.includes(f.path)) parts.push('CHANGED IN THIS RUN');
      lines.push(`  ${name}${parts.length ? ` – ${parts.join(' | ')}` : ''}`);
    }
  }
  const externals = topExternals(map);
  if (externals.length) lines.push(`external packages used: ${externals.join(', ')}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (map truncated – read the remaining files yourself if needed)';
  return text;
}

function topExternals(map, limit = 25) {
  const count = new Map();
  for (const f of map.files) for (const e of f.external) count.set(e, (count.get(e) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
}

// Graph payload for the web UI: nodes grouped by folder, edges between project files.
export function graphData(map, changed = []) {
  const nodes = map.files
    .filter((f) => f.lang && (f.deps?.length || f.dependents?.length || CODE.has(f.lang)))
    .map((f) => ({
      id: f.path,
      dir: path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path),
      name: path.posix.basename(f.path),
      lang: f.lang, loc: f.loc || 0, exports: f.exports.slice(0, 20),
      deps: f.deps?.length || 0, dependents: f.dependents?.length || 0,
      changed: changed.includes(f.path),
    }));
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: map.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), files: map.files.length };
}

// Cheap cache: rebuild only when the file set or its hashes changed.
export function createCodeMapCache() {
  let key = null;
  let map = null;
  return (cwd, ignore) => {
    const snap = snapshot(cwd, ignore);
    const k = [...snap].map(([f, v]) => `${f}:${v.hash}`).join('|');
    if (k !== key) {
      key = k;
      map = buildCodeMap(cwd, ignore, snap);
    }
    return map;
  };
}

export { CODE as CODE_LANGS };
