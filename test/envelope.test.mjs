// S459 (PS17.0, PS17.2, PS17.3a, PS17.4a, PT10j): a reply's envelope comes from the source, and a handler reads its own
// payload's bodies. Written from the specification text alone. A source declares `envelope k` on one of its keys; an
// envelope retrieval gives, as a Content, the recipient, subject and threading headers of a reply to the newest item
// with that key; an effect with `envelope e` takes that Content only from such a retrieval, passed unchanged
// (PL6830 ENVELOPE_NOT_FROM_SOURCE otherwise, so no model answer and no message chooses where a reply goes). At run time
// an intent whose `e` is not a stored envelope is denied `envelope-origin`, final whatever a policy says, and the
// handler reads the bodies of its own payload through `content.read` and nothing else. No test reaches a database or
// calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { digest } from '@poly/core';
import { parse, format } from '@poly/lang';
import { printModule, readEmbedded } from '@poly/embed';
import { checkFile } from '@poly/check';
import { postgresSource } from '@poly/io';
import { CapabilityRefused } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, handleWith, loaded } from './runtime-helpers.mjs';
import { FAULT_SOURCES } from './toolchain-faults.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'envelope');
const REPLY = readFileSync(join(FIX, 'mail-reply.poly'), 'utf8');
const HELD = readFileSync(join(FIX, 'mail-reply-held.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-envelope');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return { r: await checkFile(join(d, 'm.poly'), { root: d }), build: join(d, '.poly', 'build') };
}

// ---------------------------------------------------------------------------------------------------------------------
// The checker: the forms, the build, and the envelope rule (PS17.3a, PL6830).
// ---------------------------------------------------------------------------------------------------------------------

test('S459, PT10j: envelope in a source, an envelope retrieval and envelope in an effect format and print on both surfaces to the same digest', () => {
  for (const src of [REPLY, HELD]) {
    const a = parse(src);
    assert.ok(a.module, JSON.stringify(a.diagnostics));
    const formatted = format(a.module);
    assert.equal(digest(parse(formatted).module), digest(a.module));
    const back = readEmbedded(printModule(a.module));
    assert.ok(back.module, JSON.stringify(back.diagnostics));
    assert.equal(digest(back.module), digest(a.module));
  }
  const f = format(parse(REPLY).module);
  for (const line of ['  envelope thread', '    retrieve mail envelope where owner == account and thread == t', '    envelope e']) assert.ok(f.includes(line + '\n'), line);
});

test('S459, PS17.3a: a draft whose envelope is the envelope retrieval\'s r.envelope, passed unchanged, checks CLEAN with no PL6830; the build records envelope in the manifest and the source descriptor', { timeout: 300_000 }, async () => {
  const { r, build } = await check(REPLY);
  assert.ok(!codes(r).includes('PL6830'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  // PS17.3: the envelope carries the account's own taint and the draft goes to that account.
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'flow')?.verdict, 'CLEAN', text(r));
  // PT10j: the source descriptor records envelope, the retrieval's entry has its own kind and envelope: true, and the
  // draft's entry names its envelope parameter.
  const source = JSON.parse(readFileSync(join(build, 'sources', 'mail.json'), 'utf8'));
  assert.equal(source.envelope, 'thread');
  assert.deepEqual(source.keys, ['message', 'thread']);
  const manifest = JSON.parse(readFileSync(join(build, 'mail_reply.Replier', 'effects.manifest.json'), 'utf8')).effects;
  assert.ok(manifest['source.mail.envelope'], Object.keys(manifest).join(', '));
  assert.ok(!manifest['source.mail.retrieve'], 'an envelope retrieval is not of kind source.mail.retrieve');
  assert.deepEqual(manifest['source.mail.envelope'].retrieve, { source: 'mail', owner: 'account', key: { name: 'thread', param: 't' }, envelope: true });
  // PS17.2: labelled as a retrieval of an owned source.
  assert.deepEqual(manifest['source.mail.envelope'].labels, ['read:private']);
  assert.equal(manifest['mail.draft'].envelope, 'e');
  // The translation validation read all three back.
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'translation-validation')?.verdict, 'CLEAN', text(r));
});

