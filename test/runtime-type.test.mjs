// S140: PS3.2 defines steps only for d ∈ T(a). An input outside an action's type is refused before any step,
// like K9: an error, an audit row, no journal row and no ledger event. Replay never meets such a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefusedDispatch } from '@poly/runtime';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('types', ['conformance/m1/unions.poly', 'conformance/m4/router.poly']);

test('an input outside its action\'s type is refused before any step, with an audit row', async () => {
  const { rt } = await loaded(a);
  try {
    await rt.create('unions.Board', { id: 'b' });
    const journal = (await rt.getJournal('b')).length;
    const chain = (await rt.chain('b')).length;
    // A constructor of a union with payloads written as a bare name is outside the parameter's type (PS9.1b).
    await assert.rejects(rt.dispatch('b', 'Assign', { s: 'B', job: 'Idle' }, { actionId: 'bad-1' }), (e) => e instanceof RefusedDispatch && e.rule === 'S140' && /outside its type/.test(e.message));
    await assert.rejects(rt.dispatch('b', 'Grab', { s: 'C' }, { actionId: 'bad-2' }), (e) => e instanceof RefusedDispatch && e.rule === 'S140');
    assert.equal((await rt.getJournal('b')).length, journal);
    assert.equal((await rt.chain('b')).length, chain);
    assert.deepEqual((await rt.audit('b')).map((r) => [r.action_id, r.rule]), [['bad-1', 'S140'], ['bad-2', 'S140']]);
    // The same action with data in its type takes its step.
    assert.equal((await rt.dispatch('b', 'Assign', { s: 'B', job: { $: 'Idle' } })).stepKind, 'rejected');
  } finally { await rt.close(); }
});

test('a provider\'s answer outside the decision\'s type is refused, and the intent fails without a step', async () => {
  const { rt, clock } = await loaded(a);
  try {
    rt.provide('route', { provider: () => ({ answer: 'Sixth', distribution: [['Sixth', 0.9]] }), model: 'm' });
    await rt.create('support.Ticket', { id: 't' });
    await rt.dispatch('t', 'Received', { text: 'where is my refund' });
    await rt.worker.tick();
    clock.advance(61_000);
    await rt.worker.tick();
    const actions = (await rt.getJournal('t')).map((r) => r.action);
    assert.ok(!actions.includes('Routed'), 'no Routed step with an answer outside Branch');
    assert.equal((await rt.getState('t')).state.status, 'NeedsHuman', 'the decision failed: RouteFailed');
    assert.ok((await rt.audit('t')).some((r) => r.rule === 'S140' && r.action === 'Routed'));
  } finally { await rt.close(); }
});

test('the runtime reads the type of every action of every conformance and example source (S140)', async () => {
  const { polyFiles, build, ROOT } = await import('./helpers.mjs');
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const { actionTypes, dataOutside } = await import('../packages/poly-runtime/dist/src/types.js');
  let actions = 0;
  for (const f of [...polyFiles(join(ROOT, 'conformance')), ...polyFiles(join(ROOT, 'examples'))]) {
    let built;
    try { built = build(f, 'types'); } catch { continue; } // a source the checker refuses has no build
    for (const { dir } of built) {
      const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
      const types = actionTypes(contract);
      // Every value the contract's own data domain lists is in its type.
      for (const [a, params] of Object.entries(contract.dataDomain ?? {})) {
        actions++;
        for (const [p, values] of Object.entries(params)) for (const v of values) {
          const d = Object.fromEntries((types.get(a) ?? []).map(([q, t]) => [q, q === p ? v : undefined]));
          if (dataOutside(new Map([[a, (types.get(a) ?? []).filter(([q]) => q === p)]]), a, d) !== null) assert.fail(`${f} ${a}.${p} = ${JSON.stringify(v)} is in its domain and refused`);
        }
      }
    }
  }
  assert.ok(actions > 50, `${actions} actions`);
});

test('polywatch: data that is not a record is refused as outside its type, not a TypeError', async () => {
  const { rt } = await loaded(a);
  try {
    await rt.create('unions.Board', { id: 'b2' });
    for (const data of [5, 'Idle', true]) {
      await assert.rejects(rt.dispatch('b2', 'Grab', data), (e) => e instanceof RefusedDispatch && e.rule === 'S140', JSON.stringify(data));
    }
  } finally { await rt.close(); }
});

test('polywatch: a failure completion outside its type is audited (S140) and the intent still ends', async () => {
  const { rt } = await loaded(a);
  try {
    rt.provide('route', { provider: () => { throw Object.assign(new Error('declined'), { permanent: true }); }, model: 'm' });
    // Every completion is declared outside its type, so the permanent path's failed completion cannot be delivered.
    rt.worker['opts'].outsideType = () => 'forced outside';
    await rt.create('support.Ticket', { id: 'tp' });
    await rt.dispatch('tp', 'Received', { text: 'where is my refund' });
    await rt.worker.tick();
    const [row] = (await rt.outbox('tp')).filter((r) => r.kind === 'decision.route');
    assert.equal(row.status, 'dead');
    assert.ok((await rt.audit('tp')).some((r) => r.rule === 'S140' && r.action === 'RouteFailed'));
  } finally { await rt.close(); }
});
