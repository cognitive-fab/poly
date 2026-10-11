// plan-ex.md E2.2: the inbox's acceptance criteria on its drafts (S459 is in). A draft is written on the strong tier,
// citing the thread it read; the owner proposes it; its envelope (recipient, subject, In-Reply-To, References) comes
// from the source when it is proposed; the gate escalates it, and only the owner's signed approval lets it through
// (IAC2); the handler creates it as a Gmail draft in the thread, and never sends. IAC3: a body of another account is
// denied audience at the gate, and a variant that drafts from another account's thread is PL6831 at check. IAC5: an
// answer citing a message it was not given, or none, is refused uncited. IAC7: canaries in a message body and in every OAuth
// token appear in no record. IAC8: forgetting an account erases its bodies, and replay still folds. IAC9: CLEAN, and
// every run and gate session replays. Recorded traffic only: the corpus's Gmail tapes, a fake token endpoint, a fake
// drafts.create, and recorded model answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approvalFor } from './runtime-helpers.mjs';
import { admittedInbox, host, inbox, tape } from './ex-inbox-helpers.mjs';

const W1 = 'work/19a2f0c4d1e70a01';
const W2 = 'work/19a2f0c4d1e70a02';
const W3 = 'work/19a2f0c4d1e70a03';
const H1 = 'home/19a2f1aa00b30b01';
const TRIAGE = {
  [W1]: ['ActNowReply', 'Invoice'], [W2]: ['WeekReply', 'Invoice'], [W3]: ['Ignore', 'Newsletter'], 'work/19a2f0c4d1e70a04': ['Fyi', 'Other'],
  [H1]: ['WeekReply', 'Personal'], 'home/19a2f1aa00b30b02': ['Fyi', 'Notification'],
};
const DRAFT = 'Hello Alice, thank you: the invoice is approved and will be paid this week.';
/** Recorded answers; `write` is the draft's, which a test may replace. */
const answering = (write = (ids) => ({ answer: DRAFT, cites: ids })) => (decision, ids) => {
  if (decision === 'triage') return { answer: TRIAGE[ids[0]][0], p: 0.97 };
  if (decision === 'kind') return { answer: TRIAGE[ids[0]][1], p: 0.97 };
  if (decision === 'summary') return { answer: `To do about ${ids.length} message(s).` };
  if (decision === 'when') return { answer: 'ThisWeek', p: 0.9 };
  if (decision === 'write') return write(ids);
  throw new Error(`no recorded answer for ${decision}`);
};
const todo = (thread) => `todo:${thread.replace('/', ':')}`;
const INVOICE = todo(W1);
const verdictsOf = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.effectKind).map((e) => ({ kind: e.body.effectKind, outcome: e.body.outcome, reason: e.body.reason ?? null }));
const intentOf = (rt, id, kind) => rt.store.db.prepare('SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = ?').all(id, kind).map((r) => r.intent_id);
const statusOf = async (rt, id) => (await rt.getState(id)).state.status;

/** Syncs the accounts the tapes name, twice, settles, and opens each actionable thread's to-do. */
async function opened(i) {
  const { rt, source, accounts, settle } = i;
  const made = [];
  for (const a of accounts) for (let k = 0; k < 2; k++) made.push(...(await host.syncAccount(rt, source, a)).created);
  await settle();
  const todos = await host.openTodos(rt, made);
  await settle();
  return todos;
}
/** Asks for the invoice thread's draft and settles. */
async function written(i, id = INVOICE) {
  await i.rt.dispatch(id, 'WriteDraft', {});
  await i.settle();
  return statusOf(i.rt, id);
}
async function run(name, opts, body) {
  const a = await admittedInbox('ex-inbox-drafts');
  const dir = mkdtempSync(join(tmpdir(), `poly-ex-${name}-`));
  const i = await inbox(a, { db: join(dir, 'store.db'), ...opts });
  try { await body(i, dir, a); } finally {
    await i.rt.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
  }
}
const workTapes = () => { const w = tape('work'); return { work: [...w.initial, ...w.poll] }; };
const workOnly = (accounts) => accounts.filter((x) => x.label === 'work');

