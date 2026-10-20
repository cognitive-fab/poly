// DF17 (DAC22): heavy test for demo.approve on a recorded run. Guest 2 asks for a large refund,
// the escalated intent is found, and approve resolves with the expected shape. A second call is refused,
// and an unknown intent gives the proper message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleDemo } from '../../demo/host/assemble.mjs';
import { recordedOrdersOf } from '../../demo/host/recorded-orders.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;

test('DF17: demo.approve on escalated intent resolves and refuses on second call', { timeout: 1_800_000 }, async () => {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const workdir = mkdtempSync(join(tmpdir(), 'demo-approval-'));
  const demo = await assembleDemo({
    mode: 'recorded',
    workdir,
    now: clock.now,
    ordersOf: recordedOrdersOf(FIXTURE),
    size: 4,
  });

  try {
    // Join two guests
    const { rt, room } = demo;
    const g1 = room.join('s1');
    const g2 = room.join('s2');
    assert.deepEqual([g1.principal, g2.principal], ['cust-guest-01', 'cust-guest-02']);

    // Guest 2 says "refund-large" (above 100, triggers escalation)
    const say = async (session, id) => {
      clock.advance(6000);
      const r = await room.say(session, textOf(id));
      assert.deepEqual(r, { ok: true }, `${id}: ${JSON.stringify(r)}`);
    };

    await say('s2', 'refund-large');

    // Pump staff to get the escalation
    await demo.pumpStaff();
    await demo.settle();

    // Find the escalated intent id from the database
    const desk2 = await rt.threadId('support', g2.phone);
    const escalations = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payments.refund'").all(desk2);
    assert.ok(escalations.length > 0, 'escalation should exist');
    const esc = escalations[0].intent_id;
    assert.ok(esc, 'escalation intent id should be found');

    // First approve call should succeed
    const result1 = await demo.approve(esc);
    assert.equal(result1.approved, true);
    assert.equal(result1.intent, esc);
    assert.ok(typeof result1.by === 'string' && result1.by.length > 0, 'by should be a non-empty string');
    assert.ok(typeof result1.subject === 'string' && result1.subject.length > 0, 'subject should be a non-empty string');
    assert.ok(typeof result1.at === 'string', 'at should be a string');

    // Settle after first approval
    await demo.settle();

    // Second approve call on same intent should be refused
    await assert.rejects(
      demo.approve(esc),
      (e) => {
        assert.ok(e.message.includes('approval refused'));
        return true;
      },
      'second approve should reject with approval refused message',
    );

    // Approve with non-existent intent should give specific message
    await assert.rejects(
      demo.approve('no-such-intent'),
      (e) => {
        assert.equal(e.message, 'no escalation was found for intent no-such-intent: copy the id from the staff panel');
        return true;
      },
      'unknown intent should give escalation not found message',
    );
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
