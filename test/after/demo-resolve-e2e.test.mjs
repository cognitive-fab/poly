// DF21 item 4 second paragraph: Resolve with stand-in faults lost-all and down.
// One assembly per fault scenario, testing refund ends Unknown/Checking, claims refusals,
// resolve moves Unknown to Issued/None, journal replays with 0 divergences, DAC26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRecord, invocationSubject } from '@poly/core';
import { replayRuntime } from '@poly/check';
import { assembleDemo } from '../../demo/host/assemble.mjs';
import { recordedOrdersOf } from '../../demo/host/recorded-orders.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;
const replyOf = (id, outcome) => FIXTURE.messages.find((m) => m.id === id).replies[outcome];

const signed = (who, instance, action, data, actionId) => signRecord(
  { kind: 'invocation', subject: invocationSubject({ instance, action, data, actionId }), by: who.keyId, at: '2026-10-20T00:00:00.000Z' },
  who.privateKeyPem,
);

// ---- Assembly with lost-all fault ----

test('DF21, DF22, DAC26: with lost-all, refund ends Checking, resolve moves Unknown to Issued/None, journal replays', { timeout: 1_800_000 }, async () => {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const workdir = mkdtempSync(join(tmpdir(), 'demo-resolve-lost-all-'));

  const demo = await assembleDemo({
    mode: 'recorded',
    workdir,
    now: clock.now,
    ordersOf: recordedOrdersOf(FIXTURE),
    size: 4,
    standInFault: 'lost-all',
  });

  try {
    const { rt, room, standIn } = demo;
    const g1 = room.join('s1');
    const heard = { s1: [] };
    room.subscribe('s1', (e) => heard.s1.push(e));

    const say = async (id) => {
      clock.advance(6000);
      const r = await room.say('s1', textOf(id));
      assert.deepEqual(r, { ok: true }, `${id}: ${JSON.stringify(r)}`);
    };

    // (a) Refund request ends with Checking reply (lost-all makes all attempts lost)
    await say('refund-twice');

    // Advance clock through 5 retries with exponential backoff
    for (let i = 0; i < 10; i++) {
      clock.advance(2000);
      await demo.settle();
    }

    const checkingText = replyOf('refund-twice', 'Checking');
    assert.equal(heard.s1.at(-1).text, checkingText);

    const status = await demo.status();
    assert.deepEqual(status.unknown, ['guest-01']);

    // (b) Refusals that leave ledger Unknown: wrong credentials, agent key, wrong data
    const deskId = await rt.threadId('support', g1.phone);
    const presenterKeyId = demo.admission.person.keyId;

    // No credentials
    const r1 = await rt.dispatch(deskId, 'Resolve', { done: true }, { actionId: 'r1' });
    assert.equal(r1.stepKind, 'rejected');
    assert.equal(r1.rejectReason, 'claims-unverified');
    assert.deepEqual((await demo.status()).unknown, ['guest-01']);

    // Wrong credentials object
    const r2 = await rt.dispatch(deskId, 'Resolve', { done: true }, { credentials: { principal: 'x' }, actionId: 'r2' });
    assert.equal(r2.stepKind, 'rejected');
    assert.deepEqual((await demo.status()).unknown, ['guest-01']);

    // Agent key signed record
    const agentRecord = signed(demo.admission.agent, deskId, 'Resolve', { done: true }, 'r3');
    const r3 = await rt.dispatch(deskId, 'Resolve', { done: true }, { credentials: agentRecord, actionId: 'r3' });
    assert.equal(r3.stepKind, 'rejected');
    assert.deepEqual((await demo.status()).unknown, ['guest-01']);

    // Person key but wrong data
    const wrongDataRecord = signed(demo.admission.person, deskId, 'Resolve', { done: false }, 'r4');
    const r4 = await rt.dispatch(deskId, 'Resolve', { done: true }, { credentials: wrongDataRecord, actionId: 'r4' });
    assert.equal(r4.stepKind, 'rejected');
    assert.deepEqual((await demo.status()).unknown, ['guest-01']);

    // (c) Resolve with done=true moves to Issued
    const resolved = await demo.resolve('guest-01', 'done');
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.desk, 'guest-01');
    assert.equal(resolved.outcome, 'done');
    assert.equal(resolved.by, presenterKeyId);
    assert.deepEqual((await demo.status()).unknown, []);

    await demo.settle();

    // Later refund-twice gets Already reply
    const postsBeforeAlready = standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'POST').length;
    await say('refund-twice');
    const alreadyText = replyOf('refund-twice', 'Already');
    assert.equal(heard.s1.at(-1).text, alreadyText);
    const postsAfterAlready = standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'POST').length;
    assert.equal(postsAfterAlready, postsBeforeAlready);

    // (d) Second resolve throws error with not-unknown
    await assert.rejects(
      demo.resolve('guest-01', 'done'),
      (e) => e.message.includes('not-unknown'),
    );

    // (e) Journal replays with 0 divergences and contains Resolve step
    const journal = await rt.getJournal(deskId);
    const resolveSteps = journal.filter((x) => x.action === 'Resolve');
    // Every attempt is a row of the journal: the four refusals of (b) and the second resolve of (d) are rejected, the one of (c) is accepted.
    const accepted = resolveSteps.filter((x) => x.step_kind === 'accepted');
    assert.equal(accepted.length, 1, 'one Resolve step is accepted, the signed one');
    assert.equal(accepted[0].data.done, true);
    assert.equal(accepted[0].data.$claims.principal, 'presenter', 'the step is journaled with the claims of the person who signed it');
    const rejected = resolveSteps.filter((x) => x.step_kind === 'rejected');
    assert.deepEqual(rejected.map((x) => x.reject_reason), ['claims-unverified', 'claims-unverified', 'claims-unverified', 'claims-unverified', 'not-unknown']);

    const [run] = await replayRuntime(rt, { runs: [deskId] });
    assert.deepEqual(run.diagnostics.map((d) => d.message), []);
    assert.equal(run.folded, run.rows, 'replay should have no divergences');
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ---- Assembly with down fault ----

