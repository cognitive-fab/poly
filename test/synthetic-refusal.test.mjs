// PS20.5, S514, PL6512 (ruled 2026-10-11: "PL6512 must be tested before the gate"): a synthetic corpus is refused for a
// project whose certificate is not a test one, by mine, by promote and by admission. No test process can hold a real
// owner's anchor (the home guard forbids writing the owner's configuration), so the commands take the anchor's source
// as a parameter that the command line fills from the project's anchor: these tests name it ('user' for a project that
// is not a test one, 'test' for the control), and the command-line tests in promote.test.mjs (P7) and mine.test.mjs
// cover the 'test' source through the real anchor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineTraces, pinPolyx, promote, readPromotions, projectAnchorId } from '@poly/check';
import { keyringsOf, loadProject } from '@poly/core';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { PERSON, admitted } from './runtime-helpers.mjs';
import { candidatesFile, CANDIDATES } from './fixtures/m7/candidates.mjs';
import { shop } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const slash = (p) => p.split(String.fromCharCode(92)).join('/');
let tmp; let n = 0;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'poly-synthetic-')); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** A copy of a project directory, so that a refusal can be compared with the bytes it left. */
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== '.poly') walk(p); } else out[p.slice(dir.length)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};

/** A project, a candidates file of the given corpus kind, and a real verdict on its at-most-once candidate, signed with a person's key. */
async function prepared(kind) {
  const a = await admitted(`synthetic-${kind}-${++n}`, ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly']);
  const candidates = join(tmp, `candidates-${n}.json`);
  writeFileSync(candidates, JSON.stringify(candidatesFile(['atMostCharge'], { kind })));
  const key = join(tmp, `person-${n}.pem`);
  writeFileSync(key, PERSON.privateKeyPem);
  const adjudication = join(tmp, `adjudication-${n}.json`);
  const r = poly('adjudicate', candidates, '--candidate', CANDIDATES.atMostCharge.id, '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--project', a.dir, '--out', adjudication);
  assert.equal(r.code, 0, r.out);
  return { a, candidates, adjudication };
}

/** A stand-in polyx that logs its starts and finds nothing, pinned in the project's name. */
function fakePolyx() {
  const dir = join(tmp, `fake-polyx-${++n}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(dir, 'bin', 'polyx.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync('${slash(join(dir, 'starts.log'))}', 'start' + String.fromCharCode(10));`,
    "console.log(JSON.stringify({ manifest: { alphabetVersion: 1, thresholds: { minInstances: 5 }, seed: 1, codeCommit: 'c'.repeat(40), segmenter: 'null', corpusRevision: 'r' }, rules: [] }));",
  ].join('\n'));
  return { dir, starts: () => (existsSync(join(dir, 'starts.log')) ? readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length : 0) };
}

test('PS20.5: promote refuses a candidate of a synthetic corpus for a project that is not a test one, and the project is as it was', async () => {
  const { a, candidates, adjudication } = await prepared('synthetic');
  const before = snapshot(a.dir);
  await assert.rejects(promote({ project: a.dir, candidates, adjudications: [adjudication], anchorSource: 'user' }), /the candidate a000000000000001 was mined from a synthetic corpus, which only a test certificate may cite \(PS20\.5\)/);
  assert.deepEqual(snapshot(a.dir), before);
  assert.ok(!existsSync(join(a.dir, 'promotions')));
  // The control, same project and files: for a test project the promotion goes through.
  const ok = await promote({ project: a.dir, candidates, adjudications: [adjudication], anchorSource: 'test' });
  assert.equal(ok.promoted.length, 1);
  assert.ok(existsSync(join(a.dir, 'promotions')));
});

test('PS20.5: promote does not refuse a candidate of a recorded corpus for a project that is not a test one', async () => {
  const { a, candidates, adjudication } = await prepared('recorded');
  const ok = await promote({ project: a.dir, candidates, adjudications: [adjudication], anchorSource: 'user' });
  assert.equal(ok.promoted.length, 1);
});

