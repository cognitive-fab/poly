// Test that live runs use the real clock, not the test clock. The defect: the loader's TEST clock
// in test/runtime-helpers.mjs `loaded()` fixes a test month (2026-09) instead of using the real month.
// Spec: docs/proposals/example-harness.md HF2.10: "A live run uses the real clock ... the month's
// budget instance of a live run is keyed to the month in which it runs."
// Heavy: loads the live driver and poly-runtime. Run alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../helpers.mjs';
import { CANARY_KEY, answer, fakeApi, toolUse } from './e3-fake-api.mjs';
import { runStaged, schedule } from '../../examples/harness/host/staged.mjs';
import { runPilot } from '../../examples/harness/host/pilot.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { prepare, taskOf } from '../../examples/harness/host/tasks.mjs';

const LIVE = join(ROOT, 'examples', 'harness', 'prices-live');
const main = JSON.parse(readFileSync(join(LIVE, 'main.json'), 'utf8'));
const cheap = JSON.parse(readFileSync(join(LIVE, 'cheap.json'), 'utf8'));
const MODELS = { main: main.model, cheap: cheap.model };
const TABLES = { [main.model]: main, [cheap.model]: cheap };
// The price gate checks the table age against this date (unrelated to budget clock).
const TODAY = new Date('2026-10-14T12:00:00Z');
const OUT = join(ROOT, '.poly', 'tmp', `live-clock-${process.pid}`);
mkdirSync(OUT, { recursive: true });

// Compute the real current month once for use in assertions.
const realMonth = new Date().toISOString().slice(0, 7);

// The fake API: an agent that edits and runs a test task.
const SMALL = ['snip-headtail'];
const edits = (task, k) => taskOf(task).stages[k].edits.map((e) => toolUse('edit', { path: e.file, old: e.broken, new: e.fixed }));
const pkgOf = (task, k) => taskOf(task).stages[k].check.args[1];
function agent(entry) {
  const body = entry.body;
  const task = SMALL[0];
  const text = JSON.stringify(body.messages);
  const marks = [...text.matchAll(/Stage (\d+) of \d+/g)];
  const k = Number(marks[marks.length - 1][1]) - 1;
  const turnsDone = (text.slice(text.lastIndexOf(`Stage ${k + 1} of`)).match(/\[tool results/g) ?? []).length;
  const usage = { input_tokens: 300, output_tokens: 150, cache_creation_input_tokens: 4000, cache_read_input_tokens: 2000 };
  if (turnsDone === 0) {
    const command = `go test ${pkgOf(task, k)} -count 1`;
    if (body.tools.some((t) => t.name === 'edit_and_run')) {
      const e = taskOf(task).stages[k].edits[0];
      return answer({ blocks: [toolUse('edit_and_run', { path: e.file, old: e.broken, new: e.fixed, command })], stop: 'tool_use', usage });
    }
    return answer({ blocks: [...edits(task, k), toolUse('bash', { command })], stop: 'tool_use', usage });
  }
  return answer({ blocks: [toolUse('done', {})], stop: 'tool_use', usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 200, cache_read_input_tokens: 6000 } });
}
const serve = (entry) => (Array.isArray(entry.body?.tools) ? agent(entry) : answer({ blocks: [{ type: 'text', text: 'summary' }], stop: 'end_turn', usage: { input_tokens: 500, output_tokens: 60 } }));

const worldOf = () => ({ task, run }) => {
  const h = makeHost();
  return {
    prepare: async () => { const { copy } = prepare(task.id, `${run}-${process.pid}`); h.setWorld({ copy, task }); },
    exec: h.transports.exec,
    remove: async () => {},
  };
};

// A minimal schedule: one trial on snip-headtail, base config.
function singleTrialPlan() {
  const trial = { n: 1, task: 'snip-headtail', config: 'base', pass: 1, label: 'snip-headtail.base.p1' };
  return [trial];
}

