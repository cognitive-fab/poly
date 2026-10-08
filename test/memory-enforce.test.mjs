// M10 steps 6 and 8 (PT10k, PS17.3, PS17.4, PS17.6, S302, S305, S307): the flow check before the grant check and the
// policy, freshness, and the proposal fields taint and items, which a policy reads. AC22's run-time half: the concierge
// without `where owner == customer`, loaded through a witness certificate, has its reply to the customer denied
// audience before its handler runs. Every provider and source is recorded; no test reaches a database or a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, admitWitness, checkFile } from '@poly/check';
import { load } from '@poly/runtime';
import { postgresSource } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { admitted, handleWith, loaded, makeKey, project, approveAs } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const CONCIERGE = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'concierge-memory.poly'), 'utf8');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const verifier = (c) => (c ? { principal: c.principal } : null);

/** Loads a build, connects the orders source and a recorded provider, and runs one question from a customer. */
async function run(rt, customer, opts = {}) {
  const db = pgOrders();
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  const asked = [];
  rt.provide('answer', { provider: (q, m) => { asked.push(m); return { answer: `About ${Object.values(m.items).flat().map((i) => i.id).join(', ')}`, distribution: [['x', 0.9]], cites: [] }; }, model: 'flash' });
  const sent = [];
  handleWith(rt, 'support.reply', (payload) => { sent.push(payload); return { ok: true }; });
  if (opts.advance) opts.clock.advance(opts.advance);
  await rt.create('concierge_memory.Desk', { id: 'desk' });
  const q = await rt.putContent('Where is my order?');
  await rt.dispatch('desk', 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 6; k++) await rt.worker.tick();
  const verdicts = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all().map((r) => JSON.parse(r.event).body);
  return { sent, asked, verdicts };
}

test('PT10k: the concierge\'s reply to its own customer is allowed, proposed with the taint of the orders it read', async () => {
  const a = await admitted('memory-enforce-ok', ['test/fixtures/m10/concierge-memory.poly']);
  const { rt } = await loaded(a, { verifier });
  try {
    const { sent, verdicts } = await run(rt, 'cust-a');
    assert.equal(sent.length, 1, JSON.stringify(verdicts));
    const v = verdicts.find((x) => x.effectKind === 'support.reply' && x.outcome === 'allowed');
    const proposal = JSON.parse(rt.store.db.prepare('SELECT body FROM poly_kept WHERE digest = ?').get(v.proposal).body);
    assert.equal(proposal.taint.class, 'customer');
    assert.equal(proposal.taint.owners.length, 1);
    assert.match(proposal.taint.owners[0], /^hmac-sha256:/, 'an owner is proposed by its keyed digest, never as itself');
    const answer = verdicts.find((x) => x.effectKind === 'decision.answer' && x.outcome === 'allowed');
    const ap = JSON.parse(rt.store.db.prepare('SELECT body FROM poly_kept WHERE digest = ?').get(answer.proposal).body);
    assert.deepEqual([ap.items.count, ap.items.class], [2, 'customer']);
    assert.ok(Number.isInteger(ap.items.ageMs));
  } finally { await rt.close(); }
});

test('AC22 (run time): the variant without where owner == customer has its reply denied audience before the handler runs', async () => {
  const key = makeKey('memory-enforce-leak');
  const dir = project('memory-enforce-leak', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), swap(CONCIERGE, ' where owner == customer', ''));
  const checked = await checkFile(join(dir, 'src', 'concierge-memory.poly'), { root: join(dir, '.poly', 'scratch') });
  assert.ok(checked.machines[0].diagnostics.some((d) => d.code === 'PL6831'), 'the checker finds the leak first');
  const w = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') });
  const rt = await load(join(dir, '.poly', 'build'), { certificate: w.certificatePath, trust: { [key.id]: key.publicKey }, allowWitness: true, verifier, now: () => 1_790_000_000_000 });
  try {
    const { sent, verdicts } = await run(rt, 'cust-a');
    assert.equal(sent.length, 0, 'the reply never reached its handler');
    const denied = verdicts.find((x) => x.effectKind === 'support.reply');
    assert.ok(denied, JSON.stringify(verdicts.map((x) => [x.effectKind, x.outcome, x.reason])) + JSON.stringify(rt.store.db.prepare("SELECT kind, status, last_error FROM pr_outbox WHERE instance_id = 'desk'").all()));
    assert.deepEqual([denied.outcome, denied.reason], ['denied', 'audience']);
  } finally { await rt.close(); }
});

