import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stateDir } from './config.js';
import { snapshot, diffSnapshots, diffText } from './snapshot.js';
import { runChecks } from './checker.js';
import { createCodeMapCache, formatCodeMap, graphData } from './codemap.js';
import * as R from './roles.js';

export class AbortedError extends Error {
  constructor() { super('Stopped by the user'); this.name = 'AbortedError'; }
}

// The orchestrator never prints. It emits structured events ('event' on the emitter);
// the terminal renderer and the web UI both render from the same stream.
export class Orchestrator extends EventEmitter {
  constructor({ cwd, config, providers, gateway = null }) {
    super();
    this.gateway = gateway; // URL when claude/codex run on a remote agentci gateway
    this.cwd = cwd;
    this.cfg = config;
    this.providers = providers;
    this.dir = stateDir(cwd);
    this.stateFile = path.join(this.dir, 'state.json');
    this.state = null;
    this.abortController = new AbortController();
    this.agentSeq = 0;
    this.exhausted = new Set(); // providers that hit their usage limit in this run
    this.codeMapCache = createCodeMapCache();
  }

  // ---------- state & events ----------
  loadState() {
    if (!fs.existsSync(this.stateFile)) return null;
    this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    return this.state;
  }

  save() {
    const json = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(this.stateFile, json);
    fs.writeFileSync(path.join(this.dir, 'runs', `${this.state.runId}.state.json`), json);
    this.emit('event', { type: 'state', state: publicState(this.state), t: Date.now() });
  }

  send(type, data = {}) {
    const ev = { type, t: Date.now(), ...data };
    if (this.state?.runId) {
      fs.appendFileSync(path.join(this.dir, 'runs', `${this.state.runId}.jsonl`), JSON.stringify(ev) + '\n');
    }
    this.emit('event', ev);
    return ev;
  }

  stop() {
    this.abortController.abort();
  }

  // Static project map – cheap for us, expensive for an LLM to rediscover on every call.
  codeMap() {
    return this.codeMapCache(this.cwd, this.cfg.ignore);
  }

  mapText(changed = [], maxChars = 9000) {
    if (this.cfg.pipeline.projectMap === false) return '';
    return formatCodeMap(this.codeMap(), { changed, maxChars });
  }

  has(role) {
    const rc = this.cfg.roles[role];
    return Boolean(rc) && rc.enabled !== false;
  }

  get aborted() {
    return this.abortController.signal.aborted;
  }

