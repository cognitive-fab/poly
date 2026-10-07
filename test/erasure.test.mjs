// M9 step 9 (S205, S191; PS3.2's erasure and PS15.4's addresses): the content store is erasable, and a channel's
// addresses are kept there under their keyed digests, never in the journal or the ledger. The address scan is the
// canary-style test that lifts the certificate's limit S191.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';
import { admitted, loaded, makeKey, project } from './runtime-helpers.mjs';

const SRC = readFileSync(join(ROOT, 'test', 'fixtures', 'channels', 'concierge.poly'), 'utf8');

async function channelBuild(name) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-erasure');
  writeFileSync(join(dir, 'src', 'concierge.poly'), SRC);
  const r = await admit(dir, { std: TEST_STD });
  return { cert: r.certificate, a: { build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } } };
}

/** Every text the store holds, table by table: each column of each row, as text. */
function everything(rt, except = []) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (except.includes(name)) continue;
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push(`${name}: ${v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)}`);
  }
  return out;
}
/** The encodings the scan knows (plan-m9 section 6): plain, base64, base64url and URL-encoded. */
const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];
const found = (texts, s) => texts.filter((t) => encodings(s).some((e) => t.includes(e)));

test('S205: an erased body stays erased: its digest is kept with an erasure record, and every later step naming it is content-missing', { timeout: 120_000 }, async () => {
  const a = await admitted('erasure-content', ['conformance/m8/content/notes.poly']);
  const { rt } = await loaded(a);
  try {
    const d = await rt.putContent('a body to forget');
    await rt.create('notes.Note', { id: 'n-1' });
    assert.equal((await rt.dispatch('n-1', 'Write', { c: d })).stepKind, 'accepted');
    await rt.erase(d);
    assert.equal(await rt.contentBody(d), null);
    await rt.create('notes.Note', { id: 'n-2' });
    const r = await rt.dispatch('n-2', 'Write', { c: d });
    assert.deepEqual([r.stepKind, r.rejectReason], ['rejected', 'content-missing']);
    // Presented again, the same body is not stored again.
    assert.equal(await rt.putContent('a body to forget'), d);
    assert.equal(await rt.contentBody(d), null);
    assert.deepEqual((await rt.chain('runtime:content')).filter((e) => e.kind === 'verdict').map((e) => [e.body.stage, e.body.digest]), [['erasure', d]]);
    assert.deepEqual(found(everything(rt), 'a body to forget'), []);
    // The records the journal keeps by digest are not erasable.
    const kept = rt.store.db.prepare('SELECT digest FROM poly_content WHERE digest != ?').get(d).digest;
    await assert.rejects(rt.erase(kept), /not erasable/);
    assert.notEqual(await rt.store.body(kept), null);
  } finally { await rt.close(); }
});

test('S191, S205: a channel\'s address is kept only in the erasable store, under its keyed digest; the journal, the ledger and ingress hold none, and erasing it leaves no trace', { timeout: 300_000 }, async () => {
  const { a, cert } = await channelBuild('erasure-address');
  // The certificate's limit S191 is lifted.
  assert.ok(!cert.poly.limits.some((l) => /S191/.test(l)), JSON.stringify(cert.poly.limits));
  const { rt } = await loaded(a, { std: TEST_STD });
  const CANARY = 'canary-addr-7f3a9c41@example.test';
  try {
    const body = await rt.putContent('where is my order');
    // An unknown thread: since E13 the message creates the application at its keyed id, takes starts, spawns the
    // conversation and is delivered (PS15.4), each step journaled with the keyed digest.
    const r = await rt.inbound('support', { from: CANARY, body }, { messageId: 'm-1' });
    const app = await rt.threadId('support', CANARY);
    assert.match(app, /^support:hmac-sha256:[0-9a-f]{64}$/);
    assert.deepEqual([r.outcome, r.application], ['delivered', app], JSON.stringify(r));
    const step = (await rt.getJournal(`${app}/support`)).find((j) => j.action === 'Inbound');
    assert.match(JSON.stringify(step), /hmac-sha256:/);
    const dataOf = typeof step.data === 'string' ? await rt.store.body(step.data) : step.data;
    assert.match(dataOf.from, /^hmac-sha256:[0-9a-f]{64}$/);
    // The address is in the erasable store, and nowhere else.
    assert.ok(found(everything(rt, ['poly_content']), CANARY).length === 0, found(everything(rt, ['poly_content']), CANARY).join('\n'));
    assert.equal(found(everything(rt), CANARY).length, 1);
    assert.equal(await rt.contentBody(dataOf.from), CANARY);
    await rt.erase(dataOf.from);
    await rt.erase(app.slice('support:'.length));
    assert.deepEqual(found(everything(rt), CANARY), []);
  } finally { await rt.close(); }
});

test('S191, seeded control: the scan finds an address journaled in the clear', { timeout: 300_000 }, async () => {
  const { a } = await channelBuild('erasure-control');
  const { rt } = await loaded(a, { std: TEST_STD, fault: 'address-in-clear' });
  const CANARY = 'canary-addr-0b52e7d9@example.test';
  try {
    const body = await rt.putContent('hello');
    await rt.inbound('support', { from: CANARY, body }, { messageId: 'm-1' });
    assert.ok(found(everything(rt, ['poly_content']), CANARY).length > 0);
  } finally { await rt.close(); }
});
