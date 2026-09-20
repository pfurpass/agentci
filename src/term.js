// Terminal renderer: turns orchestrator events into a styled log plus a live footer
// (spinner per active agent, progress bar). Falls back to plain lines when not a TTY.

const out = process.stdout;
const TTY = Boolean(out.isTTY) && !process.env.NO_COLOR;
const LIVE = TTY && !process.env.CI;

const esc = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const fg = (n) => esc(`38;5;${n}`);
export const st = {
  bold: esc('1'), dim: esc('2'), italic: esc('3'),
  red: fg(203), green: fg(114), yellow: fg(221), blue: fg(75), gray: fg(244), faint: fg(239), white: fg(255),
};

export const ROLE = {
  planner: { label: 'PLAN', color: 141 },
  coder: { label: 'CODE', color: 75 },
  reviewer: { label: 'REVIEW', color: 221 },
  tester: { label: 'TEST', color: 80 },
  checker: { label: 'CHECK', color: 114 },
  docs: { label: 'DOCS', color: 246 },
  system: { label: 'AGENTCI', color: 255 },
};

const PHASE = { plan: 'planning', implement: 'implementing', fix: 'fixing', review: 'reviewing', test: 'writing tests', docs: 'writing docs' };
const TOOL = { Edit: '✎', Write: '✎', MultiEdit: '✎', NotebookEdit: '✎', Read: '◇', Bash: '$', Glob: '⌕', Grep: '⌕', WebFetch: '↯', WebSearch: '↯', Task: '◈' };
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------- string helpers ----------
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const visible = (s) => String(s).replace(ANSI, '');
export const vlen = (s) => [...visible(s)].length;

export function fit(s, width) {
  s = String(s);
  if (vlen(s) <= width) return s;
  let outStr = ''; let n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*[A-Za-z])/)) {
    if (/^\x1b\[[0-9;]*[A-Za-z]$/.test(part)) { outStr += part; continue; }
    for (const ch of part) {
      if (n >= width - 1) return outStr + '…' + (TTY ? '\x1b[0m' : '');
      outStr += ch; n++;
    }
  }
  return outStr;
}

const pad = (s, w) => s + ' '.repeat(Math.max(0, w - vlen(s)));
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function wrap(text, width, maxLines = 4) {
  const words = oneLine(text).split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = fit(lines[maxLines - 1] + ' …', width);
  return lines;
}

export function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function badge(role) {
  const r = ROLE[role] || { label: role.toUpperCase(), color: 250 };
  const text = ` ${r.label} `.padEnd(8);
  return TTY ? `\x1b[48;5;${r.color}m\x1b[38;5;232m\x1b[1m${text}\x1b[0m` : `[${r.label}]`.padEnd(9);
}
const roleFg = (role) => fg((ROLE[role] || { color: 250 }).color);
const width = () => Math.max(60, Math.min(out.columns || 100, 120));
const GUT = TTY ? '         ' : '          ';

// ---------- renderer ----------
export class TerminalRenderer {
  constructor({ showFooter = LIVE } = {}) {
    this.showFooter = showFooter;
    this.footerHeight = 0;
    this.active = new Map(); // agent id -> { role, phase, todo, started, last }
    this.state = null;
    this.startedAt = Date.now();
    this.frame = 0;
    this.timer = null;
    this.handle = this.handle.bind(this);
  }

  attach(orch) {
    orch.on('event', this.handle);
    if (this.showFooter) {
      out.write('\x1b[?25l');
      const restore = () => out.write('\x1b[?25h');
      process.once('exit', restore);
      this.timer = setInterval(() => { this.frame++; if (this.active.size) this.redraw(); }, 90);
      this.timer.unref();
    }
    return this;
  }

  detach(orch) {
    orch?.off('event', this.handle);
    clearInterval(this.timer);
    this.clearFooter();
    if (this.showFooter) out.write('\x1b[?25h');
  }

  // ---- footer plumbing ----
  clearFooter() {
    if (this.footerHeight) out.write(`\x1b[${this.footerHeight}F\x1b[J`);
    this.footerHeight = 0;
  }

