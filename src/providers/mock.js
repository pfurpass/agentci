import fs from 'node:fs';
import path from 'node:path';

// Offline provider for `agentci demo` and tests. No AI, no costs – scripted behaviour
// that exercises the whole pipeline, including one deliberate syntax error to show the fix loop.
export function mockProvider() {
  return {
    name: 'mock',
    async run({ role, phase, cwd, todo, onEvent }) {
      await new Promise((r) => setTimeout(r, Number(process.env.AGENTCI_MOCK_DELAY) || 30));
      const write = (file, content) => {
        fs.writeFileSync(path.join(cwd, file), content);
        onEvent?.({ type: 'tool', name: 'Write', detail: file });
      };

      if (phase === 'plan') {
        return result({
          summary: 'Small math library with tests',
          todos: [
            { id: 'T1', title: 'create math.js with add() and mul()', details: 'ES module exporting add and mul', dependsOn: [], acceptance: 'node --check passes' },
            { id: 'T2', title: 'CLI calc.js using math.js', details: 'node calc.js 2 3 prints 5', dependsOn: ['T1'], acceptance: 'output is correct' },
          ],
        });
      }
      if (phase === 'implement' && todo?.id === 'T1') {
        write('math.js', 'export function add(a, b) {\n  return a + b\n\nexport const mul = (a, b) => a * b;\n'); // missing }
        return result(null, 'created math.js');
      }
      if (phase === 'fix' && todo?.id === 'T1') {
        write('math.js', 'export function add(a, b) {\n  return a + b;\n}\n\nexport const mul = (a, b) => a * b;\n');
        return result(null, 'added the missing brace');
      }
      if ((phase === 'implement' || phase === 'fix') && todo?.id === 'T2') {
        write('calc.js', "import { add } from './math.js';\n\nconst [a, b] = process.argv.slice(2).map(Number);\nconsole.log(add(a, b));\n");
        return result(null, 'created calc.js');
      }
      if (phase === 'test' && todo?.id === 'T1') {
        write('math.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add, mul } from './math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\ntest('mul', () => assert.equal(mul(2, 3), 6));\n");
        return result(null, 'wrote tests');
      }
      if (phase === 'test' && todo?.id === 'T2') {
        write('calc.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { execFileSync } from 'node:child_process';\n\ntest('calc 2 3', () => assert.equal(execFileSync(process.execPath, ['calc.js', '2', '3']).toString().trim(), '5'));\n");
        return result(null, 'wrote a CLI test');
      }
      if (phase === 'review') {
        return result({ approved: true, summary: 'Looks good', issues: [] });
      }
      if (phase === 'docs') {
        write('README.md', '# Demo\n\n`node calc.js 2 3` → 5\n');
        return result(null, 'wrote the README');
      }
      return result(null, `mock: nothing to do for ${role}/${phase}`);
    },
  };
}

function result(data, text = JSON.stringify(data)) {
  return { text, data, costUsd: 0, durationMs: Number(process.env.AGENTCI_MOCK_DELAY) || 30 };
}
