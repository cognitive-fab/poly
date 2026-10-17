// S456 (PS15.5, PT "The application's completions (S456)", ruled 2026-10-08, built after decisions-v1.md "S456, S457,
// the S454 embedded form and the one-value rule"): a channel's generated configuration also offers the completions of
// the application's pending decisions and effects, each only while its intent is pending. A step of a completion takes
// one pending intent of its kind off, whatever its verdict; more than 3 pending intents of one kind is PL3901, and a
// declared configuration offers a completion only as a declared input (S61). With S456, the PL6838 fix (PS17.3, S322
// as amended): a channel's generated configuration holds the conversation its application spawns, so a channel
// application that replies tainted content is not PL6838 for that reply.
//
// Written from the specification text alone. The fixtures (test/fixtures/channel-completions) are kept small: one
// thread, one inbound message, and a channel kind of the tests' own whose one rule is tested only when the application
// replies. Each check of them takes about a second; only the M8 concierge's count check takes minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkFile, resolveUses } from '@poly/check';
import { checkConfiguration } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'channel-completions');
const STD = join(FIX, 'std');
const AGENT = readFileSync(join(FIX, 'agent.poly'), 'utf8');
const FLOW = readFileSync(join(FIX, 'flow.poly'), 'utf8');
const DECLARED = readFileSync(join(FIX, 'declared.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-channel-completions');
const RULE = 'free-when-closed';
// The completions the decision answer names: its ok and its failed (PS15.5).
const COMPLETIONS = new Set(['Answered', 'AnswerFailed']);

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const codes = (r) => all(r).map((d) => d.code);
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))} ${JSON.stringify((r.configurations ?? []).map((c) => [c.configuration, c.verdict, c.vacuous]))}`;
const ruleVacuous = (c) => (c.vacuous ?? []).some((v) => v.property.endsWith(RULE));

let n = 0;
async function check(src, opts = { std: STD }) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return checkFile(join(d, 'm.poly'), { root: d, ...opts });
}
/** poly-ref's exploration of one configuration of a source, with the tests' channel kind (PS15.0). */
function explore(src, name, std = STD) {
  const d = join(OUT, `ref-${n++}`);
  mkdirSync(d, { recursive: true });
  const file = join(d, 'm.poly');
  writeFileSync(file, src);
  const mod = parse(src).module;
  assert.ok(mod, 'parses');
  return checkConfiguration(mod, name, { program: resolveUses(mod, file, undefined, std).program });
}
const support = (r) => r.configurations.find((c) => c.configuration === 'support');

// The variants. An effect with ok and failed completions in place of the decision (PS15.5: "an effect's ok and
// failed"); its ok carries the handler's result as fetch.poly's does (conformance/m8/content).
const DECISION_BLOCK = AGENT.slice(AGENT.indexOf('  decision answer('), AGENT.lastIndexOf('}'));
const WITH_EFFECT = swap(swap(AGENT, '    decide answer(question: body)\n', '    emit ask(question: body)\n'), DECISION_BLOCK,
  '  effect ask(question: Content) {\n    kind "cc.ask"\n    labels { egress:external }\n    class reversible\n    ok(r) -> Answered(answer: r.body)\n    failed -> AnswerFailed()\n  }\n');
// The seeded control: Got decides nothing, so no intent is ever pending and no completion is offered.
const SILENT = swap(AGENT, '    decide answer(question: body)\n', '');
// k intents of one effect kind emitted by one step, beside the decision that leads to the reply. Each completion
// handler writes pinged, since a handler that can complete with no write is PL2201 (PT4.4).
const pings = (k) => swap(swap(swap(swap(AGENT, '    decide answer(question: body)\n', `${'    emit ping()\n'.repeat(k)}    decide answer(question: body)\n`),
  '    phase   : Phase = Idle\n', '    phase   : Phase = Idle\n    pinged  : bool  = false\n'),
  '  action Delivered()\n', '  action Pinged()\n  action PingFailed()\n  action Delivered()\n'),
  '  on Delivered {', '  on Pinged {\n    require started else reject "not-started"\n    pinged\' = true\n  }\n  on PingFailed {\n    require started else reject "not-started"\n    pinged\' = true\n  }\n  effect ping() {\n    kind "cc.ping"\n    labels { egress:external }\n    class reversible\n    ok -> Pinged()\n    failed -> PingFailed()\n  }\n  on Delivered {');

// ── 1. the completions make the reply, and the rule is tested ──

test('S456, PS15.5, PS5.2a: an application that replies from its decision\'s ok completion replies in the channel\'s configuration, so the conversation\'s free-when-closed is tested, not vacuous', { timeout: 120_000 }, async () => {
  const r = await check(AGENT);
  assert.ok(!r.error, text(r));
  const c = support(r);
  assert.ok(c, text(r));
  assert.ok(!ruleVacuous(c), `the decision's completion is offered while its intent is pending, so the application replies: ${text(r)}`);
  // The rule holds (Reply sends only from an open window) and is now tested, so nothing keeps the verdict from CLEAN.
  assert.deepEqual((c.nevers ?? []).filter((x) => x.property.endsWith(RULE)).map((x) => x.violated), [false], text(r));
  assert.equal(c.verdict, 'CLEAN', text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S456, PS15.5: the same with an effect whose ok completion replies: its ok and failed are offered while its intent is pending, and the rule is tested', { timeout: 120_000 }, async () => {
  const r = await check(WITH_EFFECT);
  assert.ok(!r.error, text(r));
  const c = support(r);
  assert.ok(c, text(r));
  assert.ok(!ruleVacuous(c), text(r));
  assert.equal(c.verdict, 'CLEAN', text(r));
});

