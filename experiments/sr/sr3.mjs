// SR3 of proposals/experiment-strict-rerun.md: the live rerun. T3 and T7, arms 3 and 4, five runs each: 20 runs, run by
// the M3 frozen runner (claude-opus-5-5 through the claude CLI on the subscription, 15,000,000 tokens, 3,600 s and $15
// per run) from a toolchain worktree at b8a8cfb with the S400 patch and the SR1 manual (docs/v1/sr). The blocks follow
// M3's order (by run number, then by task), each block the two arms of one task and run started together, as M3
// started its four. It stops at the first block with a refused run, a runner error, an unscored run or a cap stop, and
// says why, as M3's batch does; it skips a block whose two runs are recorded. Scoring is separate (sr3-score.mjs).
//
// Usage: node experiments/sr/sr3.mjs --toolchain <worktree> [--out <dir>] [--dry]
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const toolchain = resolve(arg('--toolchain') ?? '');
const RUNS = resolve(arg('--out') ?? join(ROOT, 'experiments', 'sr', 'runs'));
const RUNNER = join(toolchain, 'experiments', 'm3', 'runner', 'run.mjs');
if (!existsSync(RUNNER)) throw new Error(`no frozen runner under ${toolchain}`);
export const TASKS = ['T3', 'T7'];
export const ARMS = [3, 4];
export const CAPS = { tokens: 15_000_000, wallSeconds: 3600, usd: 15 };
const MODEL = 'claude-opus-5-5';
const STAGGER_MS = 90_000;
const id = (task, arm, run) => `${task}-arm${arm}-run${run}`;

const order = [];
for (let run = 1; run <= 5; run++) for (const task of TASKS) order.push({ n: order.length + 1, task, run });

const record = (task, arm, run) => {
  const f = join(RUNS, id(task, arm, run), 'run.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { unreadable: String(e.message) }; }
};

/** M3's reasons to stop after a block, for the two arms of SR3. */
function problems(b, exits = {}) {
  const out = [];
  for (const arm of ARMS) {
    const r = record(b.task, arm, b.run);
    const name = id(b.task, arm, b.run);
    if (exits[arm] !== undefined && exits[arm] !== 0) out.push(`${name}: the runner exited with code ${exits[arm]}`);
    if (!r) out.push(`${name}: refused (no run.json)`);
    else if (r.unreadable) out.push(`${name}: run.json is unreadable (${r.unreadable})`);
    else if (!r.finished) out.push(`${name}: run.json is not finished`);
    else if (r.unscored) out.push(`${name}: unscored (${r.unscored})`);
    // The first attempt of block 1 (void/block1-oauth): a turn whose CLI could not refresh its login exits 1 having
    // spent no token, which the frozen runner does not mark unscored. Such a turn measured nothing, so the run stops
    // the batch, as a failed login does (4210fa6).
    else if ((r.versions ?? []).some((v) => v.attempted && v.exitCode !== 0 && !v.tokens)) out.push(`${name}: a turn exited ${(r.versions ?? []).find((v) => v.attempted && v.exitCode !== 0 && !v.tokens).exitCode} having spent no token (a failed login, unscored)`);
    else {
      const cap = (r.versions ?? []).find((v) => ['budget', 'wall', 'usd'].includes(v.stopped));
      if (cap) out.push(`${name}: stopped by a cap (${cap.stopped}, version ${cap.n})`);
    }
  }
  return out;
}

mkdirSync(RUNS, { recursive: true });
const todo = order.filter((b) => ARMS.some((a) => !record(b.task, a, b.run)));
if (process.argv.includes('--dry')) { for (const b of todo) console.log(`block ${b.n}: ${b.task} run ${b.run}`); process.exit(0); }
for (const b of todo) {
  if (ARMS.some((a) => record(b.task, a, b.run))) { console.error(`block ${b.n}: only some of its runs are recorded; stopped`); process.exit(1); }
  const started = new Date().toISOString();
  console.log(`block ${b.n}: ${b.task} run ${b.run}, started ${started}`);
  const exits = {};
  // The two arms share the arms' login folder; started at once, their CLIs refreshed one OAuth token together and the
  // first turns of both failed (void/block1-oauth). Arm 4 starts 90 s after arm 3; both still run in parallel.
  await Promise.all(ARMS.map((arm, k) => new Promise((r) => setTimeout(r, k * STAGGER_MS)).then(() => new Promise((done) => {
    const args = [RUNNER, '--arm', String(arm), '--task', b.task, '--run', String(b.run), '--model', MODEL, '--tokens', String(CAPS.tokens), '--wall', String(CAPS.wallSeconds), '--max-budget-usd', String(CAPS.usd), '--out', RUNS];
    const child = spawn(process.execPath, args, { cwd: toolchain, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[${b.task} arm ${arm}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${b.task} arm ${arm}] ${d}`));
    child.on('close', (code) => { exits[arm] = code; done(); });
  }))));
  const found = problems(b, exits);
  appendFileSync(join(RUNS, 'blocks.jsonl'), JSON.stringify({ block: b.n, task: b.task, run: b.run, started, finished: new Date().toISOString(), exits, problems: found }) + '\n');
  if (found.length) { for (const p of found) console.error(`stopped after block ${b.n}: ${p}`); process.exit(1); }
  console.log(`block ${b.n}: done`);
}
console.log('every block is recorded');
