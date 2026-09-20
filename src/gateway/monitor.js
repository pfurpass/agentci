// In-memory activity log of the gateway: which client is running what right now,
// what ran before, and a few counters. Feeds the gateway's own web monitor.

const MAX_RECENT = 200;
const MAX_TOOLS = 12;

export function createMonitor({ maxRecent = MAX_RECENT } = {}) {
  const active = new Map();   // id -> call
  const recent = [];          // finished calls, newest first
  const clients = new Map();  // session -> { session, project, client, ip, lastSeen, calls, costUsd }
  const subs = new Set();
  const stats = { startedAt: Date.now(), total: 0, failed: 0, costUsd: 0, bytesIn: 0, bytesOut: 0, authFailures: 0 };
  let seq = 0;

  const emit = (type, data) => {
    const ev = { type, t: Date.now(), ...data };
    for (const fn of subs) { try { fn(ev); } catch { /* a dead subscriber must not break a run */ } };
  };

  function touchClient(call) {
    const key = call.session || call.ip;
    const c = clients.get(key) || { session: call.session, project: call.project, client: call.client, ip: call.ip, calls: 0, costUsd: 0 };
    c.project = call.project || c.project;
    c.client = call.client || c.client;
    c.ip = call.ip;
    c.lastSeen = Date.now();
    c.calls++;
    clients.set(key, c);
    return c;
  }

  return {
    stats,
    startCall(info) {
      const call = {
        id: ++seq, queuedAt: Date.now(), startedAt: null, tools: [], toolCount: 0, ...info,
      };
      active.set(call.id, call);
      stats.total++;
      stats.bytesIn += info.bytesIn || 0;
      touchClient(call);
      emit('call.start', { call: publicCall(call) });
      return {
        id: call.id,
        // Called once the workspace lock is free – until then the call only waits.
        begin() {
          call.startedAt = Date.now();
          emit('call.begin', { call: publicCall(call) });
        },
        tool(ev) {
          call.toolCount++;
          call.lastTool = { name: ev.name, detail: String(ev.detail || '').slice(0, 200) };
          call.tools.push(call.lastTool);
          if (call.tools.length > MAX_TOOLS) call.tools.shift();
          emit('call.tool', { id: call.id, tool: call.lastTool });
        },
        end({ ok, error, costUsd = 0, bytesOut = 0 }) {
          active.delete(call.id);
          Object.assign(call, { ok, error: error || null, costUsd, bytesOut, finishedAt: Date.now() });
          call.startedAt ??= call.queuedAt;
          stats.costUsd += costUsd;
          stats.bytesOut += bytesOut;
          if (!ok) stats.failed++;
          const c = clients.get(call.session || call.ip);
          if (c) c.costUsd += costUsd;
          recent.unshift(publicCall(call));
          if (recent.length > maxRecent) recent.pop();
          emit('call.end', { call: publicCall(call) });
        },
      };
    },
    authFailure(ip, pathname) {
      stats.authFailures++;
      emit('auth.failure', { ip, path: pathname });
    },
    note(text, level = 'info') {
      emit('note', { text, level });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    subscriberCount: () => subs.size,
    isBusy: (session) => [...active.values()].some((c) => c.session === session),
    snapshot() {
      return {
        stats: { ...stats, uptimeMs: Date.now() - stats.startedAt },
        active: [...active.values()].map(publicCall),
        recent,
        clients: [...clients.values()].sort((a, b) => b.lastSeen - a.lastSeen),
      };
    },
  };
}

function publicCall(c) {
  return {
    id: c.id, session: c.session, project: c.project, client: c.client, ip: c.ip,
    provider: c.provider, model: c.model, role: c.role, phase: c.phase, todo: c.todo,
    canEdit: c.canEdit, queuedAt: c.queuedAt, startedAt: c.startedAt, finishedAt: c.finishedAt || null,
    waiting: !c.startedAt, waitedMs: (c.startedAt || Date.now()) - c.queuedAt,
    ms: c.finishedAt ? c.finishedAt - (c.startedAt || c.queuedAt) : null,
    ok: c.ok ?? null, error: c.error || null, costUsd: c.costUsd || 0,
    toolCount: c.toolCount, lastTool: c.lastTool || null, tools: c.tools,
    bytesIn: c.bytesIn || 0, bytesOut: c.bytesOut || 0,
  };
}
