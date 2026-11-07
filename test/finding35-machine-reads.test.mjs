// Finding 35 (PT8.3, as ruled by the owner on 2026-11-06), by a separate writer under rule 7a: the gate host reads a
// machine's latest snapshot only for a machine admission certified as a service machine the scope reads. Admission
// writes `singletons` into every entry of the certificate's `poly.policies`; a read of a machine that is neither the
// emitter nor in `singletons` is unknown whatever instances the store holds, for an effect's proposal, a send's
// proposal and an approved re-proposal alike; only a machine read from `singletons` is recorded under `singletons` in
// the `verdict` event; and `load` refuses a certificate whose entry has no `singletons`, naming the scope and saying to
// run `poly admit` again. Tests marked "guard" pass on the tree before the fix and hold what must not change.
//
// The fixture is test/fixtures/finding35/: scope f35 reads Clerk (not a service machine) and Alpha and Zeta (service
// machines); scope f35own reads only its emitter; scope f35bare reads no machine; scope sa (conformance/m5/scope-a.poly)
// sends to scope sb and reads Clerk and Alpha. Every Clerk rule decides differently on Clerk's Idle snapshot than on
// unknown input, so the outcome shows which one the gate read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certificateDigest, signDigest } from '@poly/core';
import { load, LoadError, polyaxionPeer } from '@poly/runtime';
import { admitted, loaded, handleWith, approveAs } from './runtime-helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;
const FIX = 'test/fixtures/finding35';
const SOURCES = [
  `${FIX}/f35.poly`, `${FIX}/f35.policy.poly`,
  `${FIX}/f35own.poly`, `${FIX}/f35own.policy.poly`,
  `${FIX}/f35bare.poly`, `${FIX}/f35bare.policy.poly`,
  'conformance/m5/scope-a.poly', 'conformance/m5/scope-b.poly', `${FIX}/sa.policy.poly`,
];
const KINDS = ['f35.mail', 'f35.notice', 'f35.refund', 'f35.ping', 'own.go', 'bare.go'];

// One admission for the file; each test loads it into a fresh in-memory runtime.
let admission;
const desk = () => (admission ??= admitted('finding35-machine-reads', SOURCES));

async function runtime() {
  const a = await desk();
  const { rt, clock } = await loaded(a);
  const ran = [];
  for (const kind of KINDS) handleWith(rt, kind, (_p, _c, ctx) => { ran.push(ctx?.instanceId); return 'ok'; });
  return { rt, clock, ran };
}

const settle = async (rt, clock, n = 4) => { for (let k = 0; k < n; k++) { clock.advance(1_000); await rt.worker.tick(); } };
const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body?.stage === 'gate').map((e) => e.body);
/** The gate's decisions on proposals (each carries a session sequence number), not approvals or settlements. */
const decisions = (vs) => vs.filter((b) => typeof b.sseq === 'number');
const show = (vs) => JSON.stringify(vs.map((b) => ({ outcome: b.outcome, reason: b.reason, gateDecision: b.gateDecision, singletons: b.singletons, reads: b.reads, approvedBy: b.approvedBy })));

test('finding 35: admission writes singletons in every poly.policies entry, the service machines among its reads, sorted', { skip, timeout: 300_000 }, async () => {
  const a = await desk();
  // PT8.3: the field is part of the signed certificate, so it is read from the file the build was admitted with.
  const onDisk = JSON.parse(readFileSync(a.certificate, 'utf8'));
  const expected = { f35: ['f35.Alpha', 'f35.Zeta'], f35own: [], f35bare: [], sa: ['f35.Alpha'] };
  for (const cert of [a.cert, onDisk]) {
    const entries = cert.poly.policies;
    assert.deepEqual(entries.map((p) => p.scope).sort(), Object.keys(expected).sort());
    for (const p of entries) {
      assert.ok(Object.hasOwn(p, 'singletons'), `scope ${p.scope} has a singletons field: ${JSON.stringify(p)}`);
      assert.deepEqual(p.singletons, expected[p.scope], `scope ${p.scope}: reads ${JSON.stringify(p.reads)}`);
      for (const m of p.singletons) assert.ok(p.reads.includes(m), `${m} is among scope ${p.scope}'s reads`);
    }
  }
  // The reads themselves, so the expectation above is the service machines among them and not a coincidence.
  const reads = Object.fromEntries(a.cert.poly.policies.map((p) => [p.scope, p.reads]));
  assert.deepEqual(reads.f35, ['f35.Alpha', 'f35.Clerk', 'f35.Zeta']);
  assert.deepEqual(reads.f35own, ['f35own.Self']);
  assert.deepEqual(reads.f35bare, []);
});

