#!/usr/bin/env node
// PT14a: how long a multi-machine program takes to check, with and without the result cache. The program is agentapp's
// (test/fixtures/agentapp, copied with its seeded defects and with its probes as goals), the largest poly program
// written so far. Each step is one `poly check` process, run alone, one after the other, so no step competes with
// another for the machine:
//
//   baseline  the whole program, every configuration, no cache: what one check of it costs today
//   cold      the whole program and its goals, with an empty cache, which it fills
//   warm      the same again, reading the cache
//   machine   the program with one machine changed (a rejection reason of Stock), reading the cache
//   defect    one seeded defect (stock-oversold by default), reading the cache
//
// The reports of baseline, cold and warm must agree (goals aside, which baseline has none of), or the script says so
// and exits 1. node scripts/bench-check-speed.mjs [--steps baseline,cold,warm,machine,defect] [--defect <name>] [--out <dir>]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
assertNotExperimentTree(ROOT);
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'agentapp');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const steps = arg('--steps', 'baseline,cold,warm,machine,defect').split(',');
const defect = arg('--defect', 'stock-oversold');
const out = arg('--out', null) ?? mkdtempSync(join(tmpdir(), 'poly-bench-'));
mkdirSync(out, { recursive: true });
const cache = join(out, 'cache');
// The fixture is kept as text (agentapp.poly.txt), not as a source of this repository: the suite checks every .poly
// source with its default heap, and one check of agentapp needs more (agentapp runs it with 6 GB). Each run copies it.
const program = join(out, 'program', 'agentapp.poly');
mkdirSync(dirname(program), { recursive: true });
writeFileSync(program, readFileSync(join(FIXTURE, 'agentapp.poly.txt'), 'utf8'));
const goals = join(FIXTURE, 'goals.json');

// The one-machine change: a rejection reason of Stock, which changes Stock's handler and nothing else.
const CHANGE = { find: 'reject "nothing-arrived"', replace: 'reject "none-arrived"' };

/** Runs poly check with the arguments; resolves with its exit code, wall time and output. */
function check(name, args) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--max-old-space-size=6000', CLI, 'check', ...args, '--root', join(out, name)], { env: { ...process.env, POLY_NO_CACHE: '' } });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => { const t = String(d); if (!t.startsWith('[check]')) text += t; });
    child.on('close', (code) => {
      const seconds = (Date.now() - t0) / 1000;
      writeFileSync(join(out, `${name}.txt`), text);
      console.log(`${name.padEnd(9)} exit ${code}  ${seconds.toFixed(1)} s`);
      done({ name, exit: code, seconds });
    });
  });
}

/** A report with what may differ between runs set aside: timings, roots, the cache's notes, the goals. */
function comparable(file) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  return JSON.stringify(r, (k, v) => {
    if (k === 'ms' || k === 'cache' || k === 'buildDir' || k === 'goals' || k === 'file') return undefined;
    if (k === 'note' && typeof v === 'string') return v.replace(/;? ?from the cache, key sha256:[0-9a-f]+/, '') || undefined;
    if (k === 'diagnostics' && Array.isArray(v)) return v.filter((d) => d.code !== 'PL5410');
    return v;
  });
}

const results = [];
console.log(`poly check speed on agentapp (${cpus().length} CPUs, ${(totalmem() / 2 ** 30).toFixed(0)} GB), scratch ${out}`);
for (const s of steps) {
  if (s === 'baseline') results.push(await check('baseline', [program, '--no-cache']));
  else if (s === 'cold') results.push(await check('cold', [program, '--goals', goals, '--cache', cache]));
  else if (s === 'warm') results.push(await check('warm', [program, '--goals', goals, '--cache', cache]));
  else if (s === 'machine') {
    const src = readFileSync(program, 'utf8');
    if (src.split(CHANGE.find).length !== 2) throw new Error(`the one-machine change is not found once: ${CHANGE.find}`);
    mkdirSync(join(out, 'changed'), { recursive: true });
    const changed = join(out, 'changed', 'agentapp.poly');
    writeFileSync(changed, src.replace(CHANGE.find, () => CHANGE.replace));
    results.push(await check('machine', [changed, '--goals', goals, '--cache', cache]));
  } else if (s === 'defect') results.push(await check('defect', [program, '--defects', join(FIXTURE, 'defects.json'), '--only', defect, '--cache', cache]));
  else throw new Error(`no such step ${s}`);
}

let same = true;
const reports = ['baseline', 'cold', 'warm'].map((n) => [n, join(out, n, '.poly', 'report.json')]).filter(([, f]) => existsSync(f));
for (const [n, f] of reports.slice(1)) {
  const agree = comparable(f) === comparable(reports[0][1]);
  if (!agree) same = false;
  console.log(`${n} ${agree ? 'agrees' : 'DOES NOT AGREE'} with ${reports[0][0]}`);
}
writeFileSync(join(out, 'bench.json'), JSON.stringify({ cpus: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), defect, change: CHANGE, results, reportsAgree: same }, null, 2));
console.log(`results in ${join(out, 'bench.json')}`);
if (!same) process.exit(1);
