// S586: the stores the risk report reads, built through the runtime as a deployment builds them (PT34.4). Shared by
// test/s586-report.test.mjs and test/s586-tags-lowering.test.mjs. Each scenario is written once and run with the
// policy tagged or with every tag removed: by PS8.10 the two write the same decisions, so the untagged run, which this
// tree can admit before S586 is built, is the guard that the store holds what the report tests count.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admit } from '@poly/check';
import { load } from '@poly/runtime';
import { ROOT } from '../../helpers.mjs';
import { PERSON, approveAs, handleWith, makeKey, project, signPolicies } from '../../runtime-helpers.mjs';

export const DESK = readFileSync(join(ROOT, 'test', 'fixtures', 's586', 'riskdesk.poly'), 'utf8');

// The tags (PT8.6): two deny rules on one kind, so a refusal has two items that would refuse it (PT34.4, one item per
// refusal); an escalation; a rule with `on unknown`; a rule that names no risk; a recalled item with a risk.
export const DESK_POLICY = [
  '// S586: the risk desk\'s policy, tagged (PT8.6).',
  'module riskdesk_policy',
  '',
  'policy desk {',
  '  scope "riskdesk"',
  '  obligation no-wire "No wire is sent." mitigates "mit:2.1" implements "nist:MANAGE-2.4" rule {',
  '    when effect.kind == "desk.wire"',
  '    require false else deny',
  '  }',
  '  obligation wire-checked "A wire is refused before it leaves." mitigates "mit:4.3" rule {',
  '    when effect.kind == "desk.wire"',
  '    require false else deny',
  '  }',
  '  obligation refund-reviewed "A person approves every refund." mitigates "mit:7.3" implements "iso:A.9.2" rule {',
  '    when effect.kind == "desk.refund"',
  '    require false else escalate',
  '  }',
  '  obligation mail-while-clerk-works "Mail goes out only while the clerk is working." mitigates "mit:3.1" implements "nist:MAP-3.5" rule {',
  '    when effect.kind == "desk.mail" && machine("riskdesk.Clerk").phase == Working',
  '    require false else deny',
  '    on unknown deny',
  '  }',
  '  obligation no-ping "The clerk pings nobody." rule {',
  '    when effect.kind == "clerk.ping"',
  '    require false else deny',
  '  }',
  '  recalled tone "Replies are short." mitigates "mit:3.1"',
  '}',
  '',
].join('\n');

/** The same text with every tag clause removed (PS8.10's "the same policies with every tag removed"). */
export const untag = (text) => text.replace(/[ \t]+(mitigates|implements)[ \t]+"[^"]*"([ \t]*,[ \t]*"[^"]*")*/g, '');

/** The exposure the tagged desk declares: mit:6.1 is named by no item, so the report lists it as not covered. */
export const DESK_EXPOSURE = ['mit:2.1', 'mit:6.1', 'mit:7.3'];

export const T0 = 1_790_000_000_000; // 2026-09-21T14:13:20Z
export const DAY1 = '2026-09-21';
export const DAY2 = '2026-09-22';
export const ESCALATION_TIMEOUT_MS = 600_000;

// The instances and what happens to each. Day 1: a mail decided on unknown input, a wire refused, a ping refused by the
// rule that names no risk. The mail comes first: while no clerk exists, the mail rule's read of the clerk is unknown (a
// clerk read once one exists was measured on this tree to read its snapshot, recorded under `singletons`). Day 2: a note
// allowed, a note allowed whose handler fails until it is exhausted (an unknown outcome, PT34.4 item 5), a refund
// approved, a refund approved whose handler is exhausted, a refund timed out, a note whose allow is stale three times
// (`stale-allow`, a refusal by the runtime), a refund left open, and an instance with a step and no gate record.
export const RUNS = {
  refused: 'w-1', untaggedRefused: 'c-1', allowed: 'n-1', exhausted: 'n-2', unknown: 'm-1', approved: 'r-approved',
  approvedExhausted: 'r-exhausted', timedOut: 'r-timeout', stale: 's-1', open: 'r-open', noGate: 'idle-1',
};
const FAILING = new Set([RUNS.exhausted, RUNS.approvedExhausted]);