test('finding 35: a mail\'s rule that reads Clerk, not a service machine, is decided on unknown input though one Clerk exists', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    // Exactly one Clerk instance, Idle: before the fix the gate read its snapshot and the rule denied the mail.
    await rt.create('f35.Clerk', { id: 'c-1' });
    await rt.create('f35.Mail', { id: 'm-1' });
    await rt.dispatch('m-1', 'Go');
    await settle(rt, clock, 2);
    const vs = decisions(await verdicts(rt, 'm-1'));
    assert.ok(vs.length >= 1, `the mail was proposed: ${show(vs)}`);
    const [v] = vs;
    // PT8.3: Clerk is neither the emitter nor in the scope's singletons, so its read is unknown and the rule's
    // `on unknown escalate` decides.
    assert.equal(v.outcome, 'escalated', `decided on unknown input, not on c-1's snapshot: ${show(vs)}`);
    assert.match(String(v.reason), /mail-while-clerk-idle/, show(vs));
    assert.ok(!Object.hasOwn(v.singletons ?? {}, 'f35.Clerk'), `no Clerk snapshot under singletons: ${show(vs)}`);
    assert.ok(!Object.hasOwn(v.reads ?? {}, 'c-1'), `c-1 is not among the reads: ${show(vs)}`);
  } finally { await rt.close(); }
});

test('finding 35 (guard): a rule that reads a service machine gets its one instance\'s latest snapshot and seq', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    await rt.create('f35.Alpha', { id: 'alpha' });
    await rt.dispatch('alpha', 'Open');
    const alpha = await rt.getState('alpha');
    assert.equal(alpha.state.shift, 'Open');
    await rt.create('f35.Notice', { id: 'n-1' });
    await rt.dispatch('n-1', 'Go');
    await settle(rt, clock, 2);
    const vs = decisions(await verdicts(rt, 'n-1'));
    const [v] = vs;
    assert.ok(v, `the notice was proposed: ${show(vs)}`);
    assert.equal(v.outcome, 'denied', `decided on Alpha's snapshot: ${show(vs)}`);
    assert.match(String(v.reason), /notice-while-alpha-open/, show(vs));
    assert.deepEqual(v.singletons?.['f35.Alpha'], alpha.state, show(vs));
    assert.equal(v.reads?.alpha, alpha.seq, `the verdict records Alpha's seq: ${show(vs)}`);
  } finally { await rt.close(); }
});

test('finding 35 (guard): a rule that reads a service machine with no instance is decided on unknown input', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    await rt.create('f35.Notice', { id: 'n-2' });
    await rt.dispatch('n-2', 'Go');
    await settle(rt, clock, 2);
    const vs = decisions(await verdicts(rt, 'n-2'));
    const [v] = vs;
    assert.ok(v, `the notice was proposed: ${show(vs)}`);
    assert.equal(v.outcome, 'escalated', `the rule's on unknown escalate decides: ${show(vs)}`);
    assert.ok(!Object.hasOwn(v.singletons ?? {}, 'f35.Alpha'), show(vs));
  } finally { await rt.close(); }
});

test('finding 35 (guard): a rule that reads a service machine with two instances is decided on unknown input', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    await rt.create('f35.Alpha', { id: 'alpha-1' });
    await rt.create('f35.Alpha', { id: 'alpha-2' });
    await rt.dispatch('alpha-1', 'Open');
    await rt.dispatch('alpha-2', 'Open');
    await rt.create('f35.Notice', { id: 'n-3' });
    await rt.dispatch('n-3', 'Go');
    await settle(rt, clock, 2);
    const vs = decisions(await verdicts(rt, 'n-3'));
    const [v] = vs;
    assert.ok(v, `the notice was proposed: ${show(vs)}`);
    assert.equal(v.outcome, 'escalated', `PT8.3: more than one instance is unknown: ${show(vs)}`);
    assert.ok(!Object.hasOwn(v.singletons ?? {}, 'f35.Alpha'), show(vs));
  } finally { await rt.close(); }
});

test('finding 35 (guard): a rule that reads only its emitter gets the emitting step\'s snapshot, with two instances in the store', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    // Two Self instances: a read of Self is not a singleton read, so it is the emitter's own snapshot or nothing.
    await rt.create('f35own.Self', { id: 's-1' });
    await rt.create('f35own.Self', { id: 's-2' });
    await rt.dispatch('s-1', 'Go');
    await settle(rt, clock, 2);
    const vs = decisions(await verdicts(rt, 's-1'));
    const [v] = vs;
    assert.ok(v, `Self's effect was proposed: ${show(vs)}`);
    assert.equal(v.outcome, 'denied', `decided on the emitting step's snapshot (Working): ${show(vs)}`);
    assert.match(String(v.reason), /go-while-working/, show(vs));
    assert.deepEqual(v.singletons ?? {}, {}, `the emitter's snapshot is not recorded under singletons: ${show(vs)}`);
  } finally { await rt.close(); }
});

/** A message in transit, written as polyrun writes a sendTo intent (below the language), as test/cross-scope.test.mjs does. */
function inject(rt, id, from, to, action, at) {
  rt.store.db.prepare("INSERT INTO pr_outbox (intent_id, instance_id, seq, kind, payload, status, attempts, next_attempt_at) VALUES (?, ?, 0, 'sendTo', ?, 'pending', 0, ?)").run(id, from, JSON.stringify({ target: to, action, data: {} }), at);
}

