// poly journal fit and eval (PD1.6a, PD3.3, S132), on readers built in the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit } from '@poly/check';
import { calibrate } from '@poly/runtime';

const reader = (outcomes, raw = 0.9) => {
  const runs = outcomes.map((_, i) => ({ ns: 'support', wf: 'support.Ticket', run: `r${i}` }));
  const chains = Object.fromEntries(outcomes.map((o, i) => [`r${i}`, [
    { kind: 'decision', hash: `d${i}`, body: { decision: 'route', request: 'q', answer: 'Refund', raw: Array.isArray(raw) ? raw[i] : raw, model: { id: 'm', reported: null } } },
    { kind: 'outcome', hash: `o${i}`, body: { decision: 'route', outcome: o, decisionEvent: `d${i}` } },
  ]]));
  return { runs: async () => runs, chain: async (r) => chains[r], body: async () => ({}), heads: async () => [], journal: async () => null, anchors: async () => [], close: async () => {} };
};

test('review B4: fit pools equal raw values, so the map does not depend on the order of the samples', async () => {
  for (const order of [['Wrong', 'Correct'], ['Correct', 'Wrong']]) {
    const map = await fit(reader(order), 'route', 'm', 1);
    assert.deepEqual(map.points, [[900, 500]], order.join(','));
    assert.equal(calibrate(map, 0.9), 500);
  }
  const map = await fit(reader(['Correct', 'Wrong', 'Wrong', 'Correct'], [0.5, 0.5, 0.9, 0.9]), 'route', 'm', 1);
  for (let k = 1; k < map.points.length; k++) assert.ok(map.points[k][1] >= map.points[k - 1][1]);
});
