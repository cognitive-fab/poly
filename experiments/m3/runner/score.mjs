// Scores a finished run (PT13), outside its workspace: for each version, whether a delivery exists, whether it
// is admitted (the poly arms: `poly check` CLEAN and the adapter builds), and its O1, O2 and O3 results, with O1-R
// beside O1 as a secondary measure (M3-10). For the
// poly arms it also counts, from the journal, the diagnostics the agent saw by code and the typed fixes it was
// offered and applied with `poly fix`. The results are written into run.json as `scores`.
//
// Usage: node experiments/m3/runner/score.mjs <run dir> [--timeout <seconds per version>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { checkFile } from '@poly/check';
import { generate } from '../adapter/generate.mjs';
import { M3, POLYRUN, versions } from '../lib/task.mjs';
import { rangesOf } from '../o1r/ranges.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * The environment of a child `node --test`: without NODE_TEST_CONTEXT, which a parent test runner sets and which
 * would make the child report in the runner's own protocol instead of TAP.
 */
export const cleanEnv = (extra) => { const env = { ...process.env, ...extra }; delete env.NODE_TEST_CONTEXT; return env; };

/** The results of a TAP stream by test, named by their path of enclosing suites: name -> passed. */
export function tapResults(text) {
  const out = new Map();
  const stack = [];
  const lines = (text ?? '').split('\n');
  // A suite's own line comes after its subtests, so names are built from the "# Subtest:" headers.
  for (const line of lines) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) { const depth = sub[1].length / 4; stack.length = depth; stack[depth] = sub[2]; continue; }
    const m = /^(\s*)(not )?ok \d+ - (.*?)(?:\s+# (?:SKIP|TODO).*)?$/.exec(line);
    if (m) { const depth = m[1].length / 4; const name = [...stack.slice(0, depth), m[3]].join(' > '); out.set(name, !m[2]); }
  }
  return out;
}

/** O1's result for an implementation: the number of tests and of failing tests, and each test's result. */
export function runO1(task, n, impl, timeoutMs, o1Dir = join(M3, 'o1')) {
  const suite = join(o1Dir, task, `v${n}.test.mjs`);
  if (!existsSync(suite)) return { ran: false, reason: 'O1 does not exist yet' };
  return runSuite(suite, { M3_IMPL: impl }, timeoutMs);
}

/**
 * O1-R's result for an implementation (M3-10): the out-of-range refusals of the M3-8 list that apply to this
 * version, a secondary measure kept apart from O1. A version no entry applies to runs no test.
 */
export function runO1R(task, n, impl, timeoutMs) {
  // node --test counts a file with no test as one test, so a version with no entry is not run.
  if (!rangesOf(task, n).length) return { ran: true, tests: 0, failed: 0, skipped: 0, passed: [], failing: [] };
  return runSuite(join(M3, 'o1r', 'o1r.test.mjs'), { M3_IMPL: impl, M3_TASK: task, M3_VERSION: String(n) }, timeoutMs);
}

/** A suite's result under `node --test`: its tests, failing and skipped counts, and each test's result. */
function runSuite(suite, env, timeoutMs) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--test', '--test-reporter=tap', suite], { encoding: 'utf8', timeout: timeoutMs, env: cleanEnv(env) });
  const num = (k) => Number((new RegExp(`^# ${k} (\\d+)$`, 'm').exec(r.stdout ?? '') ?? [])[1] ?? NaN);
  if (r.error) return { ran: false, reason: String(r.error.message) };
  const results = tapResults(r.stdout);
  return { ran: true, tests: num('tests'), failed: num('fail') + (num('cancelled') || 0), skipped: num('skipped') || 0, passed: [...results].filter(([, ok]) => ok).map(([n]) => n).sort(), failing: [...results].filter(([, ok]) => !ok).map(([n]) => n).sort() };
}

/** The implementation module of a delivery, built into `work`: the TypeScript file, or the generated adapter. */
export function buildImpl(arm, v, delivery, work) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  if (arm <= 2) {
    const impl = join(delivery, 'src', 'host.impl.ts');
    if (!existsSync(impl)) return { impl: null, reason: 'no src/host.impl.ts' };
    cpSync(join(delivery, 'src'), join(work, 'src'), { recursive: true });
    cpSync(v.hostFile, join(work, 'host.ts'));
    return { impl: join(work, 'src', 'host.impl.ts') };
  }
  const module = join(delivery, 'src', arm === 3 ? 'system.poly' : 'system.ts');
  const map = join(delivery, 'host.map.json');
  if (!existsSync(module) || !existsSync(map)) return { impl: null, reason: `no ${arm === 3 ? 'src/system.poly' : 'src/system.ts'} or host.map.json` };
  const r = generate({ mapFile: map, hostFile: v.hostFile, moduleFile: module, out: work, polyrun: POLYRUN });
  if (r.errors) return { impl: null, reason: `the adapter does not build: ${r.errors.join('; ')}` };
  return { impl: join(work, 'host.gen.ts') };
}

