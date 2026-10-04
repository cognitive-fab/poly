// The M3 runner's dry run (plan-m3 section 6): T1 through every arm with the stub agent and a small budget.
// The workspace holds nothing an arm must not see, the budget cut-off stops a run and says so, the journal
// records every turn, and the scoring reads each delivery. The poly arms' toolchain runs from inside a
// workspace. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { M3, moduleOf, versions } from '../experiments/m3/lib/task.mjs';
import { dryRun, DRY } from '../experiments/m3/runner/dry-run.mjs';
import { makeWorkspace } from '../experiments/m3/runner/workspace.mjs';
import { claudeArgs, ALLOWED_TOOLS } from '../experiments/m3/runner/agent.mjs';
import { promptOf } from '../experiments/m3/runner/run.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));

/** The digests of everything no arm may see: every reference, mutant, O2 and O3 file, and O1 once it exists. */
function secrets() {
  const out = new Set();
  const tasks = join(M3, 'tasks');
  for (const t of readdirSync(tasks).filter((d) => /^T\d+$/.test(d))) {
    for (const f of walk(join(tasks, t))) if (/[\\/](reference|mutant|o3)[\\/]|[\\/]o2\.mjs$/.test(f)) out.add(sha(readFileSync(f)));
  }
  if (existsSync(join(M3, 'o1'))) for (const f of walk(join(M3, 'o1'))) out.add(sha(readFileSync(f)));
  // O1-R (M3-10) is hidden like O1.
  for (const f of walk(join(M3, 'o1r'))) out.add(sha(readFileSync(f)));
  return out;
}