test('S302: a body with no taint record is refused audience, fail closed', async () => {
  const a = await admitted('memory-enforce-norecord', ['test/fixtures/m10/concierge-memory.poly']);
  const { rt } = await loaded(a, { verifier });
  try {
    const d = `sha256:${'a'.repeat(64)}`;
    const r = rt.memory.check({ machineId: 'concierge_memory.Desk', kind: 'support.reply', payload: { customer: 'cust-a', body: d }, decl: { recipient: { to: 'customer', audience: 'public' } }, step: { action: 'Answered', claims: null }, channelAudience: null, approved: false, now: rt.now(), keyed: (s) => s });
    assert.deepEqual(r, { deny: 'audience' });
    // PS15.0a: a channel's provider effect is judged at the channel's class; a body of class customer reaches a staff channel.
    const body = await rt.putContent('Order 2: two lamps.');
    rt.store.db.exec('BEGIN'); rt.memory.taint(body, { c: 1, o: ['cust-a'] }); rt.store.db.exec('COMMIT');
    const send = (aud) => rt.memory.check({ machineId: 'concierge_memory.text.Conversation', kind: 'channel.text.send', payload: { body }, decl: {}, step: { action: 'Reply', claims: null }, channelAudience: aud, approved: false, now: rt.now(), keyed: (s) => s });
    assert.deepEqual(send('customer'), { deny: 'audience' });
    assert.equal(send('staff').fields.taint.class, 'customer');
  } finally { await rt.close(); }
});

test('S307: orders older than their source\'s freshness escalate the answer, stale-items, and an approval lets it through', async () => {
  const a = await admitted('memory-enforce-stale', ['test/fixtures/m10/concierge-memory.poly']);
  const { rt, clock } = await loaded(a, { verifier });
  try {
    // The oldest order is from 1 October 09:30; the clock is moved past it by more than the hour freshness allows.
    const { asked, verdicts } = await run(rt, 'cust-a', { clock, advance: Date.parse('2026-10-08T00:00:00Z') - clock.now() });
    const esc = verdicts.find((x) => x.effectKind === 'decision.answer');
    assert.deepEqual([esc.outcome, esc.reason], ['escalated', 'stale-items']);
    assert.equal(asked.length, 0, 'the model is not asked while the escalation waits');
    const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'desk' AND kind = 'decision.answer'").get().intent_id;
    await approveAs(rt, intent);
    for (let k = 0; k < 4; k++) await rt.worker.tick();
    assert.equal(asked.length, 1, 'approved, the decision is asked');
  } finally { await rt.close(); }
});

test('S307: with stale deny, the answer over stale orders is denied stale-items and its failed outcome runs', async () => {
  const key = makeKey('memory-enforce-deny');
  const dir = project('memory-enforce-deny', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), swap(CONCIERGE, '  freshness 1h\n', '  freshness 1h\n  stale deny\n'));
  const r = await admit(dir);
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
  try {
    const { asked, verdicts } = await run(rt, 'cust-a', { clock, advance: Date.parse('2026-10-08T00:00:00Z') - clock.now() });
    const den = verdicts.find((x) => x.effectKind === 'decision.answer');
    assert.deepEqual([den.outcome, den.reason], ['denied', 'stale-items']);
    assert.equal(asked.length, 0);
    assert.equal((await rt.getState('desk')).state.phase, 'Idle');
  } finally { await rt.close(); }
});

test('PT10k: a policy reads effect.items.age and effect.taint.class; its never is proved over the decision table, and its seeded control fails', async () => {
  const both = ['test/fixtures/m10/concierge-memory.poly', 'test/fixtures/m10/concierge-memory.policy.poly'];
  const a = await admitted('memory-enforce-policy', both);
  const { rt, clock } = await loaded(a, { verifier });
  try {
    // Two days past the oldest order: the source escalates (stale escalate), an approval re-proposes, and the policy
    // denies an answer over orders more than a day old.
    const { asked, verdicts } = await run(rt, 'cust-a', { clock, advance: Date.parse('2026-10-08T00:00:00Z') - clock.now() });
    const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'desk' AND kind = 'decision.answer'").get().intent_id;
    assert.equal(verdicts.find((x) => x.effectKind === 'decision.answer').reason, 'stale-items');
    await approveAs(rt, intent);
    for (let k = 0; k < 4; k++) await rt.worker.tick();
    assert.equal(asked.length, 0, 'the policy denied it');
    const last = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all().map((x) => JSON.parse(x.event).body).filter((x) => x.effectKind === 'decision.answer').pop();
    assert.equal(last.outcome, 'denied');
  } finally { await rt.close(); }
  // The seeded control: without the rule, the never statement is broken over the decision table.
  const key = makeKey('memory-enforce-policy-control');
  const dir = project('memory-enforce-policy-control', both, key, 'test-runtime');
  const pol = join(dir, 'src', 'concierge-memory.policy.poly');
  const src = readFileSync(pol, 'utf8');
  writeFileSync(pol, src.replace(/  obligation fresh-answers[\s\S]*?on unknown deny\n  \}\n/, ''));
  const { checkProject } = await import('@poly/check');
  const p = await checkProject(dir);
  assert.ok(p.files.flatMap((f) => f.policies.flatMap((x) => x.diagnostics)).some((d) => d.code === 'PL6503'), 'the never is refuted without the rule');
});
