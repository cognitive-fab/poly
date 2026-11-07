// PT34.5, "The generated reports": no body and no address in a kept store (the owner's request of 2026-11-06). Written
// by a separate writer from the specification alone, before any code (rule 7a). After its scripted day, each example's
// script erases every body and address its store marked erasable (S205, rt.erase over poly_erasable), and the kept file
// is vacuumed, so a kept store holds digests and no body or address, not even in a deleted page. pii-guard's store did
// so from A5 (test/pii-guard-risk-report.test.mjs, PG14); these tests hold the concierge's store to the same property.
//
// The private values are derived at test time from the fixtures scripts/risk-report-examples.mjs drives the concierge
// with (test/fixtures/concierge/answers.json, the recorded Slack and WhatsApp traffic, the host's notice text and its
// fixed acknowledgements), with a short list of literals only where the script builds a value inline. The kept files
// are read in place and never written; the one file this test writes is in a temporary folder.
//
// Measured on the kept store of d2f1a5f9: poly_content holds 16 rows (twelve bodies, the two WhatsApp numbers and the
// Slack user and channel), poly_erasable names the same 16 digests and poly_erased none, and 17 of the derived values
// are in the file's bytes. A copy with poly_content deleted and vacuumed held none of them, except the Slack channel
// inside the recorded post's provider id (see PROVIDER_ID below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// The repository's root, computed here rather than imported from helpers.mjs, which loads the compiler: this file reads
// files only.
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const KEPT = join(ROOT, 'docs', 'examples', 'risk-report');
const CONCIERGE = join(KEPT, 'concierge');
const AIRLINE = join(KEPT, 'airline-desk');
const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic');
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

// The values concierge() in scripts/risk-report-examples.mjs builds inline, so no fixture holds them: the second
// customer's WhatsApp number (PHONES['wa-2']) and the staff's Slack message.
const INLINE = [
  { value: '16505559876', from: 'scripts/risk-report-examples.mjs PHONES[wa-2]' },
  { value: 'Morning, the concierge is on.', from: 'scripts/risk-report-examples.mjs staff.event.text' },
];

/**
 * Every body and address the concierge's scripted day can store, each with where it comes from. A value the day does
 * not reach (a reply for an outcome it never takes, a message it never sends) is listed too: it is absent today and
 * must stay absent, so listing it costs nothing and catches a day that grows.
 */
