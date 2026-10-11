// A record result completes with a conf and a margin for each field (PD1.2b, PT28.3a, ruled 2026-10-10).
// The runtime calculates these from the provider's distribution: for each field, the probability of a value
// is the sum of the probabilities of answers holding it. conf.f is the calibrated probability of the returned
// value; margin.f is that minus the highest probability of any other value, floored at 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkFile, render } from '@poly/check';
import { admitted, loaded } from './runtime-helpers.mjs';

const FIXTURE = 'test/fixtures/field-conf/record-decision.poly';

/**
 * A recorded provider (PD3): it gives an answer and a distribution over whole answers, and no conf or margin. The runtime
 * computes those (PD1.2b, PT10k), so a test that sets them in the provider would test the provider.
 */
function provider(distribution, answer) {
  return () => ({ answer, distribution, reported: 'test-2026-10', latencyMs: 2 });
}

/** Fixture admission, lazily memoized. */
let fixtureAdmitted = null;
async function admitFixture() {
  if (!fixtureAdmitted) {
    fixtureAdmitted = await admitted('field-conf', [FIXTURE]);
  }
  return fixtureAdmitted;
}

test('The fixture checks CLEAN', async () => {
  const a = await admitFixture();
  const f = join(a.dir, 'src', 'record-decision.poly');
  const r = await checkFile(f, { root: a.dir });
  assert.equal(r.verdict, 'CLEAN', render(r));
});

test('PD1.2b, PT28.3a case 1: answer {branch:A, value:2}; distribution lists three answers with known probabilities', async () => {
  const a = await admitFixture();
  const { rt } = await loaded(a);
  try {
    // Distribution: [[{branch:A, value:2}, 0.5], [{branch:A, value:3}, 0.3], [{branch:B, value:2}, 0.2]]
    // Field probabilities: branch A = 0.8, B = 0.2; value 2 = 0.7, value 3 = 0.3
    // Answer {branch:A, value:2}: conf.branch = 800, margin.branch = 600; conf.value = 700, margin.value = 400
    const distribution = [
      [{ branch: 'A', value: 2 }, 0.5],
      [{ branch: 'A', value: 3 }, 0.3],
      [{ branch: 'B', value: 2 }, 0.2],
    ];
    const answer = { branch: 'A', value: 2 };
    rt.provide('classify', { provider: provider(distribution, answer), model: 'test' });
    await rt.create('classify.Classifier', { id: 'c1' });
    await rt.dispatch('c1', 'Ask', {});
    for (let i = 0; i < 10; i++) await rt.worker.tick();
    const state = (await rt.getState('c1')).state;
    const journal = (await rt.getJournal('c1'));
    const outbox = await rt.outbox('c1');
    assert.equal(state.phase, 'Done', `the step was accepted; phase is ${state.phase}; outbox: ${outbox.map((e) => `${e.kind}:${e.status}`).join(',')}`);
    const classified = journal.find((j) => j.action === 'Classified');
    assert.ok(classified, 'Classified action was dispatched');
    const data = typeof classified.data === 'string' ? JSON.parse(classified.data) : classified.data;
    assert.equal(data.confBranch, 800, 'conf.branch = 800');
    assert.equal(data.margBranch, 600, 'margin.branch = 600');
    assert.equal(data.confValue, 700, 'conf.value = 700');
    assert.equal(data.margValue, 400, 'margin.value = 400');
    assert.ok(!journal.some((j) => j.action === 'ClassifyFailed'), 'no ClassifyFailed');
    const chain = await rt.chain('c1');
    const decisionEvent = chain.find((e) => e.kind === 'decision');
    assert.ok(decisionEvent, 'decision event exists');
    assert.deepEqual(decisionEvent.body.conf, { branch: 800, value: 700 }, 'decision event conf is a record');
    assert.deepEqual(decisionEvent.body.margin, { branch: 600, value: 400 }, 'decision event margin is a record');
  } finally {
    await rt.close();
  }
});