test('S459, PS17.3a: an envelope held in a field written only from the retrieval\'s r.envelope, or none, is passed unchanged with no PL6830', { timeout: 300_000 }, async () => {
  const { r } = await check(HELD);
  assert.ok(!codes(r).includes('PL6830'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  // PS17.3a: `none` is one of the allowed arguments (the runtime denies it, envelope-origin).
  const none = await check(swap(HELD, 'emit draft(account: account, e: env, body: body)', 'emit draft(account: account, e: none, body: body)'));
  assert.ok(!codes(none.r).includes('PL6830'), text(none.r));
});

test('S459 (the required test): a model answer that tries to set the recipient, passed as the draft\'s envelope, is PL6830 ENVELOPE_NOT_FROM_SOURCE', { timeout: 300_000 }, async () => {
  // The decision's Content answer, bound by its ok outcome into the emitting action's parameter, is the envelope.
  const direct = await check(swap(REPLY, '    emit envelope_of(account: account, t: conv)\n', '    emit draft(account: account, e: text, body: text)\n'));
  assert.equal(direct.r.verdict, 'REFUSED', text(direct.r));
  assert.ok(codes(direct.r).includes('PL6830'), text(direct.r));
  const f = all(direct.r).find((d) => d.code === 'PL6830');
  assert.match(f.message, /draft|envelope|\be\b/, f.message);
  // The decision binds its answer into the very parameter the envelope retrieval binds: on the decision's path the
  // envelope is a model's answer, so the parameter is not one only an envelope retrieval binds.
  const shared = await check(swap(REPLY, 'ok(r) -> Written(text: r.answer)', 'ok(r) -> Enveloped(env: r.answer)'));
  assert.equal(shared.r.verdict, 'REFUSED', text(shared.r));
  assert.ok(codes(shared.r).includes('PL6830'), text(shared.r));
});

test('S459, PS17.3a: a body received as an input\'s parameter, and a field written once from the envelope and once from a decision\'s answer, are PL6830', { timeout: 300_000 }, async () => {
  // The question arrives as data of the input Reply: a message body chooses nothing about where a reply goes.
  const input = await check(swap(REPLY, '    decide write(question: question)\n', '    emit draft(account: c.principal, e: question, body: question)\n'));
  assert.equal(input.r.verdict, 'REFUSED', text(input.r));
  assert.ok(codes(input.r).includes('PL6830'), text(input.r));
  // The held field gains a second write, from the decision's answer: not every write is an envelope.
  const mixed = await check(swap(HELD, '    body\' = text\n', '    body\' = text\n    env\' = text\n'));
  assert.equal(mixed.r.verdict, 'REFUSED', text(mixed.r));
  assert.ok(codes(mixed.r).includes('PL6830'), text(mixed.r));
  // The held field gains a write from an input's parameter.
  const written = await check(swap(swap(HELD, '  action Send()\n', '  action Send(x: Content)\n'), '  on Send {\n    require phase == Ready else reject "not-ready"\n    phase\' = Idle\n', '  on Send(x) {\n    require phase == Ready else reject "not-ready"\n    phase\' = Idle\n    env\' = x\n'));
  assert.ok(codes(written.r).includes('PL6830'), text(written.r));
});

test('S459, PT10j: the forms: envelope on an undeclared key is PL1001; an envelope retrieval from a source without envelope, or by another key, is PL1201; envelope naming a non-Content parameter is PL1201, and no parameter PL1001', { timeout: 300_000 }, async () => {
  for (const [from, to, code] of [
    // PS17.0: `envelope k`, k one of the source's keys.
    ['  envelope thread\n', '  envelope correspondent\n', 'PL1001'],
    // PS17.2: the source declares `envelope k` ...
    ['  envelope thread\n', '', 'PL1201'],
    // ... and the key predicate names that k.
    ['retrieve mail envelope where owner == account and thread == t', 'retrieve mail envelope where owner == account and message == t', 'PL1201'],
    // PS17.3a: e a Content parameter of the effect.
    ['    envelope e\n', '    envelope account\n', 'PL1201'],
    ['    envelope e\n', '    envelope reply_to\n', 'PL1001'],
  ]) {
    const { r } = await check(swap(REPLY, from, to));
    assert.equal(r.verdict, 'REFUSED', `${to}: ${text(r)}`);
    assert.ok(codes(r).includes(code), `${to}: ${text(r)}`);
  }
});

test('S459, PT10j: the broken lowering envelope-dropped is in the explicit list of toolchain faults', () => {
  // The manifest's envelope dropped would let the runtime skip the origin check; translation validation must catch it.
  assert.ok(Object.hasOwn(FAULT_SOURCES, 'envelope-dropped'), Object.keys(FAULT_SOURCES).join(', '));
});

// ---------------------------------------------------------------------------------------------------------------------
// At run time: the Postgres envelope, its refusals, the origin check and content.read.
// ---------------------------------------------------------------------------------------------------------------------

// Two accounts' mail, as a host's database holds it. `rfc_id` is the RFC 5322 Message-ID and `refs` the References
// header as a list. Thread t-1 exists in both accounts, and acct-b's message is the newest of all: only the owner
// predicate keeps it out of acct-a's envelope.
const MAIL = [
  { message_id: 'm-1', account_id: 'acct-a', thread_id: 't-1', sender: 'ann@example.org', subject: 'Lamps', rfc_id: '<m1@example.org>', refs: [], updated_at: '2026-10-01T09:00:00Z', body: 'Do you have lamps?' },
  { message_id: 'm-2', account_id: 'acct-a', thread_id: 't-1', sender: 'ann@example.org', subject: 'Lamps', rfc_id: '<m2@example.org>', refs: ['<m1@example.org>'], updated_at: '2026-10-03T09:00:00Z', body: 'Two lamps, please.' },
  { message_id: 'm-3', account_id: 'acct-a', thread_id: 't-2', sender: 'bob@example.org', subject: 'Re: Invoice', rfc_id: '<m3@example.org>', refs: ['<i0@example.org>'], updated_at: '2026-10-05T09:00:00Z', body: 'The invoice.' },
  { message_id: 'm-4', account_id: 'acct-b', thread_id: 't-1', sender: 'cyd@example.org', subject: 'Chairs', rfc_id: '<m4@example.org>', refs: [], updated_at: '2026-10-07T09:00:00Z', body: 'Another account, the same thread id.' },
];
const KEYS = { message: 'message_id', thread: 'thread_id' };
const ENVELOPE = { from: 'sender', subject: 'subject', messageId: 'rfc_id', references: 'refs' };

/**
 * A query function over the rows that answers any SELECT the adapter writes by reading it: its column list (`"col"`,
 * with `AS alias` or not), its `"col" = $n` equalities, its ORDER BY and its LIMIT. It keeps every query. With
 * `ignore`, it drops the equalities on the named columns, as a source that does not honour them would.
 */
function pgMail(rows0 = MAIL, { ignore = [] } = {}) {
  const rows = rows0.map((r) => ({ ...r }));
  const seen = [];
  const query = async (q, params) => {
    seen.push({ text: q, params });
    if (!q.startsWith('SELECT ')) throw new Error(`unexpected query ${q}`);
    const at = q.indexOf(' FROM ');
    const head = q.slice(0, at);
    const rest = q.slice(at);
    const cols = [...head.matchAll(/"(\w+)"(?:\s+AS\s+"?(\w+)"?)?/g)].map((m) => [m[1], m[2] ?? m[1]]);
    const eqs = [...rest.matchAll(/"(\w+)" = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]]).filter(([c]) => !ignore.includes(c));
    const order = /ORDER BY "(\w+)" DESC/.exec(rest)?.[1];
    const lim = /LIMIT (?:\$(\d+)|(\d+))/.exec(rest);
    let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v));
    if (order) out = out.sort((x, y) => (x[order] < y[order] ? 1 : -1));
    if (lim) out = out.slice(0, lim[1] ? params[Number(lim[1]) - 1] : Number(lim[2]));
    return { rows: out.map((r) => Object.fromEntries(cols.map(([c, a]) => [a, r[c]]))) };
  };
  return { query, seen };
}

