// docs/examples/language-findings.md, item 4: what a dispatch does with a value outside its domain. A range type
// (`v: 0..10`) refuses it before any step: the dispatch throws RefusedDispatch (S140) and the runtime writes an audit
// row, and the journal has no row for it. A check clause (`v: int check 0..10`) makes it a step: the journal holds a
// rejected step with the reason `outside-check-domain`, and nothing is audited. The state is unchanged either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('range-domain', ['test/fixtures/range-domain/range.poly']);

async function gauge() {
  const { rt } = await loaded(a);
  await rt.create('range.Gauge', { id: 'g' });
  return rt;
}

test('a range type: an outside value is thrown as RefusedDispatch with an audit row, and is not journaled', async () => {
  const rt = await gauge();
  try {
    await assert.rejects(() => rt.dispatch('g', 'SetRange', { v: 12 }), (e) => e.name === 'RefusedDispatch' && e.rule === 'S140');
    const audit = await rt.audit('g');
    assert.deepEqual(audit.map((x) => [x.action, x.rule]), [['SetRange', 'S140']]);
    assert.deepEqual((await rt.getJournal('g')).map((j) => j.action), ['$create']);
    assert.equal((await rt.getState('g')).state.last, 0);
  } finally { await rt.close(); }
});

test('a check clause: an outside value is a journaled rejected step, outside-check-domain, with no audit row', async () => {
  const rt = await gauge();
  try {
    const r = await rt.dispatch('g', 'SetCheck', { v: 12 });
    assert.deepEqual([r.stepKind, r.rejectReason], ['rejected', 'outside-check-domain']);
    assert.deepEqual((await rt.getJournal('g')).map((j) => j.action), ['$create', 'SetCheck']);
    assert.deepEqual(await rt.audit('g'), []);
    assert.equal((await rt.getState('g')).state.last, 0);
  } finally { await rt.close(); }
});

test('a value inside either domain is accepted', async () => {
  const rt = await gauge();
  try {
    assert.equal((await rt.dispatch('g', 'SetRange', { v: 7 })).stepKind, 'accepted');
    assert.equal((await rt.dispatch('g', 'SetCheck', { v: 9 })).stepKind, 'accepted');
    assert.equal((await rt.getState('g')).state.last, 9);
  } finally { await rt.close(); }
});
