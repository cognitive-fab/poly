// M11 step 6 (AC25, PS18.2, S351, S353, S356): a routed decision at run time. The decision's intent starts its route; each
// tier's call is an intent of its own through the gate, answered by a recorded provider; a low-confidence answer
// escalates to the next tier; a route ends Answered or Exhausted, and the decision completes with the answering tier's
// answer or fails with route-exhausted. No test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedProvider, RefusedDispatch } from '@poly/runtime';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk, answer } from './routing-helpers.mjs';

const a = await admittedDesk('routing-runtime');
const TEXT = { text: 'where is my refund' };

/** Each tier answers as recorded: `small` and `large` are the recorded calls of each provider. */
function providers(rt, small, large) {
  const flash = recordedProvider(small.map((c) => ({ match: { tier: 'small' }, ...c })));
  const opus = recordedProvider(large.map((c) => ({ match: { tier: 'large' }, ...c })));
  rt.provideTier('flash', flash);
  rt.provideTier('opus', opus);
  return { flash, opus };
}
async function classify(rt, id) {
  await rt.create('desk.Ticket', { id });
  await rt.dispatch(id, 'Received', TEXT);
  for (let i = 0; i < 6; i++) await rt.worker.tick();
}
const routeOf = (rt, id) => rt.store.db.prepare('SELECT instance FROM poly_route WHERE run = ?').get(id).instance;
const steps = async (rt, run) => (await rt.chain(run)).filter((e) => e.kind === 'step' && e.body.action !== '$create').map((e) => e.body.action);

test('AC25: a low-confidence answer from the small tier escalates to the large one, which answers', async () => {
  const { rt } = await loaded(a);
  try {
    // 0.6 is 400 on the small tier's map, below 0.8; 0.96 is 940 on the large tier's, with a margin of 940.
    const { flash, opus } = providers(rt, [answer('Refund', 0.6)], [answer('Refund', 0.96)]);
    await classify(rt, 't-1');
    assert.equal((await rt.getState('t-1')).state.status, 'Routed');
    assert.deepEqual([flash.asked.length, opus.asked.length], [1, 1]);
    // The provider is given the decision's question and the tier's token limit (K15), never a model's name.
    assert.deepEqual(flash.asked[0].limits, { maxTokens: 4000 });
    assert.deepEqual(flash.asked[0].payload, TEXT);
    const route = routeOf(rt, 't-1');
    assert.deepEqual(await steps(rt, route), ['Start', 'Answer', 'Answer']);
    assert.equal((await rt.getState(route)).state.r, 'Answered');
    assert.equal((await rt.getState(route)).state.tier, 1);
    // Each tier's call is its own intent, allowed by the gate and journaled on the route's run.
    const verdicts = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'gate' && e.body.outcome === 'allowed');
    assert.equal(verdicts.length, 2);
    assert.deepEqual(verdicts.map((v) => v.body.effectKind), ['route.triage.call', 'route.triage.call']);
    // Each answered call has its decision event, with its tier, model, usage, cost and reservation (PS18.6).
    const calls = (await rt.chain(route)).filter((e) => e.kind === 'decision').map((e) => e.body);
    assert.deepEqual(calls.map((c) => [c.tier, c.model.id, c.conf, c.reservation]), [['small', 'flash-2026-09', 400, 1600], ['large', 'opus-2026-08', 940, 120_000]]);
    // 1000 input and 200 output tokens: 100 + 80 micro-units on the small tier, 3000 + 3000 on the large one.
    assert.deepEqual(calls.map((c) => c.cost), [{ units: 180, unit: 'micro-usd' }, { units: 6000, unit: 'micro-usd' }]);
    // The decision's own event repeats the answering tier's and links it; its completion carries that answer.
    const own = (await rt.chain('t-1')).filter((e) => e.kind === 'decision').map((e) => e.body);
    assert.equal(own.length, 1);
    assert.deepEqual([own[0].tier, own[0].answer, own[0].conf], ['large', 'Refund', 940]);
    assert.equal(own[0].via, (await rt.chain(route)).filter((e) => e.kind === 'decision')[1].hash);
    assert.deepEqual(await rt.verifyProvenance('t-1'), []);
  } finally { await rt.close(); }
});

test('AC25: an answer that meets the thresholds on the small tier is taken there, and the large tier is never called', async () => {
  const { rt } = await loaded(a);
  try {
    const { flash, opus } = providers(rt, [answer('Status', 0.96)], [answer('Status', 0.99)]);
    await classify(rt, 't-2');
    assert.equal((await rt.getState('t-2')).state.status, 'Routed');
    assert.deepEqual([flash.asked.length, opus.asked.length], [1, 0]);
    assert.deepEqual(await steps(rt, routeOf(rt, 't-2')), ['Start', 'Answer']);
  } finally { await rt.close(); }
});