const source = (query, envelope = ENVELOPE) => postgresSource({ query, table: 'mail', id: 'message_id', owner: 'account_id', asOf: 'updated_at', body: 'body', keys: KEYS, ...(envelope ? { envelope } : {}) });

/** RFC 8785 canonical JSON for the values an envelope holds: objects with their keys sorted, strings and lists. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

const T1 = { to: 'ann@example.org', subject: 'Re: Lamps', inReplyTo: '<m2@example.org>', references: ['<m1@example.org>', '<m2@example.org>'] };
const verifier = (c) => (c ? { principal: c.principal } : null);
const ANSWER = 'Yes, two lamps are on their way.';
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** Loads an admitted reply, connects its source and a recorded provider, and scripts the draft's handler. */
async function replier(a, { rows = MAIL, ignore = [], envelope = ENVELOPE, script } = {}) {
  const { rt } = await loaded(a, { verifier });
  const db = pgMail(rows, { ignore });
  rt.connectSource('mail', source(db.query, envelope));
  const asked = [];
  rt.provide('write', { provider: (q, m) => { asked.push(m); return { answer: ANSWER, distribution: [[ANSWER, 0.9]], reported: 'flash-2026-09', latencyMs: 4 }; }, model: 'flash' });
  const drafts = [];
  handleWith(rt, 'mail.draft', async (payload, caps, ctx) => { const seen = { payload, caps, out: script ? await script(payload, caps, ctx) : null }; drafts.push(seen); return { ok: true }; });
  return { rt, db, asked, drafts };
}