  drawFooter() {
    if (!this.showFooter || !this.state) return;
    const w = width() - 1;
    const lines = [st.faint('─'.repeat(w))];
    for (const a of this.active.values()) {
      const spin = roleFg(a.role)(SPIN[this.frame % SPIN.length]);
      const what = `${PHASE[a.phase] || a.phase}${a.todo ? ' ' + a.todo : ''}`;
      const last = a.last ? st.gray(`${TOOL[a.last.name] || '•'} ${a.last.name} ${a.last.detail}`) : st.faint('thinking…');
      lines.push(fit(` ${spin} ${badge(a.role)} ${pad(what, 18)} ${st.dim(pad(clock(Date.now() - a.started), 6))} ${last}`, w));
    }
    const todos = this.state.todos || [];
    const done = todos.filter((t) => ['done', 'failed', 'skipped'].includes(t.status)).length;
    const barW = 24;
    const filled = todos.length ? Math.round((done / todos.length) * barW) : 0;
    const bar = st.green('▰'.repeat(filled)) + st.faint('▱'.repeat(barW - filled));
    const cost = this.state.costUsd ? ` · ≈ $${this.state.costUsd.toFixed(2)}` : '';
    const left = ` ${bar}  ${st.bold(`${done}/${todos.length || '?'}`)} Todos · ${clock(Date.now() - this.startedAt)}${cost}`;
    const right = st.faint('Ctrl+C stops');
    lines.push(fit(pad(left, w - vlen(right)) + right, w));
    out.write(lines.join('\n') + '\n');
    this.footerHeight = lines.length;
  }

  redraw() {
    this.clearFooter();
    this.drawFooter();
  }

  print(...lines) {
    this.clearFooter();
    const w = width() - 1;
    for (const l of lines) out.write((TTY ? fit(l, w) : visible(l)) + '\n');
    this.drawFooter();
  }