async function privateValues() {
  const values = new Map();
  const add = (value, from) => { if (typeof value === 'string' && value.length > 0 && !values.has(value)) values.set(value, from); };
  const answers = json(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
  // The customers' messages, the status answers and every reply (test/fixtures/concierge/answers.json).
  for (const m of answers.messages) {
    add(m.text, `answers.json messages[${m.id}].text`);
    add(m.answer?.text, `answers.json messages[${m.id}].answer.text`);
    for (const [outcome, text] of Object.entries(m.replies ?? {})) add(text, `answers.json messages[${m.id}].replies.${outcome}`);
  }
  // The order bodies the orders source serves (orderRows maps each order's body to the column `summary`).
  for (const o of answers.orders) add(o.body, `answers.json orders[${o.id}].body`);
  // The acknowledgements the host's recorded providers answer with: the fixture's acks or the defaults recorded.mjs holds.
  const { recordedConcierge } = await import(pathToFileURL(join(ROOT, 'examples', 'concierge', 'host', 'recorded.mjs')).href);
  const decisions = recordedConcierge(answers).decisions;
  add(decisions.noted.provider({ decision: 'noted' }, {}).answer, 'examples/concierge/host/recorded.mjs noted');
  add(decisions.ack.provider({ decision: 'ack' }, { bodies: { m: answers.messages[0].text } }).answer, 'examples/concierge/host/recorded.mjs ack');
  // The notice the host posts to staff, around the intent id it names: both fixed parts of noticeText.
  const { noticeText } = await import(pathToFileURL(join(ROOT, 'examples', 'concierge', 'host', 'notice.mjs')).href);
  for (const [i, part] of noticeText('\u0000').split('\u0000').entries()) add(part, `examples/concierge/host/notice.mjs noticeText part ${i}`);
  // The addresses: the first customer's WhatsApp number and profile name from the recorded webhook, and the Slack user
  // and channel from the recorded Slack event.
  const wa = json(join(TRAFFIC, 'whatsapp', 'message.json')).entry[0].changes[0].value;
  add(wa.contacts[0].wa_id, 'test/fixtures/traffic/whatsapp/message.json contacts[0].wa_id');
  add(wa.contacts[0].profile.name, 'test/fixtures/traffic/whatsapp/message.json contacts[0].profile.name');
  const slackEvent = json(join(TRAFFIC, 'slack', 'message.json')).event;
  add(slackEvent.user, 'test/fixtures/traffic/slack/message.json event.user');
  add(slackEvent.channel, 'test/fixtures/traffic/slack/message.json event.channel');
  for (const { value, from } of INLINE) add(value, from);
  return values;
}

// A question for the owner, not settled by PT34.5. The Slack transport records the provider's id of each post as
// `<channel>:<ts>`, from the recorded reply test/fixtures/traffic/slack/post-ok.json, and the runtime keeps it in the
// hash-chained journal (pr_journal and poly_kept). It is no body or address the store marked erasable, so no erasure
// reaches it, and it embeds the staff channel's id. The scan masks that one provider id before it looks for the bare
// channel, so these tests hold what PT34.5 says the script does; whether a provider id that embeds an address is an
// address of the kept store is the owner's to decide.
const PROVIDER_ID = (() => {
  const post = json(join(TRAFFIC, 'slack', 'post-ok.json'));
  return `${post.channel}:${post.ts}`;
})();

/** The derived values found in a file's raw bytes, each with where it comes from: the file is read, not queried, so a
    value left in a deleted cell or a free page is found too. */
function valuesInBytes(file, values) {
  const bytes = readFileSync(file);
  // The store is UTF-8 (PRAGMA encoding); latin1 maps each byte to one character, so it finds an ASCII value whatever
  // bytes surround it, and utf8 finds a value with a character outside ASCII.
  const texts = [bytes.toString('latin1'), bytes.toString('utf8')].map((s) => s.split(PROVIDER_ID).join('<provider id>'));
  const hits = [];
  for (const [value, from] of values) {
    const forms = new Set([value, JSON.stringify(value).slice(1, -1)]);
    if (texts.some((t) => [...forms].some((f) => t.includes(f)))) hits.push(`${JSON.stringify(value)} (${from})`);
  }
  return hits;
}

/** The content store and the erasure records of a store: whether poly_content exists, its rows, and the erasable digests
    with no erasure recorded. */
function erasure(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const content = tables.has('poly_content') ? db.prepare('SELECT digest FROM poly_content ORDER BY digest').all().map((r) => r.digest) : null;
    const notErased = tables.has('poly_erasable') && tables.has('poly_erased')
      ? db.prepare('SELECT digest FROM poly_erasable WHERE digest NOT IN (SELECT digest FROM poly_erased) ORDER BY digest').all().map((r) => r.digest)
      : null;
    const erasable = tables.has('poly_erasable') ? db.prepare('SELECT COUNT(*) AS n FROM poly_erasable').get().n : null;
    const freelist = db.prepare('PRAGMA freelist_count').get().freelist_count;
    return { content, notErased, erasable, freelist };
  } finally {
    db.close();
  }
}