/** For the poly arms: diagnostic codes the agent saw, and fixes offered and applied, from the journal's tool results. */
export function toolchainUse(journalText) {
  const codes = {};
  const offered = new Set();
  const applied = new Set();
  for (const line of journalText.split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    const ev = e.event;
    if (ev?.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('\n');
        for (const m of text.matchAll(/\b(PL\d{4})\b/g)) codes[m[1]] = (codes[m[1]] ?? 0) + 1;
        for (const m of text.matchAll(/\b([a-z]+(?:-[a-z]+)*@[0-9a-f]{12})\b/g)) offered.add(m[1]);
        const done = /applied ([a-z-]+@[0-9a-f]{12})/.exec(text);
        if (done) applied.add(done[1]);
      }
    }
  }
  return { codes, fixesOffered: offered.size, fixesApplied: applied.size };
}

export async function scoreRun(dir, { timeoutMs = 30 * 60 * 1000, o1Dir } = {}) {
  const record = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const vs = versions(record.task);
  const scores = [];
  for (const rv of record.versions) {
    const v = vs[rv.n];
    const s = { n: rv.n, delivered: false, admitted: null, withinBudget: rv.attempted === true && !rv.stopped };
    if (!rv.attempted) { scores.push({ ...s, reason: rv.reason }); continue; }
    const delivery = join(dir, 'deliveries', `v${rv.n}`);
    if (record.arm >= 3) {
      const module = join(delivery, 'src', record.arm === 3 ? 'system.poly' : 'system.ts');
      if (existsSync(module)) {
        const r = await checkFile(module, { root: join(dir, 'scoring', `v${rv.n}`, 'check') });
        s.check = { verdict: r.verdict, codes: [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => d.code).sort() };
      }
    }
    const built = buildImpl(record.arm, v, delivery, join(dir, 'scoring', `v${rv.n}`, 'impl'));
    if (!built.impl) { scores.push({ ...s, reason: built.reason }); continue; }
    s.delivered = true;
    if (record.arm >= 3) s.admitted = s.check?.verdict === 'CLEAN';
    const one = spawnSync(process.execPath, ['--no-warnings', join(HERE, 'score-one.mjs'), record.task, String(rv.n), built.impl], { encoding: 'utf8', timeout: timeoutMs });
    try { Object.assign(s, JSON.parse(one.stdout.trim().split('\n').at(-1))); } catch { s.o3 = null; s.o2 = null; s.error = one.error ? String(one.error.message) : `scorer exited ${one.status}: ${one.stderr.slice(0, 500)}`; }
    s.o1 = runO1(record.task, rv.n, built.impl, timeoutMs, o1Dir);
    // M3-10: the range refusals of the amended briefs, scored beside O1 and never into it.
    s.o1r = runO1R(record.task, rv.n, built.impl, timeoutMs);
    scores.push(s);
  }
  // Regressions (PT13): a test of version n that passed at version n-1 and fails at delivery n was introduced;
  // one that failed on a snapshot during turn n and passes at delivery was introduced and caught.
  for (const s of scores) {
    const prev = scores.find((x) => x.n === s.n - 1);
    if (!s.n || !prev?.o1?.ran || !s.o1?.ran) continue;
    const before = new Set(prev.o1.passed);
    const inBoth = (name) => before.has(name);
    const failingAtDelivery = new Set(s.o1.failing);
    const snaps = join(dir, 'snapshots', `v${s.n}`);
    const seenFailing = new Set();
    if (existsSync(snaps)) {
      for (const k of readdirSync(snaps).sort((a, b) => Number(a) - Number(b))) {
        const built = buildImpl(record.arm, vs[s.n], join(snaps, k), join(dir, 'scoring', `v${s.n}`, 'snap', k));
        if (!built.impl) continue;
        const o = runO1(record.task, s.n, built.impl, timeoutMs, o1Dir);
        if (o.ran) for (const t of o.failing) seenFailing.add(t);
      }
    }
    s.regressions = {
      introduced: [...failingAtDelivery].filter(inBoth).length,
      caught: [...seenFailing].filter((t) => inBoth(t) && !failingAtDelivery.has(t)).length,
    };
  }
  record.scores = scores;
  if (record.arm >= 3 && existsSync(join(dir, 'journal.jsonl'))) record.toolchain = toolchainUse(readFileSync(join(dir, 'journal.jsonl'), 'utf8'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2];
  const i = process.argv.indexOf('--timeout');
  const r = await scoreRun(dir, i > 0 ? { timeoutMs: Number(process.argv[i + 1]) * 1000 } : {});
  for (const s of r.scores) console.log(`v${s.n}: delivered ${s.delivered}${s.admitted !== null ? `, admitted ${s.admitted}` : ''}, O3 ${s.o3 ? `${s.o3.failed}/${s.o3.traces} failed` : 'not run'}, O2 ${s.o2 ? `${s.o2.violated.length} violated` : 'not run'}, O1 ${s.o1?.ran ? `${s.o1.failed}/${s.o1.tests} failed` : `not run (${s.o1?.reason ?? s.reason})`}`);
}
