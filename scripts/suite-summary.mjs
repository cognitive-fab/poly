// The owner's ruling of 2026-10-06 ("Test output: a summary in the session, the full log behind a path",
// decisions-m9.md): a full suite run writes its whole output to a file under .poly/logs/, and the session reads only
// this summary: the totals of each run, the check-memory result, and for each failure its file, its name and the first
// 40 lines of its error. Tooling, not product: no test and no standing rule.
//
//   node scripts/suite-summary.mjs --run [label]   run `npm test`, log it to .poly/logs/<commit>-<time>[-label].log, summarise
//   node scripts/suite-summary.mjs <log>           summarise a log already written
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ERROR_LINES = 40;

async function run(label) {
  assertNotExperimentTree(ROOT);
  // Polywatch: the label names the log file only, so it is a plain word and never a path.
  if (label !== undefined && !/^[A-Za-z0-9_-]+$/.test(label)) throw new Error(`a label is letters, digits, _ and - only: ${JSON.stringify(label)}`);
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'nocommit';
  const time = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(ROOT, '.poly', 'logs');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${commit}-${time}${label ? `-${label}` : ''}.log`);
  const out = createWriteStream(log);
  // One command line through the shell, which finds npm on every platform; nothing is interpolated into it.
  const child = spawn('npm test', { cwd: ROOT, shell: true });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const code = await new Promise((done) => child.on('close', done));
  await new Promise((done) => out.end(`\nexit ${code}\n`, done));
  return log;
}

function summarise(log) {
  const lines = readFileSync(log, 'utf8').split(/\r?\n/);
  const out = [`log: ${relative(ROOT, log)}`];
  // Each `node --test` run ends with its totals; the suite has two runs (the main one and test/after).
  const runs = [];
  let cur = null;
  for (const l of lines) {
    const m = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/.exec(l);
    if (!m) continue;
    if (m[1] === 'tests') runs.push((cur = {}));
    if (cur) cur[m[1]] = Number(m[2]);
  }
  if (!runs.length) out.push('no totals: the suite did not reach its tests (a build or boundary failure); the last lines:', ...lines.filter((l) => l.trim()).slice(-ERROR_LINES).map((l) => `  ${l}`));
  runs.forEach((r, k) => out.push(`run ${k + 1}: ${r.tests} tests, ${r.pass} passed, ${r.fail} failed, ${r.cancelled ?? 0} cancelled, ${r.skipped} skipped, ${r.todo} waiting`));
  const memory = lines.find((l) => /keeps no memory per check/.test(l));
  out.push(`check-memory: ${memory ? memory.trim() : 'not found in the log'}`);
  // The spec reporter lists every failing test after "failing tests:", each as "test at <file>", its ✖ line and its
  // error, indented. A test marked todo or skip carries a directive after its time, and is waiting, not failing.
  const failures = [];
  let at = null;
  let inFailing = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^✖ failing tests:/.test(l)) { inFailing = true; continue; }
    if (!inFailing) continue;
    const t = /^test at (.*)$/.exec(l);
    if (t) { at = t[1]; continue; }
    const f = /^✖ (.*?) \(([\d.]+m?s)\)( # .*)?$/.exec(l);
    if (!f) continue;
    if (f[3]) continue;
    const error = [];
    for (let j = i + 1; j < lines.length && (lines[j].startsWith(' ') || lines[j] === ''); j++) error.push(lines[j]);
    while (error.length && !error[error.length - 1].trim()) error.pop();
    failures.push({ file: at, name: f[1], error: error.slice(0, ERROR_LINES).map((x) => (x.length > 400 ? `${x.slice(0, 400)} ...` : x)) });
  }
  const seen = new Set();
  const unique = failures.filter((f) => { const k = `${f.file} ${f.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  out.push(`failures: ${unique.length}`);
  for (const f of unique) out.push('', `${f.file ?? 'unknown file'}`, `  ✖ ${f.name}`, ...f.error);
  const exit = lines.map((l) => /^exit (\d+)$/.exec(l)).filter(Boolean).pop();
  if (exit) out.push('', `exit ${exit[1]}`);
  return out.join('\n');
}

const args = process.argv.slice(2);
if (args[0] === '--run') console.log(summarise(await run(args[1])));
else if (args[0]) console.log(summarise(args[0]));
else { console.error('usage: node scripts/suite-summary.mjs --run [label] | <log>'); process.exit(2); }
