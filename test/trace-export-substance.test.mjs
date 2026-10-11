// M7.1 (PS19, PT29): what the corpus holds, step by step, on a program with every tier of value PS19.4 names.
//
// Written by the implementer after the independent writers' tests proved vacuous for these properties (they asserted
// that a key exists, or that the command fails). Each test states its precondition, so an empty export cannot pass,
// and the mutation checks in docs/decisions-m7.md show that each one fails when the property is broken in the export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

const canary = `canary-${randomBytes(12).toString('hex')}`;
const principalCanary = `principal-${randomBytes(12).toString('hex')}`;
const outsideWord = `word-${randomBytes(12).toString('hex')}`;
let a; let tmp; let db; let digest1; let digest2;

const exportOf = (name, ...extra) => {
  const out = join(tmp, name);
  const r = poly('export', 'traces', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out, ...extra);
  assert.equal(r.code, 0, r.out);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { header: lines[0], episodes: lines.slice(1), bytes: readFileSync(out, 'utf8') };
};
const r1Steps = (x) => x.episodes.find((e) => e.steps.some((s) => s.action === 'Set' && s.data.n2 === 1)).steps;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-trace-sub-'));
  a = await admitted('trace-substance', ['test/fixtures/trace-export/tiers.poly']);
  writeFileSync(join(a.dir, 'admission.pub'), a.key.publicKey);
  db = join(tmp, 'store.db');
  const { rt } = await loaded(a, { store: { sqlite: db } });
  try {
    // Run r1: one Set inside the domains, one outside both (disclosed, so accepted), one strict value outside (rejected).
    await rt.create('tiers.Rec', { id: 'r1' });
    digest1 = await rt.putContent(canary);
    await rt.dispatch('r1', 'Set', { n2: 1, w: 'a', m: 'Loud', f: true, p: principalCanary, b: digest1 });
    await rt.dispatch('r1', 'Set', { n2: 7, w: outsideWord, m: 'Calm', f: false, p: principalCanary, b: digest1 });
    await rt.dispatch('r1', 'Strict', { v: 9 });
    // Run r2: a different body, which is never erased.
    await rt.create('tiers.Rec', { id: 'r2' });
    digest2 = await rt.putContent(`other-${canary}`);
    await rt.dispatch('r2', 'Set', { n2: 0, w: 'b', m: 'Calm', f: false, p: 'someone-else', b: digest2 });
    await rt.advise('r2', { advice: 'warn' });
    await rt.advise('r2', { advice: 'recommend' });
  } finally { await rt.close(); }
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('PS19.2, PS19.4: values for declared domains, tokens for Principal and Content, a disclosed value outside its domain flagged', () => {
  const steps = r1Steps(exportOf('tiers.ndjson'));
  const set1 = steps.find((s) => s.action === 'Set' && s.data.n2 === 1);
  assert.ok(set1, JSON.stringify(steps));
  assert.deepEqual([set1.data.n2, set1.data.w, set1.data.f], [1, 'a', true]);
  assert.equal(set1.data.m, 'Loud');
  assert.match(set1.data.p, /^d:[0-9a-f]{32}$/);
  assert.match(set1.data.b, /^d:[0-9a-f]{32}$/);
  assert.deepEqual(set1.outsideCheckDomain, []);
  assert.deepEqual([set1.post.n, set1.post.word, set1.post.mood, set1.post.flag], [1, 'a', 'Loud', true]);
  assert.match(set1.post.who, /^d:[0-9a-f]{32}$/);
  assert.match(set1.post.body, /^d:[0-9a-f]{32}$/);

  const set2 = steps.find((s) => s.action === 'Set' && s.data.n2 === 7);
  assert.ok(set2, 'a disclosed int outside its domain is accepted and exported as the number');
  assert.deepEqual(set2.outsideCheckDomain.slice().sort(), ['n2', 'w']);
  assert.match(set2.data.w, /^d:[0-9a-f]{32}$/, 'a string outside its domain leaves as a token');

  const strict = steps.find((s) => s.action === 'Strict');
  assert.equal(strict.stepKind, 'rejected');
  assert.equal(strict.rejectReason, 'outside-check-domain');
  assert.deepEqual(strict.outsideCheckDomain, [], 'a strict parameter is rejected at dispatch and never outside');
});

test('PT29.5: no canary, in any encoding, is in any byte of the file, and every string in it is an allowed one', () => {
  const { bytes, episodes, header } = exportOf('canary.ndjson');
  assert.ok(episodes.length === 2 && r1Steps({ episodes }).length >= 4, 'the export is not empty');
  for (const c of [canary, principalCanary, outsideWord]) {
    for (const form of [c, Buffer.from(c).toString('base64'), Buffer.from(c).toString('base64url'), Buffer.from(c).toString('hex'), encodeURIComponent(c)]) assert.ok(!bytes.includes(form), `${c} appears as ${form}`);
  }
  assert.ok(!JSON.stringify(episodes).includes('sha256:'), 'no digest of the journal appears in an episode (the header names the certificate)');
  const allowed = new Set(['tiers.Rec', 'accepted', 'rejected', 'unhandled', 'outside-check-domain', 'Set', 'Strict', '$create', 'Loud', 'Calm', 'a', 'b', 'n2', 'w', 'poly.traces', header.project, header.certificate]);
  const walk = (x, path) => {
    if (typeof x === 'string') assert.ok(allowed.has(x) || /^d:[0-9a-f]{32}$/.test(x), `${path}: ${x}`);
    else if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { assert.ok(/^[A-Za-z_][\w]*$/.test(k), `${path}: key ${k}`); walk(v, `${path}.${k}`); }
  };
  episodes.forEach((e, i) => walk(e, `episode ${i}`));
  assert.ok(!/\b1[6-9]\d{11}\b/.test(JSON.stringify(episodes)), 'no epoch time in the corpus');
});

