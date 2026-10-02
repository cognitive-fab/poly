// The M3 task set and what the O1 session sees (PT13, M3-1, S92). Every task version has its files, the kit
// given to the O1 session holds briefs and host interfaces only and names no poly concept, the O1 checker
// refuses what the prompt forbids, and the controls pass on T1 (the full set runs with
// experiments/m3/controls/run.mjs, too long for this suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskIds, versions, moduleOf, readO3 } from '../experiments/m3/lib/task.mjs';
import { buildKit, kitFiles } from '../experiments/m3/o1-kit.mjs';
import { suiteProblems } from '../experiments/m3/controls/o1-check.mjs';
import { controlsOf } from '../experiments/m3/controls/run.mjs';
import { ROOT } from './helpers.mjs';

test('M3: ten tasks, each with a base version and three changes, every version with its files', () => {
  assert.deepEqual(taskIds(), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']);
  for (const id of taskIds()) {
    const vs = versions(id);
    assert.equal(vs.length, 4, id);
    for (const v of vs) {
      for (const f of ['brief.md', 'o2.mjs', 'explore.json', join('reference', 'host.map.json'), join('o3', 'traces.json.gz')]) assert.ok(existsSync(join(v.dir, f)), `${id} v${v.n}: ${f}`);
      assert.ok(existsSync(v.hostFile), `${id} v${v.n}: host.ts`);
      assert.ok(moduleOf(join(v.dir, 'reference')) && moduleOf(join(v.dir, 'mutant')), `${id} v${v.n}: reference and mutant`);
      const o3 = readO3(v);
      assert.equal(o3.bounded, false, `${id} v${v.n}: O3 was bounded`);
    }
  }
});

test('M3-1: the O1 kit holds the prompt, the briefs and the host interfaces, and nothing names poly', () => {
  const dir = buildKit(join(tmpdir(), 'poly-m3-o1-kit-test'));
  const files = kitFiles(dir);
  assert.equal(files.length, 1 + 10 * 4 * 2);
  assert.ok(files.every((f) => f === 'PROMPT.md' || /^T\d+\/v[0-3]\/(brief\.md|host\.ts)$/.test(f)), files.join(' '));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const word of [/\bpoly\b/i, /polyrun/i, /\bSAM\b/, /host\.map/, /\bmachine\b/i, /\breference\b/i, /\bmutant\b/i, /\bO2\b/, /\bO3\b/]) assert.doesNotMatch(text, word, `${f} names ${word}`);
  }
  // The prompt the session gets is the one in the repository.
  assert.equal(readFileSync(join(dir, 'PROMPT.md'), 'utf8'), readFileSync(join(ROOT, 'docs', 'm3', 'o1-prompt.md'), 'utf8'));
});

test('M3-1: the O1 checker takes a suite that loads M3_IMPL with Node built-ins, and lists what else it sees', () => {
  const good = "import { test } from 'node:test';\nimport { pathToFileURL } from 'node:url';\nconst { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);\ntest('x', async () => { await createHost(); });\n";
  assert.deepEqual(suiteProblems(good), []);
  assert.deepEqual(suiteProblems(good.replace("'node:url'", "'url-lib'")), ['imports url-lib, which is not a Node built-in']);
  assert.deepEqual(suiteProblems(good.replace('process.env.M3_IMPL', "'./impl.mjs'")), ['does not load the implementation from M3_IMPL']);
  assert.deepEqual(suiteProblems("const x = require('fs');\nprocess.env.M3_IMPL;\ntest('y', () => {});\n"), ['uses require']);
  assert.deepEqual(suiteProblems("process.env.M3_IMPL;\n"), ['holds no test']);
});

test('S97: the tree replay finds the same failing traces as replaying each trace from a fresh host', async () => {
  const { replay, replayEach } = await import('../experiments/m3/lib/o3.mjs');
  const { adapterOf, readJson } = await import('../experiments/m3/lib/task.mjs');
  const { pathToFileURL } = await import('node:url');
  for (const v of versions('T1')) {
    const spec = readJson(join(v.dir, 'explore.json'));
    const o3 = readO3(v);
    const o2 = (await import(pathToFileURL(join(v.dir, 'o2.mjs')).href)).default;
    for (const which of ['reference', 'mutant']) {
      const host = await adapterOf(v, which);
      const ids = (r) => [...new Set(r.failures.map((f) => `${f.kind}:${f.trace ?? f.where}:${f.property ?? ''}`))].sort();
      assert.deepEqual(ids(await replay(host, o3, o2, spec)), ids(await replayEach(host, o3, o2, spec)), `T1 v${v.n} ${which}`);
    }
  }
});

test('M3-9: O1 is committed, so a missing O1 suite fails control 4, and no control may go unrun', async () => {
  const { controlsPassed } = await import('../experiments/m3/controls/run.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const empty = mkdtempSync(join(tmpdir(), 'poly-m3-no-o1-'));
  try {
    const r = await controlsOf(versions('T1')[0], { o1Dir: empty });
    const c4 = r.controls.find((c) => c.n === 4);
    assert.equal(c4.status, 'fail', c4.detail);
    assert.match(c4.detail, /no O1 suite/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const all = (s4) => [1, 2, 3].map((n) => ({ n, status: 'pass' })).concat({ n: 4, status: s4 });
  assert.equal(controlsPassed(all('not-run')), false);
  assert.equal(controlsPassed(all('pass')), true);
  // A control that is missing is not a pass either.
  assert.equal(controlsPassed([{ n: 1, status: 'pass' }, { n: 4, status: 'pass' }]), false);
  assert.equal(controlsPassed([]), false);
});

test('M3 controls on T1: every version\'s reference checks clean and replays its O3, its mutant fails, and O1 passes on the reference and fails on the mutant', async () => {
  for (const v of versions('T1')) {
    const r = await controlsOf(v);
    for (const c of r.controls) {
      // O1 exists since bb929b2, so control 4 runs and must pass like the others (M3-9).
      assert.equal(c.status, 'pass', `T1 v${v.n} control ${c.n}: ${c.detail}`);
    }
  }
});
