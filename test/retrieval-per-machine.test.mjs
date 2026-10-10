// S41 with S451 (PS17.2, PT10j, ruled 2026-10-09): one retrieval per machine and kind. Written from the specification
// text alone. Every retrieval of a source s has the kind source.s.retrieve, whatever machine declares it, and each intent
// of that kind is run with the retrieval its own machine declares: its owner predicate, its key predicate and its limit.
// So two machines may retrieve from one source differently and each runs its own, never one entry for the whole
// program. Within one machine, two effects whose retrievals from one source differ in owner predicate, key predicate or
// limit are PL1002, since a machine holds one retrieval per kind; so are two remembers of one source in one machine whose
// provenance or subject differ. No test reaches a database or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { checkFile } from '@poly/check';
import { postgresSource } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'retrieval-per-machine');
const INBOX = readFileSync(join(FIX, 'inbox.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-retrieval-per-machine');

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

// The inbox with Todo declared first and Message last, so a runtime that kept the last declared entry for the whole
// program would run Message's retrieval for Todo's intents.
const at = INBOX.indexOf('machine Todo {');
const HEAD = INBOX.slice(0, INBOX.indexOf('machine Message {'));
const MESSAGE = INBOX.slice(INBOX.indexOf('machine Message {'), at);
const TODO = INBOX.slice(at);
const REVERSED = `${HEAD}${TODO.trimEnd()}\n\n${MESSAGE.trimEnd()}\n`;

// ---------------------------------------------------------------------------------------------------------------------
// The checker.
// ---------------------------------------------------------------------------------------------------------------------

test('S41 with S451, PS17.2: two machines retrieving from one source by different keys and limits check CLEAN with no diagnostic, and each machine\'s manifest holds its own entry', { timeout: 300_000 }, async () => {
  for (const src of [INBOX, REVERSED]) {
    const { r, build } = await check(src);
    assert.deepEqual(codes(r), [], text(r));
    assert.equal(r.verdict, 'CLEAN', text(r));
    // PT10j: each machine's manifest holds its own entry for source.mail.retrieve.
    const entry = (m) => JSON.parse(readFileSync(join(build, `inbox.${m}`, 'effects.manifest.json'), 'utf8')).effects['source.mail.retrieve'];
    assert.deepEqual(entry('Message').retrieve, { source: 'mail', owner: 'account', key: { name: 'message', param: 'k' }, limit: 1 });
    assert.deepEqual(entry('Todo').retrieve, { source: 'mail', owner: 'account', key: { name: 'thread', param: 'k' }, limit: 5 });
  }
});

// Message with a second effect of the kind source.mail.retrieve beside read, the same payload and completions, emitted
// by an action of its own. `body` is the second retrieval line. String.replace swaps the first match, in Message.
const twin = (body) => swap(swap(INBOX,
  '  action ReadFailed()\n\n  on Open(k) by c: Account {',
  '  action ReadFailed()\n  action Again(k: Key)\n\n  on Again(k) by c: Account {\n    require phase == Idle else reject "busy"\n    phase\' = Reading\n    emit again(account: c.principal, k: k)\n  }\n\n  on Open(k) by c: Account {'),
  '    failed -> ReadFailed()\n  }\n}\n\nmachine Todo {',
  `    failed -> ReadFailed()\n  }\n\n  effect again(account: Principal, k: Key) {\n    ${body}\n    ok(r) -> Read(items: r.items)\n    failed -> ReadFailed()\n  }\n}\n\nmachine Todo {`);

test('S41 with S451, PS17.2, PT10j: within one machine, two retrievals from one source that differ in key predicate, limit or owner predicate are PL1002; two identical ones are not', { timeout: 600_000 }, async () => {
  const same = await check(twin('retrieve mail where owner == account and message == k limit 1'));
  assert.ok(!codes(same.r).includes('PL1002'), text(same.r));
  assert.equal(same.r.verdict, 'CLEAN', text(same.r));
  for (const body of [
    'retrieve mail where owner == account and thread == k limit 1',
    'retrieve mail where owner == account and message == k limit 2',
    'retrieve mail where message == k limit 1',
  ]) {
    const { r } = await check(twin(body));
    assert.equal(r.verdict, 'REFUSED', `${body}: ${text(r)}`);
    assert.ok(codes(r).includes('PL1002'), `${body}: ${text(r)}`);
  }
});

// PS17.2: "so are two remembers of one source in one machine whose provenance or subject differ". Message gains a
// memory source, a field, and an action that remembers a fact once through two effects of the kind source.notes.remember.
// String.replace swaps the first match, in Message.
const remembering = (provenance, about) => swap(swap(swap(swap(INBOX,
  'enum Phase', 'source notes: memory {\n  audience account owned\n}\n\nenum Phase'),
  '    phase : Phase = Idle\n  }\n', '    phase : Phase = Idle\n    noted : bool  = false\n  }\n'),
  '  action ReadFailed()\n\n  on Open(k) by c: Account {',
  '  action ReadFailed()\n  action Note(fact: Content)\n\n  on Note(fact) by c: Account {\n    require !noted else reject "noted"\n    noted\' = true\n    emit note(subject: c.principal, other: c.principal, fact: fact)\n    emit jot(subject: c.principal, other: c.principal, fact: fact)\n  }\n\n  on Open(k) by c: Account {'),
  '    failed -> ReadFailed()\n  }\n}\n\nmachine Todo {',
  `    failed -> ReadFailed()\n  }\n\n  effect note(subject: Principal, other: Principal, fact: Content) {\n    remember notes as derived about subject\n  }\n\n  effect jot(subject: Principal, other: Principal, fact: Content) {\n    remember notes as ${provenance} about ${about}\n  }\n}\n\nmachine Todo {`);

test('S41 with S451, PS17.2: within one machine, two remembers of one source that differ in provenance or subject are PL1002; two identical ones are not', { timeout: 600_000 }, async () => {
  const same = await check(remembering('derived', 'subject'));
  assert.ok(!codes(same.r).includes('PL1002'), text(same.r));
  assert.equal(same.r.verdict, 'CLEAN', text(same.r));
  for (const [provenance, about] of [['observed', 'subject'], ['derived', 'other']]) {
    const { r } = await check(remembering(provenance, about));
    assert.equal(r.verdict, 'REFUSED', `${provenance} about ${about}: ${text(r)}`);
    assert.ok(codes(r).includes('PL1002'), `${provenance} about ${about}: ${text(r)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The runtime: each intent of source.mail.retrieve runs with its own machine's entry (PT10j).
// ---------------------------------------------------------------------------------------------------------------------

// One account's mail and another's. Message m-1 is in thread t-1 with m-2; thread t-1 also exists in acct-b.
const ROWS = [
  { message_id: 'm-1', account_id: 'acct-a', thread_id: 't-1', updated_at: '2026-10-01T09:00:00Z', body: 'Hello.' },
  { message_id: 'm-2', account_id: 'acct-a', thread_id: 't-1', updated_at: '2026-10-03T09:00:00Z', body: 'Re: hello.' },
  { message_id: 'm-3', account_id: 'acct-a', thread_id: 't-2', updated_at: '2026-10-05T09:00:00Z', body: 'An invoice.' },
  { message_id: 'm-4', account_id: 'acct-b', thread_id: 't-1', updated_at: '2026-10-04T09:00:00Z', body: 'Another account.' },
];
const KEYS = { message: 'message_id', thread: 'thread_id' };

/** A query function that answers the SELECTs the adapter writes over "mail" by reading them, and keeps every query. */
function pgMail() {
  const seen = [];
  const query = async (q, params) => {
    seen.push({ text: q, params });
    if (!q.startsWith('SELECT ')) throw new Error(`unexpected query ${q}`);
    const [head, rest = ''] = q.split(' FROM ');
    const cols = [...head.matchAll(/"(\w+)" AS (\w+)/g)].map((m) => [m[1], m[2]]);
    const eqs = [...rest.matchAll(/"(\w+)" = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]]);
    const order = /ORDER BY "(\w+)" DESC/.exec(rest)?.[1];
    const lim = /LIMIT \$(\d+)/.exec(rest);
    let out = ROWS.filter((r) => eqs.every(([c, v]) => r[c] === v));
    if (order) out = out.sort((x, y) => (x[order] < y[order] ? 1 : -1));
    if (lim) out = out.slice(0, params[Number(lim[1]) - 1]);
    return { rows: out.map((r) => Object.fromEntries(cols.map(([c, a]) => [a, r[c]]))) };
  };
  return { query, seen };
}

/** The retrievals the adapter was asked: for each, the key columns it filtered on, their values and the limit. */
const retrievals = (seen) => seen.filter((x) => /LIMIT \$\d+/.test(x.text)).map((x) => {
  const eqs = Object.fromEntries([...x.text.split(' FROM ')[1].matchAll(/"(\w+)" = \$(\d+)/g)].map((m) => [m[1], x.params[Number(m[2]) - 1]]));
  return { eqs, limit: x.params[Number(/LIMIT \$(\d+)/.exec(x.text)[1]) - 1] };
});

test('S41 with S451, PT10j: at run time Message\'s intent retrieves by message with limit 1 and Todo\'s by thread with limit 5, whichever machine is declared last', { timeout: 600_000 }, async () => {
  const dir = join(OUT, 'reversed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inbox.poly'), REVERSED);
  for (const [name, file] of [['retrieval-per-machine', 'test/fixtures/retrieval-per-machine/inbox.poly'], ['retrieval-per-machine-reversed', '.poly/test-retrieval-per-machine/reversed/inbox.poly']]) {
    const a = await admitted(name, [file]);
    const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
    try {
      const db = pgMail();
      rt.connectSource('mail', postgresSource({ query: db.query, table: 'mail', id: 'message_id', owner: 'account_id', asOf: 'updated_at', body: 'body', keys: KEYS }));
      await rt.create('inbox.Message', { id: 'msg-1' });
      await rt.create('inbox.Todo', { id: 'todo-1' });

      // Message first: one retrieval, by message, limit 1.
      await rt.dispatch('msg-1', 'Open', { k: 'm-1' }, { credentials: { principal: 'acct-a' } });
      for (let k = 0; k < 4; k++) await rt.worker.tick();
      assert.equal((await rt.getState('msg-1')).state.phase, 'Idle', name);
      const first = retrievals(db.seen);
      assert.equal(first.length, 1, `${name}: ${JSON.stringify(first)}`);
      assert.deepEqual(first[0], { eqs: { account_id: 'acct-a', message_id: 'm-1' }, limit: 1 }, name);

      // Then Todo: one more retrieval, by thread, limit 5.
      await rt.dispatch('todo-1', 'Open', { k: 't-1' }, { credentials: { principal: 'acct-a' } });
      for (let k = 0; k < 4; k++) await rt.worker.tick();
      assert.equal((await rt.getState('todo-1')).state.phase, 'Idle', name);
      const both = retrievals(db.seen);
      assert.equal(both.length, 2, `${name}: ${JSON.stringify(both)}`);
      assert.deepEqual(both[1], { eqs: { account_id: 'acct-a', thread_id: 't-1' }, limit: 5 }, name);

      // Each completed with Read, never ReadFailed: an answer longer than the limit or of another key would be refused.
      for (const id of ['msg-1', 'todo-1']) {
        const steps = rt.store.db.prepare('SELECT action FROM pr_journal WHERE instance_id = ?').all(id).map((x) => x.action);
        assert.ok(steps.includes('Read') && !steps.includes('ReadFailed'), `${name} ${id}: ${JSON.stringify(steps)}`);
      }
    } finally { await rt.close(); }
  }
});