/** The files `poly report risks` reads from a kept folder (PT34.5, docs/examples/risk-report/README.md). */
function reportFiles(dir) {
  const missing = [];
  for (const f of ['store.db', 'certificate.json', 'trust.json', 'report.json', 'report.md']) if (!existsSync(join(dir, f))) missing.push(f);
  if (existsSync(join(dir, 'certificate.json'))) {
    for (const p of json(join(dir, 'certificate.json')).poly.policies) {
      const kept = join(dir, 'build', p.path.replace(/^\.poly\/build\//, ''));
      if (!existsSync(kept)) missing.push(rel(kept));
    }
  }
  if (existsSync(join(dir, 'trust.json'))) for (const f of Object.values(json(join(dir, 'trust.json')))) if (!existsSync(join(dir, f))) missing.push(f);
  return missing;
}

// ── The property (PT34.5): fails until the concierge's store is generated again with its erasure ───────────────────

test('PT34.5 S205: the concierge kept store has an empty poly_content, and every digest of poly_erasable is erased', () => {
  const store = join(CONCIERGE, 'store.db');
  const { content, notErased, erasable } = erasure(store);
  assert.notEqual(content, null, `${rel(store)} has a poly_content table`);
  assert.notEqual(notErased, null, `${rel(store)} has poly_erasable and poly_erased`);
  assert.ok(erasable > 0, `the concierge's day marks bodies and addresses erasable (${erasable}); an empty poly_erasable would make this test vacuous`);
  assert.deepEqual(content, [], `${rel(store)}: poly_content holds no body and no address, ${content.length} rows found`);
  assert.deepEqual(notErased, [], `${rel(store)}: every erasable digest is erased (rt.erase over poly_erasable), ${notErased.length} of ${erasable} are not`);
});

test('PT34.5: no body and no address of the concierge scripted day is in the kept store bytes, not even in a deleted page', async () => {
  const store = join(CONCIERGE, 'store.db');
  const values = await privateValues();
  assert.deepEqual(valuesInBytes(store, values), [], `${rel(store)} holds none of the ${values.size} derived bodies and addresses`);
});

// ── Guards: they pass today, and keep the two tests above meaningful ──────────────────────────────────────────────

test('guard: the derived values include each kind the concierge day stores, and the scan finds a value in a deleted row', async () => {
  const values = await privateValues();
  const froms = [...values.values()];
  for (const kind of ['messages[', 'orders[', 'replies.', 'noticeText', 'recorded.mjs noted', 'wa_id', 'event.user', 'event.channel', 'PHONES[wa-2]', 'staff.event.text']) {
    assert.ok(froms.some((f) => f.includes(kind)), `a value derived from ${kind}`);
  }
  // The method: a row inserted and deleted without VACUUM leaves its bytes in the file, and the scan finds them.
  const dir = mkdtempSync(join(tmpdir(), 'poly-concierge-erase-'));
  try {
    const file = join(dir, 'probe.db');
    const [value] = values.keys();
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE poly_content (digest TEXT PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO poly_content VALUES (?, ?)').run('sha256:probe', JSON.stringify(value));
    db.exec('DELETE FROM poly_content');
    db.close();
    assert.equal(erasure(file).content.length, 0, 'the probe row is deleted');
    assert.equal(valuesInBytes(file, new Map([[value, 'probe']])).length, 1, 'the scan finds the deleted row in the bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: the concierge kept folder holds what the report reads, as one vacuumed file with no -wal or -shm beside it', () => {
  assert.ok(existsSync(CONCIERGE) && statSync(CONCIERGE).isDirectory(), `${rel(CONCIERGE)} exists`);
  assert.deepEqual(reportFiles(CONCIERGE), [], `${rel(CONCIERGE)} holds every file the report reads`);
  const beside = readdirSync(CONCIERGE).filter((f) => /^store\.db-(wal|shm)$/.test(f));
  assert.deepEqual(beside, [], 'no log beside store.db, where a body could stay out of the scanned file');
  assert.equal(erasure(join(CONCIERGE, 'store.db')).freelist, 0, 'the kept store has no free page');
});

test('guard: the airline desk kept store holds no body and no address (it stored none)', async () => {
  const store = join(AIRLINE, 'store.db');
  assert.deepEqual(reportFiles(AIRLINE), [], `${rel(AIRLINE)} holds every file the report reads`);
  assert.deepEqual(readdirSync(AIRLINE).filter((f) => /^store\.db-(wal|shm)$/.test(f)), [], 'no log beside store.db');
  const { content, notErased, freelist } = erasure(store);
  assert.deepEqual(content, [], `${rel(store)}: poly_content is present and empty`);
  assert.deepEqual(notErased, [], `${rel(store)}: no erasable digest is left unerased`);
  assert.equal(freelist, 0, 'no free page');
  assert.deepEqual(valuesInBytes(store, await privateValues()), [], `${rel(store)} holds none of the concierge's values`);
});