  // ---------- agent calls ----------
  async callAgent(role, phase, prompt, { schema, canEdit = false, todo } = {}) {
    if (this.aborted) throw new AbortedError();
    const rc = this.cfg.roles[role];
    // Primary provider plus optional fallback ("fallback": "claude:sonnet"); providers that hit
    // their usage limit earlier in this run are skipped right away.
    const candidates = [{ provider: rc.provider, model: rc.model || null }];
    if (rc.fallback) {
      const [provider, model] = String(rc.fallback).split(':');
      if (provider !== rc.provider || (model || null) !== (rc.model || null)) candidates.push({ provider, model: model || null });
    }
    const usable = candidates.filter((c) => !this.exhausted.has(c.provider));
    if (!usable.length) throw new Error(`${candidates.map((c) => c.provider).join(' and ')}: usage limit reached`);
    if (usable[0] !== candidates[0]) {
      this.send('note', { todo: todo?.id ?? null, level: 'warn', text: `${candidates[0].provider} hit its usage limit – ${role} uses ${label(usable[0])}` });
    }

    let lastError;
    for (const [ci, cand] of usable.entries()) {
      const provider = this.providers[cand.provider];
      if (!provider) { lastError = new Error(`Provider "${cand.provider}" not available`); continue; }
      const id = ++this.agentSeq;
      const base = { id, role, phase, todo: todo?.id ?? null };
      this.send('agent.start', { ...base, provider: cand.provider, model: cand.model });
      const opts = {
        role, phase, todo, prompt, schema, canEdit,
        systemPrompt: R.SYSTEM[role === 'coder' && phase === 'fix' ? 'fixer' : role],
        cwd: this.cwd, model: cand.model || undefined, effort: ci === 0 ? rc.effort || undefined : undefined,
        timeoutMs: (this.cfg.pipeline.timeoutMinutes || 20) * 60_000,
        signal: this.abortController.signal,
        onEvent: (ev) => {
          if (ev.type !== 'tool') return;
          const detail = String(ev.detail || '').split(this.cwd + path.sep).join('');
          this.send('agent.tool', { ...base, name: ev.name, detail: detail.slice(0, 500) });
        },
      };

      for (let attempt = 1; ; attempt++) {
        try {
          const res = await provider.run(opts);
          if (this.aborted) throw new AbortedError();
          if (schema && !res.data) throw new Error('response contained no valid JSON');
          this.state.costUsd = (this.state.costUsd || 0) + (res.costUsd || 0);
          this.send('agent.done', { ...base, costUsd: res.costUsd || 0, ms: res.durationMs, text: schema ? null : res.text?.slice(0, 4000) });
          this.save();
          return res;
        } catch (e) {
          if (this.aborted || e instanceof AbortedError) {
            this.send('agent.error', { ...base, error: 'stopped', attempt, willRetry: false });
            throw new AbortedError();
          }
          const limited = isUsageLimit(e.message);
          if (limited) this.exhausted.add(cand.provider);
          const hasNext = ci < usable.length - 1;
          const willRetry = attempt < 2 && !limited;
          this.send('agent.error', {
            ...base, attempt, willRetry, limited,
            error: limited ? `${cand.provider}: usage limit reached${hasNext ? ` – switching to ${label(usable[ci + 1])}` : ''}` : e.message,
            detail: limited ? e.message.slice(0, 300) : undefined,
          });
          lastError = e;
          if (!willRetry) break;
        }
      }
    }
    throw lastError;
  }

  // ---------- public API ----------
  async plan(task) {
    this.state = {
      runId: new Date().toISOString().replace(/[:.]/g, '-'),
      task, summary: '', todos: [], costUsd: 0, startedAt: Date.now(), phase: 'planning',
      team: teamOf(this.cfg), gateway: this.gateway,
    };
    this.send('run.start', { runId: this.state.runId, task, team: this.state.team, cwd: this.cwd, gateway: this.gateway });
    this.save();
    try {
      const res = await this.callAgent('planner', 'plan', R.withMap(R.planPrompt(task, projectInfo(this.cwd, this.cfg.ignore, this.codeMap())), this.mapText([], 14_000)), { schema: R.PLAN_SCHEMA });
      this.state.summary = res.data.summary || '';
      this.state.todos = normalizeTodos(res.data.todos || []);
      this.state.phase = 'planned';
      this.save();
      this.send('plan', { summary: this.state.summary, todos: this.state.todos });
      return this.state;
    } catch (e) {
      this.endWithError(e);
      throw e;
    }
  }

  async execute() {
    const st = this.state;
    for (const t of st.todos) if (t.status === 'in_progress') t.status = 'pending';
    st.phase = 'executing';
    st.resumedAt = Date.now();
    st.gateway = this.gateway;
    this.send('run.resume', { runId: st.runId, task: st.task, team: teamOf(this.cfg), cwd: this.cwd, gateway: this.gateway });
    this.save();

    try {
      for (;;) {
        if (this.aborted) throw new AbortedError();
        const next = st.todos.find((t) => t.status === 'pending' && t.dependsOn.every((d) => statusOf(st, d) === 'done'));
        if (!next) break;
        await this.processTodo(next);
      }
      for (const t of st.todos) {
        if (t.status === 'pending') {
          t.status = 'skipped';
          t.notes.push('dependency not met');
          this.send('todo.done', { todo: t });
        }
      }

      if (this.has('docs') && st.todos.some((t) => t.status === 'done')) {
        this.send('docs.start', {});
        await this.callAgent('docs', 'docs', R.withMap(R.docsPrompt(st), this.mapText()), { canEdit: true });
      }
      st.phase = 'finished';
      st.finishedAt = Date.now();
      this.save();
      this.send('run.done', { state: publicState(st) });
      return st;
    } catch (e) {
      this.endWithError(e);
      if (e instanceof AbortedError) return st;
      throw e;
    }
  }

