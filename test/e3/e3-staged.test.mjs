// plan-e3.md E3.9: the launcher of the staged plan (host/staged.mjs) against a local fake of the API, on Go tasks in scratch copies on this host.
// Shown: the choice of the eight tasks to rerun and the order of the 40 trials (pure); a run of a small plan to its end, with the trials
// numbered, the commands of every bash call logged, the trigger rates, the noise floor over the tasks rerun, the paired comparison and ONE
// report; the stops (the month's cap, a failed isolation check, an error), each with a report and no call after it; --resume counting what
// finished trials cost and calling nothing for them; the key in nothing written. No key of value, no model, no spend. Heavy: run alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { CANARY_KEY, answer, fakeApi, toolUse } from './e3-fake-api.mjs';
import { rerunTasks, runStaged, schedule } from '../../examples/harness/host/staged.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { prepare, taskIds, taskOf } from '../../examples/harness/host/tasks.mjs';

const LIVE = join(ROOT, 'examples', 'harness', 'prices-live');
const main = JSON.parse(readFileSync(join(LIVE, 'main.json'), 'utf8'));
const cheap = JSON.parse(readFileSync(join(LIVE, 'cheap.json'), 'utf8'));
const MODELS = { main: main.model, cheap: cheap.model };
const TABLES = { [main.model]: main, [cheap.model]: cheap };
const TODAY = new Date('2026-10-14T12:00:00Z');
const OUT = join(ROOT, '.poly', 'tmp', `staged-${process.pid}`);
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- the plan, pure

test('the eight tasks rerun are chosen before the run, by stage count within each repository, ties by id', () => {
  assert.deepEqual(rerunTasks(), ['snip-config', 'snip-dedup', 'snip-group', 'snip-utils', 'todo-dates', 'todo-fuzzy', 'todo-nlparse', 'todo-recurrence']);
  const stages = Object.fromEntries(taskIds().map((id) => [id, taskOf(id).stages.length]));
  // the ones left out have no more stages than the ones taken in their repository
  assert.deepEqual(Object.entries(stages).filter(([id]) => !rerunTasks().includes(id)).map(([id]) => id).sort(), ['snip-headtail', 'snip-pipeline', 'todo-safehtml', 'todo-urgency']);
  for (const left of ['snip-headtail', 'snip-pipeline']) assert.ok(stages[left] <= Math.min(...['snip-config', 'snip-dedup', 'snip-group', 'snip-utils'].map((id) => stages[id])));
});