test('AC25: a failed call escalates, since the route names failed', async () => {
  const { rt } = await loaded(a);
  try {
    providers(rt, [{ fail: 'provider unavailable' }], [answer('Refund', 0.96)]);
    await classify(rt, 't-3');
    assert.equal((await rt.getState('t-3')).state.status, 'Routed');
    assert.deepEqual(await steps(rt, routeOf(rt, 't-3')), ['Start', 'Fail', 'Answer']);
  } finally { await rt.close(); }
});

test('AC25: a route whose last tier is below the thresholds is exhausted, and the decision fails with route-exhausted', async () => {
  const { rt } = await loaded(a);
  try {
    providers(rt, [answer('Refund', 0.6)], [answer('Refund', 0.6)]);
    await classify(rt, 't-4');
    assert.equal((await rt.getState('t-4')).state.status, 'NeedsHuman');
    assert.equal((await rt.getState(routeOf(rt, 't-4'))).state.r, 'Exhausted');
    const failed = (await rt.chain('t-4')).find((e) => e.kind === 'observation' && e.body.stage === 'handler' && e.body.outcome === 'permanent');
    assert.ok(failed);
    const row = rt.store.db.prepare("SELECT last_error FROM pr_outbox WHERE instance_id = 't-4' AND kind = 'decision.classify'").get();
    assert.match(row.last_error, /route-exhausted/);
    // No decision event: the decision has no answer, and its failure completion is no decision completion (PD2.2d).
    assert.equal((await rt.chain('t-4')).filter((e) => e.kind === 'decision').length, 0);
    assert.deepEqual(await rt.verifyProvenance('t-4'), []);
  } finally { await rt.close(); }
});

test('PS18.4, S356: a route\'s and a budget\'s instances are the runtime\'s, and a tier is served only by its provider', async () => {
  const { rt } = await loaded(a);
  try {
    providers(rt, [answer('Refund', 0.96)], []);
    await classify(rt, 't-5');
    const route = routeOf(rt, 't-5');
    await assert.rejects(rt.dispatch(route, 'Start', {}), (e) => e instanceof RefusedDispatch && e.rule === 'PS18.4');
    const budget = rt.store.db.prepare("SELECT budget FROM poly_reservation LIMIT 1").get().budget;
    await assert.rejects(rt.dispatch(budget, 'Release', { r: 1 }), (e) => e instanceof RefusedDispatch && e.rule === 'PS18.4');
    await assert.rejects(rt.create('desk.support.Budget', { id: 'budget:mine' }), (e) => e instanceof RefusedDispatch && e.rule === 'PS18.4');
    assert.throws(() => rt.handle('route.triage.call', () => ({})), /rt.provideTier/);
    assert.throws(() => rt.provide('classify', { provider: () => answer('Refund', 1), model: 'any' }), /rt.provideTier/);
    assert.throws(() => rt.provideTier('gpt', () => answer('Refund', 1)), /no tier/);
  } finally { await rt.close(); }
});

test('S356: with no provider registered for a tier, its call fails and the route goes on', async () => {
  const { rt } = await loaded(a);
  try {
    rt.provideTier('opus', recordedProvider([{ answer: 'Other', distribution: [['Other', 0.96]], usage: { input: 10 } }]));
    await classify(rt, 't-6');
    assert.equal((await rt.getState('t-6')).state.status, 'Routed');
    assert.deepEqual(await steps(rt, routeOf(rt, 't-6')), ['Start', 'Fail', 'Answer']);
  } finally { await rt.close(); }
});

test('PT25.1, S353: a policy of the route\'s scope reads a call\'s route and tier, after the budget check', { timeout: 300_000 }, async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { FIX } = await import('./routing-helpers.mjs');
  const p = await admittedDesk('routing-policy', undefined, { 'tiers.policy.poly': readFileSync(join(FIX, 'tiers.policy.poly'), 'utf8') });
  const { rt } = await loaded(p);
  try {
    const { opus } = providers(rt, [answer('Refund', 0.6)], [answer('Refund', 0.96)]);
    await classify(rt, 'p-1');
    assert.equal((await rt.getState('p-1')).state.status, 'NeedsHuman');
    assert.equal(opus.asked.length, 0);
    const verdicts = (await rt.chain(routeOf(rt, 'p-1'))).filter((e) => e.kind === 'verdict' && e.body.stage === 'gate' && e.body.outcome !== 'settled');
    assert.deepEqual(verdicts.map((v) => v.body.outcome), ['allowed', 'denied']);
    // The proposal carried the call's route and budget (PT25.1).
    const proposal = await rt.store.body(verdicts[1].body.proposal);
    assert.deepEqual([proposal.route, proposal.budget.budget], [{ route: 'triage', tier: 'large', reservation: 120_000 }, 'support']);
  } finally { await rt.close(); }
});
