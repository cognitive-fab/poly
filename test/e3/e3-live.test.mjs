// plan-e3.md E3.9, amendment A1: the live driver (host/live.mjs) against a local fake of the Anthropic API. The harness module is
// admitted and loaded as in the loop tests; the agent's answers come from a script served over HTTP on the loopback; the tools run
// in a scratch copy of a Go task on this host (the live run uses the container, which e3-tasks and ctl.mjs prove separately). No key
// of value, no model, no spend. What is shown: a stage of several turns ended by done, by the bound and by the budget, scored from
// the journal; the fused action and the done tool in the schema; the cheaper tier reading a log whose receipt is verified or
// rejected; a cut-off answer and its reprompt; a turn with no call; the wall-clock cap; and that poly's cost of each call is the
// driver's. Heavy: it admits the module once (shared). Run alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { CANARY_KEY, answer, fakeApi, toolUse } from './e3-fake-api.mjs';
import { sharedBuild } from './e3-loop-helpers.mjs';
import { loaded } from './e3-runtime-helpers.mjs';
import { createAnthropic } from '../../examples/harness/host/anthropic.mjs';
import { runLive } from '../../examples/harness/host/live.mjs';
import { ALL_OFF, ALL_ON } from '../../examples/harness/host/loop.mjs';
import { scoreRun } from '../../examples/harness/host/score.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { originalsUnchanged, prepare, scratchLinksOutside, taskOf } from '../../examples/harness/host/tasks.mjs';
import { reservation } from '../../examples/harness/host/cost-plan.mjs';

