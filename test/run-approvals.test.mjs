// S189 (M8a step 2): a person's approval reaches a running runtime through a drop folder. Each record is verified against
// the certified keyring and must match the open escalation it names; a record is applied once, and the same record
// again, under any file name, is refused as replayed; one that arrives after its escalation timed out is refused as
// expired. Records are taken in file-name order, each is moved to applied/ or to refused/ with the reason beside it,
// and every outcome is journaled on the runtime's approvals run. No model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signRecord } from '@poly/core';
import { admitted, loaded, approvalFor, AGENT, makePerson } from './runtime-helpers.mjs';

const BRIEF = 'conformance/m6/customer-brief.poly';
const gate = { propose: (p) => (p.effectKind === 'post_brief' && !p.approved ? { decision: 'escalate', reason: 'public-post' } : { decision: 'allow' }), settle: () => 'ok' };
const RESULTS = { fetch_tickets: { count: 2 }, draft_brief: {}, request_approval: {}, post_brief: {} };

let built;
const build = async () => (built ??= await admitted('run-approvals', [BRIEF]));

/** A run driven to its escalated post: returns the post's intent. */
async function escalated(rt, date) {
  const { instanceId } = await rt.startWorkflow('customer-brief', { date });
  for (let k = 0; k < 6; k++) {
    await rt.advance();
    const [o] = await rt.workOrders(instanceId);
    if (!o) break;
    assert.equal((await rt.reportWorkOrder(o.orderId, { ok: true, result: RESULTS[o.kind] })).status, 'settled');
  }
  await rt.advance();
  const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'post_brief'").get(instanceId).intent_id;
  return { instanceId, intent };
}

const folder = () => mkdtempSync(join(tmpdir(), 'poly-approvals-'));
const drop = (dir, name, record) => writeFileSync(join(dir, name), typeof record === 'string' ? record : JSON.stringify(record));
const reasonOf = (dir, name) => readFileSync(join(dir, 'refused', `${name}.reason.txt`), 'utf8');
const journaled = async (rt) => (await rt.chain('runtime:approvals')).filter((e) => e.body?.stage === 'approval').map((e) => [e.body.file, e.body.outcome, e.body.reason ?? null]);

test('S189: a signed record matching the open escalation is applied, moved to applied/ and journaled; the order is then issued', async () => {
  const { rt } = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  try {
    const { instanceId, intent } = await escalated(rt, '2026-10-04');
    assert.deepEqual(await rt.workOrders(instanceId), []);
    drop(dir, '001-approve.json', await approvalFor(rt, intent));
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.file, o.outcome]), [['001-approve.json', 'applied']]);
    assert.ok(existsSync(join(dir, 'applied', '001-approve.json')));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    await rt.advance();
    assert.equal((await rt.workOrders(instanceId))[0]?.tool, 'slack_send');
    assert.deepEqual(await journaled(rt), [['001-approve.json', 'applied', null]]);
    assert.ok((await rt.verifyChain('runtime:approvals')).ok);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S189: the same record again, under a new file name, is refused as replayed', async () => {
  const { rt } = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  try {
    const { intent } = await escalated(rt, '2026-10-04');
    const record = await approvalFor(rt, intent);
    drop(dir, '001-approve.json', record);
    await rt.takeApprovals(dir);
    drop(dir, '002-again.json', record);
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.file, o.outcome, o.reason]), [['002-again.json', 'refused', 'replayed']]);
    assert.match(reasonOf(dir, '002-again.json'), /^replayed/);
    assert.deepEqual(await journaled(rt), [['001-approve.json', 'applied', null], ['002-again.json', 'refused', 'replayed']]);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S189: a record that arrives after its escalation timed out is refused as expired', async () => {
  const { rt, clock } = await loaded(await build(), { gate: { gate, escalationTimeoutMs: 600_000 } });
  const dir = folder();
  try {
    const { intent } = await escalated(rt, '2026-10-04');
    const record = await approvalFor(rt, intent);
    clock.advance(600_001);
    drop(dir, '001-late.json', record);
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.outcome, o.reason]), [['refused', 'expired']]);
    assert.match(reasonOf(dir, '001-late.json'), /^expired/);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S189: a record that names no open escalation is refused as unmatched', async () => {
  const { rt } = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  try {
    await escalated(rt, '2026-10-04');
    const { PERSON } = await import('./runtime-helpers.mjs');
    drop(dir, '001-other.json', signRecord({ kind: 'approval', subject: 'sha256:' + '0'.repeat(64), by: PERSON.keyId, at: '2026-10-05T00:00:00.000Z' }, PERSON.privateKeyPem));
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.outcome, o.reason]), [['refused', 'unmatched']]);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S189, PF9.6: a record signed with an agent\'s key, or a key the keyring does not hold, is refused as wrong-key', async () => {
  const { rt } = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  try {
    const { intent } = await escalated(rt, '2026-10-04');
    const stranger = makePerson('stranger');
    drop(dir, '001-agent.json', await approvalFor(rt, intent, AGENT));
    drop(dir, '002-stranger.json', await approvalFor(rt, intent, stranger));
    drop(dir, '003-garbage.json', 'not a record');
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.file, o.outcome, o.reason]), [['001-agent.json', 'refused', 'wrong-key'], ['002-stranger.json', 'refused', 'wrong-key'], ['003-garbage.json', 'refused', 'not-a-record']]);
    assert.ok(existsSync(join(dir, 'refused', '001-agent.json')));
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S189: the journal reproduces the drop folder: its records, taken again in journal order on the same state, give the same outcomes', async () => {
  const first = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  let journal;
  try {
    const { intent } = await escalated(first.rt, '2026-10-04');
    const record = await approvalFor(first.rt, intent);
    drop(dir, '001-approve.json', record);
    drop(dir, '002-again.json', record);
    drop(dir, '003-agent.json', await approvalFor(first.rt, intent, AGENT));
    await first.rt.takeApprovals(dir);
    journal = await Promise.all((await first.rt.chain('runtime:approvals')).map(async (e) => ({ file: e.body.file, outcome: e.body.outcome, reason: e.body.reason ?? null, text: await first.rt.store.body(e.body.record) })));
  } finally { await first.rt.close(); rmSync(dir, { recursive: true, force: true }); }
  const second = await loaded(await build(), { gate: { gate } });
  const again = folder();
  try {
    await escalated(second.rt, '2026-10-04');
    for (const j of journal) drop(again, j.file, j.text);
    const out = await second.rt.takeApprovals(again);
    assert.deepEqual(out.map((o) => [o.file, o.outcome, o.reason ?? null]), journal.map((j) => [j.file, j.outcome, j.reason]));
    assert.deepEqual(journal.map((j) => j.reason), [null, 'replayed', 'wrong-key']);
  } finally { await second.rt.close(); rmSync(again, { recursive: true, force: true }); }
});

test('S189: records are taken in file-name order, whatever order they were written in', async () => {
  const { rt } = await loaded(await build(), { gate: { gate } });
  const dir = folder();
  try {
    const { intent } = await escalated(rt, '2026-10-04');
    const record = await approvalFor(rt, intent);
    drop(dir, 'b.json', record);
    drop(dir, 'a.json', record);
    const out = await rt.takeApprovals(dir);
    assert.deepEqual(out.map((o) => [o.file, o.outcome, o.reason ?? null]), [['a.json', 'applied', null], ['b.json', 'refused', 'replayed']]);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});
