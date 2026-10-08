// SR3's scoring: each recorded run scored by the frozen scorer of the toolchain worktree (b8a8cfb with the S400 patch),
// as M3's runs were by runner/score.mjs, which writes the scores into the run's own run.json. A run already scored is
// left as it is.
//
// Usage: node experiments/sr/sr3-score.mjs --toolchain <worktree> [--runs <dir>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const toolchain = resolve(arg('--toolchain') ?? '');
const RUNS = resolve(arg('--runs') ?? join(ROOT, 'experiments', 'sr', 'runs'));
const { scoreRun } = await import(pathToFileURL(join(toolchain, 'experiments', 'm3', 'runner', 'score.mjs')).href);
for (const d of readdirSync(RUNS).filter((x) => /^T(3|7)-arm(3|4)-run[1-5]$/.test(x)).sort()) {
  const f = join(RUNS, d, 'run.json');
  if (!existsSync(f)) continue;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  if (r.scores || r.unscored) { console.log(`${d}: ${r.unscored ? `unscored (${r.unscored})` : 'already scored'}`); continue; }
  const s = await scoreRun(join(RUNS, d), { timeoutMs: 30 * 60 * 1000 });
  console.log(`${d}: ${s.notScored ? `not scored (${s.notScored.reason})` : (s.scores ?? []).map((x) => `v${x.n} O1 ${x.o1?.ran ? `${x.o1.failed}/${x.o1.tests}` : 'not run'}`).join(', ')}`);
}