async function reply(rt, machine, id, thread, account = 'acct-a', ticks = 8) {
  await rt.create(machine, { id });
  const q = await rt.putContent('Can you send two lamps?');
  await rt.dispatch(id, 'Reply', { t: thread, question: q }, { credentials: { principal: account } });
  for (let k = 0; k < ticks; k++) await rt.worker.tick();
  return q;
}

const journal = (rt, id) => rt.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ?').all(id);
const verdicts = (rt, id) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict'").all(id).map((r) => JSON.parse(r.event).body);
const envelopes = (rt) => { try { return rt.store.db.prepare('SELECT * FROM poly_envelope').all(); } catch { return []; } };

test('S459, PT10j: postgresSource gives the envelope of a reply to the newest row with the key, its key and owner as parameters', async () => {
  const db = pgMail();
  const s = source(db.query);
  assert.equal(typeof s.envelope, 'function', 'a source with envelope columns gives envelopes');
  const e1 = await s.envelope({ owner: 'acct-a', key: { name: 'thread', value: 't-1' } });
  assert.equal(e1.id, 'm-2');
  assert.equal(e1.owner, 'acct-a');
  assert.ok(e1.asOf, JSON.stringify(e1));
  // The reply goes to the sender, `Re: ` before the subject, In-Reply-To the message id, References the row's then it.
  assert.deepEqual(e1.envelope, T1);
  // A subject that already starts `Re: ` is not prefixed again.
  const e2 = await s.envelope({ owner: 'acct-a', key: { name: 'thread', value: 't-2' } });
  assert.deepEqual(e2.envelope, { to: 'bob@example.org', subject: 'Re: Invoice', inReplyTo: '<m3@example.org>', references: ['<i0@example.org>', '<m3@example.org>'] });
  // No item with the key: null.
  assert.equal(await s.envelope({ owner: 'acct-a', key: { name: 'thread', value: 't-9' } }), null);
  // PT10j: the owner and the key are values, never query text.
  for (const x of db.seen) assert.ok(!x.text.includes('acct-a') && !x.text.includes('t-1'), x.text);
  assert.ok(db.seen.some((x) => x.params.includes('acct-a') && x.params.includes('t-1')), JSON.stringify(db.seen));
  // A column name is checked at construction, as every name the adapter writes.
  assert.throws(() => source(db.query, { ...ENVELOPE, from: 'sender name' }), /not a plain name/);
});