test('PD1.2b case 2: answer {branch:B, value:3}; a less likely value of each field', async () => {
  const a = await admitFixture();
  const { rt } = await loaded(a);
  try {
    // Same distribution: branch B = 0.2, value 3 = 0.3
    // Answer {branch:B, value:3}: conf.branch = 200, margin.branch = 0 (floored); conf.value = 300, margin.value = 0
    const distribution = [
      [{ branch: 'A', value: 2 }, 0.5],
      [{ branch: 'A', value: 3 }, 0.3],
      [{ branch: 'B', value: 2 }, 0.2],
    ];
    const answer = { branch: 'B', value: 3 };
    rt.provide('classify', { provider: provider(distribution, answer), model: 'test' });
    await rt.create('classify.Classifier', { id: 'c2' });
    await rt.dispatch('c2', 'Ask', {});
    for (let i = 0; i < 10; i++) await rt.worker.tick();
    const state = (await rt.getState('c2')).state;
    assert.equal(state.phase, 'Done', `the step was accepted; phase is ${state.phase}`);
    const journal = (await rt.getJournal('c2'));
    const classified = journal.find((j) => j.action === 'Classified');
    const data = typeof classified.data === 'string' ? JSON.parse(classified.data) : classified.data;
    assert.equal(data.confBranch, 200, 'conf.branch = 200 (B probability)');
    assert.equal(data.margBranch, 0, 'margin.branch = 0 (floored: 0.2 - 0.8 < 0)');
    assert.equal(data.confValue, 300, 'conf.value = 300 (value 3 probability)');
    assert.equal(data.margValue, 0, 'margin.value = 0 (floored: 0.3 - 0.7 < 0)');
    assert.ok(!journal.some((j) => j.action === 'ClassifyFailed'), 'no ClassifyFailed');
  } finally {
    await rt.close();
  }
});

test('PT28.3a case 3: answer {branch:A, value:4}; a value not in the distribution for that field', async () => {
  const a = await admitFixture();
  const { rt } = await loaded(a);
  try {
    // Distribution has only value 2 and 3; answer returns value 4, so conf.value = 0
    const distribution = [
      [{ branch: 'A', value: 2 }, 0.5],
      [{ branch: 'A', value: 3 }, 0.3],
      [{ branch: 'B', value: 2 }, 0.2],
    ];
    const answer = { branch: 'A', value: 4 };
    rt.provide('classify', { provider: provider(distribution, answer), model: 'test' });
    await rt.create('classify.Classifier', { id: 'c3' });
    await rt.dispatch('c3', 'Ask', {});
    for (let i = 0; i < 10; i++) await rt.worker.tick();
    const state = (await rt.getState('c3')).state;
    assert.equal(state.phase, 'Done', `the step was accepted with conf.value = 0; phase is ${state.phase}`);
    const journal = (await rt.getJournal('c3'));
    const classified = journal.find((j) => j.action === 'Classified');
    const data = typeof classified.data === 'string' ? JSON.parse(classified.data) : classified.data;
    assert.equal(data.confBranch, 800, 'conf.branch = 800 (A probability)');
    assert.equal(data.margBranch, 600, 'margin.branch = 600');
    assert.equal(data.confValue, 0, 'conf.value = 0 (value 4 not in distribution)');
    assert.equal(data.margValue, 0, 'margin.value = 0 (no second-highest when answer value has prob 0)');
    assert.ok(!journal.some((j) => j.action === 'ClassifyFailed'), 'no ClassifyFailed');
  } finally {
    await rt.close();
  }
});

test('Scalar control: a decision with a scalar result keeps one conf and one margin, as numbers (PT10k)', async () => {
  const a = await admitted('field-conf-scalar', ['test/fixtures/field-conf/scalar-decision.poly']);
  const { rt } = await loaded(a);
  try {
    rt.provide('classify', { provider: provider([['A', 0.93], ['B', 0.04], ['C', 0.03]], 'A'), model: 'test' });
    await rt.create('scalar_conf.Classifier', { id: 's1' });
    await rt.dispatch('s1', 'Ask', {});
    for (let i = 0; i < 10; i++) await rt.worker.tick();
    assert.equal((await rt.getState('s1')).state.phase, 'Done');
    const journal = await rt.getJournal('s1');
    const classified = journal.find((j) => j.action === 'Classified');
    const data = typeof classified.data === 'string' ? JSON.parse(classified.data) : classified.data;
    assert.equal(data.conf, 930, 'conf = 930 (A has probability 0.93)');
    assert.equal(data.margin, 890, 'margin = 890 (0.93 - 0.04)');
    const event = (await rt.chain('s1')).find((e) => e.kind === 'decision');
    assert.equal(event.body.conf, 930);
    assert.equal(event.body.margin, 890);
  } finally {
    await rt.close();
  }
});