/** The public keys a report is given (`--trust`): the ledger's, and the admission key's. */
function trustFiles(dir, signer, key) {
  const ledger = join(dir, 'ledger.pub.pem');
  const admission = join(dir, 'admission.pub.pem');
  writeFileSync(ledger, signer.publicKey);
  writeFileSync(admission, key.publicKey);
  return { ledger: { id: signer.id, file: ledger }, admission: { id: key.id, file: admission } };
}

/**
 * Admits the desk (tagged or not), runs every instance of RUNS through the runtime on a store file with a ledger
 * signer, signs every head and publishes an anchor, so that `poly journal verify` vouches for each run.
 */
export async function deskScenario({ tagged, name = tagged ? 's586-desk-tagged' : 's586-desk-untagged' } = {}) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-s586-report');
  writeFileSync(join(dir, 'src', 'riskdesk.poly'), DESK);
  writeFileSync(join(dir, 'src', 'riskdesk.policy.poly'), tagged ? DESK_POLICY : untag(DESK_POLICY));
  if (tagged) {
    const pj = join(dir, 'poly.json');
    writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), exposure: { risks: DESK_EXPOSURE } }, null, 2));
  }
  await signPolicies(dir);
  const admitted = await admit(dir);
  const build = join(dir, '.poly', 'build');
  const certificate = join(dir, 'certificate.json');
  copyFileSync(admitted.certificatePath, certificate);
  const signer = makeKey(`${name}-ledger`);
  const db = join(dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock.db`]) rmSync(f, { force: true });
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(build, {
    certificate: admitted.certificatePath, trust: { [key.id]: key.publicKey }, now: clock.now,
    store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
    gate: { escalationTimeoutMs: ESCALATION_TIMEOUT_MS },
    worker: { isStale: (row) => row.instance_id === RUNS.stale },
  });
  const calls = [];
  const exhausted = {};
  try {
    const script = (_payload, _caps, ctx) => {
      calls.push(ctx.instanceId);
      if (FAILING.has(ctx.instanceId)) throw new Error('scripted failure');
      return `${ctx.instanceId}|ok`;
    };
    for (const kind of ['desk.wire', 'desk.refund', 'desk.note', 'desk.mail', 'clerk.ping']) handleWith(rt, kind, script);
    const go = async (machine, id) => { await rt.create(`riskdesk.${machine}`, { id }); await rt.dispatch(id, 'Go'); };
    const settle = async (n = 8) => { for (let k = 0; k < n; k++) { clock.advance(1_000); await rt.worker.tick(); } };
    const intentOf = async (id) => (await rt.outbox(id))[0].intent_id;
    // Day 1.
    await go('Mail', RUNS.unknown);
    await settle(4);
    await go('Wire', RUNS.refused);
    await go('Clerk', RUNS.untaggedRefused);
    await settle();
    // Day 2.
    clock.advance(86_400_000);
    await go('Note', RUNS.allowed);
    await go('Note', RUNS.exhausted);
    await settle(12);
    for (const id of [RUNS.approved, RUNS.approvedExhausted]) {
      await go('Refund', id);
      await settle(2);
      await approveAs(rt, await intentOf(id));
      await settle(12);
    }
    await go('Refund', RUNS.timedOut);
    await settle(2);
    clock.advance(ESCALATION_TIMEOUT_MS + 60_000);
    await settle(2);
    await go('Note', RUNS.stale);
    await settle(12);
    await go('Refund', RUNS.open);
    await settle(2);
    await rt.create('riskdesk.Note', { id: RUNS.noGate });
    await rt.dispatch(RUNS.noGate, 'Worked'); // rejected: a step, and no gate record
    // What the guard reads of the two exhausted intents: the exhausted completion, as test/outbox-intent.test.mjs reads it.
    for (const id of [RUNS.exhausted, RUNS.approvedExhausted]) exhausted[id] = (await rt.getJournal(id)).some((x) => x.action === 'Gave' && String(x.action_id).endsWith(':exhausted'));
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { await rt.close(); }
  const trust = trustFiles(dir, signer, key);
  return { dir, key, signer, db, build, certificate, cert: admitted.certificate, trust, calls, exhausted, end: clock.now() };
}

// The escalate-once policy of test/finding34-escalate-once-record.test.mjs, tagged.
export const REVIEW_POLICY = [
  'module concierge_memory_policy',
  '',
  'policy review-answers {',
  '  scope "concierge_memory"',
  '  obligation person-reviews "Every answer waits for a person." mitigates "mit:3.1" implements "nist:MANAGE-2.4" rule {',
  '    when proposal.kind == "effect" && effect.kind == "decision.answer"',
  '    require false else escalate',
  '    on unknown escalate',
  '  }',
  '}',
  '',
].join('\n');

// Values the journal keeps only as digests or in its content store (PT34.4 item 7): the customer's question, the order's
// summary and the customer's principal. The report must print none of them (RT12).
export const CANARIES = { question: 'canary-question-5e1f9a', summary: 'canary-summary-5e1f9a', principal: 'canary-principal-5e1f9a' };

/**
 * Finding 34's run (PT9.7 rule 2) on a store file with a ledger signer: the concierge's answer is escalated by the
 * policy, approved two hours later, and at the re-proposal freshness escalates `stale-items` again, so the intent is
 * denied `escalate-once` with `gateDecision: "escalate"` and `escalatedBy: "stale-items"`.
 */
export async function escalateOnceScenario({ tagged, name = tagged ? 's586-once-tagged' : 's586-once-untagged' } = {}) {
  const { postgresSource } = await import('@poly/io');
  const { pgOrders } = await import('../../memory-helpers.mjs');
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m10/concierge-memory.poly'], key, 'test-s586-report');
  writeFileSync(join(dir, 'src', 'review.policy.poly'), tagged ? REVIEW_POLICY : untag(REVIEW_POLICY));
  await signPolicies(dir);
  const admitted = await admit(dir);
  const build = join(dir, '.poly', 'build');
  const certificate = join(dir, 'certificate.json');
  copyFileSync(admitted.certificatePath, certificate);
  const signer = makeKey(`${name}-ledger`);
  const db = join(dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock.db`]) rmSync(f, { force: true });
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(build, {
    certificate: admitted.certificatePath, trust: { [key.id]: key.publicKey }, now: clock.now,
    store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
    verifier: (c) => (c ? { principal: c.principal } : null),
  });
  let intent;
  try {
    const orders = pgOrders([{ order_id: 'o-1', customer_id: CANARIES.principal, updated_at: new Date(clock.now()).toISOString(), summary: `Order 1: ${CANARIES.summary}.` }]);
    rt.connectSource('orders', postgresSource({ query: orders.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.provide('answer', { provider: (_q, m) => ({ answer: 'ok', distribution: [['ok', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }), model: 'flash' });
    handleWith(rt, 'support.reply', () => ({ ok: true }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await rt.dispatch('desk', 'Ask', { question: await rt.putContent(`Where is my order? ${CANARIES.question}`) }, { credentials: { principal: CANARIES.principal } });
    for (let k = 0; k < 6; k++) await rt.worker.tick();
    clock.advance(2 * 3600_000);
    intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'desk' AND kind = 'decision.answer'").get().intent_id;
    await approveAs(rt, intent);
    for (let k = 0; k < 6; k++) await rt.worker.tick();
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { await rt.close(); }
  const trust = trustFiles(dir, signer, key);
  return { dir, key, signer, db, build, certificate, cert: admitted.certificate, trust, intent };
}

/** The bodies of every event of a kind in a store, by run, read straight from the ledger table. */
export function eventsOf(db, kind) {
  const sql = new DatabaseSync(db, { readOnly: true });
  try {
    return sql.prepare('SELECT run, seq, event FROM poly_ledger WHERE kind = ? ORDER BY run, seq').all(kind).map((r) => ({ ...JSON.parse(r.event), run: r.run, seq: r.seq }));
  } finally { sql.close(); }
}

/** The runs a store holds, by id. */
export function runsOf(db) {
  const sql = new DatabaseSync(db, { readOnly: true });
  try { return [...new Set(sql.prepare('SELECT DISTINCT run FROM poly_ledger').all().map((r) => r.run))].sort(); } finally { sql.close(); }
}

/** A copy of a store under another name, with its write-ahead log, so a test may change it without touching the original. */
export function copyStore(db, to) {
  for (const f of [to, `${to}-wal`, `${to}-shm`]) rmSync(f, { force: true });
  copyFileSync(db, to);
  for (const x of ['-wal', '-shm']) if (existsSync(`${db}${x}`)) copyFileSync(`${db}${x}`, `${to}${x}`);
  return to;
}

export { PERSON };