  endWithError(e) {
    const st = this.state;
    for (const t of st.todos) if (t.status === 'in_progress') t.status = 'pending';
    st.phase = e instanceof AbortedError ? 'stopped' : 'error';
    st.error = e.message;
    st.finishedAt = Date.now();
    this.save();
    this.send(e instanceof AbortedError ? 'run.stopped' : 'run.error', { error: e.message, state: publicState(st) });
  }

  async run(task) {
    await this.plan(task);
    if (!this.state.todos.length) {
      const e = new Error('the planner returned no todos');
      this.endWithError(e);
      throw e;
    }
    return this.execute();
  }

  // ---------- per-todo pipeline ----------
  async processTodo(todo) {
    const st = this.state;
    const p = this.cfg.pipeline;
    todo.status = 'in_progress';
    todo.startedAt = Date.now();
    todo.fixAttempts = 0;
    todo.reviewRounds = 0;
    this.send('todo.start', { todo, index: st.todos.indexOf(todo), total: st.todos.length });
    this.save();

    const before = snapshot(this.cwd, this.cfg.ignore);
    try {
      await this.callAgent('coder', 'implement', R.withMap(R.implementPrompt(st, todo), this.mapText()), { canEdit: true, todo });
      if (!this.changedSince(before)) {
        // An agent that "succeeds" without touching a file usually couldn't use its tools – don't trust it.
        this.send('note', { todo: todo.id, level: 'warn', text: 'coder changed no file – second attempt' });
        await this.callAgent('coder', 'fix', R.fixPrompt(st, todo, 'You have changed NO file so far. Implement the todo in the files now. If you cannot write files, say so clearly.'), { canEdit: true, todo });
        if (!this.changedSince(before)) {
          todo.notes.push('The coder did not change a single file (tools unusable or task misunderstood).');
          return this.finish(todo, 'failed', before);
        }
      }
      if (!(await this.checkAndFix(todo, before))) return this.finish(todo, 'failed', before);

      const rounds = this.has('reviewer') ? Math.max(1, p.maxReviewRounds) : 0;
      let testsWritten = !(p.writeTests && this.has('tester'));
      for (let round = 1; round <= rounds; round++) {
        const after = snapshot(this.cwd, this.cfg.ignore);
        const changes = diffSnapshots(before, after);
        const diff = diffText(before, after, changes);

        // Reviewer and tester work in parallel: one reads the diff, the other writes tests.
        // Reviewer/tester failures (e.g. usage limit) degrade the todo instead of failing it.
        const reviewJob = this.callAgent('reviewer', 'review', R.reviewPrompt(st, todo, diff, 'alle bestanden'), { schema: R.REVIEW_SCHEMA, todo })
          .catch((e) => this.soften(e, todo, 'review failed – todo is unreviewed', () => { todo.unreviewed = true; }));
        const testJob = testsWritten ? null
          : this.callAgent('tester', 'test', R.withMap(R.testPrompt(st, todo, changes.changed), this.mapText(changes.changed)), { canEdit: true, todo })
            .catch((e) => this.soften(e, todo, 'tester failed', () => { todo.testerFailed = true; }));
        const [review] = await Promise.all([reviewJob, testJob]);

        if (!testsWritten) {
          testsWritten = true;
          this.checkTesterWrote(todo, after);
          if (!(await this.checkAndFix(todo, before, 'The newly written tests fail. Decide whether the code or the test is wrong and fix the right one.'))) {
            return this.finish(todo, 'failed', before);
          }
        }

        if (!review) break;
        const blocking = R.formatReviewIssues(review.data);
        todo.reviewRounds = round;
        todo.review = { approved: !!review.data.approved, summary: review.data.summary, issues: review.data.issues || [] };
        this.send('review', { todo: todo.id, round, ...todo.review, blocking: !!blocking });
        if (review.data.approved || !blocking) break;
        if (round === rounds) {
          todo.notes.push(`Review not fully addressed:\n${blocking}`);
          this.send('note', { todo: todo.id, level: 'warn', text: 'maximum review rounds reached – finishing the todo with a note' });
          break;
        }
        await this.callAgent('coder', 'fix', R.fixPrompt(st, todo, `Code-Review:\n${blocking}`), { canEdit: true, todo });
        if (!(await this.checkAndFix(todo, before))) return this.finish(todo, 'failed', before);
      }

      if (!testsWritten) {
        // no reviewer configured: tester still runs
        const pre = snapshot(this.cwd, this.cfg.ignore);
        const changes = diffSnapshots(before, pre);
        await this.callAgent('tester', 'test', R.withMap(R.testPrompt(st, todo, changes.changed), this.mapText(changes.changed)), { canEdit: true, todo })
          .catch((e) => this.soften(e, todo, 'tester failed', () => { todo.testerFailed = true; }));
        this.checkTesterWrote(todo, pre);
        if (!(await this.checkAndFix(todo, before))) return this.finish(todo, 'failed', before);
      }
      return this.finish(todo, 'done', before);
    } catch (e) {
      if (e instanceof AbortedError) {
        todo.status = 'pending';
        this.send('todo.done', { todo });
        throw e;
      }
      todo.notes.push(`Aborted: ${e.message}`);
      return this.finish(todo, 'failed', before);
    }
  }

