// M7.4 (PT32.4, S521): the inbox host's surface for a person's verdict on a recorded answer. The digest lists each decision
// event no one has judged, once, by its name, the start of its hash and its model (never a question, an answer or a body); and
// `run.mjs ask --do adjudicate` signs a verdict with the person key the host's config names and writes it to <project>/verdicts.
// Written by the implementer from PT32.4. Light: the store is a small one from the router of conformance/m4.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyringsOf, loadProject, verdictSubject, verifyRecord } from '@poly/core';
import { load } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { ANCHORS, PERSON, admitted } from './runtime-helpers.mjs';

const host = (f) => import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', f)).href);
const { readDigest, formatDigest } = await host('digest.mjs');
const { main, judged } = await host('run.mjs');
const hex = (h) => h.replace(/^sha256:/, '').slice(0, 12);

let tmp; let a; let db; let hashes;
const refund = (p) => ({ answer: 'Refund', distribution: [['Refund', p], ['Complaint', (1 - p) * 0.7], ['Other', (1 - p) * 0.3]] });
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-adjudicate-host-'));
  a = await admitted('ex-adjudicate', ['conformance/m4/router.poly']);
  db = join(tmp, 'store.sqlite');
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db } });
  let k = 0;
  rt.provide('route', { provider: () => ({ reported: 'jev-2026-09-18', latencyMs: 1, ...refund(0.9 - 0.04 * (k++ % 20)) }), model: 'jev-latest' });
  for (const id of Array.from({ length: 20 }, (_, i) => 't-' + (i + 1))) {
    await rt.create('support.Ticket', { id });
    await rt.dispatch(id, 'Received', { text: 'where is my refund' });
    await rt.worker.tick();
  }
  await rt.close();
  const { openJournal } = await import('@poly/runtime');
  const reader = openJournal(db);
  hashes = [];
  for (const r of await reader.runs()) for (const e of await reader.chain(r.run)) if (e.kind === 'decision') hashes.push(e.hash);
  await reader.close();
  writeFileSync(join(tmp, 'person.pem'), PERSON.privateKeyPem);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const ledgerRt = (rows) => ({
  store: { db: { prepare: (sql) => ({ all: () => (/poly_ledger/.test(sql) ? rows : []) }) } },
  escalationOf: async () => null,
  getState: async () => ({ state: {} }),
  contentBody: async () => null,
});

test('PT32.4: the digest lists each unjudged decision event once, by name, the start of its hash and its model, and never an answer', async () => {
  const rows = hashes.map((h, i) => ({ hash: h, event: JSON.stringify({ body: { decision: 'route', request: 'sha256:q', answer: `SECRET-ANSWER-${i}`, raw: 0.5, model: { id: 'jev-latest', reported: 'jev-2026-09-18' } } }) }));
  const model = await readDigest(ledgerRt(rows), { accounts: [], source: { resolve: async () => null }, judged: new Set([hashes[0]]) });
  assert.deepEqual(model.toAdjudicate.map((x) => x.event), hashes.slice(1), 'the judged one is left out');
  assert.ok(model.toAdjudicate.every((x) => x.decision === 'route' && x.model === 'jev-2026-09-18'));
  const text = formatDigest(model, { drafts: false });
  assert.match(text, new RegExp(`To adjudicate[^\n]*: ${hashes.length - 1} answer`));
  for (const h of hashes.slice(1)) assert.ok(text.includes(`route ${hex(h)} (jev-2026-09-18)`), h);
  assert.ok(!text.includes(hex(hashes[0])), 'a judged event is not listed');
  assert.ok(!text.includes('SECRET-ANSWER') && !text.includes('sha256:q'), 'no answer and no question');
  const none = await readDigest(ledgerRt(rows), { accounts: [], source: { resolve: async () => null }, judged: new Set(hashes) });
  assert.ok(!formatDigest(none, { drafts: false }).includes('To adjudicate'), 'nothing to judge, no section');
});

function sink() { const t = { out: '', err: '' }; return { t, io: { out: (s) => { t.out += s; }, err: (s) => { t.err += s; } } }; }
const projectFor = () => {
  const project = a.dir;
  writeFileSync(join(project, 'inbox.host.json'), JSON.stringify({ v: 1, accounts: [{ label: 'work', owner: 'me' }], personKey: { keyId: PERSON.keyId, file: join(tmp, 'person.pem') } }));
  return project;
};

