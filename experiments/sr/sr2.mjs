// SR2 of proposals/experiment-strict-rerun.md: the counterfactual, with no model call. Every poly delivery of T3 and
// T7 (arms 3 and 4, five runs each) is scored again with the M3 frozen toolchain (b8a8cfb) plus the S400 patch, and
// nothing else changed, so the default is the only difference. Each run's recorded deliveries are copied out of the M3
// records (never written there) and scored by the frozen scorer of the toolchain named; snapshots are not copied, since
// SR2 compares deliveries, not regressions. Before is each run's recorded M3 score.
//
// Usage: node experiments/sr/sr2.mjs --toolchain <worktree at b8a8cfb with the S400 patch> --out <dir> [--runs <id,...>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const toolchain = resolve(arg('--toolchain') ?? '');
const out = resolve(arg('--out') ?? join(ROOT, '.poly', 'sr2'));
if (!existsSync(join(toolchain, 'experiments', 'm3', 'runner', 'score.mjs'))) throw new Error(`no frozen scorer under ${toolchain}`);
const { scoreRun } = await import(pathToFileURL(join(toolchain, 'experiments', 'm3', 'runner', 'score.mjs')).href);
const RUNS = join(ROOT, 'experiments', 'm3', 'runs');
const only = arg('--runs')?.split(',');
const ids = readdirSync(RUNS).filter((d) => /^T(3|7)-arm(3|4)-run[1-5]$/.test(d)).filter((d) => !only || only.includes(d)).sort();
const pick = (s) => ({
  n: s.n, delivered: s.delivered, admitted: s.admitted ?? null, check: s.check?.verdict ?? null,
  o1: s.o1?.ran ? { tests: s.o1.tests, failed: s.o1.failed, failing: s.o1.failing } : { ran: false, reason: s.o1?.reason ?? s.reason ?? null },
  o1r: s.o1r?.ran ? { tests: s.o1r.tests, failed: s.o1r.failed, failing: s.o1r.failing } : { ran: false, reason: s.o1r?.reason ?? null },
});
const report = [];
for (const id of ids) {
  const src = join(RUNS, id);
  const dir = join(out, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const before = JSON.parse(readFileSync(join(src, 'run.json'), 'utf8'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...before, scores: undefined }, null, 2));
  cpSync(join(src, 'deliveries'), join(dir, 'deliveries'), { recursive: true });
  const after = await scoreRun(dir, { timeoutMs: 30 * 60 * 1000 });
  const entry = { id, before: (before.scores ?? []).map(pick), after: after.notScored ? { notScored: after.notScored } : (after.scores ?? []).map(pick) };
  report.push(entry);
  process.stderr.write(`${id} scored\n`);
}
writeFileSync(join(out, 'sr2.json'), JSON.stringify({ toolchain: 'b8a8cfb + S400', runs: report }, null, 2) + '\n');
console.log(`${report.length} runs scored into ${join(out, 'sr2.json')}`);