  soften(e, todo, text, mark) {
    if (e instanceof AbortedError) throw e;
    mark();
    todo.notes.push(`${text}: ${e.message}`);
    this.send('note', { todo: todo.id, level: 'warn', text: `${text}: ${e.message.slice(0, 160)}` });
    return null;
  }

  changedSince(before) {
    const c = diffSnapshots(before, snapshot(this.cwd, this.cfg.ignore));
    return c.changed.length + c.deleted.length > 0;
  }

  checkTesterWrote(todo, pre) {
    if (this.changedSince(pre)) return;
    todo.testsMissing = true;
    if (todo.testerFailed) return; // already reported
    todo.notes.push('The tester wrote no test file – this todo is untested.');
    this.send('note', { todo: todo.id, level: 'warn', text: 'tester wrote no file – todo is untested' });
  }

  // Runs syntax checks + tests on everything changed since `before`; lets the coder fix failures.
  async checkAndFix(todo, before, hint = '') {
    const max = this.cfg.pipeline.maxFixAttempts;
    for (let attempt = 0; ; attempt++) {
      if (this.aborted) throw new AbortedError();
      const changes = diffSnapshots(before, snapshot(this.cwd, this.cfg.ignore));
      this.send('checks.start', { todo: todo.id, files: changes.changed.length });
      const res = runChecks(this.cwd, changes.changed, this.cfg.checks);
      const clean = (o) => cleanOutput(o, this.cwd);
      todo.checksOk = res.ok;
      this.send('checks', {
        todo: todo.id, ok: res.ok,
        syntax: res.syntax.map((s) => ({ file: s.file, ok: s.ok, skipped: s.skipped || null, output: s.ok ? '' : tail(clean(s.output), 1500) })),
        commands: res.commands.map((c) => ({ cmd: c.cmd, ok: c.ok, output: tail(clean(c.output), c.ok ? 400 : 3000) })),
      });
      if (res.ok) return true;
      if (attempt >= max) {
        todo.notes.push(`Checks still failing after ${max} fix attempts:\n${res.report.slice(0, 2000)}`);
        return false;
      }
      todo.fixAttempts = (todo.fixAttempts || 0) + 1;
      this.send('fix', { todo: todo.id, attempt: attempt + 1, max });
      await this.callAgent('coder', 'fix', R.fixPrompt(this.state, todo, `${hint ? hint + '\n\n' : ''}${res.report}`), { canEdit: true, todo });
    }
  }