test('S459, PS17.2, PS17.4: the envelope retrieval completes with a Content whose body is the canonical JSON of the envelope, owned by the account; the draft carries it unchanged', async () => {
  const a = await admitted('envelope-runtime', ['test/fixtures/envelope/mail-reply.poly']);
  const { rt, asked, drafts } = await replier(a);
  try {
    await reply(rt, 'mail_reply.Replier', 'reply-1', 't-1');
    assert.equal((await rt.getState('reply-1')).state.phase, 'Idle');
    assert.equal(asked.length, 1);
    const steps = journal(rt, 'reply-1');
    const enveloped = steps.find((s) => s.action === 'Enveloped');
    assert.ok(enveloped, JSON.stringify(steps.map((s) => s.action)));
    const env = JSON.parse(enveloped.data).env;
    assert.match(env, /^sha256:/);
    assert.equal(await rt.contentBody(env), canon(T1));
    // The taint of a retrieval of mail by owner acct-a: class account (the second), owner acct-a.
    assert.deepEqual(rt.memory.taintOf(env), { c: 1, o: ['acct-a'] });
    // Recorded as an envelope of mail, by digest.
    const kept = envelopes(rt);
    assert.ok(kept.some((row) => Object.values(row).includes(env) && Object.values(row).includes('mail')), JSON.stringify(kept));
    // The draft's handler got the envelope's digest unchanged, and the address is in no journal entry.
    assert.equal(drafts.length, 1, JSON.stringify(verdicts(rt, 'reply-1').map((v) => [v.effectKind, v.outcome, v.reason])));
    assert.equal(drafts[0].payload.e, env);
    assert.ok(!steps.map((s) => s.data).join('\n').includes('ann@example.org'));
    // Only the runtime delivers an envelope retrieval's completion (K10), and only the runtime runs it.
    await rt.create('mail_reply.Replier', { id: 'reply-forged' });
    const forged = await rt.putContent(canon({ to: 'eve@example.org', subject: 'Re: Lamps', inReplyTo: '<m2@example.org>', references: [] }));
    await assert.rejects(rt.dispatch('reply-forged', 'Enveloped', { env: forged }), /only the outbox worker delivers it/);
    assert.throws(() => rt.handle('source.mail.envelope', () => ({})), /the runtime runs it/);
  } finally { await rt.close(); }
});

test('S459, K14: an envelope of another owner, an empty recipient, a header with a carriage return or a line feed, no item, or an adapter without envelopes fails the retrieval, and nothing is drafted', async () => {
  const a = await admitted('envelope-refusals', ['test/fixtures/envelope/mail-reply.poly']);
  const bad = (over) => [...MAIL, { message_id: 'm-9', account_id: 'acct-a', thread_id: 't-9', sender: 'dan@example.org', subject: 'Desks', rfc_id: '<m9@example.org>', refs: [], updated_at: '2026-10-08T09:00:00Z', body: 'Desks?', ...over }];
  const cases = [
    // acct-b's message is the newest of t-1; a source that drops the owner equality answers it.
    ['another owner', { ignore: ['account_id'] }, 't-1'],
    ['an empty recipient', { rows: bad({ sender: '' }) }, 't-9'],
    ['a line feed in the recipient', { rows: bad({ sender: 'dan@example.org\nBcc: eve@example.org' }) }, 't-9'],
    ['a carriage return in the subject', { rows: bad({ subject: 'Desks\r\nBcc: eve@example.org' }) }, 't-9'],
    ['a line feed in the message id', { rows: bad({ rfc_id: '<m9@example.org>\nBcc: eve@example.org' }) }, 't-9'],
    ['a carriage return in a reference', { rows: bad({ refs: ['<m8@example.org>\rBcc: eve@example.org'] }) }, 't-9'],
    ['no item with the key', {}, 't-8'],
  ];
  for (const [what, opts, thread] of cases) {
    const { rt, drafts } = await replier(a, opts);
    try {
      await reply(rt, 'mail_reply.Replier', 'reply-bad', thread);
      const steps = journal(rt, 'reply-bad').map((s) => s.action);
      assert.ok(!steps.includes('Enveloped') && steps.includes('EnvelopeFailed'), `${what}: ${JSON.stringify(steps)}`);
      assert.equal(drafts.length, 0, what);
      assert.equal(envelopes(rt).length, 0, `${what}: no envelope is kept`);
      if (what !== 'no item with the key') {
        const dead = rt.store.db.prepare("SELECT last_error FROM pr_outbox WHERE instance_id = 'reply-bad' AND kind = 'source.mail.envelope'").get();
        assert.ok(dead?.last_error, `${what}: refused permanently, with its reason`);
      }
    } finally { await rt.close(); }
  }
  // An adapter with no envelope method: refused at connection or by the retrieval, never drafted.
  const { rt } = await loaded(a, { verifier });
  try {
    let connected = true;
    try { rt.connectSource('mail', source(pgMail().query, null)); } catch { connected = false; }
    if (connected) {
      rt.provide('write', { provider: () => ({ answer: ANSWER, distribution: [[ANSWER, 0.9]], reported: 'flash-2026-09', latencyMs: 4 }), model: 'flash' });
      const drafts = [];
      handleWith(rt, 'mail.draft', (payload) => { drafts.push(payload); return { ok: true }; });
      await reply(rt, 'mail_reply.Replier', 'reply-none', 't-1');
      assert.ok(journal(rt, 'reply-none').some((s) => s.action === 'EnvelopeFailed'));
      assert.equal(drafts.length, 0);
    }
  } finally { await rt.close(); }
});