// ── 2. the seeded control ──

test('S456, seeded control: an application that decides nothing never replies, and free-when-closed stays untested (vacuous), INCONCLUSIVE', { timeout: 120_000 }, async () => {
  const r = await check(SILENT);
  assert.ok(!r.error, text(r));
  const c = support(r);
  assert.ok(ruleVacuous(c), `nothing is pending, so no completion is offered and no reply is made: ${text(r)}`);
  assert.equal(c.verdict, 'INCONCLUSIVE', text(r));
  // The exploration agrees: no completion is offered, and no Reply reaches the conversation.
  const g = explore(SILENT, 'support');
  assert.ok(!g.graph.edges.some((e) => COMPLETIONS.has(e.label.action)), 'a completion of a kind with no pending intent is not offered');
  assert.ok(!g.graph.edges.some((e) => e.label.action === 'Reply'), 'the application never replies');
});

// ── 3. offered only while pending, at most once per intent ──

test('S456, PS15.5: a completion is offered only while its intent is pending, never from the initial state, and at most once per intent', { timeout: 120_000 }, () => {
  const r = explore(AGENT, 'support');
  const app = r.instances.findIndex((i) => i.name === 'app');
  assert.ok(app >= 0, JSON.stringify(r.instances.map((i) => i.name)));
  const { states, edges } = r.graph;
  const completion = (e) => e.label.instance === app && COMPLETIONS.has(e.label.action);
  // An intent of the decision answer, of kind decision.answer (PT), emitted by an accepted step of app.
  const emitted = (e) => (e.label.instance === app && e.label.verdict.kind === 'accepted' ? e.label.effects.filter((x) => x.type === 'effect' && x.kind === 'decision.answer').length : 0);
  assert.ok(edges.some(completion), 'the decision\'s completions are offered in the channel\'s configuration');
  assert.ok(edges.some((e) => e.label.action === 'Reply' && e.label.verdict.kind === 'accepted'), 'the application replies');
  assert.ok(!edges.some((e) => completion(e) && e.from === 0), 'no completion from the initial state, where nothing is pending');
  // Each state's number of pending intents of answer (emitted minus completed) on every path to it: never negative, so
  // no completion arrives without an intent in flight, and a completion takes one off whatever its verdict.
  const pending = states.map(() => new Set());
  pending[0].add(0);
  const work = [0];
  while (work.length) {
    const s = work.pop();
    for (const k of r.graph.out[s]) {
      const e = edges[k];
      if (e.to === null) continue;
      for (const p of pending[s]) {
        const q = p + emitted(e) - (completion(e) ? 1 : 0);
        assert.ok(q >= 0, `a completion ${e.label.action} (${e.label.verdict.kind}) taken with no pending intent, from state ${s}: ${JSON.stringify(states[s])}`);
        if (!pending[e.to].has(q)) { pending[e.to].add(q); work.push(e.to); }
      }
    }
  }
  // At most one intent of answer is ever emitted on a path (Got leaves Idle for good), so once it is completed no second
  // completion is offered: a state whose only pending count is 0 has no completion edge.
  for (let s = 0; s < states.length; s++) {
    if ([...pending[s]].every((p) => p === 0)) {
      assert.ok(!r.graph.out[s].some((k) => completion(edges[k])), `a completion offered with no pending intent at state ${s}: ${JSON.stringify(states[s])}`);
    }
  }
});

