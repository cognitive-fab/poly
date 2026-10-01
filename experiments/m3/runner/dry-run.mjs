// The dry run of plan-m3 section 6: T1 through every arm with the stub agent and a small budget, so the
// workspace isolation, the budget cut-off, the journal and the scoring are tested without a real run. The stub
// replays a recorded stream: the delivery each turn writes, and each assistant message's tokens. Arms 1 and 2
// deliver the TypeScript of dry-run/t1-impl.ts; arm 3 delivers T1's reference and map, arm 4 their embedded
// print. Arm 2's third turn spends more than the budget, so its last two versions are not delivered in budget.
//
// Usage: node experiments/m3/runner/dry-run.mjs [<out dir>]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@poly/lang';
import { printModule } from '@poly/embed';
import { moduleOf, versions } from '../lib/task.mjs';
import { runOne } from './run.mjs';
import { scoreRun } from './score.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const DRY = { tokens: 200_000, wallMs: 10 * 60 * 1000, perTurn: { input_tokens: 20_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 20_000, output_tokens: 5_000 } };

/** The stub's script for an arm on T1: one turn per version. */
export function stubScript(arm) {
  const ts = readFileSync(join(HERE, 'dry-run', 't1-impl.ts'), 'utf8');
  return {
    turns: versions('T1').map((v) => {
      const events = [{ type: 'text', text: `version ${v.n}` }];
      if (arm <= 2) events.push({ type: 'write', path: 'src/host.impl.ts', content: ts.replace('const VERSION: number = 0;', `const VERSION: number = ${v.n};`) });
      else {
        const src = readFileSync(moduleOf(join(v.dir, 'reference')), 'utf8');
        events.push({ type: 'write', path: arm === 3 ? 'src/system.poly' : 'src/system.ts', content: arm === 3 ? src : printModule(parse(src).module) });
        events.push({ type: 'write', path: 'host.map.json', content: readFileSync(join(v.dir, 'reference', 'host.map.json'), 'utf8') });
      }
      // Arm 2 spends the budget in its third turn: 4 turns of 50k would fit 200k; 250k does not.
      const usage = arm === 2 && v.n === 2 ? { ...DRY.perTurn, input_tokens: 200_000 } : DRY.perTurn;
      events.push({ type: 'usage', usage });
      events.push({ type: 'text', text: 'Done.' });
      return { events };
    }),
  };
}

export async function dryRun(out) {
  const results = [];
  for (const arm of [1, 2, 3, 4]) {
    const { dir } = await runOne({ arm, task: 'T1', run: 0, model: 'stub', tokens: DRY.tokens, wallMs: DRY.wallMs, out, agent: { kind: 'stub', turns: stubScript(arm).turns } });
    results.push(await scoreRun(dir, { timeoutMs: 10 * 60 * 1000 }));
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = process.argv[2] ?? join(tmpdir(), 'poly-m3-dry-run');
  for (const r of await dryRun(out)) {
    console.log(`arm ${r.arm}: ${r.spent.tokens} tokens; ${r.scores.map((s) => `v${s.n} ${s.delivered ? 'delivered' : 'not delivered'}${s.withinBudget ? '' : ' (budget)'} O3 ${s.o3 ? `${s.o3.failed}/${s.o3.traces}` : '-'}`).join('; ')}`);
  }
  console.log(out);
}