test('DF21, DF22, DAC26: with down, refund ends Checking, resolve not-done empties unknown, reset enables refund', { timeout: 1_800_000 }, async () => {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const workdir = mkdtempSync(join(tmpdir(), 'demo-resolve-down-'));

  const demo = await assembleDemo({
    mode: 'recorded',
    workdir,
    now: clock.now,
    ordersOf: recordedOrdersOf(FIXTURE),
    size: 4,
    standInFault: 'down',
  });

  try {
    const { room, standIn } = demo;
    room.join('s1');
    const heard = { s1: [] };
    room.subscribe('s1', (e) => heard.s1.push(e));

    const say = async (id) => {
      clock.advance(6000);
      const r = await room.say('s1', textOf(id));
      assert.deepEqual(r, { ok: true });
    };

    // Refund request ends Checking (down makes all attempts fail with 503)
    await say('refund-twice');
    for (let i = 0; i < 10; i++) {
      clock.advance(2000);
      await demo.settle();
    }

    const checkingText = replyOf('refund-twice', 'Checking');
    assert.equal(heard.s1.at(-1).text, checkingText);

    // Stand-in holds no refund object
    assert.equal(standIn.report().refunds, 0);

    // Resolve with not-done empties unknown
    const resolved = await demo.resolve('guest-01', 'not-done');
    assert.equal(resolved.resolved, true);
    assert.deepEqual((await demo.status()).unknown, []);

    await demo.settle();

    // Reset stand-in to none and send refund: it succeeds (Refunded reply)
    standIn.reset({ fault: 'none' });

    const postsBeforeRefund = standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'POST').length;
    await say('refund-twice');
    assert.equal(heard.s1.at(-1).text, replyOf('refund-twice', 'Refunded'), 'the refund after not-done is made and told');
    const postsAfterRefund = standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'POST').length;
    assert.equal(postsAfterRefund, postsBeforeRefund + 1, 'one new POST should have been sent');
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