test('PT32.4: ask --do adjudicate signs the owner\'s verdict with the config\'s person key, from the start of a hash, into <project>/verdicts', async () => {
  const project = projectFor();
  rmSync(join(project, 'verdicts'), { recursive: true, force: true });
  const s = sink();
  assert.equal(await main(['ask', '--project', project, '--do', 'adjudicate', '--db', db, '--event', hex(hashes[1]), '--verdict', 'wrong', '--correct', '"Complaint"'], s.io), 0, s.t.err);
  const files = readdirSync(join(project, 'verdicts'));
  assert.deepEqual(files, [`0001-${hex(hashes[1])}.json`]);
  const v = JSON.parse(readFileSync(join(project, 'verdicts', files[0]), 'utf8'));
  assert.deepEqual([v.kind, v.event, v.verdict, v.correct, v.decision], ['poly.verdict', hashes[1], 'wrong', 'Complaint', 'route']);
  const anchor = JSON.parse(readFileSync(JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8')).anchors['ex-adjudicate'].replace(/^file:/, ''), 'utf8')).id;
  const rings = keyringsOf(project, loadProject(project).manifest);
  assert.equal(verifyRecord(v.record, rings, { kind: 'verdict', subject: verdictSubject(anchor, hashes[1], 'wrong', 'Complaint') }).ok, true);
  assert.deepEqual([...judged(project)], [hashes[1]], 'the digest will not list it again');
  assert.ok(s.t.out.includes(files[0]));
});

test('PT32.4: an event that is not there, a prefix that names several, and a verdict that is none are the host\'s usage errors (64) and write nothing', async () => {
  const project = projectFor();
  rmSync(join(project, 'verdicts'), { recursive: true, force: true });
  const common = ['ask', '--project', project, '--do', 'adjudicate', '--db', db];
  const run = async (...extra) => { const s = sink(); const code = await main([...common, ...extra], s.io); return { code, err: s.t.err }; };
  const none = await run('--event', 'zzzzzzzz', '--verdict', 'right');
  assert.equal(none.code, 64);
  assert.match(none.err, /no decision event begins with zzzzzzzz/);
  const hexes = hashes.map((h) => h.replace(/^sha256:/, ''));
  const shared = [...'0123456789abcdef'].find((c) => hexes.filter((h) => h.startsWith(c)).length > 1);
  assert.ok(shared, '20 hashes over 16 first characters: two share one');
  { const many = await run('--event', shared, '--verdict', 'right'); assert.equal(many.code, 64); assert.match(many.err, /names \d+ decisions/); }
  const bad = await run('--event', hex(hashes[0]), '--verdict', 'maybe');
  assert.equal(bad.code, 64);
  assert.match(bad.err, /--verdict right\|wrong/);
  assert.equal((await run('--verdict', 'right')).code, 64, 'no --event');
  assert.deepEqual(readdirSync(join(project, 'verdicts').replace(/verdicts$/, '')).includes('verdicts'), false, 'nothing was written');
  mkdirSync(join(tmp, 'x'), { recursive: true });
});

test('IT4.4: the digest asks the owner to look in Gmail Drafts for a to-do that is Uncertain, and names the two answers', () => {
  const model = { at: 'now', accounts: {}, todos: [{ id: 'todo:work:t9', label: 'work', status: 'Uncertain', title: 'Reply to Bob', due: 'Unstated', reply: true }, { id: 'todo:work:t1', label: 'work', status: 'Open', title: 'Pay', due: 'Unstated', reply: false }], held: [], approvals: [] };
  const text = formatDigest(model, { drafts: true });
  assert.match(text, /Look in Gmail Drafts:[^\n]*--do found\|missing/);
  assert.match(text, /\[work\] Reply to Bob: todo:work:t9/);
  assert.ok(!/Look in Gmail Drafts[\s\S]*Pay: todo:work:t1/.test(text), 'an open to-do is not asked about');
  assert.ok(!formatDigest({ ...model, todos: [model.todos[1]] }, { drafts: true }).includes('Look in Gmail Drafts'));
});