test('the dry run: every arm on T1, the budget cut-off, the journal and the scores', async () => {
  const out = join(tmpdir(), 'poly-m3-dry-run-test');
  const runs = await dryRun(out);
  assert.deepEqual(runs.map((r) => r.arm), [1, 2, 3, 4]);
  for (const r of runs) {
    const journal = readFileSync(join(out, r.id, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const prompts = journal.filter((e) => e.type === 'runner.prompt');
    if (r.arm === 2) {
      // The third turn spent 250k tokens against a budget of 200k: it is stopped, and the last change never runs.
      assert.equal(r.versions[2].stopped, 'budget');
      assert.equal(r.versions[3].attempted, false);
      assert.equal(prompts.length, 3);
      assert.deepEqual(r.scores.map((s) => s.withinBudget), [true, true, false, false]);
    } else {
      assert.equal(prompts.length, 4);
      assert.equal(r.spent.tokens, 4 * 50_000);
      for (const s of r.scores) {
        assert.equal(s.delivered, true, `arm ${r.arm} v${s.n}: ${s.reason}`);
        assert.equal(s.o3.failed, 0, `arm ${r.arm} v${s.n}`);
        assert.deepEqual(s.o2.violated, []);
        if (r.arm >= 3) assert.equal(s.admitted, true);
      }
    }
    // The first prompt is the skeleton with the arm's sections; the others are the change template.
    assert.match(prompts[0].prompt, /# The brief\n\n# Order lifecycle/);
    assert.match(prompts[1].prompt, /^The brief has changed/);
    assert.equal(r.budget.tokens, DRY.tokens);
  }
});

test('the workspace holds no reference, mutant, O2, O3 or O1, and the prompts name none', () => {
  const hidden = secrets();
  for (const arm of [1, 2, 3, 4]) {
    const v = versions('T1')[0];
    const { ws, files } = makeWorkspace(join(tmpdir(), 'poly-m3-ws-test', `arm${arm}`), arm, v);
    for (const f of files) {
      assert.doesNotMatch(f, /(^|\/)(reference|mutant|o2\.mjs|o3|o1)(\/|$)/, `arm ${arm}: ${f}`);
      if (!f.startsWith('node_modules/')) assert.ok(!hidden.has(sha(readFileSync(join(ws, f)))), `arm ${arm}: ${f} is a hidden file`);
    }
    if (arm === 2) assert.ok(files.includes('tools/polygraph/scripts/check.mjs'));
    if (arm >= 3) assert.ok(!readFileSync(join(ws, 'tools', 'poly', 'docs', '03-technical-spec.md'), 'utf8').includes('## PT13.'), 'the experiment design is cut from the manual');
    for (const n of [0, 1, 2, 3]) {
      const p = promptOf(arm, versions('T1')[n]);
      assert.doesNotMatch(p, /\bO[123]\b|reference machine|mutant/, `arm ${arm} turn ${n}`);
    }
  }
});

test('the poly arms\' toolchain runs inside a workspace: check, fix listing and the adapter', () => {
  const v = versions('T1')[0];
  const { ws } = makeWorkspace(join(tmpdir(), 'poly-m3-ws-test', 'toolchain'), 3, v);
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'system.poly'), readFileSync(moduleOf(join(v.dir, 'reference')), 'utf8'));
  writeFileSync(join(ws, 'host.map.json'), readFileSync(join(v.dir, 'reference', 'host.map.json'), 'utf8'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const check = spawnSync(npm, ['run', '--silent', 'poly', '--', 'check', 'src/system.poly'], { cwd: ws, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /verdict: CLEAN/);
  const adapter = spawnSync(npm, ['run', '--silent', 'adapter'], { cwd: ws, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(adapter.status, 0, adapter.stdout + adapter.stderr);
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', "const { default: c } = await import('./build/host.gen.ts'); const h = await c(); console.log(JSON.stringify([await h.create('a'), await h.order('a')])); h.__dispose();"], { cwd: ws, encoding: 'utf8' });
  assert.equal(run.stdout.trim(), JSON.stringify([{ ok: true }, { status: 'draft', items: 0, charges: 0, refunds: 0 }]), run.stderr);
});

test('regressions: a test of an unchanged rule that fails on a snapshot and passes at delivery is caught; one failing at delivery was introduced', async () => {
  const { runOne } = await import('../experiments/m3/runner/run.mjs');
  const { scoreRun, tapResults } = await import('../experiments/m3/runner/score.mjs');
  // A synthetic O1: the same test of an unchanged rule in every version, and one that only version 0 has.
  const o1Dir = join(tmpdir(), 'poly-m3-o1-synthetic');
  const suite = (extra) => "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nconst { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);\ntest('an order starts as an empty draft', async () => { const h = await createHost(); assert.equal((await h.create('a')).ok, true); assert.deepEqual((await h.order('a')).status, 'draft'); });\n" + extra;
  for (const n of [0, 1, 2, 3]) {
    mkdirSync(join(o1Dir, 'T1'), { recursive: true });
    writeFileSync(join(o1Dir, 'T1', `v${n}.test.mjs`), suite(n === 0 ? "test('only in version 0', () => {});\n" : ''));
  }
  const ts = readFileSync(join(M3, 'runner', 'dry-run', 't1-impl.ts'), 'utf8');
  const at = (n) => ts.replace('const VERSION: number = 0;', `const VERSION: number = ${n};`);
  const broken = (n) => at(n).replace("async create(id: string) { if (orders.has(id)) return no('exists');", "async create(id: string) { return no('broken');");
  assert.notEqual(broken(1), at(1));
  const use = { type: 'usage', usage: DRY.perTurn };
  const turns = [
    { events: [{ type: 'write', path: 'src/host.impl.ts', content: at(0) }, use] },
    // Turn 1 breaks the unchanged rule, then repairs it before delivery: caught.
    { events: [{ type: 'write', path: 'src/host.impl.ts', content: broken(1) }, { type: 'write', path: 'src/host.impl.ts', content: at(1) }, use] },
    // Turn 2 delivers it broken: introduced.
    { events: [{ type: 'write', path: 'src/host.impl.ts', content: broken(2) }, use] },
    { events: [{ type: 'write', path: 'src/host.impl.ts', content: at(3) }, use] },
  ];
  const { dir } = await runOne({ arm: 1, task: 'T1', run: 9, model: 'stub', tokens: DRY.tokens, wallMs: DRY.wallMs, out: join(tmpdir(), 'poly-m3-regressions'), agent: { kind: 'stub', turns } });
  const r = await scoreRun(dir, { o1Dir });
  assert.deepEqual(r.scores.map((s) => s.o1.failed), [0, 0, 1, 0]);
  assert.equal(r.scores[0].regressions, undefined);
  assert.deepEqual(r.scores[1].regressions, { introduced: 0, caught: 1 });
  assert.deepEqual(r.scores[2].regressions, { introduced: 1, caught: 0 });
  // Version 3 repairs it: the test failed at version 2, so its failure there is not a regression of version 3.
  assert.deepEqual(r.scores[3].regressions, { introduced: 0, caught: 0 });
  assert.deepEqual([...tapResults('# Subtest: s\n    ok 1 - a\n    not ok 2 - b\nok 1 - s\n')], [['s > a', true], ['s > b', false], ['s', true]]);
});

test('the CLI turn: headless, without --bare (4210fa6), the arm\'s tools only, and resumed for a change', () => {
  const a = claudeArgs({ arm: 3, model: 'm', prompt: 'p', sessionId: 's1' });
  assert.deepEqual(a.slice(0, 2), ['-p', 'p']);
  assert.ok(a.includes('--disable-slash-commands'));
  // The subscription needs the login, which --bare never reads; isolation comes from the folder and the environment.
  assert.ok(!a.includes('--bare'));
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--allowedTools') + 1], ALLOWED_TOOLS[3].join(','));
  assert.equal(a[a.indexOf('--resume') + 1], 's1');
  assert.ok(!claudeArgs({ arm: 1, model: 'm', prompt: 'p' }).includes('--resume'));
  assert.ok(!ALLOWED_TOOLS[1].some((t) => /poly/.test(t)), 'the TypeScript arms have no poly tool');
});

test('a real run is refused until the freeze is approved, and a pilot until the owner approves it', async () => {
  // Both gates are open (PILOT since ab9d2d0, FROZEN since 1c8d155), so a spawned run would really run: the gates are
  // checked on a stand-in directory only. Until block 39's ruling this test spawned a T1 run, which then started the
  // real CLI on the arms' login and was stopped by its 1-second wall cap with no token spent (measured on 3 October).
  const { gateProblem } = await import('../experiments/m3/runner/run.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const m3 = mkdtempSync(join(tmpdir(), 'poly-m3-gate-'));
  try {
    assert.match(gateProblem('P1', m3), /pilot run needs/);
    assert.match(gateProblem('T1', m3), /needs the freeze/);
    writeFileSync(join(m3, 'PILOT'), '');
    assert.equal(gateProblem('P1', m3), null);
    assert.match(gateProblem('T1', m3), /needs the freeze/);
  } finally {
    rmSync(m3, { recursive: true, force: true });
  }
});
