import { spawn } from 'node:child_process';

// Spawns a CLI, feeds stdin, streams stdout line by line. Resolves with exit info.
export function runProcess(cmd, args, { cwd, input, timeoutMs, onLine, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;

    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (!onLine) return;
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" is not installed or not in PATH`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Pulls the first JSON object/array out of free text (models sometimes wrap JSON in prose or fences).
export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [text, fenced?.[1]].filter(Boolean);
  for (const cand of candidates) {
    try { return JSON.parse(cand.trim()); } catch { /* try next */ }
  }
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
