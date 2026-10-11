// M7.1 acceptance (PF10.1, PS19, PT29): the export of both release examples' recorded runs, with the canary and the
// erasure tests passing. In the serial after group, because each example's admission checks its program.
//
// This is the fixture step: each example's real recorded sequence (AC27 for the concierge, IAC9 and IAC8 for the inbox,
// copied from test/after/ex-concierge-e2e.test.mjs and test/ex-inbox-drafts.test.mjs, which stay as they are) runs
// against a sqlite store that the test keeps, the runtime is closed, and `poly export traces` reads the store as a
// person would. The expectations are computed from the runtime's own API and from the example's source, never from
// the export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit, replayRuntime } from '@poly/check';
import { forgetSubject, grantRequestSubject, signRecord } from '@poly/core';
import { whatsapp, slack, postgresSource, oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { ACCEPT_TEST_ANCHORS, ROOT } from '../helpers.mjs';
import { PERSON, approvalFor, handleWith, loaded, makeKey, project, signPolicies } from '../runtime-helpers.mjs';
import { fakeStripe, memoryWrap, orderRows, ordersTable } from '../ex-concierge-helpers.mjs';
import { recorded, whatsappWebhook, slackWebhook } from '../concierge-helpers.mjs';
import { ACCOUNTS, admittedInbox, host, inbox, tape } from '../ex-inbox-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex'), encodeURIComponent(s)];
const CONSEQUENCES = new Set(['none', 'reversible', 'compensable', 'irreversible', 'unknown']);
const GATE = new Set(['allowed', 'denied', 'escalated', 'late', 'held']);
const FIXED = ['v', 'kind', 'poly.traces', 'accepted', 'rejected', 'unhandled', 'Correct', 'Wrong', '$create', '$undeliverable', '$migrate', 'poisoned', 'outside-check-domain', ...CONSEQUENCES, ...GATE];

/** The words of an example: its sources, its policy, and the build's manifests, split on anything that is not a name. */
function vocabulary(dir, build) {
  const words = new Set(FIXED);
  const add = (text) => { for (const w of text.match(/[A-Za-z_$][\w$-]*/g) ?? []) words.add(w); };
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(poly|json|cjs|mjs|ts)$/.test(e.name)) add(readFileSync(p, 'utf8')); } };
  walk(join(dir, 'src'));
  walk(build);
  return words;
}

/** The export, as the command writes it; the expectations of the caller come from elsewhere. */
function exportOf(a, db, file, ...extra) {
  const pub = join(a.dir, 'admission.pub');
  writeFileSync(pub, a.key.publicKey);
  const r = poly('export', 'traces', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${pub}`, '--out', file, ...extra);
  assert.equal(r.code, 0, r.out);
  const bytes = readFileSync(file, 'utf8');
  const lines = bytes.trim().split('\n').map((l) => JSON.parse(l));
  return { header: lines[0], episodes: lines.slice(1), bytes };
}

/** The properties every corpus has (PS19, PT29), whatever the example. */
function corpusProperties(x, { vocab, runs, secrets }) {
  const { header, episodes, bytes } = x;
  assert.deepEqual([header.v, header.kind], [1, 'poly.traces']);
  assert.equal(header.episodes, episodes.length);
  assert.ok(episodes.length > 0 && episodes.some((e) => e.steps.length > 2), 'the export is not empty');
  // Every run the store holds is an episode, or is counted as omitted (PS19.6).
  const o = header.omitted;
  assert.equal(episodes.length + o.runtimeRuns + o.archivedRuns + o.erasedRuns, runs, JSON.stringify(header));
  assert.equal(episodes.filter((e) => e.gapped).length, o.gappedRuns);
  // Consequences are the four words or unknown; the header counts the unknown ones.
  let unknown = 0; let effects = 0; const gates = new Set(); const by = {};
  for (const e of episodes) for (const s of e.steps) for (const f of s.effects) {
    effects++;
    assert.ok(CONSEQUENCES.has(f.consequence), f.consequence);
    by[f.consequence] = (by[f.consequence] ?? 0) + 1;
    if (f.consequence === 'unknown') unknown++;
    if (f.gate) { assert.ok(GATE.has(f.gate.outcome), JSON.stringify(f.gate)); gates.add(f.gate.outcome); }
  }
  assert.equal(header.unknown.consequence, unknown);
  // PS19.3: over every run of consecutive seq values the post-state of a step is the pre-state of the next.
  let chained = 0;
  for (const e of episodes) for (let i = 1; i < e.steps.length; i++) {
    const [p, q] = [e.steps[i - 1], e.steps[i]];
    if (q.seq === p.seq + 1) { assert.deepEqual(q.pre, p.post, `${e.machine} seq ${q.seq}`); chained++; }
    else assert.ok(e.gapped, `a seq gap in an episode that is not gapped: ${e.machine} ${p.seq} to ${q.seq}`);
  }
  assert.ok(chained > 0);
  // PT29.5: no secret in any byte or encoding; every string is a name the example declares, a fixed word or a token.
  for (const s of secrets) for (const form of encodings(s)) assert.ok(!bytes.includes(form), `${s} appears as ${form}`);
  assert.ok(!JSON.stringify(episodes).includes('sha256:'), 'no journal digest in an episode');
  const bad = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (/^d:[0-9a-f]{32}$/.test(v) || v === header.project || v === header.certificate) return;
      const words = v.match(/[A-Za-z_$][\w$-]*|\d+/g) ?? [];
      if (!words.every((w) => /^\d+$/.test(w) || vocab.has(w))) bad.push(`${path}: ${v}`);
    } else if (Array.isArray(v)) v.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, y] of Object.entries(v)) { if (!/^[$A-Za-z_][\w$]*$/.test(k)) bad.push(`${path}: key ${k}`); walk(y, `${path}.${k}`); }
  };
  episodes.forEach((e, i) => walk(e, `episode ${i}`));
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} string(s) are not declared names or tokens`);
  assert.ok(!/\b1[6-9]\d{11}\b/.test(JSON.stringify(episodes)), 'no epoch time');
  return { effects, by, gates: [...gates] };
}

