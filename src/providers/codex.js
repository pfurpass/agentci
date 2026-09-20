import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess, extractJson } from './proc.js';

// Runs OpenAI Codex CLI headless. Uses the `codex login` session – i.e. your ChatGPT Plus/Pro subscription.
export function codexProvider({ bin = 'codex', permissions = {} } = {}) {
  return {
    name: 'codex',
    async run({ prompt, systemPrompt, cwd, model, effort, schema, canEdit, timeoutMs, onEvent, signal }) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentci-codex-'));
      const lastFile = path.join(tmp, 'last.txt');
      const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-o', lastFile,
        '-s', canEdit ? (permissions.codexSandbox || 'workspace-write') : 'read-only'];
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${mapEffort(effort)}"`);
      if (schema) {
        const schemaFile = path.join(tmp, 'schema.json');
        fs.writeFileSync(schemaFile, JSON.stringify(schema));
        args.push('--output-schema', schemaFile);
      }
      args.push('-');

      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      const started = Date.now();
      let errorMsg = null;
      let toolsBroken = null;
      try {
        const res = await runProcess(bin, args, {
          cwd, input: fullPrompt, timeoutMs, signal,
          onLine(line) {
            let ev;
            try { ev = JSON.parse(line); } catch { return; }
            if (ev.type === 'error' || ev.type === 'turn.failed') {
              errorMsg = ev.message || ev.error?.message || JSON.stringify(ev);
            }
            if (ev.type !== 'item.completed' && ev.type !== 'item.started') return;
            const it = ev.item || {};
            if (it.type === 'error' && /code[- ]mode/i.test(it.message || '')) toolsBroken = it.message;
            if (it.type === 'command_execution' && ev.type === 'item.started') {
              onEvent?.({ type: 'tool', name: 'Bash', detail: it.command });
            } else if (it.type === 'file_change' && ev.type === 'item.completed') {
              for (const ch of it.changes || []) onEvent?.({ type: 'tool', name: 'Edit', detail: `${ch.kind || ''} ${ch.path}`.trim() });
            } else if (it.type === 'agent_message' && ev.type === 'item.completed' && it.text) {
              onEvent?.({ type: 'text', text: it.text });
            }
          },
        });
        if (res.timedOut) throw new Error(`codex: timed out after ${Math.round(timeoutMs / 60000)} min`);
        // Without its tool host Codex can't touch files or run commands – it only apologises in prose.
        if (toolsBroken && canEdit) throw new Error(CODEX_HOST_HINT);
        const text = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8') : '';
        if (res.code !== 0 || (errorMsg && !text)) {
          throw new Error(`codex exited with code ${res.code}: ${errorMsg || res.stderr.slice(-800)}`);
        }
        return { text, data: schema ? extractJson(text) : null, costUsd: 0, durationMs: Date.now() - started };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

export const CODEX_HOST_HINT = 'Codex cannot touch files or run commands: "codex-code-mode-host" is missing (incomplete Codex install). '
  + 'Fix: install Codex via npm (npm i -g @openai/codex) – see agentci doctor.';

// Static health check: a standalone `codex` binary needs codex-code-mode-host next to it
// (the npm package ships both; copying only the `codex` binary breaks all tool use).
export function codexHealth(bin = 'codex') {
  const which = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const found = which.stdout.trim();
  if (which.status !== 0 || !found) return { installed: false, ok: false, problem: 'not installed' };
  let real = found;
  try { real = fs.realpathSync(found); } catch { /* keep */ }
  let isElf = false;
  try {
    const fd = fs.openSync(real, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    isElf = head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { /* unreadable – assume wrapper */ }
  if (isElf && !fs.existsSync(path.join(path.dirname(real), 'codex-code-mode-host'))) {
    const feat = spawnSync(bin, ['features', 'list'], { encoding: 'utf8', timeout: 10_000 });
    if (/code_mode_host\s+\S+\s+true/.test(feat.stdout || '')) {
      return { installed: true, ok: false, path: real, problem: 'codex-code-mode-host missing next to ' + real };
    }
  }
  return { installed: true, ok: true, path: real };
}

function mapEffort(e) {
  return { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }[e] || 'medium';
}