test('S459, PS17.3a: a draft whose envelope is a body put by the host, a forged digest or none is denied envelope-origin, final under a policy that allows everything', async () => {
  const a = await admitted('envelope-origin', ['test/fixtures/envelope/mail-reply-held.poly', 'test/fixtures/envelope/allow-all.policy.poly']);
  // The control: the envelope the runtime stored passes the origin check and reaches the handler.
  const good = await replier(a);
  try {
    await reply(good.rt, 'mail_reply_held.Replier', 'held-ok', 't-1');
    assert.equal((await good.rt.getState('held-ok')).state.phase, 'Ready');
    await good.rt.dispatch('held-ok', 'Send', {});
    for (let k = 0; k < 4; k++) await good.rt.worker.tick();
    assert.equal(good.drafts.length, 1, JSON.stringify(verdicts(good.rt, 'held-ok').map((v) => [v.effectKind, v.outcome, v.reason])));
  } finally { await good.rt.close(); }
  // The static rule makes another origin unwritable, so each case replaces the pending draft's envelope in the outbox
  // before the worker reads it: the run-time check must hold by itself (PS17.3a, fail closed).
  for (const what of ['host', 'forged', 'none']) {
    const { rt, drafts } = await replier(a);
    try {
      await reply(rt, 'mail_reply_held.Replier', 'held-bad', 't-1');
      assert.equal((await rt.getState('held-bad')).state.phase, 'Ready');
      await rt.dispatch('held-bad', 'Send', {});
      const row = rt.store.db.prepare("SELECT intent_id, payload FROM pr_outbox WHERE instance_id = 'held-bad' AND kind = 'mail.draft'").get();
      assert.ok(row, 'the draft is pending');
      const payload = JSON.parse(row.payload);
      // A body put by the host holding a well-formed envelope to someone else is not an envelope the source gave.
      if (what === 'host') payload.e = await rt.putContent(canon({ to: 'eve@example.org', subject: 'Re: Lamps', inReplyTo: '<m2@example.org>', references: ['<m1@example.org>', '<m2@example.org>'] }));
      if (what === 'forged') payload.e = `sha256:${'c'.repeat(64)}`;
      if (what === 'none') payload.e = null;
      rt.store.db.prepare('UPDATE pr_outbox SET payload = ? WHERE intent_id = ?').run(JSON.stringify(payload), row.intent_id);
      for (let k = 0; k < 4; k++) await rt.worker.tick();
      assert.equal(drafts.length, 0, `${what}: the handler never ran`);
      const v = verdicts(rt, 'held-bad').find((x) => x.effectKind === 'mail.draft');
      assert.ok(v, `${what}: ${JSON.stringify(verdicts(rt, 'held-bad'))}`);
      assert.deepEqual([v.outcome, v.reason], ['denied', 'envelope-origin'], what);
    } finally { await rt.close(); }
  }
});

