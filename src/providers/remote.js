import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshot } from '../snapshot.js';
import { safeRel } from '../gateway/paths.js';

// Runs an agent on an agentci gateway (a machine with internet + Claude/Codex logins).
// Flow per call: send manifest → gateway says which files it lacks → send those + the prompt →
// stream tool events back → apply the returned file changes locally.
export function remoteProvider({ url, token, target, ignore = [] }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  async function post(pathname, body, signal) {
    let res;
    try {
      res = await fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(`gateway ${base} not reachable: ${netReason(e)}`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`gateway: ${data.error || `HTTP ${res.status}`}`), { status: res.status });
    }
    return res;
  }

  return {
    name: `remote:${target}`,
    async run({ role, phase, prompt, systemPrompt, cwd, model, effort, schema, canEdit, timeoutMs, onEvent, signal, todo }) {
      const started = Date.now();
      const snap = snapshot(cwd, ignore);
      const manifest = Object.fromEntries([...snap].map(([f, v]) => [f, v.hash]));
      const session = sessionId(cwd);
      const slot = canEdit ? 'edit' : 'ro';
      const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 120_000)]) : AbortSignal.timeout(timeoutMs + 120_000);

      let res;
      for (let attempt = 1; ; attempt++) {
        const { need } = await (await post('/v1/sync', { session, slot, manifest }, callSignal)).json();
        const files = Object.fromEntries(need.map((f) => [f, fs.readFileSync(path.join(cwd, f)).toString('base64')]));
        try {
          res = await post('/v1/run', {
            session, slot, manifest, files, ignore, provider: target,
            project: path.basename(path.resolve(cwd)), client: os.hostname(),
            role, phase, prompt, systemPrompt, model, effort, schema, canEdit, timeoutMs,
            todo: todo ? { id: todo.id, title: todo.title } : undefined,
          }, callSignal);
          break;
        } catch (e) {
          if (e.status === 409 && attempt < 3) continue; // workspace changed between sync and run
          throw e;
        }
      }

      let result = null;
      let buf = '';
      const decoder = new TextDecoder();
      const handle = (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'event') onEvent?.(msg.event);
        else if (msg.type === 'result') result = msg;
        else if (msg.type === 'error') throw new Error(msg.message);
      };
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      handle(buf);
      if (!result) throw new Error('the gateway closed the connection without a result');

      if (canEdit) applyChanges(cwd, result.changes, ignore, onEvent);
      return {
        text: result.text, data: result.data, costUsd: result.costUsd || 0,
        durationMs: result.durationMs || Date.now() - started,
      };
    },
  };
}

// Stable per project + machine, so the gateway can reuse the mirrored workspace between calls.
export function sessionId(cwd) {
  return 'p' + crypto.createHash('sha256').update(`${os.hostname()}:${path.resolve(cwd)}`).digest('hex').slice(0, 32);
}

export function applyChanges(cwd, changes = {}, ignore = [], onEvent) {
  const ignored = (rel) => rel.split('/').some((seg) => ignore.includes(seg));
  const root = fs.realpathSync(cwd);
  for (const [rel, b64] of Object.entries(changes.written || {})) {
    const safe = safeRel(rel);
    if (ignored(safe)) continue;
    const full = path.join(cwd, safe);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const parent = fs.realpathSync(path.dirname(full));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`the gateway tried to write outside the project: ${rel}`);
    if (fs.lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(full);
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
  }
  for (const rel of changes.deleted || []) {
    const safe = safeRel(rel);
    if (!ignored(safe)) fs.rmSync(path.join(cwd, safe), { force: true });
  }
  for (const rel of changes.skipped || []) {
    onEvent?.({ type: 'tool', name: 'Note', detail: `${rel} is too large and was not transferred` });
  }
}

export async function gatewayHealth({ url, token }) {
  const base = String(url).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return { ok: false, error: `not reachable (${netReason(e)})` };
  }
  if (res.status === 401) return { ok: false, error: 'wrong token' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = await res.json();
  if (data.service !== 'agentci-gateway') return { ok: false, error: 'not an agentci gateway' };
  return { ok: true, ...data };
}

// fetch() wraps the real network error; dig out something a human understands.
function netReason(e) {
  if (e.name === 'TimeoutError') return 'timeout';
  const c = e.cause;
  const code = c?.code || c?.errors?.[0]?.code;
  const known = {
    ECONNREFUSED: 'connection refused – is agentci gateway running there?',
    ENOTFOUND: 'host name unknown',
    EHOSTUNREACH: 'host unreachable',
    ETIMEDOUT: 'timeout',
    ECONNRESET: 'connection reset',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate – set NODE_EXTRA_CA_CERTS',
  };
  return known[code] || code || c?.message || e.message;
}