  finish(todo, status, before) {
    todo.status = status;
    todo.finishedAt = Date.now();
    if (before) {
      const after = snapshot(this.cwd, this.cfg.ignore);
      const changes = diffSnapshots(before, after);
      todo.changedFiles = changes.changed;
      todo.deletedFiles = changes.deleted;
      todo.diff = diffText(before, after, changes);
    }
    this.send('todo.done', { todo: { ...todo, diff: undefined } });
    this.save();
    return status;
  }
}

// ---------- helpers ----------
const label = (c) => `${c.provider}${c.model ? ':' + c.model : ''}`;

export function isUsageLimit(msg = '') {
  return /usage limit|rate.?limit|quota|hit your limit|too many requests|\b429\b|limit reached|out of credits/i.test(msg);
}

function statusOf(st, id) {
  return st.todos.find((t) => t.id === id)?.status;
}

// Tool output for humans: paths relative to the project, no Node-internal stack noise.
export function cleanOutput(s, cwd) {
  return String(s || '').split(cwd + path.sep).join('')
    .split('\n').filter((l) => !/^\s+at .*\(node:internal|^Node\.js v\d/.test(l)).join('\n').trim();
}

function tail(s, max) {
  s = String(s || '');
  return s.length > max ? '…' + s.slice(-max) : s;
}

export function teamOf(cfg) {
  return Object.fromEntries(Object.entries(cfg.roles)
    .filter(([, rc]) => rc && rc.enabled !== false)
    .map(([role, rc]) => [role, `${rc.provider}${rc.model ? ':' + rc.model : ''}`]));
}

// State without the (potentially large) diffs – what gets streamed to UIs.
export function publicState(st) {
  return { ...st, todos: st.todos.map((t) => ({ ...t, diff: undefined, hasDiff: Boolean(t.diff) })) };
}

export function normalizeTodos(raw) {
  const todos = raw.map((t, i) => ({
    id: String(t.id || `T${i + 1}`).trim(),
    title: String(t.title || `Todo ${i + 1}`),
    details: String(t.details || ''),
    acceptance: String(t.acceptance || ''),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    status: 'pending',
    notes: [],
  }));
  const seen = new Set();
  for (const t of todos) {
    while (seen.has(t.id)) t.id += "'";
    seen.add(t.id);
  }
  // drop unknown deps and deps that would create cycles (only allow deps on earlier todos)
  const order = new Map(todos.map((t, i) => [t.id, i]));
  todos.forEach((t, i) => {
    t.dependsOn = t.dependsOn.filter((d) => order.has(d) && order.get(d) < i);
  });
  return todos;
}

export function projectInfo(cwd, ignore, map = null) {
  const snap = snapshot(cwd, ignore);
  if (!snap.size) return 'Empty directory – new project.';
  let info = `${snap.size} files.`;
  if (map) {
    const entry = [...map.files].sort((a, b) => (b.dependents?.length || 0) - (a.dependents?.length || 0)).slice(0, 5);
    if (entry.length && entry[0].dependents?.length) {
      info += ` Most depended-on files: ${entry.filter((f) => f.dependents.length).map((f) => `${f.path} (${f.dependents.length}×)`).join(', ')}.`;
    }
  }
  for (const f of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'README.md']) {
    const c = snap.get(f)?.content;
    if (c) info += `\n\n${f}:\n${c.slice(0, 2500)}`;
  }
  return info;
}

export { graphData };
