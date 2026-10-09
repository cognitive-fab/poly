// S451 (PS1.4c, PS4.1g, PS17.0, PS17.2, PT10j, IAC3): Key, a source's keys, and a retrieval by key. Written from the
// specification text alone. A Key is opaque: stored, passed and compared with == and != only (PL1209 otherwise). A source
// declares its keys in `keys { … }`, recorded in its descriptor; a retrieval may add one equality on a declared key with a
// Key parameter, recorded in its manifest entry, and it narrows the items without changing their taint. At run time the
// adapter is asked with the key, Postgres filters by it as a parameter, and an item without that key value is refused
// (K14). No test reaches a database or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile } from '@poly/check';
import { postgresSource } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'source-keys');
const HELD = readFileSync(join(FIX, 'held.poly'), 'utf8');
const MAIL = readFileSync(join(FIX, 'mail-draft.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-source-keys');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const staticCodes = (src) => { const r = parse(src); if (!r.module) return r.diagnostics.map((d) => d.code); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
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

test('S451: a Key is stored, passed and compared with == and !=; an order, arithmetic, a map key, a string or a check domain is PL1209', { timeout: 120_000 }, async () => {
  // PS1.4c: the base module uses Key only as a value that is held and compared for equality.
  assert.deepEqual(staticCodes(HELD), []);
  for (const [from, to] of [
    ["same' = k == key", "same' = k < key"],
    ["same' = k == key", "same' = k + 1 == 2"],
    ['key   : Key   = none\n', 'key   : Key   = none\n    seen  : map<Key, bool> = {}\n'],
    ["same' = k == key", "same' = k == \"t-1\""],
    ['action Put(k: Key)', 'action Put(k: Key check { none })'],
    ["key' = k", "key' = \"t-1\""],
  ]) {
    const c = staticCodes(swap(HELD, from, to));
    assert.ok(c.includes('PL1209'), `${to}: ${JSON.stringify(c)}`);
  }
  // PS4.1g: check explores Key by representatives, so the module checks with no domain of its own.
  const { r } = await check(HELD);
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.ok(!codes(r).includes('PL1209') && !codes(r).includes('PL1101'), text(r));
});

test('S451: a source declares its keys and a retrieval reads one by a Key parameter; both are recorded in the build; an undeclared key is PL1001, a parameter of another type PL1201', { timeout: 300_000 }, async () => {
  const { r, build } = await check(MAIL);
  assert.ok(!codes(r).includes('PL1001') && !codes(r).includes('PL1201'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  // PT10j: the source descriptor records the keys, the manifest's retrieve entry the key predicate.
  const source = JSON.parse(readFileSync(join(build, 'sources', 'mail.json'), 'utf8'));
  assert.deepEqual(source.keys, ['message', 'thread', 'correspondent']);
  assert.equal(source.owned, true);
  const manifest = JSON.parse(readFileSync(join(build, 'mail_draft.Drafter', 'effects.manifest.json'), 'utf8')).effects;
  assert.deepEqual(manifest['source.mail.retrieve'].retrieve, { source: 'mail', owner: 'account', key: { name: 'thread', param: 't' }, limit: 2 });
  // PS17.2: the key must be one the source declares (PL1001), and its value a Key parameter (PL1201).
  for (const [from, to, code] of [
    ['and thread == t', 'and subject == t', 'PL1001'],
    ['  keys { message, thread, correspondent }\n', '  keys { message, correspondent }\n', 'PL1001'],
    ['  keys { message, thread, correspondent }\n', '', 'PL1001'],
    ['t: Key)', 't: Principal)', 'PL1201'],
    ['t: Key)', 't: string)', 'PL1201'],
  ]) {
    let src = swap(MAIL, from, to);
    // The emitting step passes a value of the parameter's new type.
    if (to === 't: Principal)') src = swap(src, 'emit read(account: c.principal, t: thread)', 'emit read(account: c.principal, t: c.principal)');
    if (to === 't: string)') src = swap(src, 'emit read(account: c.principal, t: thread)', 'emit read(account: c.principal, t: "t-1")');
    const { r: bad } = await check(src);
    assert.equal(bad.verdict, 'REFUSED', `${to}: ${text(bad)}`);
    assert.ok(codes(bad).includes(code), `${to}: ${text(bad)}`);
  }
});

test('S451, IAC3: a draft that reads a thread by key from its own account and sends to that account does not leak; by key alone, or from another account, it is PL6831', { timeout: 600_000 }, async () => {
  const { r } = await check(MAIL);
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.ok(!codes(r).includes('PL6831'), text(r));
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'flow')?.verdict, 'CLEAN', text(r));
  // PS17.2: the key narrows the items and never their taint; without the owner predicate the taint is every owner.
  const keyOnly = await check(swap(MAIL, 'where owner == account and thread == t', 'where thread == t'));
  assert.ok(codes(keyOnly.r).includes('PL6831'), text(keyOnly.r));
  const f = all(keyOnly.r).find((d) => d.code === 'PL6831');
  assert.match(f.message, /mail\.send/);
  // Another account's thread, read by key and drafted to this account.
  const other = swap(swap(swap(MAIL, 'action Draft(thread: Key)', 'action Draft(thread: Key, from: Principal)'), 'on Draft(thread) by c: Account', 'on Draft(thread, from) by c: Account'), 'emit read(account: c.principal, t: thread)', 'emit read(account: from, t: thread)');
  const leak = await check(other);
  assert.ok(codes(leak.r).includes('PL6831'), text(leak.r));
});

// Two accounts' mail, as a host's database holds it. Thread t-1 exists in both accounts: only the owner predicate
// separates them, and only the key separates t-1 from t-2 within an account.
const ROWS = [
  { message_id: 'm-1', account_id: 'acct-a', thread_id: 't-1', correspondent: 'ann', updated_at: '2026-10-01T09:00:00Z', body: 'Hello from Ann.' },
  { message_id: 'm-2', account_id: 'acct-a', thread_id: 't-1', correspondent: 'ann', updated_at: '2026-10-03T09:00:00Z', body: 'Re: hello from Ann.' },
  { message_id: 'm-3', account_id: 'acct-a', thread_id: 't-2', correspondent: 'bob', updated_at: '2026-10-05T09:00:00Z', body: 'An invoice from Bob.' },
  { message_id: 'm-4', account_id: 'acct-b', thread_id: 't-1', correspondent: 'cyd', updated_at: '2026-10-04T09:00:00Z', body: 'Another account, the same thread id.' },
];
const KEYS = { message: 'message_id', thread: 'thread_id', correspondent: 'correspondent' };

/**
 * A query function over the rows that answers any SELECT the adapter writes over "mail" by reading it: its `"col" AS
 * alias` list, its `"col" = $n` equalities, its ORDER BY and its LIMIT. It keeps every query. With `ignore`, it drops the
 * equalities on the named columns, as a source that does not honour the key would.
 */
function pgMail({ ignore = [] } = {}) {
  const rows = ROWS.map((r) => ({ ...r }));
  const seen = [];
  const query = async (q, params) => {
    seen.push({ text: q, params });
    if (!q.startsWith('SELECT ')) throw new Error(`unexpected query ${q}`);
    const [head, rest = ''] = q.split(' FROM ');
    const cols = [...head.matchAll(/"(\w+)" AS (\w+)/g)].map((m) => [m[1], m[2]]);
    const eqs = [...rest.matchAll(/"(\w+)" = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]]).filter(([c]) => !ignore.includes(c));
    const order = /ORDER BY "(\w+)" DESC/.exec(rest)?.[1];
    const lim = /LIMIT \$(\d+)/.exec(rest);
    let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v));
    if (order) out = out.sort((x, y) => (x[order] < y[order] ? 1 : -1));
    if (lim) out = out.slice(0, params[Number(lim[1]) - 1]);
    return { rows: out.map((r) => Object.fromEntries(cols.map(([c, a]) => [a, r[c]]))) };
  };
  return { query, seen };
}

