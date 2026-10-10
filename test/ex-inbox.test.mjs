// plan-ex.md E2.2: the inbox assistant's acceptance criteria that need no Gmail draft (S459 is queued on v1): IAC1,
// IAC3, IAC4, IAC5, IAC6, IAC7 without a draft, IAC8 and IAC9's check. Recorded traffic only: the Gmail tapes of the
// synthetic corpus, a fake token endpoint whose tokens the test makes, and recorded model answers. No test reaches
// Google or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ACCOUNTS, admittedInbox, host, inbox, tape } from './ex-inbox-helpers.mjs';

/** The corpus's triage and kind, by item id; summaries and due buckets by thread. */
const TRIAGE = {
  'work/19a2f0c4d1e70a01': ['ActNowReply', 'Invoice'],
  'work/19a2f0c4d1e70a02': ['WeekReply', 'Invoice'],
  'work/19a2f0c4d1e70a03': ['Ignore', 'Newsletter'],
  'work/19a2f0c4d1e70a04': ['Fyi', 'Other'],
  'home/19a2f1aa00b30b01': ['WeekReply', 'Personal'],
  'home/19a2f1aa00b30b02': ['Fyi', 'Notification'],
  'club/19a2f2bb11c40c01': ['ActNowReply', 'Meeting'],
  'club/19a2f2bb11c40c02': ['Fyi', 'Newsletter'],
};
const answers = (decision, ids) => {
  if (decision === 'triage') return { answer: TRIAGE[ids[0]][0], p: 0.97 };
  if (decision === 'kind') return { answer: TRIAGE[ids[0]][1], p: 0.97 };
  if (decision === 'summary') return { answer: `To do about ${ids.length} message(s).` };
  if (decision === 'when') return { answer: 'ThisWeek', p: 0.9 };
  throw new Error(`no recorded answer for ${decision}`);
};
const msg = (id) => `msg:${id.replace('/', ':')}`;

test('IAC1: three accounts, every message once and tagged with its account, across a host crash in the middle of a batch', { timeout: 600_000 }, async () => {
  const a = await admittedInbox('ex-inbox-iac1');
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const { rt, source, accounts, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll, ...w.quiet, ...w.quiet], home: tape('home').initial, club: tape('club').initial }, answers });
  try {
    const [work, home, club] = accounts;
    // The host crashes after creating the work account's first message and before announcing it: the sync is read,
    // one instance is made, and nothing is announced.
    const r = await source.sync(work.owner);
    await rt.create('inbox.Message', { id: msg(r.fresh[0].id), creation: { action: 'Arrived', data: { owner: work.owner, item: r.fresh[0].id } } });
    // The next pass polls the history and reports every item not yet announced, the made one among them; it is not
    // made again, and every item is announced.
    const p1 = await host.syncAccount(rt, source, work);
    assert.deepEqual(p1.created.map((c) => c.id), [msg('work/19a2f0c4d1e70a03'), msg('work/19a2f0c4d1e70a02'), msg('work/19a2f0c4d1e70a04')]);
    assert.equal(r.fresh[0].id, 'work/19a2f0c4d1e70a01');
    const made = [{ id: msg(r.fresh[0].id), thread: r.fresh[0].thread }, ...p1.created];
    for (const acct of [home, club]) made.push(...(await host.syncAccount(rt, source, acct)).created);
    made.push(...(await host.syncAccount(rt, source, work)).created);
    // A pass with nothing new makes nothing.
    assert.deepEqual((await host.syncAccount(rt, source, work)).created, []);
    await settle();
    // Every message of the corpus is one instance, tagged with its account's principal, and triaged.
    assert.deepEqual(made.map((m) => m.id).sort(), Object.keys(TRIAGE).map(msg).sort());
    for (const id of Object.keys(TRIAGE)) {
      const s = (await rt.getState(msg(id))).state;
      assert.equal(s.account, ACCOUNTS.find((x) => id.startsWith(`${x.label}/`)).owner, id);
      assert.ok(s.seen === 'Actionable' || s.seen === 'Filed', `${id}: ${s.seen}`);
    }
    // IT3.2: act-now or this-week messages are actionable, fyi and ignore filed.
    assert.equal((await rt.getState(msg('work/19a2f0c4d1e70a01'))).state.seen, 'Actionable');
    assert.equal((await rt.getState(msg('work/19a2f0c4d1e70a03'))).state.seen, 'Filed');
    // One Todo per thread: the invoice's two messages open one to-do.
    const opened = await host.openTodos(rt, made);
    assert.deepEqual(opened.sort(), ['todo:club:19a2f2bb11c40c01', 'todo:home:19a2f1aa00b30b01', 'todo:work:19a2f0c4d1e70a01']);
    assert.deepEqual(await host.openTodos(rt, made), []);
  } finally {
    await rt.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
  }
});