test('finding 35: a send\'s rule that reads Clerk is decided on unknown input, and only the service machine Alpha is recorded', { skip, timeout: 300_000 }, async () => {
  const { rt, clock } = await runtime();
  try {
    await rt.create('sa.Pinger', { id: 'ping' });
    await rt.create('sb.Ponger', { id: 'pong' });
    await rt.create('f35.Clerk', { id: 'c-1' });
    await rt.create('f35.Alpha', { id: 'alpha' });
    await rt.dispatch('alpha', 'Open');
    const alpha = await rt.getState('alpha');
    inject(rt, 'm-ping', 'ping', 'pong', 'Ping', clock.now());
    await rt.tick();
    const vs = (await rt.chain('ping')).filter((e) => e.kind === 'verdict' && e.body?.kind === 'send').map((e) => e.body);
    const v = vs.find((b) => b.intent === 'm-ping');
    assert.ok(v, `the send was proposed: ${show(vs)}`);
    // PT8.3: the sender is the emitter; Clerk is unknown, so send-while-clerk-idle skips; Alpha is Open, so
    // send-while-alpha-closed holds. Before the fix c-1's Idle snapshot was read and the send was denied.
    assert.equal(v.outcome, 'allowed', `decided on unknown input for Clerk: ${show(vs)}`);
    assert.deepEqual(v.singletons, { 'f35.Alpha': alpha.state }, `only Alpha, a certified singleton, is recorded: ${show(vs)}`);
    assert.equal((await rt.getState('pong')).state.pings, 1, 'the ping was delivered');
  } finally { await rt.close(); }
});

test('finding 35: an approved re-proposal reads Clerk as unknown, though a Clerk was created before the approval', { skip, timeout: 300_000 }, async () => {
  const { rt, clock, ran } = await runtime();
  try {
    await rt.create('f35.Refund', { id: 'r-1' });
    await rt.dispatch('r-1', 'Go');
    await settle(rt, clock, 2);
    const first = decisions(await verdicts(rt, 'r-1'));
    // No Clerk yet: the Clerk rule skips on unknown input before and after the fix, and refund-reviewed escalates.
    assert.equal(first[0]?.outcome, 'escalated', `the refund waits for a person: ${show(first)}`);
    assert.match(String(first[0].reason), /refund-reviewed/, show(first));
    // One Clerk, Idle, exists at the re-proposal: before the fix the gate read it and refund-while-clerk-idle denied.
    await rt.create('f35.Clerk', { id: 'c-1' });
    const [row] = await rt.outbox('r-1');
    await approveAs(rt, row.intent_id);
    await settle(rt, clock, 6);
    const vs = decisions(await verdicts(rt, 'r-1'));
    const again = vs.filter((b) => b.approvedBy);
    assert.equal(again.length, 1, `one approved re-proposal: ${show(vs)}`);
    const [v] = again;
    assert.equal(v.outcome, 'allowed', `decided on unknown input for Clerk, so the approval decides: ${show(vs)}`);
    assert.ok(!Object.hasOwn(v.singletons ?? {}, 'f35.Clerk'), `no Clerk snapshot under singletons: ${show(vs)}`);
    assert.ok(!Object.hasOwn(v.reads ?? {}, 'c-1'), `c-1 is not among the reads: ${show(vs)}`);
    assert.deepEqual(ran, ['r-1'], 'the approved refund ran');
  } finally { await rt.close(); }
});

/** A copy of the admitted certificate, changed by `edit` and signed again with the test's admission key. */
function resigned(a, name, edit) {
  const file = join(a.dir, name);
  copyFileSync(a.certificate, file);
  const cert = JSON.parse(readFileSync(file, 'utf8'));
  edit(cert);
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, a.key.id, readFileSync(a.key.file, 'utf8'))];
  writeFileSync(file, JSON.stringify(cert));
  return file;
}

/** Loads a certificate and returns the error, or null after closing the runtime it opened. */
async function loadError(a, certificate) {
  let rt;
  try { rt = await load(a.build, { certificate, trust: a.trust }); } catch (e) { return e; }
  await rt.close();
  return null;
}

test('finding 35 (guard): a certificate signed again with nothing removed loads', { skip, timeout: 300_000 }, async () => {
  const a = await desk();
  const file = resigned(a, 'certificate.same.json', () => {});
  assert.equal(await loadError(a, file), null, 're-signing alone does not refuse the certificate');
});

test('finding 35: load refuses a certificate whose poly.policies entry has no singletons, naming the scope and poly admit', { skip, timeout: 300_000 }, async () => {
  const a = await desk();
  // A certificate admitted before the rule: the entry for scope f35own has no singletons field.
  const file = resigned(a, 'certificate.no-singletons.json', (cert) => {
    const entry = cert.poly.policies.find((p) => p.scope === 'f35own');
    delete entry.singletons;
  });
  const e = await loadError(a, file);
  assert.ok(e, 'load refused the certificate (it must not be read the old way, nor as having no singletons)');
  assert.ok(e instanceof LoadError, `a LoadError: ${e?.stack ?? e}`);
  assert.match(e.message, /f35own/, 'the message names the scope');
  assert.match(e.message, /poly admit/, 'the message says to run poly admit again');
});
