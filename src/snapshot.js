import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_KEEP_BYTES = 256 * 1024;

// Snapshot of the workspace so we know exactly which files an agent touched – works without git.
export function snapshot(root, ignore = []) {
  const files = new Map();
  const ignoreSet = new Set(ignore);
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const buf = fs.readFileSync(full);
        const rel = path.relative(root, full).split(path.sep).join('/');
        files.set(rel, {
          hash: crypto.createHash('sha1').update(buf).digest('hex'),
          content: buf.length <= MAX_KEEP_BYTES && !buf.includes(0) ? buf.toString('utf8') : null,
        });
      }
    }
  })(root);
  return files;
}

export function diffSnapshots(before, after) {
  const added = []; const modified = []; const deleted = [];
  for (const [f, v] of after) {
    if (!before.has(f)) added.push(f);
    else if (before.get(f).hash !== v.hash) modified.push(f);
  }
  for (const f of before.keys()) if (!after.has(f)) deleted.push(f);
  return { added, modified, deleted, changed: [...added, ...modified] };
}

// Minimal line diff (LCS) for the reviewer prompt.
export function unifiedDiff(file, oldText, newText, context = 3) {
  const a = oldText == null ? [] : oldText.split('\n');
  const b = newText == null ? [] : newText.split('\n');
  if (a.length * b.length > 4_000_000) return `--- ${file}\n(file too large for a diff – read it directly)\n`;

  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', b[j]]); j++; }
    else { ops.push(['-', a[i]]); i++; }
  }

  const keep = new Array(ops.length).fill(false);
  ops.forEach(([t], k) => {
    if (t === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let gap = false;
  ops.forEach(([t, line], k) => {
    if (!keep[k]) { if (!gap) out.push('@@ …'); gap = true; return; }
    gap = false;
    out.push(t + line);
  });
  return out.join('\n') + '\n';
}

export function diffText(before, after, changes, maxChars = 60_000) {
  let text = '';
  for (const f of [...changes.added, ...changes.modified, ...changes.deleted]) {
    const oldC = before.get(f)?.content ?? null;
    const newC = after.get(f)?.content ?? null;
    text += unifiedDiff(f, oldC, newC) + '\n';
    if (text.length > maxChars) return text.slice(0, maxChars) + '\n… (diff truncated – read the remaining files directly)\n';
  }
  return text;
}