  // ---- blocks ----
  banner(task, team, cwd, gateway) {
    const w = Math.min(width() - 2, 96);
    const inner = w - 4;
    const row = (s) => st.faint('│ ') + pad(fit(s, inner), inner) + st.faint(' │');
    const teamLine = Object.entries(team || {}).map(([r, m]) => `${roleFg(r)('●')} ${st.gray(r)} ${m}`).join(st.faint('  '));
    const lines = [
      '',
      st.faint('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${st.bold(fg(141)('◆ agentci'))}  ${st.gray('Multi-Agent Coding')}`),
      row(''),
      ...wrap(task, inner - 10, 3).map((l, i) => row(`${i ? '          ' : st.gray('Task      ')}${st.white(l)}`)),
      row(`${st.gray('Folder    ')}${cwd}`),
      row(`${st.gray('Team      ')}${teamLine}`),
      ...(gateway ? [row(`${st.gray('Gateway   ')}${fg(80)('⇄')} ${gateway} ${st.faint('(claude/codex run there)')}`)] : []),
      st.faint('╰' + '─'.repeat(w - 2) + '╯'),
    ];
    this.print(...lines);
  }

  section(title, right = '') {
    const w = Math.min(width() - 2, 96);
    const lead = `${st.faint('━━')} ${st.bold(title)} `;
    const tailTxt = right ? ` ${st.gray(right)} ${st.faint('━━')}` : '';
    const fill = Math.max(3, w - vlen(lead) - vlen(tailTxt));
    this.print('', fit(lead + st.faint('━'.repeat(fill)) + tailTxt, w));
  }

  // ---- event handling ----
  handle(ev) {
    const h = this['on_' + ev.type.replace('.', '_')];
    if (h) h.call(this, ev);
  }

  on_state(ev) { this.state = ev.state; }

  on_run_start(ev) {
    this.startedAt = ev.t;
    this.banner(ev.task, ev.team, ev.cwd, ev.gateway);
    this.section('Planning');
  }

  on_run_resume(ev) {
    if (this.planned) return; // normal run: banner + plan already shown
    this.planned = true;
    this.startedAt = ev.t;
    this.banner(ev.task, ev.team, ev.cwd, ev.gateway);
    if (this.state) this.print('', renderTodoList(this.state.todos));
  }

  on_plan(ev) {
    this.planned = true;
    const w = Math.min(width() - 2, 96);
    const lines = ['', ...wrap(ev.summary, w - GUT.length, 3).map((l) => GUT + st.white(l)), ''];
    ev.todos.forEach((t, i) => {
      const deps = t.dependsOn.length ? st.faint(`  ← ${t.dependsOn.join(', ')}`) : '';
      lines.push(`${GUT}${st.faint(String(i + 1).padStart(2) + '.')} ${fg(141)(t.id.padEnd(4))} ${t.title}${deps}`);
    });
    this.print(...lines);
  }

  on_todo_start(ev) {
    this.section(`${ev.todo.id}  ${ev.todo.title}`, `${ev.index + 1}/${ev.total}`);
    if (ev.todo.details) this.print(...wrap(ev.todo.details, Math.min(width(), 96) - GUT.length - 2, 2).map((l) => GUT + st.gray(l)));
  }

  on_docs_start() { this.section('Documentation'); }

  on_agent_start(ev) {
    this.lastAgent = ev.id;
    this.active.set(ev.id, { role: ev.role, phase: ev.phase, todo: ev.todo, started: ev.t, last: null, tools: 0 });
    const model = st.faint(`${ev.provider}${ev.model ? ':' + ev.model : ''}`);
    this.print(`${badge(ev.role)} ${roleFg(ev.role)('▸')} ${PHASE[ev.phase] || ev.phase}  ${model}`);
  }

  on_agent_tool(ev) {
    const a = this.active.get(ev.id);
    if (a) { a.last = { name: ev.name, detail: oneLine(ev.detail) }; a.tools++; }
    const icon = TOOL[ev.name] || '•';
    const isEdit = /Edit|Write/.test(ev.name);
    const detail = oneLine(ev.detail);
    this.print(`${GUT}${roleFg(ev.role)('│')} ${this.who(ev)}${isEdit ? st.white(icon) : st.gray(icon)} ${st.gray(ev.name.padEnd(6))} ${isEdit ? detail : st.gray(detail)}`);
  }

  on_agent_done(ev) {
    const a = this.active.get(ev.id);
    this.active.delete(ev.id);
    const meta = [clock(ev.ms || 0), a?.tools ? `${a.tools} ${a.tools === 1 ? 'action' : 'actions'}` : null, ev.costUsd ? `$${ev.costUsd.toFixed(2)}` : null].filter(Boolean).join(' · ');
    const lines = [`${GUT}${roleFg(ev.role)('╰')} ${this.who(ev, true)}${st.green('✓')} ${st.gray(meta)}`];
    if (ev.text) for (const l of wrap(ev.text, Math.min(width(), 100) - GUT.length - 4, 3)) lines.push(`${GUT}  ${st.dim(st.italic(l))}`);
    this.print(...lines);
  }

  // When agents run in parallel, tag their lines with the role so the output stays readable.
  who(ev, closing = false) {
    const parallel = this.active.size > (closing ? 0 : 1) || this.lastAgent !== ev.id;
    this.lastAgent = ev.id;
    return parallel ? roleFg(ev.role)(st.bold((ROLE[ev.role]?.label || ev.role).toLowerCase())) + ' ' : '';
  }

  on_agent_error(ev) {
    if (!ev.willRetry) this.active.delete(ev.id);
    this.print(`${GUT}${roleFg(ev.role)('╰')} ${st.red('✗')} ${st.red(oneLine(ev.error).slice(0, 200))}${ev.willRetry ? st.gray('  → retrying') : ''}`);
  }

  on_checks(ev) {
    const syn = ev.syntax.filter((s) => !s.skipped);
    const bad = syn.filter((s) => !s.ok);
    const parts = [];
    if (syn.length) parts.push(bad.length ? st.red(`✗ syntax ${bad.length}/${syn.length}`) : st.green(`✓ syntax · ${syn.length} ${syn.length === 1 ? 'file' : 'files'}`));
    for (const c of ev.commands) parts.push(c.ok ? st.green(`✓ ${c.cmd}`) : st.red(`✗ ${c.cmd}`));
    const lines = [`${badge('checker')} ${parts.length ? parts.join('   ') : st.gray('nothing to check')}`];
    const errs = [...bad.map((s) => s.output), ...ev.commands.filter((c) => !c.ok).map((c) => c.output)];
    for (const e of errs) {
      const eLines = String(e).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      for (const l of eLines.slice(-6)) lines.push(`${GUT}${st.red('┃')} ${st.gray(l)}`);
    }
    this.print(...lines);
  }

  on_fix(ev) {
    this.print(`${badge('checker')} ${st.yellow(`↻ back to the coder · fix attempt ${ev.attempt}/${ev.max}`)}`);
  }

  on_review(ev) {
    const sev = { critical: st.red('● critical'), major: fg(209)('● major   '), minor: st.gray('○ minor   ') };
    const verdict = ev.approved ? st.green(st.bold('✓ approved')) : ev.blocking ? st.yellow(st.bold('✗ changes needed')) : st.green(st.bold('✓ ok (nitpicks only)'));
    const lines = [`${badge('reviewer')} ${verdict}  ${st.gray(oneLine(ev.summary))}`];
    for (const i of ev.issues || []) lines.push(`${GUT}${sev[i.severity] || i.severity} ${st.white(i.file)}  ${st.gray(oneLine(i.description))}`);
    this.print(...lines);
  }

  on_note(ev) {
    this.print(`${GUT}${st.yellow('!')} ${st.yellow(ev.text)}`);
  }

  on_todo_done(ev) {
    const t = ev.todo;
    const ms = t.finishedAt && t.startedAt ? t.finishedAt - t.startedAt : 0;
    const label = {
      done: st.green(st.bold('● done')), failed: st.red(st.bold('✗ failed')),
      skipped: st.gray('– skipped'), pending: st.gray('○ interrupted'),
    }[t.status] || t.status;
    const meta = [ms ? clock(ms) : null, t.fixAttempts ? `${t.fixAttempts} ${t.fixAttempts === 1 ? 'fix' : 'fixes'}` : null, t.changedFiles?.length ? `${t.changedFiles.length} ${t.changedFiles.length === 1 ? 'file' : 'files'}` : null].filter(Boolean).join(' · ');
    this.print(`${GUT}${label}  ${st.gray(meta)}`);
  }

  on_run_done(ev) { this.summary(ev.state); }
  on_run_stopped(ev) { this.print('', `${badge('system')} ${st.yellow('■ stopped')} ${st.gray('– continue with: agentci resume')}`); this.summary(ev.state); }
  on_run_error(ev) { this.print('', `${badge('system')} ${st.red('✗ error:')} ${ev.error}`); }

  summary(s) {
    this.active.clear();
    this.clearFooter();
    const w = Math.min(width() - 2, 96);
    const inner = w - 4;
    const row = (x) => st.faint('│ ') + pad(fit(x, inner), inner) + st.faint(' │');
    const icon = { done: st.green('●'), failed: st.red('✗'), skipped: st.gray('–'), pending: st.gray('○'), in_progress: st.yellow('◐') };
    const done = s.todos.filter((t) => t.status === 'done').length;
    const files = [...new Set(s.todos.flatMap((t) => t.changedFiles || []))];
    const ok = done === s.todos.length;
    const lines = ['', st.faint('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${st.bold(ok ? st.green('✓ Done') : st.yellow('◐ Partly done'))}   ${st.gray(`${done}/${s.todos.length} todos · ${clock((s.finishedAt || Date.now()) - s.startedAt)}${s.costUsd ? ` · API value ≈ $${s.costUsd.toFixed(2)} (billed to your subscription)` : ''}`)}`),
      st.faint('├' + '─'.repeat(w - 2) + '┤')];
    for (const t of s.todos) {
      const ms = t.finishedAt && t.startedAt ? clock(t.finishedAt - t.startedAt) : '';
      const extra = [t.fixAttempts ? `${t.fixAttempts}× fix` : '', t.testsMissing ? 'untested' : '', t.unreviewed ? 'unreviewed' : '', t.review ? (t.review.approved ? 'review ✓' : 'review !') : ''].filter(Boolean).join(' ');
      const right = st.gray(`${extra}  ${ms}`.trim());
      const left = `${icon[t.status] || '?'} ${st.faint(t.id.padEnd(4))} ${t.title}`;
      lines.push(row(pad(fit(left, inner - vlen(right) - 2), inner - vlen(right)) + right));
      for (const n of t.notes || []) lines.push(row(`       ${st.yellow('! ' + oneLine(n))}`));
    }
    if (files.length) {
      lines.push(st.faint('├' + '─'.repeat(w - 2) + '┤'));
      for (const l of wrap(files.join('  '), inner - 10, 4)) lines.push(row(`${st.gray(lines.at(-1).includes('├') ? 'Files     ' : '          ')}${l}`));
    }
    lines.push(st.faint('╰' + '─'.repeat(w - 2) + '╯'), st.faint(`  Log: .agentci/runs/${s.runId}.jsonl`), '');
    for (const l of lines) out.write((TTY ? l : visible(l)) + '\n');
  }
}

// Static todo list, used by `agentci status`.
export function renderTodoList(todos) {
  const icon = { done: st.green('●'), failed: st.red('✗'), skipped: st.gray('–'), pending: st.gray('○'), in_progress: st.yellow('◐') };
  if (!todos?.length) return st.gray('  (no todos)');
  return todos.map((t) => `  ${icon[t.status] || '?'} ${st.faint(t.id.padEnd(4))} ${t.status === 'done' ? st.gray(t.title) : t.title}${t.dependsOn?.length ? st.faint(`  ← ${t.dependsOn.join(', ')}`) : ''}`).join('\n');
}