test('IAC2, S459: a proposed draft waits for the owner; with the signed approval it is created once, in the thread, addressed by the source\'s envelope', { timeout: 900_000 }, async () => {
  const { ACCOUNTS } = await import('./ex-inbox-helpers.mjs');
  await run('iac2', { tapes: workTapes(), answers: answering(), accounts: workOnly(ACCOUNTS) }, async (i) => {
    const { rt, settle, created } = i;
    assert.ok((await opened(i)).includes(INVOICE));
    assert.equal(await written(i), 'Drafted');
    await rt.dispatch(INVOICE, 'Propose', {});
    await settle();
    // The envelope came from the source, and the draft is escalated: nothing is created without a person's record.
    assert.equal(await statusOf(rt, INVOICE), 'Proposed');
    const [intent] = intentOf(rt, INVOICE, 'gmail.createDraft');
    assert.ok(intent);
    assert.deepEqual((await verdictsOf(rt, INVOICE)).filter((v) => v.kind === 'gmail.createDraft').map((v) => v.outcome), ['escalated']);
    assert.equal(created.length, 0);
    await rt.approve(await approvalFor(rt, intent));
    await settle();
    assert.equal(await statusOf(rt, INVOICE), 'Created');
    assert.equal(created.length, 1, 'one draft, once');
    const d = created[0];
    assert.deepEqual([d.label, d.auth, d.threadId], ['work', true, '19a2f0c4d1e70a01']);
    // The reply to the thread's newest message, the supplier's second, as the source gave it (RFC 5322 3.6.4).
    const head = d.raw.split('\r\n\r\n')[0].split('\r\n');
    assert.deepEqual(head.slice(0, 4), ['To: alice@supplier.example.com', 'Subject: Re: Invoice 4471 for the October delivery', 'In-Reply-To: <inv-4471-2@supplier.example.com>', 'References: <inv-4471@supplier.example.com> <inv-4471-2@supplier.example.com>']);
    assert.equal(Buffer.from(d.raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), DRAFT);
    // The handler never sends: the only Gmail write was drafts.create.
    assert.ok(i.seen.every((q) => q.method === 'GET'));
  });
});

test('IAC3: at run time, a draft of the work account carrying the home account\'s mail is denied audience at the gate, and nothing is created', { timeout: 900_000 }, async () => {
  const { ACCOUNTS } = await import('./ex-inbox-helpers.mjs');
  const w = tape('work');
  await run('iac3', { tapes: { work: [...w.initial, ...w.poll], home: [...tape('home').initial, ...tape('home').quiet] }, answers: answering(), accounts: ACCOUNTS.filter((x) => x.label !== 'club') }, async (i) => {
    const { rt, settle, created } = i;
    const todos = await opened(i);
    const home = todo(H1);
    assert.ok(todos.includes(INVOICE) && todos.includes(home), JSON.stringify(todos));
    // The home to-do's title is a summary of the home account's thread: a body with that account's taint.
    const foreign = (await rt.getState(home)).state.title;
    assert.ok(foreign);
    assert.equal(await written(i), 'Drafted');
    // The owner's page edits the work draft into that body, then proposes it.
    await rt.dispatch(INVOICE, 'Edit', { body: foreign });
    await rt.dispatch(INVOICE, 'Propose', {});
    await settle();
    const v = (await verdictsOf(rt, INVOICE)).filter((x) => x.kind === 'gmail.createDraft');
    assert.deepEqual(v.map((x) => [x.outcome, x.reason]), [['denied', 'audience']], JSON.stringify(v));
    assert.equal(created.length, 0);
    assert.equal(await statusOf(rt, INVOICE), 'Drafted', 'the denial is the effect\'s failure, and the draft stays');
  });
});