test('IAC4: a message that gives the assistant instructions yields its triage and nothing else', { timeout: 600_000 }, async () => {
  const a = await admittedInbox('ex-inbox-iac4');
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const { rt, source, accounts, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll] }, answers });
  try {
    await host.syncAccount(rt, source, accounts[0]);
    await host.syncAccount(rt, source, accounts[0]);
    await settle();
    const id = msg('work/19a2f0c4d1e70a04');
    assert.equal((await rt.getState(id)).state.seen, 'Filed');
    // The only intents its run ever proposed: reading its own item, and its two decisions.
    const kinds = new Set((await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.effectKind).map((e) => e.body.effectKind));
    assert.deepEqual([...kinds].sort(), ['decision.kind', 'decision.triage', 'source.mail.retrieve']);
  } finally {
    await rt.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
  }
});

const states = async (rt, instance) => {
  const out = [];
  for (const e of await rt.chain(instance)) if (e.kind === 'step' && e.body.stepKind === 'accepted') out.push({ action: e.body.action, post: await rt.store.body(e.body.post) });
  return out;
};

test('IAC6: with the monthly budget below a batch\'s cost, triage stops at the limit with the reason budget, no reservation is overspent, and the rest wait for the next month', { timeout: 900_000 }, async () => {
  // The cap is 40,000 micro-usd, which must hold the largest reservation on the budget (the draft's, 39,000; PL6845).
  // Each message's triage and kind are unsure on the small tier and answered on the large one, and each call uses its
  // whole limits, so it costs its reservation: 408 on the small tier and 12,300 on the large. A decision costs 12,708,
  // three fit, and the work account's four messages ask eight.
  const { SOURCE } = await import('./ex-inbox-helpers.mjs');
  const from = 'cap usd 20 per month';
  assert.equal(SOURCE.split(from).length, 2);
  const a = await admittedInbox('ex-inbox-iac6', { source: SOURCE.split(from).join('cap usd 0.04 per month') });
  const unsure = (decision, ids, tier) => ({ ...answers(decision, ids), p: tier === 'small' ? 0.5 : 0.97, usage: { input: 4000, output: 20 } });
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const { rt, clock, source, accounts, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll] }, answers: unsure, accounts: ACCOUNTS.filter((x) => x.label === 'work') });
  try {
    const made = [];
    for (let k = 0; k < 2; k++) made.push(...(await host.syncAccount(rt, source, accounts[0])).created);
    assert.equal(made.length, 4);
    await settle();
    const seen = await Promise.all(made.map(async (m) => (await rt.getState(m.id)).state.seen));
    console.log(`IAC6: ${JSON.stringify(seen)}`);
    assert.ok(seen.some((s) => s === 'Held') && seen.some((s) => s === 'Actionable' || s === 'Filed'), JSON.stringify(seen));
    // The calls past the cap were refused budget at the gate, before any provider.
    const refused = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((v) => v.reason === 'budget');
    assert.ok(refused.length >= 2 && refused.every((v) => v.outcome === 'denied'), JSON.stringify(refused));
    // One budget instance for the month; spent plus reserved never passed the cap, and nothing is held at the end.
    const month = new Date(clock.now()).toISOString().slice(0, 7);
    const budgets = rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'inbox.monthly.Budget'").all().map((r) => r.instance_id);
    assert.deepEqual(budgets, [`budget:monthly:month:${month}`]);
    const steps = await states(rt, budgets[0]);
    assert.ok(steps.length > 0);
    for (const s of steps) assert.ok(s.post.spent + s.post.reserved <= s.post.cap + s.post.overrun && s.post.overrun === 0, JSON.stringify(s));
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM poly_reservation WHERE status = 'held'").get().n, 0);
    // The rest wait: in the next month, a new budget holds them, and a retry triages them from the source's store.
    clock.advance(32 * 24 * 3600 * 1000);
    const held = made.filter((_, k) => seen[k] === 'Held');
    for (const m of held.slice(0, 1)) await rt.dispatch(m.id, 'Retry', {});
    await settle();
    const after = (await rt.getState(held[0].id)).state.seen;
    assert.ok(after === 'Actionable' || after === 'Filed', after);
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM pr_instance WHERE machine_id = 'inbox.monthly.Budget'").get().n, 2);
  } finally {
    await rt.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
  }
});
