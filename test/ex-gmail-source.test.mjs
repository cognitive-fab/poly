// plan-ex.md E2.0, S451, S452: the Gmail source of poly-io, against the recorded tapes only. An account's mail is a
// source owned by its account's principal: the adapter syncs a mailbox through the history API (a first sync and the
// expired-cursor fallback by a bounded list), keeps each message's text by reference, and answers a retrieval by owner.
// Every request goes through the host's authenticated request function, which a test replays from a tape; no test
// reaches Gmail. The key predicate of S451 is added when that ruling lands on v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gmailSource, memoryMailStore, fileMailStore, madeHere } from '@poly/io';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const TAPES = join(ROOT, 'test', 'fixtures', 'traffic', 'gmail');
const tape = (label) => JSON.parse(readFileSync(join(TAPES, `${label}.json`), 'utf8'));
const W = { a01: 'work/19a2f0c4d1e70a01', a02: 'work/19a2f0c4d1e70a02', a03: 'work/19a2f0c4d1e70a03', a04: 'work/19a2f0c4d1e70a04' };

/**
 * A transport that answers each request from the first unused exchange with the same method and URL, keeps every
 * request it was given, and refuses one the tape does not hold. `failAt` makes the n-th request fail, as a crash would.
 */
function replay(exchanges, { failAt } = {}) {
  const left = exchanges.map((e) => ({ ...e, used: false }));
  const seen = [];
  return {
    seen,
    unused: () => left.filter((e) => !e.used).map((e) => e.request.url),
    async request(r) {
      seen.push(r);
      if (failAt !== undefined && seen.length === failAt) throw new Error('connection reset');
      const e = left.find((x) => !x.used && x.request.method === r.method && x.request.url === r.url);
      if (!e) throw new Error(`no recorded exchange for ${r.method} ${r.url}`);
      e.used = true;
      return { status: e.response.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e.response.body) };
    },
  };
}

const account = (owner, label, t) => ({ owner, label, request: (r) => t.request(r) });