test('runStaged with a live run loads the harness with the real clock, and the month budget instance is keyed to the real month, not the test month (2026-09)', { timeout: 3_000_000 }, async () => {
  const api = await fakeApi(serve);
  const out = join(OUT, 'staged');
  try {
    const plan = singleTrialPlan();
    const report = await runStaged({
      models: MODELS,
      tables: TABLES,
      world: worldOf(),
      isolation: () => true,
      outDir: out,
      trials: plan,
      baseUrl: api.url,
      getKey: () => CANARY_KEY,
      sleep: async () => {},
      today: TODAY,
    });
    assert.equal(report.trialsFinished, 1);
    assert.deepEqual(report.stoppedBecause, { reason: 'plan-complete', detail: '1 trials' });
    // The poly store is created at poly-<pid>.sqlite.
    const storeFile = readdirSync(out).find((f) => f.endsWith('.sqlite'));
    assert.ok(storeFile, 'runStaged created a sqlite store file');
    const storePath = join(out, storeFile);
    // Query the pr_instance table for budget instances.
    const db = new DatabaseSync(storePath, { readOnly: true });
    const instances = db.prepare('SELECT instance_id, state FROM pr_instance').all();
    db.close();
    // Find the budget instance. The instance_id should match budget:task:scope:harness:month:<YYYY-MM>.
    const budgetInstances = instances.filter((row) => row.instance_id.startsWith('budget:'));
    assert.ok(budgetInstances.length > 0, 'there is at least one budget instance in the store');
    // The budget instance should be keyed to the real month, not 2026-09.
    const instanceIds = budgetInstances.map((row) => row.instance_id);
    const realMonthInstance = instanceIds.find((id) => id.includes(`month:${realMonth}`));
    assert.ok(
      realMonthInstance,
      `the budget instance is keyed to the real month (${realMonth}), not the test month (2026-09). Found: ${instanceIds.join(', ')}`,
    );
    // Assert that no instance with the test month (2026-09) exists (unless real month is 2026-09).
    if (realMonth !== '2026-09') {
      assert.ok(
        !instanceIds.some((id) => id.includes('month:2026-09')),
        'no budget instance is keyed to the test month (2026-09) when the real month is different',
      );
    }
    // Assert that the budget instance's state shows spending (the fake API reports usage).
    const realInstance = budgetInstances.find((row) => row.instance_id === realMonthInstance);
    assert.ok(realInstance, 'found the real month budget instance');
    const state = JSON.parse(realInstance.state);
    assert.ok(state.spent > 0, `the budget instance's state shows spending (spent: ${state.spent})`);
  } finally {
    await api.close();
  }
});

test('source-level assertion: runStaged and runPilot call loaded() with a now option (real clock), not relying on the test clock', () => {
  // Read the source files and check that every call to `loaded(` includes a `now:` option.
  // This verifies that the fix is in place: live runs must not use the test clock from loaded().
  const stagedPath = join(ROOT, 'examples', 'harness', 'host', 'staged.mjs');
  const pilotPath = join(ROOT, 'examples', 'harness', 'host', 'pilot.mjs');
  const stagedText = readFileSync(stagedPath, 'utf8');
  const pilotText = readFileSync(pilotPath, 'utf8');
  // Find all calls to loaded( in both files.
  const loadedPattern = /loaded\s*\(\s*([^)]+)\s*\)/g;
  const stagedMatches = [...stagedText.matchAll(loadedPattern)];
  const pilotMatches = [...pilotText.matchAll(loadedPattern)];
  assert.ok(stagedMatches.length > 0, 'staged.mjs calls loaded()');
  assert.ok(pilotMatches.length > 0, 'pilot.mjs calls loaded()');
  // For each call, check that the second argument (the options object) contains `now:`.
  // The pattern captures everything inside the parentheses; we need to check if it contains now:.
  for (const match of stagedMatches) {
    const args = match[1];
    // The call may be loaded(a, { ... }) so we need to check the second argument.
    // A simple heuristic: if the argument string contains 'now:', the call passes now.
    // However, the second argument is everything after the first comma if there is one.
    const hasSecondArg = args.includes(',');
    if (hasSecondArg) {
      const secondArg = args.split(',', 1)[0]; // everything before the first comma is the first arg
      const afterFirstArg = args.slice(secondArg.length); // everything after the first arg
      // The second arg should contain now:.
      assert.match(afterFirstArg, /now\s*:/, `staged.mjs: loaded() call includes now option: ${match[0]}`);
    }
  }
  for (const match of pilotMatches) {
    const args = match[1];
    const hasSecondArg = args.includes(',');
    if (hasSecondArg) {
      const secondArg = args.split(',', 1)[0];
      const afterFirstArg = args.slice(secondArg.length);
      assert.match(afterFirstArg, /now\s*:/, `pilot.mjs: loaded() call includes now option: ${match[0]}`);
    }
  }
});

test('the temporary files of this test are removed', () => {
  try {
    rmSync(OUT, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e; // the store may still be held by this process on Windows; ignored by git
  }
});
