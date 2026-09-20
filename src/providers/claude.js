import { runProcess, extractJson } from './proc.js';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

// Claude Code caches the system prompt. A per-role system prompt would break that prefix on
// every call, so all roles share one line and the role instructions travel in the message.
// Measured: cache writes drop from 7.8k to 3.8k tokens per call (~40% cheaper per call).
const SHARED_SYSTEM = 'You are one agent in an agentci team (planner, coder, checker, reviewer, tester). '
  + 'The message starts with YOUR ROLE – follow it exactly and ignore the other roles\' jobs.';

// Runs Claude Code headless. Uses whatever login `claude` has – i.e. your Pro/Max subscription.
// Never pass --bare here: bare mode ignores the subscription login and requires an API key.
export function claudeProvider({ bin = 'claude', permissions = {} } = {}) {
  return {
    name: 'claude',
    async run({ prompt, systemPrompt, cwd, model, effort, schema, canEdit, timeoutMs, onEvent, signal }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--strict-mcp-config']; // project .mcp.json servers would add context we never asked for
      args.push('--append-system-prompt', SHARED_SYSTEM);
      const input = systemPrompt ? `YOUR ROLE\n${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (schema) args.push('--json-schema', JSON.stringify(schema));
      if (canEdit) {
        args.push('--permission-mode', permissions.claudeMode || 'acceptEdits');
        args.push('--allowedTools', ...(permissions.claudeAllowedTools || []));
      } else {
        args.push('--permission-mode', 'default');
        args.push('--allowedTools', ...READ_ONLY_TOOLS);
        args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash');
      }

      let result = null;
      const started = Date.now();
      const res = await runProcess(bin, args, {
        cwd, input, timeoutMs, signal,
        onLine(line) {
          let ev;
          try { ev = JSON.parse(line); } catch { return; }
          if (ev.type === 'result') { result = ev; return; }
          if (ev.type !== 'assistant') return;
          for (const block of ev.message?.content || []) {
            if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
              onEvent?.({ type: 'tool', name: block.name, detail: describeTool(block.name, block.input) });
            } else if (block.type === 'text' && block.text?.trim()) {
              onEvent?.({ type: 'text', text: block.text });
            }
          }
        },
      });

      if (res.timedOut) throw new Error(`claude: timed out after ${Math.round(timeoutMs / 60000)} min`);
      if (!result) {
        throw new Error(`claude exited with code ${res.code}: ${(res.stderr || res.stdout).slice(-800)}`);
      }
      if (result.is_error) {
        throw new Error(`claude error (${result.subtype}): ${String(result.result || '').slice(0, 800)}`);
      }
      const text = result.result ?? '';
      return {
        text,
        data: schema ? (result.structured_output ?? extractJson(text)) : null,
        costUsd: result.total_cost_usd ?? 0,
        durationMs: Date.now() - started,
        denials: result.permission_denials || [],
      };
    },
  };
}

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit':
      return input.file_path || '';
    case 'Bash':
      return input.command || '';
    case 'Glob': case 'Grep':
      return input.pattern || '';
    default:
      return '';
  }
}