// ── 4. the bound ──

test('S456, PS15.5: a step that would hold more than 3 pending intents of one kind is PL3901 and the configuration is INCONCLUSIVE; 3 is within the bound', { timeout: 180_000 }, async () => {
  const four = await check(pings(4));
  assert.ok(!four.error, text(four));
  const c4 = support(four);
  assert.ok(c4.diagnostics.some((d) => d.code === 'PL3901'), `four pending intents of cc.ping: ${text(four)}`);
  assert.equal(c4.verdict, 'INCONCLUSIVE', text(four));
  assert.notEqual(four.verdict, 'CLEAN', text(four));
  const three = await check(pings(3));
  assert.ok(!three.error, text(three));
  assert.ok(!support(three).diagnostics.some((d) => d.code === 'PL3901'), text(three));
});

// ── 5. a declared configuration is unchanged ──

test('S456, S61: a declared configuration offers a completion only as a declared input', { timeout: 120_000 }, () => {
  const r = explore(DECLARED, 'c');
  const asks = r.graph.edges.filter((e) => e.label.action === 'Ask' && e.label.verdict.kind === 'accepted');
  assert.ok(asks.length > 0 && asks.every((e) => e.label.effects.some((x) => x.kind === 'decision.answer')), 'Ask emits its intent');
  assert.ok(!r.graph.edges.some((e) => COMPLETIONS.has(e.label.action)), 'no completion is offered though an intent is pending');
  // Declared as an input, Answered is offered as any input is, from the initial state too, where nothing is pending.
  const d = explore(swap(DECLARED, 'inputs { a.Ask }', 'inputs { a.Ask, a.Answered }'), 'c');
  assert.ok(d.graph.edges.some((e) => e.label.action === 'Answered' && e.from === 0), 'a declared input is offered whatever is pending');
  assert.ok(!d.graph.edges.some((e) => e.label.action === 'AnswerFailed'), 'an undeclared completion is still not offered');
});

// ── 6. the PL6838 fix ──

test('S456, PS17.3, S322 as amended: a channel application that replies a decision\'s answer over a retrieval is not PL6838, since the channel\'s configuration holds its conversation', { timeout: 180_000 }, async () => {
  const r = await check(FLOW);
  assert.ok(!r.error, text(r));
  assert.ok(!codes(r).includes('PL6838'), `the reply to the spawned conversation is followed: ${text(r)}`);
  // The recipient's class is the channel's, customer, and the source's taint is (customer, {}): the reply may go.
  assert.ok(!codes(r).includes('PL6831'), text(r));
  // The configuration explored the reply with its taints: the retrieval's and the decision's completions are offered.
  assert.ok(!ruleVacuous(support(r)), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S322, control: a tainted message to a machine that no configuration holds is still PL6838, INCONCLUSIVE', { timeout: 180_000 }, async () => {
  const r = await check(readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'review-message.poly'), 'utf8'), {});
  const d = all(r).find((x) => x.code === 'PL6838');
  assert.ok(d, text(r));
  assert.match(d.message, /Forward/);
  assert.equal(r.verdict, 'INCONCLUSIVE', text(r));
});

// ── 7. the M8 concierge's counts ──

// The concierge's applications decide nothing and emit no effect with a completion: each only replies (emit c.reply).
// So S456 adds nothing to their configurations, and each keeps the global state and transition counts recorded in
// docs/v1/verdicts-after-rulings.json (support 14,482, text 14,483, staff 24,452 global states).
test('S456: the M8 concierge\'s generated configurations keep their recorded global state and transition counts', { timeout: 1_200_000 }, async () => {
  const recorded = JSON.parse(readFileSync(join(ROOT, 'docs', 'v1', 'verdicts-after-rulings.json'), 'utf8')).files['conformance/m8/concierge/concierge.poly'];
  assert.ok(recorded?.configurations, 'the counts are recorded');
  const src = readFileSync(join(ROOT, 'conformance', 'm8', 'concierge', 'concierge.poly'), 'utf8');
  assert.ok(!/\bdecide\b|\beffect\b/.test(src), 'the concierge decides nothing and declares no effect');
  const r = await check(src, {});
  assert.equal(r.verdict, recorded.verdict, text(r));
  const got = Object.fromEntries(r.configurations.map((c) => [c.configuration, { verdict: c.verdict, states: c.instance?.states, transitions: c.instance?.transitions }]));
  assert.deepEqual(got, recorded.configurations);
});