// ── the concierge: AC27 ─────────────────────────────────────────────────────────────────────────────────────────
const EX = join(ROOT, 'examples', 'concierge');
const hostModule = (f) => import(pathToFileURL(join(EX, 'host', f)).href);
const { loadAnswers, recordedConcierge, provideRecorded } = await hostModule('recorded.mjs');
const { forwardEscalations } = await hostModule('notice.mjs');
const { refund } = await hostModule('refund.mjs');
const FIXTURE = loadAnswers(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
const STRIPE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
const PHONES = { 'wa-1': '16505551234', 'wa-2': '16505559876' };
const MERCHANT = 'merchant-1';

async function admittedConcierge() {
  const key = makeKey('ex-trace-concierge');
  const dir = project('ex-trace-concierge', [], key, 'test-ex-trace');
  for (const f of ['concierge.poly', 'concierge.policy.poly']) copyFileSync(join(EX, f), join(dir, 'src', f));
  cpSync(join(EX, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  cpSync(join(EX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  await signPolicies(dir);
  const r = await admit(dir);
  assert.equal(r.report.verdict, 'CLEAN');
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } };
}
function waMessage(wa, from, body, k) {
  const m = JSON.parse(recorded('whatsapp/message.json'));
  const v = m.entry[0].changes[0].value;
  v.contacts[0].wa_id = from;
  Object.assign(v.messages[0], { from, id: `wamid.ex-${k}`, text: { body } });
  return whatsappWebhook(wa, JSON.stringify(m));
}
function slackMessage(sl, text, k, now) {
  const m = JSON.parse(recorded('slack/message.json'));
  Object.assign(m.event, { text, ts: `1355517523.00000${k}`, event_ts: `1355517523.00000${k}` });
  m.event_id = `Ev-ex-${k}`;
  return slackWebhook(sl, JSON.stringify(m), now);
}
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;

test('AC27, PF10.1: the concierge\'s recorded run is exported with no message, answer or refund text in it, and every run accounted for', { timeout: 1_800_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-ac27-'));
  try {
    const a = await admittedConcierge();
    const db = join(tmp, 'concierge.db');
    const { rt, clock } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null), store: { sqlite: db } });
    let runs; let rows;
    try {
      const secret = () => randomBytes(32).toString('hex');
      const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
      const sl = { signingSecret: secret(), botToken: `xoxb-${secret()}`, teamId: 'T123ABC456' };
      rt.connectChannel('support', whatsapp(wa), { http: { async request() { return { status: 200, headers: {}, body: recorded('whatsapp/send-response.json') }; } } });
      rt.connectChannel('staff', slack(sl), { http: { async request() { return { status: 200, headers: {}, body: recorded('slack/post-ok.json') }; } } });
      rt.mapSenders('support', (sender) => FIXTURE.customers[Object.keys(PHONES).find((k) => sender.includes(PHONES[k]))] ?? null);
      const odb = ordersTable(orderRows(FIXTURE));
      rt.connectSource('orders', postgresSource({ query: odb.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', keys: { charge: 'charge_id' } }));
      provideRecorded(rt, recordedConcierge(FIXTURE));
      handleWith(rt, 'payments.refund', refund);
      const { http: stripeHttp } = fakeStripe(FIXTURE, STRIPE);
      const vault = oauthVault(STRIPE, { clientId: 'ca_concierge', redirectUri: 'https://concierge.example/credentials/payments', clientSecret: `sk_test_${secret()}` }, kmsStore(memoryWrap()), { http: stripeHttp });
      rt.connectVault('payments', vault);
      const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
      const approvals = join(a.dir, 'approvals');
      mkdirSync(approvals, { recursive: true });
      const request = signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', MERCHANT), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
      writeFileSync(join(approvals, '00-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: MERCHANT, record: request }));
      assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
      const url = rt.takeAuthorizations().find((x) => x.credential === 'payments').url;
      assert.equal((await callback('payments', { method: 'GET', url: `https://concierge.example/credentials/payments?code=ac_${secret()}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' })).status, 200);
      const settle = async (n = 40) => { for (let k = 0; k < n; k++) { await rt.advance(); await rt.worker.tick(); } };
      let k = 0;
      const say = async (who, id) => { await rt.receive('support', waMessage(wa, PHONES[who], textOf(id), ++k)); clock.advance(1000); await settle(); };
      const deskA = await rt.threadId('support', PHONES['wa-1']);
      const deskB = await rt.threadId('support', PHONES['wa-2']);
      await say('wa-1', 'status');
      await say('wa-1', 'refund-small');
      await rt.receive('staff', slackMessage(sl, 'Morning, the concierge is on.', 1, clock.now()));
      await settle();
      const notice = await rt.threadId('staff', 'C123ABC456');
      await say('wa-2', 'refund-large');
      const [esc] = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payments.refund'").all(deskB).map((r) => r.intent_id);
      assert.ok(esc);
      await forwardEscalations(rt, { desks: [deskA, deskB], notice, noticed: new Set() });
      await settle();
      await rt.approve(await approvalFor(rt, esc));
      await settle();
      const replays = await replayRuntime(rt);
      for (const x of replays) assert.deepEqual([x.run, x.diagnostics], [x.run, []]);
      rows = replays.reduce((n, x) => n + x.rows, 0);
      runs = (await rt.runs()).length;
    } finally { await rt.close(); }

    const x = exportOf(a, db, join(tmp, 'concierge.ndjson'));
    // What the customers said and what they were answered is Content: none of it, in any form, is in the corpus.
    const bodies = FIXTURE.messages.flatMap((m) => [m.text, m.answer?.text]).filter((t) => typeof t === 'string' && t.length >= 8);
    assert.ok(bodies.length >= 4);
    const { effects, by, gates } = corpusProperties(x, { vocab: vocabulary(a.dir, a.build), runs, secrets: bodies });
    // The refund waited for a person and then went through: the gate said so, and a refund is no 'none'.
    assert.ok(gates.includes('allowed'), JSON.stringify(gates));
    const refunds = x.episodes.flatMap((e) => e.steps.flatMap((s) => s.effects)).filter((f) => f.kind === 'payments.refund');
    assert.ok(refunds.length >= 2 && refunds.every((f) => f.consequence !== 'none' && f.gate), JSON.stringify(refunds));
    const two = exportOf(a, db, join(tmp, 'concierge-2.ndjson'));
    const tok = (v) => new Set(JSON.stringify(v.episodes).match(/d:[0-9a-f]{32}/g));
    assert.ok(tok(x).size > 10 && tok(two).size > 10);
    assert.deepEqual([...tok(x)].filter((t) => tok(two).has(t)), [], 'two exports of the store share no token');
    console.log(`AC27 export: ${x.header.episodes} episodes, ${x.episodes.reduce((n, e) => n + e.steps.length, 0)} steps of ${rows} journal rows, ${effects} effects ${JSON.stringify(by)}, gate ${JSON.stringify(gates)}, omitted ${JSON.stringify(x.header.omitted)}, ${runs} runs in the store`);
  } finally { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store may stay locked a moment on Windows */ } }
});

// ── the inbox: IAC9, IAC7, IAC8 ─────────────────────────────────────────────────────────────────────────────────
const W1 = 'work/19a2f0c4d1e70a01';
const W2 = 'work/19a2f0c4d1e70a02';
const W3 = 'work/19a2f0c4d1e70a03';
const H1 = 'home/19a2f1aa00b30b01';
const TRIAGE = {
  [W1]: ['ActNowReply', 'Invoice'], [W2]: ['WeekReply', 'Invoice'], [W3]: ['Ignore', 'Newsletter'], 'work/19a2f0c4d1e70a04': ['Fyi', 'Other'],
  [H1]: ['WeekReply', 'Personal'], 'home/19a2f1aa00b30b02': ['Fyi', 'Notification'],
};
const DRAFT = 'Hello Alice, thank you: the invoice is approved and will be paid this week.';
const answering = () => (decision, ids) => {
  if (decision === 'triage') return { answer: TRIAGE[ids[0]][0], p: 0.97 };
  if (decision === 'kind') return { answer: TRIAGE[ids[0]][1], p: 0.97 };
  if (decision === 'summary') return { answer: `To do about ${ids.length} message(s).` };
  if (decision === 'when') return { answer: 'ThisWeek', p: 0.9 };
  if (decision === 'write') return { answer: DRAFT, cites: ids };
  throw new Error(`no recorded answer for ${decision}`);
};
const todo = (thread) => `todo:${thread.replace('/', ':')}`;
const INVOICE = todo(W1);
const intentOf = (rt, id, kind) => rt.store.db.prepare('SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = ?').all(id, kind).map((r) => r.intent_id);

/** The recorded sequence of IAC9: sync both accounts, open the to-dos, write, propose, approve and create the invoice's draft. */
async function throughDraft(i) {
  const { rt, source, accounts, settle } = i;
  const made = [];
  for (const acct of accounts) for (let k = 0; k < 2; k++) made.push(...(await host.syncAccount(rt, source, acct)).created);
  await settle();
  await host.openTodos(rt, made);
  await settle();
  await rt.dispatch(INVOICE, 'WriteDraft', {});
  await settle();
  await rt.dispatch(INVOICE, 'Propose', {});
  await settle();
  await rt.approve(await approvalFor(rt, intentOf(rt, INVOICE, 'gmail.createDraft')[0]));
  await settle();
  assert.equal((await rt.getState(INVOICE)).state.status, 'Created');
  assert.equal(i.created.length, 1);
}

/** The inbox over both accounts, a canary in the invoice's first message, kept in a store the test names. */
async function inboxRun(name, canary, body) {
  const tmp = mkdtempSync(join(tmpdir(), `poly-trace-${name}-`));
  try {
    const a = await admittedInbox('ex-trace-inbox');
    const w = tape('work');
    const withCanary = (e) => {
      if (!canary || !e.request.url.includes('/messages/19a2f0c4d1e70a01?')) return e;
      const raw = Buffer.from(e.response.body.raw, 'base64url').toString('utf8').replace(/\r?\n\r?\n/, (sep) => `${sep}${canary}\r\n`);
      return { ...e, response: { ...e.response, body: { ...e.response.body, raw: Buffer.from(raw, 'utf8').toString('base64url') } } };
    };
    const db = join(tmp, 'inbox.db');
    const i = await inbox(a, { db, tapes: { work: [...w.initial.map(withCanary), ...w.poll], home: [...tape('home').initial, ...tape('home').quiet] }, answers: answering(), accounts: ACCOUNTS.filter((x) => x.label !== 'club') });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await i.rt.close(); } };
    try { await body({ i, a, db, tmp, close }); } finally { await close(); }
  } finally { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store may stay locked a moment on Windows */ } }
}

test('IAC9, IAC7, PF10.1: the inbox\'s recorded run is exported with a canary from a message body in no byte of it, and every run accounted for', { timeout: 1_800_000 }, async () => {
  const canary = `canary-body-${randomBytes(9).toString('hex')}`;
  await inboxRun('iac9', canary, async ({ i, a, db, tmp, close }) => {
    await throughDraft(i);
    // The canary was in the mail the decisions read: the content store holds it (so the scan below is not empty for want of one).
    const content = i.rt.store.db.prepare('SELECT * FROM poly_content').all().map((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v))).join(' ')).join('\n');
    assert.ok(content.includes(canary));
    const replays = await replayRuntime(i.rt);
    for (const r of replays) assert.deepEqual([r.run, r.diagnostics], [r.run, []]);
    const runs = (await i.rt.runs()).length;
    const rows = replays.reduce((n, r) => n + r.rows, 0);
    await close();
    const x = exportOf(a, db, join(tmp, 'inbox.ndjson'));
    const { effects, by, gates } = corpusProperties(x, { vocab: vocabulary(a.dir, a.build), runs, secrets: [canary, DRAFT] });
    assert.ok(x.header.omitted.erasedSteps === 0 && x.header.omitted.gappedRuns === 0, 'nothing was forgotten');
    const kinds = new Set(x.episodes.map((e) => e.machine));
    for (const m of ['inbox.Message', 'inbox.Todo', 'inbox.triage.Route']) assert.ok(kinds.has(m), `${m} in ${[...kinds].join(', ')}`);
    assert.ok(gates.includes('escalated') || gates.includes('allowed'), JSON.stringify(gates));
    const draftEffects = x.episodes.flatMap((e) => e.steps.flatMap((s) => s.effects)).filter((f) => f.kind === 'gmail.createDraft');
    assert.ok(draftEffects.length >= 1 && draftEffects.every((f) => f.gate), JSON.stringify(draftEffects));
    console.log(`IAC9 export: ${x.header.episodes} episodes, ${x.episodes.reduce((n, e) => n + e.steps.length, 0)} steps of ${rows} journal rows, ${effects} effects ${JSON.stringify(by)}, gate ${JSON.stringify(gates)}, omitted ${JSON.stringify(x.header.omitted)}, ${runs} runs in the store`);
  });
});

test('IAC8, PS19.5: after an account is forgotten its steps are left out and counted, its runs are gapped, the other account\'s are whole, and no erased digest is in the corpus', { timeout: 1_800_000 }, async () => {
  await inboxRun('iac8', null, async ({ i, a, db, tmp, close }) => {
    const { rt, accounts } = i;
    await throughDraft(i);
    const work = accounts.find((x) => x.label === 'work').owner;
    await rt.forget({ subject: work }, signRecord({ kind: 'forget', subject: forgetSubject(rt.anchorId, { subject: work }), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem));
    // What the runtime says is erased, and which journal rows name it: the expectation, from the journal and not from the export.
    const erased = new Set(rt.forgottenBodies().keys());
    assert.ok(erased.size > 0);
    const naming = (row) => (JSON.stringify([row.data, row.pre, row.post]).match(/sha256:[0-9a-f]{64}/g) ?? []).some((d) => erased.has(d));
    let steps = 0; let gapped = 0; let whole = 0; let all = 0;
    for (const inst of (await rt.instances()).filter((x) => !rt.modelOf(x.machineId))) {
      const journal = await rt.getJournal(inst.id);
      const n = journal.filter(naming).length;
      steps += n;
      if (n === 0) whole++; else if (n === journal.length) all++; else gapped++;
    }
    assert.ok(steps > 0 && gapped > 0 && whole > 0, `${steps} steps, ${gapped} gapped, ${whole} whole`);
    const runs = (await rt.runs()).length;
    await close();
    const x = exportOf(a, db, join(tmp, 'forgotten.ndjson'));
    corpusProperties(x, { vocab: vocabulary(a.dir, a.build), runs, secrets: [DRAFT] });
    assert.equal(x.header.omitted.erasedSteps, steps);
    assert.equal(x.header.omitted.gappedRuns, gapped);
    assert.equal(x.header.omitted.erasedRuns, all);
    assert.equal(x.episodes.filter((e) => !e.gapped).length, whole);
    for (const d of erased) assert.ok(!x.bytes.includes(d) && !x.bytes.includes(d.replace('sha256:', '')), `erased digest ${d} is in the corpus`);
    assert.ok(x.episodes.some((e) => e.machine === 'inbox.Todo' && !e.gapped), 'the home account\'s to-do is whole');
    console.log(`IAC8 export: ${x.header.episodes} episodes, ${x.header.omitted.erasedSteps} erased steps left out, ${x.header.omitted.gappedRuns} gapped runs, ${x.header.omitted.erasedRuns} erased runs, ${whole} whole runs`);
  });
});