const source = (query) => postgresSource({ query, table: 'mail', id: 'message_id', owner: 'account_id', asOf: 'updated_at', body: 'body', keys: KEYS });

test('S451, K14: Postgres retrieves one account\'s items of one thread by key as a parameter; an item of another thread is refused and nothing of it is kept', { timeout: 300_000 }, async () => {
  // The adapter alone (PT10j): the key is filtered by equality with the value as a parameter, never as text.
  const db = pgMail();
  const s = source(db.query);
  const items = await s.retrieve({ owner: 'acct-a', key: { name: 'thread', value: 't-1' }, limit: 2 });
  assert.deepEqual(items.map((i) => i.id).sort(), ['m-1', 'm-2']);
  assert.ok(items.every((i) => i.owner === 'acct-a' && i.keys?.thread === 't-1'), JSON.stringify(items));
  const sql = db.seen.find((x) => x.text.includes('LIMIT'));
  assert.match(sql.text, /"thread_id" = \$\d+/);
  assert.ok(!sql.text.includes('t-1') && !sql.text.includes('acct-a'), sql.text);
  assert.ok(sql.params.includes('t-1') && sql.params.includes('acct-a'), JSON.stringify(sql.params));
  // A value that would be SQL, as text, stays a parameter.
  assert.deepEqual(await s.retrieve({ owner: 'acct-a', key: { name: 'thread', value: "t-1' OR '1'='1" }, limit: 2 }), []);
  // A key column name is checked at construction.
  assert.throws(() => postgresSource({ query: db.query, table: 'mail', id: 'message_id', owner: 'account_id', asOf: 'updated_at', body: 'body', keys: { thread: 'thread id' } }), /not a plain name/);

  // At run time: the draft reads acct-a's thread t-1 and only that.
  const a = await admitted('source-keys', ['test/fixtures/source-keys/mail-draft.poly']);
  const run = async (query) => {
    const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
    rt.connectSource('mail', source(query));
    const asked = [];
    rt.provide('write', { provider: (q, m) => { asked.push({ q, m }); const t = `Draft over: ${Object.values(m.items).flat().map((i) => i.body).join(' ')}`; return { answer: t, distribution: [[t, 0.9]], reported: 'flash-2026-09', latencyMs: 4 }; }, model: 'flash' });
    await rt.create('mail_draft.Drafter', { id: 'draft-1' });
    await rt.dispatch('draft-1', 'Draft', { thread: 't-1' }, { credentials: { principal: 'acct-a' } });
    for (let k = 0; k < 4; k++) await rt.worker.tick();
    return { rt, asked };
  };

  const ok = pgMail();
  const good = await run(ok.query);
  try {
    assert.equal((await good.rt.getState('draft-1')).state.phase, 'Idle');
    assert.equal(good.asked.length, 1);
    assert.deepEqual(good.asked[0].m.items.context.map((i) => i.id).sort(), ['m-1', 'm-2']);
    const sent = ok.seen.find((x) => x.text.includes('LIMIT'));
    assert.match(sent.text, /"thread_id" = \$\d+/);
    assert.ok(!sent.text.includes('t-1'), sent.text);
    assert.ok(sent.params.includes('t-1') && sent.params.includes('acct-a'), JSON.stringify(sent.params));
    // The draft carries the account's own taint, and goes to the account.
    const out = good.rt.store.db.prepare("SELECT payload FROM pr_outbox WHERE instance_id = 'draft-1' AND kind = 'mail.send'").get();
    assert.ok(out, 'the draft is sent');
    const body = JSON.parse(out.payload).body;
    const draft = await good.rt.contentBody(body);
    assert.ok(draft.includes('Re: hello from Ann.') && draft.includes(' Hello from Ann.'), draft);
    assert.ok(!draft.includes('invoice') && !draft.includes('Another account'), draft);
    assert.deepEqual(good.rt.memory.taintOf(body).o, ['acct-a']);
  } finally { await good.rt.close(); }

  // A source that ignores the key answers acct-a's item of thread t-2: refused, permanent, and nothing kept.
  const leaky = pgMail({ ignore: ['thread_id'] });
  const bad = await run(leaky.query);
  try {
    assert.equal((await bad.rt.getState('draft-1')).state.phase, 'Idle');
    assert.equal(bad.asked.length, 0, 'no decision read an item of another thread');
    const dead = bad.rt.store.db.prepare("SELECT last_error FROM pr_outbox WHERE instance_id = 'draft-1' AND kind = 'source.mail.retrieve'").get();
    assert.match(dead.last_error ?? '', /key|thread/i);
    const steps = bad.rt.store.db.prepare("SELECT action FROM pr_journal WHERE instance_id = 'draft-1'").all().map((x) => x.action);
    assert.ok(!steps.includes('Read') && steps.includes('ReadFailed'), JSON.stringify(steps));
    assert.equal(bad.rt.store.db.prepare('SELECT count(*) AS c FROM poly_items').get().c, 0, 'no item set is kept');
  } finally { await bad.rt.close(); }
});