test('S452: a first sync lists the inbox once, fetches each message raw, and reports the new items by reference', async () => {
  const t = replay(tape('work').initial);
  const s = gmailSource({ accounts: [account('acct-work', 'work', t)], store: memoryMailStore() });
  assert.ok(madeHere(s));
  assert.equal(s.kind, 'gmail');
  assert.ok(Object.isFrozen(s));
  const r = await s.sync('acct-work');
  assert.equal(r.fallback, false);
  assert.equal(r.first, true);
  // Oldest first, the order they arrived in.
  assert.deepEqual(r.fresh.map((i) => i.id), [W.a01, W.a03]);
  assert.deepEqual(r.fresh.map((i) => i.thread), ['work/19a2f0c4d1e70a01', 'work/19a2f0c4d1e70a03']);
  assert.deepEqual(t.unused(), []);
  // Only GETs, under the API's base, with no credential of their own: the vault's withToken attaches the token (K13).
  for (const q of t.seen) {
    assert.equal(q.method, 'GET');
    assert.ok(q.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/'));
    assert.ok(!Object.keys(q.headers).some((h) => /authorization/i.test(h)));
  }
  assert.deepEqual(await s.retrieve({ owner: 'acct-work', limit: 5 }), [
    { id: W.a03, owner: 'acct-work', asOf: 1791270000000, keys: { message: W.a03, thread: W.a03 } },
    { id: W.a01, owner: 'acct-work', asOf: 1791191520000, keys: { message: W.a01, thread: W.a01 } },
  ]);
  const body = await s.resolve(W.a01);
  assert.match(body, /^From: Alice Moreau <alice@supplier\.example\.com>\nTo: Owner <owner@work\.example\.com>\nSubject: Invoice 4471 for the October delivery\nDate: /);
  assert.match(body, /due on Friday 9 October/);
  assert.equal(await s.resolve('work/19a2f0c4d1e70aff'), null);
});

test('S452: a poll reads messageAdded records page by page from the cursor; announced items are not reported again', async () => {
  const w = tape('work');
  const t = replay([...w.initial, ...w.poll, ...w.quiet]);
  const s = gmailSource({ accounts: [account('acct-work', 'work', t)], store: memoryMailStore() });
  const first = await s.sync('acct-work');
  await s.announce(first.fresh.map((i) => i.id));
  const poll = await s.sync('acct-work');
  assert.equal(poll.first, false);
  assert.deepEqual(poll.fresh.map((i) => i.id), [W.a02, W.a04]);
  // The reply joins its thread.
  assert.equal(poll.fresh[0].thread, 'work/19a2f0c4d1e70a01');
  await s.announce(poll.fresh.map((i) => i.id));
  const quiet = await s.sync('acct-work');
  assert.deepEqual(quiet.fresh, []);
  assert.deepEqual(t.unused(), []);
  assert.equal((await s.retrieve({ owner: 'acct-work', limit: 10 })).length, 4);
});

test('IAC1 at the adapter: a sync cut short is taken again on a restart, with nothing fetched twice and nothing missed', async () => {
  const store = memoryMailStore();
  const w = tape('work');
  // The third request is the second message: the crash comes after the first is kept and before the cursor is.
  const cut = replay(w.initial, { failAt: 4 });
  await assert.rejects(gmailSource({ accounts: [account('acct-work', 'work', cut)], store }).sync('acct-work'), /connection reset/);
  const again = replay(w.initial);
  const s = gmailSource({ accounts: [account('acct-work', 'work', again)], store });
  const r = await s.sync('acct-work');
  assert.deepEqual(r.fresh.map((i) => i.id).sort(), [W.a01, W.a03].sort());
  // The message kept before the crash is not fetched again.
  assert.deepEqual(again.seen.filter((q) => q.url.includes('format=raw')).map((q) => q.url.match(/messages\/(\w+)/)[1]), ['19a2f0c4d1e70a01']);
  assert.deepEqual(again.unused(), ['https://gmail.googleapis.com/gmail/v1/users/me/messages/19a2f0c4d1e70a03?format=raw']);
  // Not announced yet, so a second restart reports them again; the host's instance ids make that harmless (IT2.3).
  const third = gmailSource({ accounts: [account('acct-work', 'work', replay(w.quiet.map((e) => ({ ...e, request: { ...e.request, url: e.request.url.replace('41090', '41000') } }))))], store });
  assert.deepEqual((await third.sync('acct-work')).fresh.map((i) => i.id).sort(), [W.a01, W.a03].sort());
});

test('IT2.1: an expired cursor (404) falls back to a bounded list since the newest message, reports it, and fetches nothing it holds', async () => {
  const w = tape('work');
  const t = replay([...w.initial, ...w.poll, ...w.expired]);
  const s = gmailSource({ accounts: [account('acct-work', 'work', t)], store: memoryMailStore() });
  await s.announce((await s.sync('acct-work')).fresh.map((i) => i.id));
  await s.announce((await s.sync('acct-work')).fresh.map((i) => i.id));
  const r = await s.sync('acct-work');
  assert.equal(r.fallback, true);
  assert.deepEqual(r.fresh, []);
  assert.deepEqual(t.unused(), []);
  assert.equal(t.seen.at(-1).url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=100&q=after%3A1791344640');
  assert.equal(s.cursorOf('acct-work'), '41200');
});

test('S451 at the adapter: three accounts, each one\'s items owned by its principal; a retrieval by owner never returns another\'s', async () => {
  const tapes = { work: replay(tape('work').initial), home: replay(tape('home').initial), club: replay(tape('club').initial) };
  const s = gmailSource({ accounts: [account('acct-work', 'work', tapes.work), account('acct-home', 'home', tapes.home), account('acct-club', 'club', tapes.club)], store: memoryMailStore() });
  for (const o of ['acct-work', 'acct-home', 'acct-club']) await s.sync(o);
  const home = await s.retrieve({ owner: 'acct-home', limit: 10 });
  assert.deepEqual(home.map((i) => i.id), ['home/19a2f1aa00b30b02', 'home/19a2f1aa00b30b01']);
  assert.ok(home.every((i) => i.owner === 'acct-home'));
  assert.deepEqual(await s.retrieve({ owner: 'acct-nobody', limit: 10 }), []);
  // With no owner predicate, every account's items, newest first (the runtime gives such a set the owners Ω, S326).
  const all = await s.retrieve({ limit: 3 });
  assert.deepEqual(all.map((i) => i.id), [W.a03, W.a01, 'home/19a2f1aa00b30b02']);
  await assert.rejects(s.sync('acct-nobody'), /no account/);
  assert.match(await s.resolve('home/19a2f1aa00b30b01'), /Subject: Dîner samedi \?/);
  assert.match(await s.resolve('club/19a2f2bb11c40c01'), /\[attachment: budget-draft\.pdf, application\/pdf, 78 bytes\]/);
});

test('PS17.7 at the adapter: forget removes an account\'s items and its cursor, and leaves the others', async () => {
  const s = gmailSource({ accounts: [account('acct-work', 'work', replay(tape('work').initial)), account('acct-home', 'home', replay(tape('home').initial))], store: memoryMailStore() });
  await s.sync('acct-work');
  await s.sync('acct-home');
  assert.deepEqual(await s.forget('acct-home'), { removed: 2 });
  assert.equal(await s.resolve('home/19a2f1aa00b30b01'), null);
  assert.equal(s.cursorOf('acct-home'), null);
  assert.equal((await s.retrieve({ owner: 'acct-work', limit: 5 })).length, 2);
  assert.deepEqual(await s.forget('acct-nobody'), { removed: 0 });
});

test('S452: a body is bounded, and the adapter refuses a configuration it could be misled by', async () => {
  const s = gmailSource({ accounts: [account('acct-work', 'work', replay(tape('work').initial))], store: memoryMailStore(), maxBody: 120 });
  await s.sync('acct-work');
  const b = await s.resolve(W.a01);
  assert.ok(b.length <= 120 + '\n[truncated]'.length);
  assert.ok(b.endsWith('\n[truncated]'));
  const t = replay([]);
  for (const [accounts, why] of [
    [[account('acct-work', 'work/x', t)], /label/],
    [[account('', 'work', t)], /owner/],
    [[account('acct-work', 'work', t), account('acct-work', 'home', t)], /twice/],
    [[account('acct-work', 'work', t), account('acct-home', 'work', t)], /twice/],
    [[{ owner: 'acct-work', label: 'work', request: 'no' }], /request/],
    [[], /account/],
  ]) assert.throws(() => gmailSource({ accounts, store: memoryMailStore() }), why);
});

test('S452: a file mail store is named by an absolute file: path, keeps items across instances, names no file by an address, and forgets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-mailstore-'));
  try {
    assert.throws(() => fileMailStore('relative/dir'), /file:/);
    assert.throws(() => fileMailStore('file:relative/dir'), /absolute/);
    const store = fileMailStore(`file:${dir}`);
    const s = gmailSource({ accounts: [account('acct-home', 'home', replay(tape('home').initial))], store });
    await s.sync('acct-home');
    const names = readdirSync(dir);
    assert.ok(names.length >= 3);
    assert.ok(names.every((n) => /^[0-9a-f]{64}\.json$/.test(n)), names.join(' '));
    const again = gmailSource({ accounts: [account('acct-home', 'home', replay([]))], store: fileMailStore(`file:${dir}`) });
    assert.match(await again.resolve('home/19a2f1aa00b30b02'), /Votre colis a été expédié/);
    assert.deepEqual(await again.forget('acct-home'), { removed: 2 });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S452: a source may name the adapter "gmail"; poly-io makes it, so the checker no longer refuses it (PL6834)', { timeout: 120_000 }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'poly-gmail-check-'));
  try {
    const { writeFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'concierge-memory.poly'), 'utf8').replace('  adapter "postgres"', '  adapter "gmail"');
    writeFileSync(join(d, 'm.poly'), src);
    const r = await checkFile(join(d, 'm.poly'), { root: d });
    const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((x) => x.code);
    assert.ok(!codes.includes('PL6834'), JSON.stringify(codes));
    assert.equal(r.verdict, 'CLEAN');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('S451: each item gives its message and thread keys; a retrieval by key narrows to them; a correspondent key only through the host\'s keyed function', async () => {
  const w = tape('work');
  const keyed = (address) => `ck:${address.length}:${address.split('@')[1]}`;
  const s = gmailSource({ accounts: [account('acct-work', 'work', replay([...w.initial, ...w.poll]))], store: memoryMailStore(), correspondentKey: keyed });
  await s.announce((await s.sync('acct-work')).fresh.map((i) => i.id));
  await s.sync('acct-work');
  // The reply joins the first message's thread: a retrieval by that thread returns both, newest first.
  const thread = await s.retrieve({ owner: 'acct-work', key: { name: 'thread', value: 'work/19a2f0c4d1e70a01' }, limit: 5 });
  assert.deepEqual(thread.map((i) => i.id), [W.a02, W.a01]);
  assert.ok(thread.every((i) => i.keys.thread === 'work/19a2f0c4d1e70a01'));
  assert.deepEqual((await s.retrieve({ owner: 'acct-work', key: { name: 'message', value: W.a04 }, limit: 5 })).map((i) => i.id), [W.a04]);
  // Another owner's thread key gives nothing (K14): a key narrows within the owner, never across.
  assert.deepEqual(await s.retrieve({ owner: 'acct-home', key: { name: 'thread', value: 'work/19a2f0c4d1e70a01' }, limit: 5 }), []);
  // The correspondent key is the host's keyed value, never the address.
  const alice = await s.retrieve({ owner: 'acct-work', key: { name: 'correspondent', value: keyed('alice@supplier.example.com') }, limit: 5 });
  assert.deepEqual(alice.map((i) => i.id), [W.a02, W.a01]);
  assert.ok(!JSON.stringify(alice).includes('alice@'));
  await assert.rejects(s.retrieve({ owner: 'acct-work', key: { name: 'subject', value: 'x' }, limit: 5 }), /does not give/);
  await assert.rejects(s.retrieve({ owner: 'acct-work', key: { name: 'thread', value: '' }, limit: 5 }), /non-empty/);
  const plain = gmailSource({ accounts: [account('acct-work', 'work', replay(w.initial))], store: memoryMailStore() });
  await plain.sync('acct-work');
  assert.ok((await plain.retrieve({ owner: 'acct-work', limit: 5 })).every((i) => !('correspondent' in i.keys)));
  await assert.rejects(plain.retrieve({ owner: 'acct-work', key: { name: 'correspondent', value: 'x' }, limit: 5 }), /correspondentKey/);
});