const TASK = taskOf('snip-headtail');
const EDITABLE = join(ROOT, 'examples', 'harness', 'editable');
const TMP = join(ROOT, '.poly', 'tmp', `live-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const PLACEHOLDER = JSON.parse(readFileSync(join(ROOT, 'examples', 'harness', 'prices', 'main.json'), 'utf8'));
const CHEAP = JSON.parse(readFileSync(join(ROOT, 'examples', 'harness', 'prices', 'cheap.json'), 'utf8'));
// the same tables as the module's, so that poly's charge and the driver's figure can be compared
const TABLES = { 'test-main': PLACEHOLDER, 'test-cheap': CHEAP };
const MODELS = { main: 'test-main', cheap: 'test-cheap' };
// the module's reservations, from its limits (50,000 and 4,000; 100,000 and 4,000; 100,000 and 2,000) at the table the module reads
const RESERVATIONS = { agent: reservation(PLACEHOLDER, 50000, 4000), summarise: reservation(CHEAP, 100000, 4000), read: reservation(CHEAP, 100000, 2000) };
const CAP = 600000;

const FILE = 'internal/filter/actions.go';
const fixOf = (k) => TASK.stages[k].edits[0];
const editCall = (k) => toolUse('edit', { path: FILE, old: fixOf(k).broken, new: fixOf(k).fixed });
const fusedCall = (k, cmd) => toolUse('edit_and_run', { path: FILE, old: fixOf(k).broken, new: fixOf(k).fixed, command: cmd });
const HEAD_TEST = 'go test ./internal/filter -run TestHead -count 1';
const TAIL_TEST = 'go test ./internal/filter -run TestTail -count 1';
const say = (blocks, stop = 'tool_use', usage = {}) => answer({ blocks, stop, usage: { input_tokens: 900, output_tokens: 120, ...usage } });

/** The fake API: the agent's calls (model test-main) are answered by `agent(n, request)` in order, the cheaper tier's by `cheap(request)`. */
function script(agent, cheap = () => answer({ blocks: [{ type: 'text', text: 'a summary of the work' }], stop: 'end_turn', usage: { input_tokens: 500, output_tokens: 60 } })) {
  let n = 0;
  return (entry) => {
    if (entry.body?.model === 'test-main') return agent(++n, entry);
    return cheap(entry);
  };
}

let runNo = 0;
async function live(name, agent, { mechanisms = ALL_ON, cheap, now, wallClockMs, onCap, trialCapMicro = CAP } = {}) {
  const a = await sharedBuild();
  const host = makeHost();
  const { copy } = prepare(TASK.id, `live-${name}-${process.pid}`);
  host.setWorld({ copy, task: TASK });
  const { rt } = await loaded(a, { transports: host.transports });
  const api = await fakeApi(script(agent, cheap));
  const logPath = join(TMP, `${name}-${++runNo}.jsonl`);
  const anthropic = createAnthropic({ baseUrl: api.url, getKey: () => CANARY_KEY, tables: TABLES, logPath, sleep: async () => {}, retries: 0 });
  const close = async () => { await rt.close(); await api.close(); };
  let result;
  let score;
  try {
    result = await runLive({ rt, host, task: TASK, models: MODELS, anthropic, editableDir: EDITABLE, mechanisms, trialCapMicro, reservations: RESERVATIONS, ...(now ? { now } : {}), ...(wallClockMs ? { wallClockMs } : {}), ...(onCap ? { onCap } : {}) });
    score = scoreRun(await rt.getJournal(result.ids.trial));
  } catch (e) {
    await close(); // a run that throws must not leave the runtime and the server open, or the test process never exits
    throw e;
  }
  return { rt, api, anthropic, host, result, score, copy, close, logPath };
}

const decisions = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'decision').map((e) => e.body);
const agentRequests = (api) => api.seen.filter((s) => s.body?.model === 'test-main');
const textOf = (req) => req.body.messages.map((m) => m.content.map((b) => b.text).join('')).join('\n');

test('A1 and E3.9: two stages of several turns each, ended by done, scored from the journal; the fused action and done are in the schema; poly\'s charge is the driver\'s', { timeout: 900_000 }, async () => {
  const L = await live('plan', (n) => ({
    1: say([toolUse('read', { path: FILE })]),
    2: say([fusedCall(0, HEAD_TEST)]),
    3: say([toolUse('done', { summary: 'head fixed' })]),
    4: say([fusedCall(1, TAIL_TEST)]),
    5: say([toolUse('done', { summary: 'tail fixed' })]),
  })[n]);
  try {
    const { result, score, api, rt } = L;
    assert.equal(result.trial.mode, 'Done');
    assert.equal(result.trial.why, 'PlanDone');
    assert.deepEqual(score.stages.map((s) => [s.state, s.turns, s.endedBy]), [['passed', 3, 'Done'], ['passed', 2, 'Done']], 'the turns of each stage and what ended it, from the journal');
    assert.equal(score.failingStage, null);
    assert.equal(agentRequests(api).length, 5);
    // the schema: the fused action and done are offered, with the system prompt and tools cached
    const first = agentRequests(api)[0].body;
    assert.deepEqual(first.tools.map((t) => t.name), ['read', 'search', 'edit', 'write', 'bash', 'edit_and_run', 'done']);
    assert.equal(first.system[0].cache_control.type, 'ephemeral');
    assert.equal(first.max_tokens, 4000, 'the decision\'s output limit is the request\'s');
    // the results of a turn reach the next turn through the transcript: the file read in turn 1 is in turn 2's request
    assert.match(textOf(agentRequests(api)[1]), /\[tool results, exit status 0\]/);
    assert.match(textOf(agentRequests(api)[1]), /func /);
    assert.match(textOf(agentRequests(api)[0]), /Stage 1 of 2: head reports how many lines it dropped/);
    assert.match(textOf(agentRequests(api)[3]), /Stage 2 of 2: tail keeps the last lines/);
    // the fused call was fused (an edit then a declared runner), and its result came back
    assert.equal(result.metrics.fusion.fired, 2);
    // the commands of every bash call are logged (a fused call\'s too), with what the classifier and the Reducer\'s condition said
    const fusedTurn = result.turns.find((x) => x.stage === 0 && x.turn === 2);
    assert.deepEqual(fusedTurn.commands, [HEAD_TEST]);
    assert.deepEqual([fusedTurn.plan, fusedTurn.fusable, fusedTurn.fusedTool, fusedTurn.runnerCall], ['Fusable', true, true, true]);
    const readTurn = result.turns.find((x) => x.stage === 0 && x.turn === 1);
    assert.deepEqual([readTurn.commands, readTurn.calls, readTurn.plan, readTurn.fusable, readTurn.runnerCall], [[], ['read'], 'Separate', false, false]);
    assert.ok(result.turns.every((x) => x.runId === 'snip-headtail' && Array.isArray(x.commands)));
    assert.equal((await rt.getState('turn:snip-headtail:0:1')).state.plan, 'Fusable');
    assert.equal((await rt.getState('turn:snip-headtail:0:0')).state.plan, 'Separate');
    // the copy holds the fixes and the originals are untouched
    assert.match(readFileSync(join(L.copy, FILE), 'utf8'), /remaining := len\(input\.Lines\) - n\b(?! - 1)/);
    assert.deepEqual(originalsUnchanged(), { 'todo-app': true, snip: true });
    assert.deepEqual(scratchLinksOutside(), []);
    // poly's charge of each agent call (its own, from the usage reported, under the table) equals the driver's figure
    let poly = 0;
    for (const t of result.turns.map((x, i) => `turn:snip-headtail:${x.stage}:${x.turn - 1}`)) for (const d of await decisions(rt, t)) poly += d.cost.units;
    assert.equal(poly, L.anthropic.totals.byKind.agent, 'poly and the driver price the same usage alike');
    assert.equal(L.anthropic.totals.calls, 5);
    // the log: a line per call, usage and cost, and no key anywhere in it
    const lines = readFileSync(L.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 5);
    assert.ok(lines.every((l) => l.kind === 'agent' && l.usage.input === 900 && l.microUsd > 0));
    assert.ok(!readFileSync(L.logPath, 'utf8').includes(CANARY_KEY));
    assert.ok(!JSON.stringify(api.seen.map((s) => s.raw)).includes(CANARY_KEY), 'the key is not in any body sent');
  } finally {
    await L.close();
  }
});

test('A1, HF3.13: an agent that never says done has the stage checked at its eighth turn, ended by the bound, and the trial goes on to the next stage', { timeout: 900_000 }, async () => {
  const L = await live('bound', (n) => (n <= 8 ? say([toolUse('read', { path: FILE })]) : n === 9 ? say([editCall(1), toolUse('done', {})]) : say([toolUse('done', {})])), { mechanisms: ALL_OFF });
  try {
    const { result, score, api } = L;
    assert.deepEqual(score.stages.map((s) => [s.state, s.turns, s.endedBy]), [['failed', 8, 'Bound'], ['passed', 1, 'Done']]);
    assert.equal(score.failingStage, 0);
    assert.equal(result.trial.mode, 'Done');
    assert.equal(result.trial.failedAt, 0, 'the failing stage is the first failed one, and the later stage is still scored');
    assert.equal(agentRequests(api).length, 9, 'the ninth turn is stage 1\'s first, not a ninth turn of stage 0');
    // the base configuration is not offered the fused action
    assert.deepEqual(agentRequests(api)[0].body.tools.map((t) => t.name), ['read', 'search', 'edit', 'write', 'bash', 'done']);
    assert.equal(result.metrics.fusion.fired, 0);
  } finally {
    await L.close();
  }
});

test('FINDING (PS18.4): "cap usd 0.60 per run" is per decision instance, that is per Turn, not per trial: 16 calls of 0.12 USD (1.92 USD) are all admitted', { timeout: 900_000 }, async () => {
  // each call is charged 0.12 USD at the module's table (20,000 input, 4,000 output). Under a per-trial cap of 0.60 the fifth would be
  // refused (0.48 spent, 0.21 reserved). The runtime refuses nothing: every Turn is its own run, with its own cap, which one Turn's
  // at most two calls cannot reach. Only the month's cap of the scope (25 USD) spans trials. A per-trial cap is therefore the host's
  // (see decisions-e3.md); this test fails the day the module binds the cap to the trial, and the plan is then to be read again.
  const L = await live('percap', () => say([toolUse('read', { path: FILE })], 'tool_use', { input_tokens: 20000, output_tokens: 4000 }), { mechanisms: ALL_OFF, trialCapMicro: Infinity });
  try {
    assert.equal(agentRequests(L.api).length, 16, 'two stages of eight turns, none refused');
    assert.ok(L.anthropic.totals.byKind.agent > 600000, `${L.anthropic.totals.byKind.agent} micro-USD spent in one trial, over the 600000 of the per-run cap`);
    assert.equal(L.result.trial.mode, 'Done');
    assert.deepEqual(L.score.stages.map((s) => [s.state, s.turns, s.endedBy]), [['failed', 8, 'Bound'], ['failed', 8, 'Bound']]);
  } finally {
    await L.close();
  }
});

test('A1, HF3.8: a window at its limit is compacted (HF3.1 allows it mid-stage) as often as the machine allows, each compaction adopted, and the stage goes on', { timeout: 900_000 }, async () => {
  // every call reports 45,000 input tokens, so the window is over the limit bucket after each turn; the cheaper tier's summary makes it small
  const L = await live('overflow', () => say([toolUse('read', { path: FILE })], 'tool_use', { input_tokens: 45000, output_tokens: 300 }), { mechanisms: ALL_OFF, trialCapMicro: Infinity });
  try {
    assert.equal(L.result.trial.mode, 'Done');
    assert.ok(L.result.compactions.length >= 3, `${L.result.compactions.length} compactions adopted`);
    assert.ok(L.result.compactions.every((c) => c.after < c.before), 'each one shrank the transcript');
    assert.equal(L.result.metrics.compaction.forced, L.result.compactions.length);
    assert.ok(L.api.seen.some((s) => s.body?.model === 'test-cheap'), 'the cheaper tier wrote the summaries');
    assert.deepEqual(L.score.stages.map((s) => s.endedBy), ['Bound', 'Bound']);
  } finally {
    await L.close();
  }
});

test('E3.9: the trial\'s cap is the host\'s: a call that would take the trial past 0.60 USD is refused, the open stage is checked once, and the trial ends with the reason Budget', { timeout: 900_000 }, async () => {
  // each call is charged 0.12 USD (20,000 input, 4,000 output) at the module's table, and an agent call reserves 0.21: four calls are
  // admitted (0.48 spent, 0.69 with the reservation is refused at the fifth), then the guard refuses and the machines take it as the budget
  const L = await live('trialcap', () => say([toolUse('read', { path: FILE })], 'tool_use', { input_tokens: 20000, output_tokens: 4000 }), { mechanisms: ALL_OFF });
  try {
    const { result, score, api } = L;
    assert.equal(agentRequests(api).length, 4, 'the fifth call was refused before any request was made');
    assert.equal(result.trial.mode, 'Stopped');
    assert.equal(result.trial.why, 'Budget');
    assert.deepEqual(score.stages.map((s) => [s.state, s.turns, s.endedBy]), [['failed', 4, 'Budget'], ['not-reached', null, null]]);
    assert.equal(score.failingStage, 0);
    assert.equal(result.llm.spentThisTrial, 480000);
    assert.ok(result.llm.spentThisTrial + RESERVATIONS.agent > CAP, 'and one more call would have passed the cap');
    // a trial that stays inside its cap is not touched by the guard
  } finally {
    await L.close();
  }
});

test('E3.9: the guard needs a cap and the reservations, and refuses to run without them', async () => {
  await assert.rejects(runLive({ rt: null, host: null, task: TASK, models: MODELS, anthropic: { totals: { microUsd: 0 } }, editableDir: EDITABLE, reservations: RESERVATIONS }), /needs the trial cap/);
  await assert.rejects(runLive({ rt: null, host: null, task: TASK, models: MODELS, anthropic: { totals: { microUsd: 0 } }, editableDir: EDITABLE, trialCapMicro: CAP }), /needs the reservation of each kind/);
});

test('A1: a persistent API failure is a failed call: the machines take it as the end of the budget and the trial ends the same way', { timeout: 900_000 }, async () => {
  const L = await live('apifail', (n) => (n === 1 ? say([toolUse('read', { path: FILE })]) : { status: 500, body: { error: { message: 'down' } } }), { mechanisms: ALL_OFF });
  try {
    assert.equal(L.result.trial.why, 'Budget');
    assert.deepEqual(L.score.stages.map((s) => [s.state, s.turns, s.endedBy]), [['failed', 1, 'Budget'], ['not-reached', null, null]]);
    assert.ok(!readFileSync(L.logPath, 'utf8').includes(CANARY_KEY));
  } finally {
    await L.close();
  }
});

test('A1, HF3.7: an answer cut off at the output limit is answered by one reprompt, and the tool runs on the second answer only', { timeout: 900_000 }, async () => {
  const L = await live('cutoff', (n) => ({
    1: answer({ blocks: [{ type: 'tool_use', id: 'tu_x', name: 'edit', input: {} }], stop: 'max_tokens', usage: { input_tokens: 900, output_tokens: 4000 } }),
    2: say([editCall(0), toolUse('done', {})]),
    3: say([editCall(1), toolUse('done', {})]),
  })[n], { mechanisms: ALL_OFF });
  try {
    assert.deepEqual(L.score.stages.map((s) => [s.state, s.turns]), [['passed', 1], ['passed', 1]]);
    assert.equal((await L.rt.getState('turn:snip-headtail:0:0')).state.reprompts, 1);
    assert.equal(agentRequests(L.api).length, 3, 'the cut-off turn asked twice');
    assert.deepEqual((await decisions(L.rt, 'turn:snip-headtail:0:0')).length, 2);
  } finally {
    await L.close();
  }
});

test('A1: a turn with no tool call is told to call a tool or done, and the stage goes on', { timeout: 900_000 }, async () => {
  const L = await live('notool', (n) => ({
    1: answer({ blocks: [{ type: 'text', text: 'Let me think about this.' }], stop: 'end_turn' }),
    2: say([editCall(0), toolUse('done', {})]),
    3: say([editCall(1), toolUse('done', {})]),
  })[n], { mechanisms: ALL_OFF });
  try {
    assert.deepEqual(L.score.stages.map((s) => [s.state, s.turns]), [['passed', 2], ['passed', 1]]);
    assert.match(textOf(agentRequests(L.api)[1]), /You made no tool call\. Make the tool calls the stage needs, or call done/);
  } finally {
    await L.close();
  }
});

/** A cheaper-tier answer that reads the output of the request and writes a receipt for it: right quotes, or a quote that is not in the log. */
const readerOf = (honest) => (entry) => {
  const text = entry.body.messages.map((m) => m.content.map((b) => b.text).join('')).join('\n');
  if (!text.includes('sourceHash: sha256:')) return answer({ blocks: [{ type: 'text', text: 'a summary of the work' }], stop: 'end_turn', usage: { input_tokens: 500, output_tokens: 60 } });
  const hash = /sourceHash: (sha256:[0-9a-f]{64})/.exec(text)[1];
  const status = /status: (pass|fail)/.exec(text)[1];
  const log = text.slice(text.indexOf('Output:\n') + 8);
  const lines = log.split('\n').filter((l) => l.trim().length > 12);
  const quotes = honest ? [lines[0], lines[lines.length - 1]] : [lines[0], 'a line that the command never wrote'];
  return answer({ blocks: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify({ sourceHash: hash, status, quotes })}\n\`\`\`` }], stop: 'end_turn', usage: { input_tokens: 2400, output_tokens: 90 } });
};

