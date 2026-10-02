// The controls of plan-m3 section 5 (PT13), for every version of the given tasks (all when none is given):
//
//   1. the reference checks clean: `poly check` verdict CLEAN, every stage run;
//   2. the reference replays its own O3 at 100% through the adapter over polyrun, with every O2 predicate true;
//   3. the mutant fails O3 or O2 on at least one trace;
//   4. O1 (experiments/m3/o1/<task>/v<n>.test.mjs) passes on the reference and fails on the mutant.
//
// A control that cannot run is reported as not run, never as passed. The exit code is 0 only when every control
// of every version ran and passed; since O1 is committed, a missing suite fails control 4 (M3-9).
//
// Usage: node experiments/m3/controls/run.mjs [T1 T2 ...]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkFile } from '@poly/check';
import { replay } from '../lib/o3.mjs';
import { cleanEnv } from '../runner/score.mjs';
import { M3, adapterOf, mapOf, moduleOf, o3Path, readJson, readO3, taskIds, versions } from '../lib/task.mjs';
import { tmpdir } from 'node:os';

/** Runs the controls of one version; returns { version, controls: [{ n, name, status, detail }] }. */
export async function controlsOf(v, { o1Dir = join(M3, 'o1') } = {}) {
  const out = [];
  const add = (n, name, status, detail = '') => out.push({ n, name, status, detail });
  const spec = readJson(join(v.dir, 'explore.json'));
  const o3 = existsSync(o3Path(v)) ? readO3(v) : null;
  const o2 = (await import(pathToFileURL(join(v.dir, 'o2.mjs')).href)).default;

  // 1. The reference checks clean, every stage run.
  const r = await checkFile(moduleOf(join(v.dir, 'reference')), { root: join(tmpdir(), 'poly-m3', 'check', `${v.task}-v${v.n}`) });
  const notRun = [...r.machines.flatMap((m) => m.stages.filter((s) => s.status !== 'ran').map((s) => `${m.machine}.${s.stage}`)), ...r.configurations.flatMap((c) => c.stages.filter((s) => s.status !== 'ran').map((s) => `${c.configuration}.${s.stage}`))];
  const findings = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => `${d.code} ${d.message}`);
  add(1, 'reference checks clean', r.verdict === 'CLEAN' && !notRun.length ? 'pass' : 'fail', `verdict ${r.verdict}${notRun.length ? `; not run: ${notRun.join(', ')}` : ''}${findings.length ? `; ${findings.join('; ')}` : ''}`);

  // 2 and 3 need O3.
  if (!o3) {
    add(2, 'reference replays O3', 'not-run', 'no O3');
    add(3, 'mutant fails O3 or O2', 'not-run', 'no O3');
  } else {
    if (o3.bounded) add(2, 'O3 is complete', 'fail', 'the exploration was bounded');
    const ref = await replay(await adapterOf(v, 'reference'), o3, o2, spec);
    add(2, 'reference replays O3', ref.failures.length === 0 ? 'pass' : 'fail', `${ref.traces} traces; ${ref.failures.length} failures${ref.failures.length ? `: ${JSON.stringify(ref.failures.slice(0, 3))}` : ''}`);
    const mut = await replay(await adapterOf(v, 'mutant'), o3, o2, spec);
    const o2Names = [...new Set(mut.failures.filter((f) => f.kind === 'o2').map((f) => f.property))];
    add(3, 'mutant fails O3 or O2', mut.failures.length > 0 ? 'pass' : 'fail', `${mut.failures.filter((f) => f.kind === 'o3').length} O3 failures; O2 violated: ${o2Names.join(', ') || 'none'}`);
  }

  // 4. O1. It is committed (bb929b2) and frozen (M3-9), so a missing suite is a failure, not a control not run.
  const o1 = join(o1Dir, v.task, `v${v.n}.test.mjs`);
  if (!existsSync(o1)) add(4, 'O1 passes on the reference and fails on the mutant', 'fail', `no O1 suite: ${o1}`);
  else {
    const runO1 = async (which) => {
      const dir = await adapterDir(v, which);
      return spawnSync(process.execPath, ['--no-warnings', '--test', o1], { encoding: 'utf8', env: cleanEnv({ M3_IMPL: join(dir, 'host.gen.ts') }) }).status;
    };
    const onRef = await runO1('reference');
    const onMut = await runO1('mutant');
    add(4, 'O1 passes on the reference and fails on the mutant', onRef === 0 && onMut !== 0 ? 'pass' : 'fail', `reference exit ${onRef}, mutant exit ${onMut}`);
  }
  return { task: v.task, version: v.n, controls: out };
}

/** Whether a version's controls all passed: each of controls 1 to 4 is there, and a control that did not run is not a pass (M3-9). */
export const controlsPassed = (controls) => [1, 2, 3, 4].every((n) => controls.some((c) => c.n === n)) && controls.every((c) => c.status === 'pass');

/** The directory of a generated adapter, for O1, which imports it by path. */
async function adapterDir(v, which) {
  const { generate } = await import('../adapter/generate.mjs');
  const { POLYRUN } = await import('../lib/task.mjs');
  const { mkdirSync, rmSync } = await import('node:fs');
  const out = join(tmpdir(), 'poly-m3', 'o1', `${v.task}-v${v.n}-${which}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = generate({ mapFile: mapOf(v, which), hostFile: v.hostFile, moduleFile: moduleOf(join(v.dir, which)), out, polyrun: POLYRUN });
  if (r.errors) throw new Error(r.errors.join('\n'));
  return out;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : taskIds();
  let ok = true;
  for (const id of ids) {
    for (const v of versions(id)) {
      const r = await controlsOf(v);
      if (!controlsPassed(r.controls)) ok = false;
      for (const c of r.controls) {
        console.log(`${id} v${v.n} control ${c.n} ${c.status.toUpperCase().padEnd(7)} ${c.name}: ${c.detail}`);
      }
    }
  }
  process.exitCode = ok ? 0 : 1;
}
