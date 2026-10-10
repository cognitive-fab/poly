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
