// Runs the remaining blocks of M3 in the order plan-m3.md fixes (4c630d2): by run number, then by task, each block
// the four arms on one task and run number, started together. It stops at the first block with a run that was
// refused (the runner exited before running it), is unscored (limited, a failed login, or something synced into
// the arms' folder), or was stopped by a cap, and says why. It skips blocks whose four runs are already recorded.
//
// It only orchestrates: each run is runner/run.mjs as frozen, with the frozen caps, so this file is in no part of
// the freeze. It writes one line per block to experiments/m3/runs/blocks.jsonl, with an `overlap` flag: the
// processes outside the block that looked like tests or a review on this PC while it ran (the M5b work shares the
// machine), sampled every 30 seconds and listed, so a process wrongly taken for one (an agent's own test whose
// parent has exited) can be told from the M5b work. Scoring is separate (runner/score.mjs).
//
// Usage: node experiments/m3/blocks.mjs [--dry]   (--dry lists the blocks it would run)
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { M3, taskIds } from './lib/task.mjs';

export const RUNS = join(M3, 'runs');
export const ARMS = [1, 2, 3, 4];
export const CAPS = { tokens: 15_000_000, wallSeconds: 3600, usd: 15 };
const MODEL = 'claude-opus-5-5';

/** Every block in the plan's order: run 1 of T1 to T10, then run 2, up to run 5. */
export function blockOrder(tasks = taskIds(), runs = 5) {
  const out = [];
  for (let run = 1; run <= runs; run++) for (const task of tasks) out.push({ n: out.length + 1, task, run });
  return out;
}

const id = (task, arm, run) => `${task}-arm${arm}-run${run}`;
const readRecord = (dir, task, arm, run) => {
  const f = join(dir, id(task, arm, run), 'run.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};

/** Why a finished block stops the batch, or null: a refused run, an unscored run, or a run a cap stopped. */
export function blockProblems(block, records, exits = {}) {
  const out = [];
  for (const arm of ARMS) {
    const r = records[arm];
    const name = id(block.task, arm, block.run);
    if (!r) out.push(`${name}: refused (no run.json${exits[arm] !== undefined ? `, exit ${exits[arm]}` : ''})`);
    else if (r.unscored) out.push(`${name}: unscored (${r.unscored})`);
    else {
      const cap = (r.versions ?? []).find((v) => ['budget', 'wall', 'usd'].includes(v.stopped));
      if (cap) out.push(`${name}: stopped by a cap (${cap.stopped}, version ${cap.n})`);
    }
  }
  return out;
}

/** Where the batch starts: the first block whose four runs are not all recorded. A block with some runs only is a problem. */
export function firstToRun(order, dir = RUNS) {
  for (const b of order) {
    const recs = Object.fromEntries(ARMS.map((a) => [a, readRecord(dir, b.task, a, b.run)]));
    const have = ARMS.filter((a) => recs[a]);
    if (have.length === 4) {
      const p = blockProblems(b, recs);
      if (p.length) return { block: b, problems: p };
      continue;
    }
    if (have.length) return { block: b, problems: [`block ${b.n} (${b.task} run ${b.run}) is partly recorded: arms ${have.join(', ')}`] };
    return { block: b, problems: [] };
  }
  return { block: null, problems: [] };
}

/** Processes on this PC that look like tests or a review and are not this batch's own. */
export function overlapping(processes, selfPid) {
  const parent = new Map(processes.map((p) => [p.ProcessId, p.ParentProcessId]));
  const ours = (pid) => { for (let p = pid, i = 0; p && i < 64; p = parent.get(p), i++) if (p === selfPid) return true; return false; };
  // Tests and reviews only: an editor's TypeScript server in the M5b worktree is no load worth flagging.
  const looks = /node(\.exe)?"?\s.*--test\b|npm(-cli\.js|\.cmd)?"?\s.*\btest\b|polywatch/i;
  return processes.filter((p) => p.CommandLine && looks.test(p.CommandLine) && !ours(p.ProcessId)).map((p) => p.CommandLine.slice(0, 200));
}

function processes() {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Runs one block: the four arms started together, and the processes sampled while they run. */
async function runBlock(b) {
  const started = new Date().toISOString();
  const seen = new Set();
  let sampled = 0;
  const sample = () => { const ps = processes(); if (ps) { sampled++; for (const c of overlapping(ps, process.pid)) seen.add(c); } };
  sample();
  const timer = setInterval(sample, 30_000);
  const exits = {};
  await Promise.all(ARMS.map((arm) => new Promise((resolve) => {
    const args = [join(M3, 'runner', 'run.mjs'), '--arm', String(arm), '--task', b.task, '--run', String(b.run), '--model', MODEL, '--tokens', String(CAPS.tokens), '--wall', String(CAPS.wallSeconds), '--max-budget-usd', String(CAPS.usd), '--out', RUNS];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[${b.task} arm ${arm}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${b.task} arm ${arm}] ${d}`));
    child.on('close', (code) => { exits[arm] = code; resolve(); });
  })));
  clearInterval(timer);
  sample();
  return { started, finished: new Date().toISOString(), exits, overlap: { flagged: seen.size > 0, processes: [...seen], samples: sampled } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  mkdirSync(RUNS, { recursive: true });
  const order = blockOrder();
  const start = firstToRun(order);
  if (start.problems.length) { for (const p of start.problems) console.error(`stopped before block ${start.block.n}: ${p}`); process.exit(1); }
  if (!start.block) { console.log('every block is recorded'); process.exit(0); }
  const todo = order.slice(start.block.n - 1);
  if (process.argv.includes('--dry')) { for (const b of todo) console.log(`block ${b.n}: ${b.task} run ${b.run}`); process.exit(0); }
  for (const b of todo) {
    console.log(`block ${b.n}: ${b.task} run ${b.run}, started ${new Date().toISOString()}`);
    const res = await runBlock(b);
    const records = Object.fromEntries(ARMS.map((a) => [a, readRecord(RUNS, b.task, a, b.run)]));
    const problems = blockProblems(b, records, res.exits);
    appendFileSync(join(RUNS, 'blocks.jsonl'), JSON.stringify({ block: b.n, task: b.task, run: b.run, ...res, problems }) + '\n');
    if (res.overlap.flagged) console.log(`block ${b.n}: overlap flagged, ${res.overlap.processes.length} process(es) outside the block`);
    if (problems.length) { for (const p of problems) console.error(`stopped after block ${b.n}: ${p}`); process.exit(1); }
    console.log(`block ${b.n}: done`);
  }
  console.log('every block is recorded');
}
