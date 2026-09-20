# Contributing

Thanks for taking a look. agentci is plain Node.js with **zero runtime dependencies** – clone it and it runs.

```bash
git clone <your fork>
cd agentci
npm test                 # 67 tests, no install step needed
node bin/agentci.js demo  # full pipeline with the offline mock AI (free, no API calls)
```

## Ground rules

- **No runtime dependencies.** Everything ships in `src/`, `web/` and `bin/`. Dev tooling is fine if it stays optional.
- **Every change comes with a test.** `test/` uses `node:test`; the mock provider (`src/providers/mock.js`) and the scripted `fake()` provider in `test/pipeline.test.js` let you exercise the whole pipeline without spending tokens.
- **No AI calls in tests.** CI must run offline.
- **English** for code, comments, UI strings and docs.

## Where things live

| Path | What it does |
|------|--------------|
| `bin/agentci.js` | CLI: argument parsing, commands, output |
| `src/orchestrator.js` | the pipeline; emits structured events, prints nothing |
| `src/term.js` | terminal renderer (reads those events) |
| `src/server.js` + `web/` | local web interface |
| `src/gateway/` + `web/gateway.*` | gateway server, monitor, service, settings |
| `src/providers/` | claude, codex, mock, remote (gateway client) |
| `src/checker.js` | syntax checks and test detection (no AI) |
| `src/codemap.js` | static project map that goes into the prompts |

The orchestrator never writes to stdout: terminal and browser both render from the same event stream, which is also stored in `.agentci/runs/*.jsonl`. Keep it that way when adding features.