test('IAC5: a draft citing a message it was not given, or citing none, is refused uncited, and the to-do stays open', { timeout: 900_000 }, async () => {
  const { ACCOUNTS } = await import('./ex-inbox-helpers.mjs');
  let cite = () => [W3];
  await run('iac5', { tapes: workTapes(), answers: answering(() => ({ answer: DRAFT, cites: cite() })), accounts: workOnly(ACCOUNTS) }, async (i) => {
    const { rt } = i;
    await opened(i);
    // A message of another thread, which the decision was not given: the runtime refuses the answer (PS17.6).
    assert.equal(await written(i), 'Open');
    const run_ = (await rt.chain(INVOICE)).filter((e) => e.kind === 'observation' && e.body.stage === 'citation');
    assert.deepEqual(run_.map((e) => e.body.outcome), ['uncited']);
    assert.equal((await rt.getState(INVOICE)).state.draft, null);
    // An answer citing nothing: a citation is required (PS17.6 as amended, 58b59cd5), so it is refused uncited too.
    cite = () => [];
    assert.equal(await written(i), 'Open');
    assert.deepEqual((await rt.chain(INVOICE)).filter((e) => e.kind === 'observation' && e.body.stage === 'citation').map((e) => e.body.outcome), ['uncited', 'uncited']);
    assert.equal((await rt.getState(INVOICE)).state.draft, null);
    // With the thread cited, the draft is kept: the recorded provider reads `cite` at each call.
    cite = () => [W1, W2];
    assert.equal(await written(i), 'Drafted');
  });
});

const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];
/** Every text the run left: each column of each row of the store but the content store, each file, and what was printed. */
function outputs(rt, dirs, printed) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'poly_content') continue;
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push([`table ${name}`, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]);
  }
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (!p.endsWith('.db') && !p.endsWith('.db-wal') && !p.endsWith('.db-shm')) out.push([p, readFileSync(p, 'latin1')]); } };
  for (const d of dirs) walk(d);
  out.push(['printed', printed.join('')]);
  return out;
}
const found = (texts, canaries) => texts.flatMap(([where, text]) => canaries.flatMap((t) => (encodings(t).some((e) => text.includes(e)) ? [where] : [])));

test('IAC7: canaries in a message body and in every OAuth token appear in no state, journal, ledger, proposal, report, file or printed line, through a created draft', { timeout: 900_000 }, async () => {
  const { ACCOUNTS } = await import('./ex-inbox-helpers.mjs');
  const body = `canary-body-${randomBytes(9).toString('hex')}`;
  const prefix = `canary-token-${randomBytes(6).toString('hex')}`;
  // The invoice's first message, with the canary in its text (the tape's raw message, rewritten).
  const w = tape('work');
  const withCanary = (e) => {
    if (!e.request.url.includes('/messages/19a2f0c4d1e70a01?')) return e;
    const raw = Buffer.from(e.response.body.raw, 'base64url').toString('utf8').replace(/\r?\n\r?\n/, (sep) => `${sep}${body}\r\n`);
    return { ...e, response: { ...e.response, body: { ...e.response.body, raw: Buffer.from(raw, 'utf8').toString('base64url') } } };
  };
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...r) => { printed.push(String(c)); return write(c, ...r); };
  process.stderr.write = (c, ...r) => { printed.push(String(c)); return ewrite(c, ...r); };
  const tokens = [];
  try {
    await run('iac7', { tapes: { work: [...w.initial.map(withCanary), ...w.poll] }, answers: answering(), accounts: workOnly(ACCOUNTS), tokens: (k) => { const t = `${prefix}-${k}-${randomBytes(12).toString('base64url')}`; tokens.push(t); return t; } }, async (i, dir, a) => {
      const { rt, settle, created } = i;
      await opened(i);
      assert.equal(await written(i), 'Drafted');
      await rt.dispatch(INVOICE, 'Propose', {});
      await settle();
      await rt.approve(await approvalFor(rt, intentOf(rt, INVOICE, 'gmail.createDraft')[0]));
      await settle();
      assert.equal(created.length, 1, 'the run reached the draft, so the scan is not empty for want of one');
      // The run did read the body: the content store holds it, and the decisions were given it.
      const content = rt.store.db.prepare('SELECT * FROM poly_content').all().map((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v))).join(' ')).join('\n');
      assert.ok(content.includes(body), 'the canary body was kept in the content store');
      assert.ok(tokens.length >= 4, 'tokens were issued for both credentials');
      const hits = found(outputs(rt, [dir, a.dir], printed), [body, ...tokens]);
      assert.deepEqual([...new Set(hits)], []);
    });
  } finally { process.stdout.write = write; process.stderr.write = ewrite; }
});

