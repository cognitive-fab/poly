// Finding 34 (docs/examples/language-findings.md, section 34): PT9.7 rule 2, "What the denial records". When the
// decision of an approved re-proposal would be an escalation, the intent is denied `escalate-once`, and its `denied`
// event records the escalation it replaces: `gateDecision: "escalate"` and `escalatedBy`, the reason that escalation
// carried. Written by a separate writer from the specification (rule 7a), before any code.
//
// The shape is review-m10 B1, the only escalate-once the runtime reaches (finding 34): the concierge's answer is
// escalated by a `require false else escalate` policy, a person approves it after the orders went stale, and at the
// re-proposal freshness (S307) escalates `stale-items` again, before the policy. The engine lifts every escalate rule
// of an approved proposal (PS8.5), so it is never asked, and the denial takes no session and no sseq (S146).
//
// A budget `escalate` at an approved re-proposal (`escalatedBy: "budget"`) is not tested here. In the existing budget
// fixtures (test/budget.test.mjs, the large tier; test/workflow-budget.test.mjs W6) the escalation an approval answers
// is the budget's own, and the approved call is denied `budget` (PS18.4), not `escalate-once`. Reaching escalate-once
// through a budget needs a policy escalation first and a budget that fills between the proposal and the approval,
// which no existing fixture builds.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { postgresSource } from '@poly/io';
import { approveAs, handleWith, loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const verifier = (c) => (c ? { principal: c.principal } : null);
const POLICY = [
  'module concierge_memory_policy',
  '',
  'policy review-answers {',
  '  scope "concierge_memory"',
  '  obligation person-reviews "Every answer waits for a person." rule {',
  '    when proposal.kind == "effect" && effect.kind == "decision.answer"',
  '    require false else escalate',
  '    on unknown escalate',
  '  }',
  '}',
  '',
].join('\n');

let opened;
/** The B1 run, once: escalated by the policy, approved two hours later (freshness 1h), re-proposed and denied. */
async function scenario() {
  if (opened) return opened;
  const key = makeKey('finding34-escalate-once');
  const dir = project('finding34-escalate-once', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'review.policy.poly'), POLICY);
  await signPolicies(dir);
  const r = await admit(dir);
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
  const db = pgOrders([{ order_id: 'o-1', customer_id: 'cust-a', updated_at: new Date(clock.now()).toISOString(), summary: 'Order 1: a lamp.' }]);
  const asked = [];
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', { provider: (_q, m) => { asked.push(1); return { answer: 'ok', distribution: [['ok', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }; }, model: 'flash' });
  handleWith(rt, 'support.reply', () => ({ ok: true }));
  await rt.create('concierge_memory.Desk', { id: 'desk' });
  await rt.dispatch('desk', 'Ask', { question: await rt.putContent('Where is my order?') }, { credentials: { principal: 'cust-a' } });
  for (let k = 0; k < 6; k++) await rt.worker.tick();
  clock.advance(2 * 3600_000);
  const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'desk' AND kind = 'decision.answer'").get().intent_id;
  await approveAs(rt, intent);
  for (let k = 0; k < 6; k++) await rt.worker.tick();
  const verdicts = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all()
    .map((x) => JSON.parse(x.event).body).filter((x) => x.effectKind === 'decision.answer');
  opened = { rt, intent, asked, verdicts, denied: verdicts.find((v) => v.outcome === 'denied') };
  return opened;
}
after(async () => { if (opened) await opened.rt.close(); });

// A guard: the decision itself is unchanged by finding 34. The re-proposal is denied `escalate-once` (rule 2), the
// model is never asked over stale orders, and the decision's `failed` arm (onFailure) is dispatched, so the desk is
// back at Idle. This passes on the tree before the fix.
test('finding 34 guard: the approved re-proposal of a stale answer is denied escalate-once and onFailure is dispatched (PT9.7 rule 2)', { timeout: 300_000 }, async () => {
  const { rt, verdicts, denied, asked } = await scenario();
  assert.deepEqual(verdicts.map((v) => v.outcome), ['escalated', 'approved', 'denied']);
  assert.equal(denied.reason, 'escalate-once');
  assert.equal(asked.length, 0, 'the model was not asked over stale orders');
  const journal = (await rt.getJournal('desk')).map((j) => j.action);
  assert.ok(journal.includes('AnswerFailed'), `the decision's failed arm was dispatched: ${JSON.stringify(journal)}`);
  assert.equal((await rt.getState('desk')).state.phase, 'Idle');
});

// The record: the denied event names the escalation rule 2 replaced, `gateDecision: "escalate"`, and its cause,
// `escalatedBy: "stale-items"` from freshness (S307). Finding 34 records that no other event of the intent holds
// `stale-items`: the first `escalated` event names the policy rule. This fails on the tree before the fix.
test('finding 34: the escalate-once denial records gateDecision "escalate" and escalatedBy "stale-items" (PT9.7 rule 2)', { timeout: 300_000 }, async () => {
  const { denied } = await scenario();
  assert.ok(denied, 'a denied verdict');
  assert.equal(denied.reason, 'escalate-once', 'the reason stays escalate-once');
  assert.deepEqual({ gateDecision: denied.gateDecision, escalatedBy: denied.escalatedBy }, { gateDecision: 'escalate', escalatedBy: 'stale-items' },
    `the denial records the escalation it replaces and its cause: ${JSON.stringify(denied)}`);
});

// A guard that the fix does not invent a sequence number. The escalation came from a host check before the policy,
// which the engine never saw, so the event carries no session and no sseq, and the session's sequence has no gap
// (S146): session replay reports no diagnostic (no gap, no divergence) and nothing not run. This passes on the tree
// before the fix.
test('finding 34 guard: the escalate-once denial carries no session and no sseq, and session replay is clean (PT9.7 rule 2, S146)', { timeout: 300_000 }, async () => {
  const { rt, denied, verdicts } = await scenario();
  assert.ok(denied, 'a denied verdict');
  assert.equal(denied.session ?? null, null, `no session on the denial: ${JSON.stringify(denied)}`);
  assert.equal(denied.sseq ?? null, null, `no sseq on the denial: ${JSON.stringify(denied)}`);
  assert.ok(verdicts.find((v) => v.outcome === 'escalated').sseq != null, 'the policy escalation did take an sseq');
  const replay = await rt.replaySessions();
  assert.ok(replay.length > 0, 'a session was replayed');
  assert.ok(replay.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(replay));
});