test('PS19.4, PT29.4: equal digests have equal tokens in one export, and no token of one export is in another', () => {
  const one = exportOf('t1.ndjson');
  const two = exportOf('t2.ndjson');
  const steps = r1Steps(one);
  const set1 = steps.find((s) => s.action === 'Set' && s.data.n2 === 1);
  const set2 = steps.find((s) => s.action === 'Set' && s.data.n2 === 7);
  assert.equal(set1.data.b, set1.post.body, 'the body in the data is the body in the state');
  assert.equal(set2.pre.body, set1.post.body, 'the same body has the same token across steps');
  assert.equal(set1.data.p, set2.data.p, 'the same principal has the same token');
  const tokens = (x) => new Set(JSON.stringify(x).match(/d:[0-9a-f]{32}/g));
  const t1 = tokens(one.episodes); const t2 = tokens(two.episodes);
  assert.ok(t1.size >= 4 && t2.size >= 4, `${t1.size} ${t2.size}`);
  assert.deepEqual([...t1].filter((t) => t2.has(t)), [], 'two exports of one store share no token');
});

test('PS19.1: the episode id is a token, never the run id', () => {
  const { episodes } = exportOf('ids.ndjson');
  assert.equal(episodes.length, 2);
  for (const e of episodes) { assert.match(e.episode, /^d:[0-9a-f]{32}$/); assert.ok(e.episode !== 'r1' && e.episode !== 'r2'); assert.equal(e.machine, 'tiers.Rec'); }
});

test('PS19.6: advice events are omitted and counted exactly', () => {
  const { header, bytes } = exportOf('advice.ndjson');
  assert.equal(header.omitted.adviceEvents, 2);
  assert.ok(!bytes.includes('recommend'));
});

test('PS19.5: an erased body leaves its steps out, marks the run gapped, counts exactly, names no digest; the other run is whole', async () => {
  const { rt } = await loaded(a, { store: { sqlite: db } });
  let named; let total;
  try {
    const journal = await rt.getJournal('r1');
    total = journal.length;
    named = journal.filter((row) => JSON.stringify([row.data, row.pre, row.post]).includes(digest1)).length;
    assert.ok(named >= 2 && named < total, `${named} of ${total} rows name the body`);
    await rt.erase(digest1);
  } finally { await rt.close(); }
  const { header, episodes, bytes } = exportOf('erased.ndjson');
  assert.equal(header.omitted.erasedSteps, named);
  assert.equal(header.omitted.gappedRuns, 1);
  assert.equal(header.omitted.erasedRuns, 0);
  assert.equal(header.episodes, episodes.length);
  const gapped = episodes.filter((e) => e.gapped);
  assert.equal(gapped.length, 1);
  assert.equal(gapped[0].steps.length, total - named);
  assert.ok(gapped[0].steps.every((s) => s.action !== 'Set'), 'the steps that name the erased body are the ones left out');
  const whole = episodes.find((e) => !e.gapped);
  assert.ok(whole && whole.steps.some((s) => s.action === 'Set' && s.data.n2 === 0), 'the other subject is untouched');
  assert.ok(!bytes.includes(digest1) && !bytes.includes(digest1.replace('sha256:', '')), 'no digest of the erased body');
});

test('PS19.2, PT29.6: an effect exports its declared class as its consequence, and unknown when it declares none, counted in the header', async () => {
  const b = await admitted('trace-effects', ['conformance/m1/effects.poly']);
  writeFileSync(join(b.dir, 'admission.pub'), b.key.publicKey);
  const store = join(tmp, 'effects.db');
  const { rt } = await loaded(b, { store: { sqlite: store } });
  try {
    await rt.create('effects.Account', { id: 'acc' });
    await rt.dispatch('acc', 'Bill', { tier: 'Gold' });
    await rt.dispatch('acc', 'Notify', {});
  } finally { await rt.close(); }
  const out = join(tmp, 'effects.ndjson');
  const r = poly('export', 'traces', '--db', store, '--build', b.build, '--certificate', b.certificate, '--trust', `${b.key.id}=${join(b.dir, 'admission.pub')}`, '--out', out);
  assert.equal(r.code, 0, r.out);
  const [header, ep] = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byKind = Object.fromEntries(ep.steps.flatMap((s) => s.effects).map((e) => [e.kind, [e.consequence, e.labels]]));
  assert.deepEqual(byKind, {
    'billing.invoice': ['compensable', ['write:store']],
    'billing.perk': ['reversible', ['write:store']],
    'mail.receipt': ['unknown', ['egress:external']],
    'mail.notice': ['unknown', ['egress:external']],
  });
  assert.equal(header.unknown.consequence, 2);
  assert.ok(ep.steps.every((s) => s.effects.every((e) => e.gate === null)), 'a build with no policy gate has no gate decision');
});