test('IAC3 at check: the variant whose work draft is written from another account\'s thread gets PL6831, with its witness', { timeout: 600_000 }, async () => {
  const { checkFile } = await import('@poly/check');
  const { ROOT } = await import('./helpers.mjs');
  const r = await checkFile(join(ROOT, 'test', 'fixtures', 'ex-inbox', 'cross-account.poly'), { root: join(ROOT, '.poly', 'test-build', 'ex-inbox-iac3') });
  const all = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
  const leak = all.filter((d) => d.code === 'PL6831');
  assert.equal(r.verdict, 'FINDINGS', JSON.stringify([...new Set(all.map((d) => d.code))]));
  assert.deepEqual([...new Set(all.map((d) => d.code))], ['PL6831'], JSON.stringify([...new Set(all.map((d) => d.code))]));
  assert.ok(leak.some((d) => /createDraft/.test(d.message)), leak.map((d) => d.message).join('\n'));
  assert.ok(leak.every((d) => d.witness?.trace?.length > 0), 'each finding carries its witness');
  console.log(`IAC3 witness: ${leak[0].message}\n  ${leak[0].witness.trace.map((s) => s.action).join(' -> ')}`);
  // The same module with the draft read under its own account is CLEAN: the leak is the one change.
  const { readFileSync: read, writeFileSync: put, mkdirSync: mk } = await import('node:fs');
  const own = read(join(ROOT, 'test', 'fixtures', 'ex-inbox', 'cross-account.poly'), 'utf8').replace('emit read(owner: from, k: at)', 'emit read(owner: owner, k: at)').replace('emit read(owner: other, k: thread)', 'emit read(owner: account, k: thread)');
  const dir = join(ROOT, '.poly', 'test-build', 'ex-inbox-iac3-own');
  mk(dir, { recursive: true });
  put(join(dir, 'own.poly'), own);
  const c = await checkFile(join(dir, 'own.poly'), { root: join(dir, 'out') });
  assert.equal(c.verdict, 'CLEAN', JSON.stringify([...c.diagnostics, ...c.machines.flatMap((m) => m.diagnostics)].map((d) => `${d.code} ${d.message}`)));
});

/** The full path for two accounts: sync, triage, to-dos, the invoice's draft proposed, approved and created. */
async function throughDraft(i) {
  const { rt, settle } = i;
  await opened(i);
  assert.equal(await written(i), 'Drafted');
  await rt.dispatch(INVOICE, 'Propose', {});
  await settle();
  await rt.approve(await approvalFor(rt, intentOf(rt, INVOICE, 'gmail.createDraft')[0]));
  await settle();
  assert.equal(await statusOf(rt, INVOICE), 'Created');
}
const twoAccounts = async () => {
  const { ACCOUNTS } = await import('./ex-inbox-helpers.mjs');
  const w = tape('work');
  return { tapes: { work: [...w.initial, ...w.poll], home: [...tape('home').initial, ...tape('home').quiet] }, answers: answering(), accounts: ACCOUNTS.filter((x) => x.label !== 'club') };
};