test('S459, PS17.4a: content.read in the draft\'s handler gives the bodies of its own payload, refuses any other digest before reading (PL6406, audited), and records each read by digest on runtime:content', async () => {
  const a = await admitted('envelope-read', ['test/fixtures/envelope/mail-reply.poly']);
  let question;
  const { rt, drafts } = await replier(a, {
    script: async (payload, caps) => ({
      keys: Object.keys(caps),
      env: await caps.content.read(payload.e),
      body: await caps.content.read(payload.body),
      // The question is a stored body, but not one of this intent's payload.
      other: await refused(caps.content.read(question)),
      // A digest no body has: refused as outside the payload, not content-missing, so nothing was read first.
      forged: await refused(caps.content.read(`sha256:${'d'.repeat(64)}`)),
    }),
  });
  try {
    await rt.create('mail_reply.Replier', { id: 'reply-read' });
    question = await rt.putContent('Can you send two lamps?');
    await rt.dispatch('reply-read', 'Reply', { t: 't-1', question }, { credentials: { principal: 'acct-a' } });
    for (let k = 0; k < 8; k++) await rt.worker.tick();
    assert.equal(drafts.length, 1, JSON.stringify(verdicts(rt, 'reply-read').map((v) => [v.effectKind, v.outcome, v.reason])));
    const { payload, out } = drafts[0];
    assert.ok(out.keys.includes('content'), JSON.stringify(out.keys));
    assert.equal(out.env, canon(T1));
    assert.equal(out.body, ANSWER);
    for (const e of [out.other, out.forged]) {
      assert.ok(e instanceof CapabilityRefused, String(e));
      assert.ok(!/content-missing/.test(e.message), e.message);
    }
    const audit = await rt.audit('reply-read');
    const rows = audit.filter((r) => r.rule === 'PL6406');
    assert.equal(rows.length, 2, JSON.stringify(audit));
    // Each read is recorded by its digest with the intent; no body is in the record.
    const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'reply-read' AND kind = 'mail.draft'").get().intent_id;
    const chain = await rt.chain('runtime:content');
    const reads = chain.filter((ev) => ev.body?.stage === 'read');
    assert.deepEqual(reads.map((ev) => ev.body.digest).sort(), [payload.e, payload.body].sort(), JSON.stringify(reads));
    assert.ok(reads.every((ev) => ev.body.intent === intent), JSON.stringify(reads));
    const recorded = JSON.stringify(chain);
    for (const body of [ANSWER, 'ann@example.org', 'Can you send two lamps?']) assert.ok(!recorded.includes(body), body);
  } finally { await rt.close(); }
});

test('S459, PS17.3a, PS17.7 (ruled 2026-10-09): a draft whose envelope was erased is denied envelope-origin before any handler, so no recipient survives erasure', async () => {
  const a = await admitted('envelope-erased', ['test/fixtures/envelope/mail-reply-held.poly', 'test/fixtures/envelope/allow-all.policy.poly']);
  const { rt, drafts } = await replier(a);
  try {
    await reply(rt, 'mail_reply_held.Replier', 'held-erased', 't-1');
    const st = (await rt.getState('held-erased')).state;
    assert.equal(st.phase, 'Ready');
    // The envelope the source gave is kept in the field; it is erased before the draft is sent.
    assert.ok(envelopes(rt).some((row) => Object.values(row).includes(st.env)), 'the field holds a stored envelope');
    await rt.erase(st.env);
    await rt.dispatch('held-erased', 'Send', {});
    for (let k = 0; k < 4; k++) await rt.worker.tick();
    assert.equal(drafts.length, 0, 'the handler never ran, so it never read a recipient');
    const v = verdicts(rt, 'held-erased').find((x) => x.effectKind === 'mail.draft');
    assert.ok(v, JSON.stringify(verdicts(rt, 'held-erased')));
    assert.deepEqual([v.outcome, v.reason], ['denied', 'envelope-origin']);
  } finally { await rt.close(); }
});
