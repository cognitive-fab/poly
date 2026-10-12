// M7.4a (PS20.4 "A refinement", PT30.5, PT30.6): a rule can be real and wrong as written. A person who adjudicated a candidate
// real promotes their own text in its place; the promotion cites the candidate and the record, and the entry keeps the
// reason and the candidate's own source. Written by the implementer from the spec text before the code and seen failing
// (the reviewer's ruling on the inbox rule of 2026-10-12: "real; too strong as written").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { canonicalize, signRecord } from '@poly/core';
import { admit, AdmitError } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { ANCHORS, PERSON, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { CANDIDATES, candidatesFile, ID } from './fixtures/m7/candidates.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const SHOP = ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'];
const REFINED = 'path property charge-at-most-once-meant: count("payment.charge") < 2';
const REASON = 'the mined rule counts proposals; the rule meant counts the charge once';
const NL = String.fromCharCode(10);

function adjudication(projDir, candidate, verdict) {
  const anchorConfig = JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8'));
  const anchor = JSON.parse(readFileSync(anchorConfig.anchors[basename(projDir)].replace(/^file:/, ''), 'utf8'));
  const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor: anchor.id, candidate: candidate.digest, verdict }), 'utf8').digest('hex')}`;
  const record = signRecord({ kind: 'adjudication', subject, by: PERSON.keyId, at: '2026-10-12T00:00:00.000Z' }, PERSON.privateKeyPem);
  return { v: 1, kind: 'poly.adjudication', candidate: candidate.digest, id: candidate.id, verdict, record };
}

let tmp; let n = 0;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'poly-refine-')); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function setup(name, verdict = 'real') {
  const projDir = project(name, SHOP, makeKey(name));
  const candFile = join(tmp, `cand-${++n}.json`);
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));
  const adj = join(tmp, `adj-${n}.json`);
  writeFileSync(adj, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, verdict)));
  const refined = join(tmp, `refined-${n}.txt`);
  writeFileSync(refined, REFINED + NL);
  return { projDir, candFile, adj, refined };
}
const args = (s, ...extra) => ['promote', s.projDir, '--candidates', s.candFile, '--adjudication', s.adj, ...extra];

test('PS20.4: a refinement inserts the person\'s text under the candidate\'s marker, and the entry keeps the reason and the candidate\'s source', async () => {
  const control = setup('refine-control');
  assert.equal(poly(...args(control)).code, 0, 'the control: the candidate\'s own text promotes');
  const s = setup('refine-r1');
  const r = poly(...args(s, '--refine', s.refined, '--reason', REASON));
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(join(s.projDir, 'src', 'orders.poly'), 'utf8');
  assert.match(text, new RegExp(`  // promoted: ${ID.atMostCharge} sha256:[0-9a-f]{64}\\n  ${REFINED.replace(/[()".<]/g, '\\$&')}`), 'the marker, then the person\'s text');
  assert.ok(!text.includes(`mined-${ID.atMostCharge}`), 'the candidate\'s own text is not in the sources');
  const [file] = readdirSync(join(s.projDir, 'promotions'));
  const entry = JSON.parse(readFileSync(join(s.projDir, 'promotions', file), 'utf8'));
  assert.equal(entry.id, ID.atMostCharge);
  assert.deepEqual(entry.refinement, { reason: REASON, candidateSource: CANDIDATES.atMostCharge.source });
  assert.ok(entry.inserted.text.includes(REFINED));
  assert.equal(entry.inserted.digest, `sha256:${createHash('sha256').update(entry.inserted.text, 'utf8').digest('hex')}`);
  await signPolicies(s.projDir);
  const a = await admit(s.projDir);
  assert.equal(a.verdict, 'CLEAN');
  assert.equal(a.certificate.poly.promotions[0].id, ID.atMostCharge, 'the certificate cites the mined id');
});

test('PT30.5: --refine needs --reason (a usage error, nothing written); a spurious verdict still refuses; the candidate\'s own text is not a refinement; a refinement that does not parse restores the sources', () => {
  const s = setup('refine-r2');
  const before = readFileSync(join(s.projDir, 'src', 'orders.poly'), 'utf8');
  const noReason = poly(...args(s, '--refine', s.refined));
  assert.equal(noReason.code, 64, noReason.out);
  assert.match(noReason.out, /--reason/);
  assert.equal(readFileSync(join(s.projDir, 'src', 'orders.poly'), 'utf8'), before);
  assert.ok(!existsSync(join(s.projDir, 'promotions')));

  const same = join(tmp, `same-${++n}.txt`);
  writeFileSync(same, CANDIDATES.atMostCharge.source + NL);
  const own = poly(...args(s, '--refine', same, '--reason', REASON));
  assert.equal(own.code, 2, own.out);
  assert.match(own.out, /is the candidate's own text/);
  assert.equal(readFileSync(join(s.projDir, 'src', 'orders.poly'), 'utf8'), before);

  const bad = join(tmp, `bad-${++n}.txt`);
  writeFileSync(bad, 'path property broken: count(' + NL);
  const broken = poly(...args(s, '--refine', bad, '--reason', REASON));
  assert.equal(broken.code, 2, broken.out);
  assert.equal(readFileSync(join(s.projDir, 'src', 'orders.poly'), 'utf8'), before, 'restored');
  assert.ok(!existsSync(join(s.projDir, 'promotions')));

  const spurious = setup('refine-r3', 'spurious');
  const refused = poly(...args(spurious, '--refine', spurious.refined, '--reason', REASON));
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /is spurious: only a real verdict reaches a program/);
});

test('PT30.6: an entry with a refinement must give a reason and the candidate\'s source, or admission refuses it (PL6510)', async () => {
  const s = setup('refine-r4');
  assert.equal(poly(...args(s, '--refine', s.refined, '--reason', REASON)).code, 0);
  const dir = join(s.projDir, 'promotions');
  const [file] = readdirSync(dir);
  const good = readFileSync(join(dir, file), 'utf8');
  await signPolicies(s.projDir);
  assert.equal((await admit(s.projDir)).verdict, 'CLEAN', 'the control');
  for (const change of [(e) => { e.refinement.reason = ''; }, (e) => { delete e.refinement.reason; }, (e) => { e.refinement.candidateSource = e.inserted.text.split(NL).slice(1).join(NL).trim(); }]) {
    const e = JSON.parse(good);
    change(e);
    writeFileSync(join(dir, file), JSON.stringify(e, null, 2));
    await assert.rejects(admit(s.projDir), (x) => x instanceof AdmitError && /PL6510/.test(x.message) && /refinement/.test(x.message));
  }
});