test('IAC9: the inbox is CLEAN with its instance, and its journal replays every post-state, gate decision and tier choice from recorded providers', { timeout: 900_000 }, async () => {
  const { replayRuntime, replaySessions } = await import('@poly/check');
  const a = await admittedInbox('ex-inbox-drafts');
  // The admission's check of the project, the module with its policy: every machine, configuration and policy stage.
  const r = a.report;
  assert.equal(r.verdict, 'CLEAN');
  const machines = r.files.flatMap((f) => f.machines ?? []);
  assert.ok(machines.length >= 7 && machines.every((m) => m.verdict === 'CLEAN' && m.instance?.states > 0), JSON.stringify(machines.map((m) => [m.machine, m.verdict])));
  const policies = r.files.flatMap((f) => f.policies ?? []);
  assert.ok(policies.length === 1 && policies[0].stages.every((s) => s.status === 'ran' && s.verdict === 'CLEAN'), JSON.stringify(policies.map((p) => p.stages)));
  console.log(`IAC9 instance: ${machines.map((m) => `${m.machine} ${m.instance.states}`).join(', ')}`);
  await run('iac9', await twoAccounts(), async (i) => {
    const { rt } = i;
    await throughDraft(i);
    const replays = await replayRuntime(rt);
    assert.ok(replays.length > 0);
    for (const x of replays) assert.deepEqual([x.run, x.diagnostics, x.notRun ?? null, x.gateNotRun], [x.run, [], null, 0], JSON.stringify(x));
    // Every kind of run the path made is among them: messages, to-dos, the routes' tier choices, the budget, the grants.
    const kinds = new Set(replays.map((x) => x.machine));
    for (const m of ['inbox.Message', 'inbox.Todo', 'inbox.triage.Route', 'inbox.kinds.Route', 'inbox.monthly.Budget']) assert.ok(kinds.has(m), `${m} in ${[...kinds].join(', ')}`);
    assert.ok(replays.every((x) => x.folded === x.rows || x.folded > 0));
    // Every gate session replays its decisions and Σ (S118, S146).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0 && sessions.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(sessions.filter((s) => s.diagnostics.length || s.notRun.length)));
    console.log(`IAC9 replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions, ${sessions.reduce((n, s) => n + s.proposals, 0)} proposals`);
  });
});

test('IAC8: forgetting an account erases its bodies and its source\'s items, leaves the other account\'s, and the journal still replays, with the steps marked forgotten', { timeout: 900_000 }, async () => {
  const { replayRuntime } = await import('@poly/check');
  const { signRecord, forgetSubject } = await import('@poly/core');
  const { PERSON } = await import('./runtime-helpers.mjs');
  await run('iac8', await twoAccounts(), async (i) => {
    const { rt, accounts } = i;
    await throughDraft(i);
    const work = accounts.find((x) => x.label === 'work').owner;
    const home = todo(H1);
    const homeTitle = (await rt.getState(home)).state.title;
    const invoiceDraft = (await rt.getState(INVOICE)).state.draft;
    assert.ok(await rt.contentBody(invoiceDraft) && await rt.contentBody(homeTitle));
    const before = await replayRuntime(rt);
    assert.ok(before.every((x) => !x.diagnostics.length && !x.forgotten?.length));
    const { erased } = await rt.forget({ subject: work }, signRecord({ kind: 'forget', subject: forgetSubject(rt.anchorId, { subject: work }), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem));
    // The work account's bodies are erased: the mail the decisions read, the draft, the envelope.
    assert.ok(erased.includes(invoiceDraft), 'the draft, written from the work thread');
    for (const d of erased) assert.equal(await rt.contentBody(d), null, d);
    // The home account's are not.
    assert.ok(!erased.includes(homeTitle));
    assert.ok(await rt.contentBody(homeTitle));
    // The source forgot the account's items: a retrieval finds none of them.
    assert.deepEqual(await i.source.retrieve({ owner: work, limit: 10 }), []);
    assert.ok((await i.source.retrieve({ owner: accounts.find((x) => x.label === 'home').owner, limit: 10 })).length > 0);
    // The journal holds digests only: every chain verifies, and replay folds, each step naming an erased body forgotten.
    for (const id of [INVOICE, home]) assert.equal((await rt.verifyChain(id)).ok, true, id);
    const after = await replayRuntime(rt);
    for (const x of after) assert.deepEqual(x.diagnostics, [], x.run);
    const todoRun = after.find((x) => x.run === INVOICE);
    assert.ok(todoRun.forgotten?.some((f) => f.digest === invoiceDraft), JSON.stringify(todoRun.forgotten));
    assert.ok(!after.find((x) => x.run === home).forgotten?.length, 'the home to-do names nothing erased');
  });
});