test('40 trials: 12 tasks under both configurations, then 8 reruns; a pair is adjacent; the order alternates by task and reverses in pass 2', () => {
  const s = schedule();
  assert.equal(s.length, 40);
  assert.deepEqual(s.map((t) => t.n), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual([s.filter((t) => t.pass === 1).length, s.filter((t) => t.pass === 2).length], [24, 16]);
  for (let i = 0; i < s.length; i += 2) {
    assert.equal(s[i].task, s[i + 1].task, `trials ${i + 1} and ${i + 2} are a pair`);
    assert.deepEqual([s[i].config, s[i + 1].config].sort(), ['base', 'full']);
  }
  // alternation by task in pass 1, and pass 2 reverses pass 1 for the same task
  const first = (pass, task) => s.find((t) => t.pass === pass && t.task === task).config;
  assert.notEqual(first(1, 'snip-config'), first(1, 'snip-dedup'));
  for (const id of rerunTasks()) assert.notEqual(first(1, id), first(2, id), id);
  assert.equal(new Set(s.map((t) => t.label)).size, 40, 'each trial has its own label (its run id in the store)');
  assert.ok(s.filter((t) => t.config === 'base').length === 20 && s.filter((t) => t.config === 'full').length === 20);
});

// ---------------------------------------------------------------- a small plan, run

const SMALL = ['snip-config', 'snip-headtail'];
const edits = (task, k) => taskOf(task).stages[k].edits.map((e) => toolUse('edit', { path: e.file, old: e.broken, new: e.fixed }));
const pkgOf = (task, k) => taskOf(task).stages[k].check.args[1];
// the whole prompt, as JSON writes it inside the request: two tasks of one repository begin alike
const taskOfRequest = (body) => SMALL.find((id) => JSON.stringify(body.messages).includes(JSON.stringify(taskOf(id).prompt).slice(1, -1)));
/** The agent: in each stage, one turn that edits and runs the package's tests (a runner of the table), a second that says done. */
function agent(entry) {
  const body = entry.body;
  const task = taskOfRequest(body);
  const text = JSON.stringify(body.messages);
  const marks = [...text.matchAll(/Stage (\d+) of \d+/g)];
  const k = Number(marks[marks.length - 1][1]) - 1;
  const turnsDone = (text.slice(text.lastIndexOf(`Stage ${k + 1} of`)).match(/\[tool results/g) ?? []).length;
  const usage = { input_tokens: 300, output_tokens: 150, cache_creation_input_tokens: 4000, cache_read_input_tokens: 2000 };
  if (turnsDone === 0) {
    const command = `go test ${pkgOf(task, k)} -count 1`;
    // the full harness is offered the fused action and uses it; the base harness writes the two calls
    if (body.tools.some((t) => t.name === 'edit_and_run')) {
      const e = taskOf(task).stages[k].edits[0];
      return answer({ blocks: [toolUse('edit_and_run', { path: e.file, old: e.broken, new: e.fixed, command })], stop: 'tool_use', usage });
    }
    return answer({ blocks: [...edits(task, k), toolUse('bash', { command })], stop: 'tool_use', usage });
  }
  return answer({ blocks: [toolUse('done', {})], stop: 'tool_use', usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 200, cache_read_input_tokens: 6000 } });
}
const serve = (entry) => (Array.isArray(entry.body?.tools) ? agent(entry) : answer({ blocks: [{ type: 'text', text: 'summary' }], stop: 'end_turn', usage: { input_tokens: 500, output_tokens: 60 } }));

const worldOf = (log = []) => ({ task, run }) => {
  const h = makeHost();
  return {
    prepare: async () => { log.push(`prepare ${run}`); const { copy } = prepare(task.id, `${run}-${process.pid}`); h.setWorld({ copy, task }); },
    exec: h.transports.exec,
    remove: async () => { log.push(`remove ${run}`); },
  };
};
const smallPlan = () => schedule(SMALL, ['snip-headtail']);

test('a small plan runs to its end: trials numbered and written one by one, the commands logged, the rates, the floor over the rerun task, the comparison, one report', { timeout: 3_000_000 }, async () => {
  const api = await fakeApi(serve);
  const out = join(OUT, 'whole');
  const log = [];
  let isolations = 0;
  try {
    const plan = smallPlan();
    assert.equal(plan.length, 6);
    const report = await runStaged({ models: MODELS, tables: TABLES, world: worldOf(log), isolation: () => { isolations += 1; return true; }, outDir: out, trials: plan, baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.deepEqual(report.stoppedBecause, { reason: 'plan-complete', detail: '6 trials' });
    assert.equal(report.trialsFinished, 6);
    assert.equal(isolations, 6, 'the isolation check is made before every trial');
    assert.deepEqual(log.filter((l) => l.startsWith('remove')).length, 6, 'every copy is removed when its trial ends');
    // one report, and one file for each trial
    assert.deepEqual(readdirSync(out).filter((f) => f === 'report.json').length, 1);
    assert.equal(readdirSync(out).filter((f) => /^trial-\d\d-/.test(f)).length, 6);
    assert.equal(readdirSync(out).filter((f) => /^calls-\d\d-/.test(f)).length, 6);
    for (const t of report.trials) {
      assert.deepEqual(t.trial, { mode: 'Done', why: 'PlanDone' }, t.label);
      assert.ok(t.stages.every((s) => s.state === 'passed' && s.endedBy === 'Done' && s.turns === 2), t.label);
      assert.equal(t.polyMicroUsd, t.driverMicroUsd, `${t.label}: poly's charge is the driver's`);
      assert.ok(t.turns.every((x) => Array.isArray(x.commands)), 'every turn logs its commands');
    }
    // the commands of the bash calls (a fused call's command too) and what the classifier said of them
    const ts = report.trials.filter((t) => t.task === 'snip-headtail' && t.pass === 1);
    for (const t of ts) {
      const first = t.turns.find((x) => x.stage === 0 && x.turn === 1);
      assert.deepEqual(first.commands, ['go test ./internal/filter -count 1']);
      assert.equal(first.runnerCall, true);
      assert.equal(first.fusable, t.config === 'full', `${t.label}: fused only when fusion is on`);
      assert.equal(first.fusedTool, t.config === 'full', 'and the fused tool is what the full agent called');
    }
    // the rates of the mechanisms, by configuration
    assert.equal(report.mechanisms.base.fusion.fired, 0);
    assert.equal(report.mechanisms.base.fusion.opportunities, 6, 'an edit then a command, three trials, two stages: opportunities exist without the mechanism');
    assert.equal(report.mechanisms.full.fusion.fired, 6);
    assert.equal(report.mechanisms.full.fusion.fusedToolUsed, 6);
    assert.ok(report.mechanisms.full.commands.length >= 6 && report.mechanisms.full.commands.every((c) => /^go test /.test(c)));
    // the floor is over the one task rerun, and the comparison is of the two configurations
    assert.equal(report.tasksWithBoth, 2);
    assert.equal(report.paired.verdict, 'INCONCLUSIVE', 'two pairs cannot reach alpha');
    assert.equal(report.paired.instance.noise.base.measured, true);
    assert.equal(report.paired.instance.noise.base.tasks, 1, 'the floor is over the tasks that were rerun');
    assert.equal(report.paired.instance.detectableGap, null, 'two pairs detect no gain at all: the verdict says so, as null, and not as a small number');
    // the money: the tally is the sum, the month and trial caps are in the report, and nothing near them was spent
    assert.equal(report.spentMicroUsd, report.trials.reduce((a, t) => a + t.driverMicroUsd, 0));
    assert.equal(report.totals.base.completed + report.totals.full.completed, 6);
    assert.ok(report.spentMicroUsd < 1_000_000);
    assert.deepEqual([report.trialCapMicro, report.monthCapMicro], [600000, 25000000]);
    assert.ok(existsSync(readdirSync(out).map((f) => join(out, f)).find((f) => f.endsWith('.sqlite'))), 'one store across the plan, which is where poly\'s month budget accumulates');
    // the key is in nothing written
    for (const f of readdirSync(out).filter((x) => !x.endsWith('.sqlite'))) assert.ok(!readFileSync(join(out, f), 'utf8').includes(CANARY_KEY), f);
    // --resume: the finished trials are counted and cost nothing, and no call is made
    const before = api.seen.length;
    const again = await runStaged({ models: MODELS, tables: TABLES, world: worldOf(), isolation: () => true, outDir: out, trials: plan, baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.equal(api.seen.length, before, 'a resumed plan with every trial finished calls nothing');
    assert.equal(again.trialsFinished, 6);
    assert.equal(again.spentMicroUsd, report.spentMicroUsd, 'what the finished trials cost is counted');
    assert.equal(again.stoppedBecause.reason, 'plan-complete');
  } finally {
    await api.close();
  }
});

test('the month\'s cap stops the plan before a trial that could take it past the cap, and the report says so; nothing is called after', { timeout: 3_000_000 }, async () => {
  const api = await fakeApi(serve);
  const out = join(OUT, 'month');
  try {
    // a trial may spend 0.30 USD and the month has 0.300001: the first trial starts, the second cannot
    const report = await runStaged({ models: MODELS, tables: TABLES, world: worldOf(), isolation: () => true, outDir: out, trials: smallPlan(), trialCapMicro: 300_000, monthCapMicro: 300_001, baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.equal(report.stoppedBecause.reason, 'month-cap');
    assert.equal(report.trialsFinished, 1);
    assert.equal(report.trialsPlanned, 6);
    assert.ok(report.spentMicroUsd + 300_000 > 300_001);
    const calls = api.seen.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.seen.length, calls, 'no call after the stop');
    assert.ok(existsSync(join(out, 'report.json')));
  } finally {
    await api.close();
  }
});

test('a failed isolation check stops the plan at once: the trial it guards is not started, and the report names it', { timeout: 3_000_000 }, async () => {
  const api = await fakeApi(serve);
  const out = join(OUT, 'isolation');
  let n = 0;
  const log = [];
  try {
    const report = await runStaged({ models: MODELS, tables: TABLES, world: worldOf(log), isolation: () => { n += 1; return n < 3; }, outDir: out, trials: smallPlan(), baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.deepEqual(report.stoppedBecause, { reason: 'isolation-check-failed', detail: `before trial 3 (${smallPlan()[2].label})` });
    assert.equal(report.trialsFinished, 2);
    assert.equal(n, 3);
    assert.equal(log.filter((l) => l.startsWith('prepare')).length, 2, 'no copy was made for the trial the failed check guards');
    const calls = api.seen.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.seen.length, calls);
  } finally {
    await api.close();
  }
});

test('an error stops the plan with its message (the key scrubbed), the trials finished before it are kept, and the report is written', { timeout: 3_000_000 }, async () => {
  const api = await fakeApi(serve);
  const out = join(OUT, 'error');
  let made = 0;
  const world = ({ task, run }) => {
    const w = worldOf()({ task, run });
    return { ...w, prepare: async () => { made += 1; if (made === 2) throw new Error(`the container is gone ${CANARY_KEY}`); return w.prepare(); } };
  };
  try {
    const report = await runStaged({ models: MODELS, tables: TABLES, world, isolation: () => true, outDir: out, trials: smallPlan(), baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.equal(report.stoppedBecause.reason, 'error');
    assert.match(report.stoppedBecause.detail, /the container is gone/);
    assert.equal(report.trialsFinished, 1);
    assert.ok(!JSON.stringify(report).includes(CANARY_KEY.slice(0, 20)) || !JSON.stringify(report).includes(CANARY_KEY), 'the key is not in the report');
  } finally {
    await api.close();
  }
});

test('the plan does not start on tables that do not pass the gate, and writes nothing', async () => {
  await assert.rejects(runStaged({ models: MODELS, tables: TABLES, world: worldOf(), isolation: () => true, outDir: join(OUT, 'gate'), pricesDir: join(ROOT, 'examples', 'harness', 'prices'), today: TODAY }), /do not pass the gate/);
  assert.ok(!existsSync(join(OUT, 'gate', 'report.json')));
});

test('the temporary files of this file are removed', () => {
  try {
    rmSync(OUT, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e; // the store of the last runtime may still be held by this process on Windows; the folder is ignored by git
  }
});