test('PS20.5: mine --synthetic refuses a project that is not a test one, starts nothing and writes nothing', async () => {
  const { a } = await prepared('recorded');
  const f = fakePolyx();
  const pin = join(tmp, `pin-${++n}.json`);
  await pinPolyx({ project: a.dir, polyx: f.dir, polyxPin: pin });
  const traces = join(tmp, `corpus-${n}.ndjson`);
  writeFileSync(traces, shop());
  const out = (k) => join(tmp, `mined-${k}-${++n}.json`);
  const base = { traces, project: a.dir, polyx: f.dir, polyxPin: pin };
  const refused = out('refused');
  await assert.rejects(mineTraces({ ...base, out: refused, synthetic: true, anchorSource: 'user' }), /--synthetic: a corpus made for the purpose is mined only for a project with a test anchor/);
  assert.ok(!existsSync(refused));
  assert.equal(f.starts(), 0, 'polyx was not started');
  // The controls: the same call for a test project, and a recorded corpus for a project that is not a test one.
  const test1 = out('test');
  await mineTraces({ ...base, out: test1, synthetic: true, anchorSource: 'test' });
  assert.equal(JSON.parse(readFileSync(test1, 'utf8')).corpus.kind, 'synthetic');
  const recorded = out('recorded');
  await mineTraces({ ...base, out: recorded, anchorSource: 'user' });
  assert.equal(JSON.parse(readFileSync(recorded, 'utf8')).corpus.kind, 'recorded');
  assert.equal(f.starts(), 2);
});

test('PS20.5: mine --synthetic from the command line is allowed for a test project and says so in the candidates', async () => {
  const { a } = await prepared('recorded');
  const f = fakePolyx();
  const pin = join(tmp, `pin-${++n}.json`);
  assert.equal(poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin).code, 0);
  const traces = join(tmp, `corpus-${++n}.ndjson`);
  writeFileSync(traces, shop());
  const out = join(tmp, `cli-synthetic-${++n}.json`);
  const r = poly('mine', '--traces', traces, '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin, '--out', out, '--synthetic');
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).corpus.kind, 'synthetic');
});

test('PL6512: admission refuses a promotion from a synthetic corpus when the certificate is not a test one, and reads it when it is', async () => {
  const { a, candidates, adjudication } = await prepared('synthetic');
  assert.equal((await promote({ project: a.dir, candidates, adjudications: [adjudication], anchorSource: 'test' })).promoted.length, 1);
  const rings = keyringsOf(a.dir, loadProject(a.dir).manifest);
  const anchor = projectAnchorId(a.dir);
  const asTest = readPromotions(a.dir, rings, anchor, 'test');
  assert.deepEqual(asTest.problems, []);
  assert.equal(asTest.list.length, 1);
  assert.equal(asTest.list[0].corpus.kind, 'synthetic');
  const asUser = readPromotions(a.dir, rings, anchor, 'user');
  assert.equal(asUser.problems.length, 1);
  assert.equal(asUser.problems[0].code, 'PL6512');
  assert.match(asUser.problems[0].message, /was mined from a synthetic corpus, which only a test certificate may cite \(PS20\.5\)/);
  assert.match(asUser.problems[0].entry, /^promotions\/0001-a000000000000001\.json$/);
});

test('PL6512: a recorded corpus is read for a certificate that is not a test one', async () => {
  const { a, candidates, adjudication } = await prepared('recorded');
  assert.equal((await promote({ project: a.dir, candidates, adjudications: [adjudication], anchorSource: 'user' })).promoted.length, 1);
  const rings = keyringsOf(a.dir, loadProject(a.dir).manifest);
  const read = readPromotions(a.dir, rings, projectAnchorId(a.dir), 'user');
  assert.deepEqual(read.problems, []);
  assert.equal(read.list.length, 1);
});