test('E3.9, HF3.2: a long log of a declared runner is read by the cheaper tier; a receipt with true quotes is shown, and one with a quote not in the log is rejected and the original is shown', { timeout: 900_000 }, async () => {
  for (const [name, honest] of [['verified', true], ['rejected', false]]) {
    const L = await live(`receipt-${name}`, (n) => ({
      1: say([toolUse('bash', { command: 'go test ./internal/filter -v -count 1' })]),
      2: say([toolUse('done', {})]),
      3: say([toolUse('done', {})]),
    })[n], { mechanisms: ALL_ON, cheap: readerOf(honest) });
    try {
      assert.equal(L.result.metrics.reducer.opportunities, 1, 'the verbose test log is over the reader\'s threshold');
      assert.equal(L.result.metrics.reducer.receipts, 1);
      assert.equal(L.result.metrics.reducer.verified, honest ? 1 : 0);
      assert.equal(L.result.metrics.reducer.rejected, honest ? 0 : 1);
      const second = textOf(agentRequests(L.api)[1]);
      if (honest) assert.match(second, /\[verified receipt of a log of \d+ bytes, status (pass|fail)\]/);
      else {
        assert.doesNotMatch(second, /verified receipt/);
        assert.match(second, /=== RUN/, 'the original log is what the agent saw');
      }
      assert.equal(L.api.seen.filter((s) => s.body?.model === 'test-cheap').length >= 1, true);
    } finally {
      await L.close();
    }
  }
});

test('E3.9, HF3.9: the wall-clock cap ends the trial between turns, with the work saved first and the reason Cap', { timeout: 900_000 }, async () => {
  let clock = 0;
  let saved = 0;
  const L = await live('cap', () => say([toolUse('read', { path: FILE })]), { mechanisms: ALL_OFF, now: () => (clock += 400_000), wallClockMs: 900_000, onCap: async () => { saved += 1; } });
  try {
    assert.equal(L.result.trial.mode, 'Stopped');
    assert.equal(L.result.trial.why, 'Cap');
    assert.equal(L.result.trial.saved, true, 'the work was saved before the trial was closed');
    assert.equal(saved, 1);
    assert.ok(agentRequests(L.api).length >= 1 && agentRequests(L.api).length <= 3);
  } finally {
    await L.close();
  }
});

test('the temporary files of this file are removed', () => {
  rmSync(TMP, { recursive: true, force: true });
});
