// M7.2 promote tests (PS20.4, PS20.5, PS20.7, PT30.5, PT30.6, PT30.9): `poly promote` adds mined rules to sources and
// the project's promotion list, with signed adjudications. Rule 7a: tests from the spec text alone, not from code or agent.
// Each success case includes a positive control (valid promotion exits 0) before testing the intended scenario.
// Each refusal case includes a positive control before testing the specific refusal reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { canonicalize, signRecord } from '@poly/core';
import { admit, commandNamed } from '@poly/check';
import { polyaxionPeer } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { ANCHORS, PERSON, AGENT, makePerson, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { CANDIDATES, candidatesFile, ID } from './fixtures/m7/candidates.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

const SHOP_SOURCES = ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'];
const peer = polyaxionPeer();
const skipPolicy = peer.ok ? false : `not run: ${peer.reason}`;

// Build an adjudication file object from scratch, with a signed record by a person key.
// The anchor id comes from the project's keyrings anchor file.
function adjudication(projDir, candidate, verdict, who = PERSON) {
  const projName = basename(projDir);
  const anchorConfig = JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8'));
  const anchorFilePath = anchorConfig.anchors[projName];
  if (!anchorFilePath) throw new Error(`no anchor for project ${projName} in ${join(ANCHORS, 'anchors.json')}`);
  const anchorPath = anchorFilePath.replace(/^file:/, '');
  const anchorData = JSON.parse(readFileSync(anchorPath, 'utf8'));
  const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor: anchorData.id, candidate: candidate.digest, verdict }), 'utf8').digest('hex')}`;
  const record = signRecord({ kind: 'adjudication', subject, by: who.keyId, at: '2026-10-06T00:00:00.000Z' }, who.privateKeyPem);
  return { v: 1, kind: 'poly.adjudication', candidate: candidate.digest, id: candidate.id, verdict, record };
}

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'poly-promote-'));
});
after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// P1: atMostCharge path property, promoted successfully.
test('P1: a real at-most-one candidate is promoted, sources updated with marker, admission succeeds', { timeout: 300_000 }, async () => {
  const name = 'promote-p1';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p1-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p1-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const polyOrderBefore = readFileSync(join(projDir, 'src', 'orders.poly'), 'utf8');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  const polyOrderAfter = readFileSync(join(projDir, 'src', 'orders.poly'), 'utf8');
  assert.notEqual(polyOrderAfter, polyOrderBefore, 'orders.poly was modified');

  // Verify insertion by checking marker and property lines are present with correct indentation.
  const markerPattern = new RegExp(`  // promoted: ${ID.atMostCharge} sha256:[0-9a-f]+\\n  path property mined-${ID.atMostCharge}: count\\("payment\\.charge"\\) <= 1`);
  assert.match(polyOrderAfter, markerPattern, 'marker and property inserted with 2-space indentation');

  // Verify no other changes: remove the inserted lines and compare to original.
  const markerLineRegex = new RegExp(`  // promoted: ${ID.atMostCharge} sha256:[0-9a-f]+`);
  const propertyLineRegex = new RegExp(`  path property mined-${ID.atMostCharge}: count\\("payment\\.charge"\\) <= 1`);
  const withoutInsertion = polyOrderAfter
    .split('\n')
    .filter((line) => !markerLineRegex.test(line) && !propertyLineRegex.test(line))
    .join('\n');
  assert.equal(withoutInsertion, polyOrderBefore, 'only marker and property were inserted');

  // Check promotion entry exists.
  const promDir = join(projDir, 'promotions');
  assert.ok(existsSync(promDir), 'promotions directory created');
  const files = readdirSync(promDir).sort();
  assert.equal(files.length, 1, 'one promotion entry');
  assert.match(files[0], /^0001-/, 'entry numbered 0001');

  const promEntry = JSON.parse(readFileSync(join(promDir, files[0]), 'utf8'));
  assert.equal(promEntry.candidate, CANDIDATES.atMostCharge.digest);
  assert.ok(promEntry.adjudication);
  assert.ok(promEntry.corpus);
  assert.ok(promEntry.tool);

  // Check project is CLEAN.
  await signPolicies(projDir);
  const adm = await admit(projDir);
  assert.equal(adm.verdict, 'CLEAN', `project not CLEAN: ${JSON.stringify(adm.diagnostics?.map((d) => d.code))}`);

  // Verify certificate lists the promotion.
  assert.ok(adm.certificate.poly.promotions.some((p) => p.candidate === CANDIDATES.atMostCharge.digest), 'promotion in certificate');
});

// P2: beforeCharge violates the shop's design (charge offered before reserve).
test('P2: a before candidate that violates the program exits FINDINGS, insertion remains, admission fails', { timeout: 300_000 }, async () => {
  const name = 'promote-p2';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['beforeCharge']);
  const candFile = join(tmpDir, 'p2-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p2-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.beforeCharge, 'real')));

  const polyOrderBefore = readFileSync(join(projDir, 'src', 'orders.poly'), 'utf8');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  // PT30.5: "exits FINDINGS when a path property the machine violates is promoted"
  assert.equal(r.code, 1, `expected exit 1 (FINDINGS), got ${r.code}: ${r.out}`);
  assert.match(r.out, /PL4001/, 'path property finding reported');
  // The finding should name the before property as the violated one
  assert.match(r.out, new RegExp(`PL4001 path property mined-${ID.beforeCharge} is violated: "payment\\.charge" is emitted before any "stock\\.reserve"`), 'the finding names the violated property and its two effects');

  // The insertion remains in sources.
  const polyOrderAfter = readFileSync(join(projDir, 'src', 'orders.poly'), 'utf8');
  assert.notEqual(polyOrderAfter, polyOrderBefore, 'insertion made despite finding');

  // Admission is refused because of the finding.
  await signPolicies(projDir);
  await assert.rejects(admit(projDir), /FINDINGS/i, 'admit rejects with FINDINGS');
});

// P3: eligReserve eligibility rule.
test('P3: an eligibility candidate with --scope succeeds, then without --scope is a usage error', { skip: skipPolicy, timeout: 300_000 }, async () => {
  // Positive control: with --scope, promotion succeeds.
  const name = 'promote-p3';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['eligReserve']);
  const candFile = join(tmpDir, 'p3-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p3-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.eligReserve, 'real')));

  const policyBefore = readFileSync(join(projDir, 'src', 'orders.policy.poly'), 'utf8');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData, '--scope', 'orders');
  assert.equal(r.code, 0, r.out);

  const policyAfter = readFileSync(join(projDir, 'src', 'orders.policy.poly'), 'utf8');
  assert.notEqual(policyAfter, policyBefore, 'policy was modified');

  // Check obligation text is in policy with correct indentation.
  assert.match(policyAfter, new RegExp(`  // promoted: ${ID.eligReserve} sha256:[0-9a-f]+`), 'marker in policy');
  assert.match(policyAfter, /    when proposal\.kind == "effect" && effect\.kind == "stock\.reserve"/, 'obligation when clause indented');

  // Policy signature is required before admission.
  await assert.rejects(admit(projDir), /PL6409/i, 'policy needs signature');

  // Sign the policy.
  await signPolicies(projDir);

  // Now admission succeeds.
  await signPolicies(projDir);
  const adm = await admit(projDir);
  assert.equal(adm.verdict, 'CLEAN');
  assert.ok(adm.certificate.poly.promotions.some((p) => p.candidate === CANDIDATES.eligReserve.digest));

  // Now test refusal without --scope on a fresh project.
  const name2 = 'promote-p3-noscope';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const adjFileData2 = join(tmpDir, 'p3-noscope-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.eligReserve, 'real')));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 64, `expected usage error (64), got ${r2.code}`);
  assert.match(r2.out, /poly:.*--scope/i, 'exact usage message naming --scope');

  // No changes to second project.
  assert.ok(!existsSync(join(projDir2, 'promotions')), 'no promotions created on usage error');
});

// P4: eligConflict conflicts with the reserved-by-end mandate.
test('P4: a valid eligibility promotion succeeds, then a conflicting one is refused with PL6501', { skip: skipPolicy, timeout: 300_000 }, async () => {
  // Positive control: the valid eligReserve case works.
  const name = 'promote-p4-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['eligReserve']);
  const candFile = join(tmpDir, 'p4-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p4-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.eligReserve, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData, '--scope', 'orders');
  assert.equal(r.code, 0, r.out);

  // Now test the conflict case on a fresh project.
  const name2 = 'promote-p4-conflict';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const cand2 = candidatesFile(['eligConflict']);
  const candFile2 = join(tmpDir, 'p4-conflict-candidates.json');
  writeFileSync(candFile2, JSON.stringify(cand2));
  const adjFileData2 = join(tmpDir, 'p4-conflict-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.eligConflict, 'real')));

  const policyBefore2 = readFileSync(join(projDir2, 'src', 'orders.policy.poly'), 'utf8');

  const r2 = poly('promote', projDir2, '--candidates', candFile2, '--adjudication', adjFileData2, '--scope', 'orders');
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}: ${r2.out}`);
  assert.match(r2.out, /PL6501/, 'conflict code reported');
  // Subset must name the promoted rule and the mandate, and exclude fee-free
  assert.match(r2.out, new RegExp(`mined-${ID.eligConflict}`), 'promoted rule named by id');
  assert.match(r2.out, /reserved-by-end/, 'mandate named in subset');
  assert.doesNotMatch(r2.out, /fee-free/, 'unrelated obligation excluded from minimal subset');

  // Project files unchanged.
  const policyAfter2 = readFileSync(join(projDir2, 'src', 'orders.policy.poly'), 'utf8');
  assert.equal(policyAfter2, policyBefore2, 'policy unchanged after refusal');
  assert.ok(!existsSync(join(projDir2, 'promotions')), 'no promotions directory created');
});

// P5: various refusals due to adjudication validation.
test('P5: a valid promotion succeeds, then a spurious adjudication is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-spurious-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-spurious-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-spurious-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test spurious on fresh project.
  const name2 = 'promote-p5-spurious';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const adjFileData2 = join(tmpDir, 'p5-spurious-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostCharge, 'spurious')));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*spurious/i, 'verdict spurious named in refusal message');
});

test('P5: a valid promotion succeeds, then a defer adjudication is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-defer-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-defer-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-defer-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test defer on fresh project.
  const name2 = 'promote-p5-defer';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const adjFileData2 = join(tmpDir, 'p5-defer-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostCharge, 'defer')));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*defer/i, 'verdict defer named in refusal');
});

test('P5: a valid promotion succeeds, then an adjudication signed by an agent key is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-agent-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-agent-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-agent-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test agent key on fresh project.
  const name2 = 'promote-p5-agent';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const adjFileData2 = join(tmpDir, 'p5-agent-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostCharge, 'real', AGENT)));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*agent key/i, 'agent key refusal in message');
});

test('P5: a valid promotion succeeds, then a key not in the people ring is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-unknown-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-unknown-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-unknown-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test unknown key on fresh project.
  const name2 = 'promote-p5-unknown-key';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const stranger = makePerson('stranger');
  const adjFileData2 = join(tmpDir, 'p5-unknown-key-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostCharge, 'real', stranger)));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*not a key in the certified people keyring/, 'key validation refused');
});

test('P5: a valid promotion succeeds, then a candidate not in file is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-missing-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-missing-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-missing-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test missing candidate on fresh project.
  const name2 = 'promote-p5-missing-candidate';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const adjFileData2 = join(tmpDir, 'p5-missing-candidate-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostFee, 'real')));

  const r2 = poly('promote', projDir2, '--candidates', candFile, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, new RegExp(`poly:.*${ID.atMostFee}`), 'missing candidate id named');
});

test('P5: a valid promotion succeeds, then an unpromptable candidate is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-sames-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-sames-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-sames-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test sameS on fresh project.
  const name2 = 'promote-p5-same-s';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const cand2 = candidatesFile(['sameS']);
  const candFile2 = join(tmpDir, 'p5-same-s-candidates.json');
  writeFileSync(candFile2, JSON.stringify(cand2));
  const adjFileData2 = join(tmpDir, 'p5-same-s-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.sameS, 'real')));

  const r2 = poly('promote', projDir2, '--candidates', candFile2, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*/, 'refusal message present');
  assert.ok(r2.out.includes(CANDIDATES.sameS.reason), 'unpromoptable reason stated');
});

test('P5: a valid promotion succeeds, then a mixed pattern candidate is refused', { timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p5-mixed-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p5-mixed-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p5-mixed-valid-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, r.out);

  // Now test mixed on fresh project.
  const name2 = 'promote-p5-mixed';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const cand2 = candidatesFile(['mixed']);
  const candFile2 = join(tmpDir, 'p5-mixed-candidates.json');
  writeFileSync(candFile2, JSON.stringify(cand2));
  const adjFileData2 = join(tmpDir, 'p5-mixed-adjudication.json');
  writeFileSync(adjFileData2, JSON.stringify(adjudication(projDir2, CANDIDATES.mixed, 'real')));

  const r2 = poly('promote', projDir2, '--candidates', candFile2, '--adjudication', adjFileData2);
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}`);
  assert.ok(r2.out.includes(CANDIDATES.mixed.reason), 'mixed pattern reason stated');
});

// P6: two promotions in one call, and sequential conflict.
test('P6: two promotions in one call are promoted in order, with numbered entries', { timeout: 300_000 }, async () => {
  const name = 'promote-p6-two';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge', 'atMostFee']);
  const candFile = join(tmpDir, 'p6-two-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adj1 = join(tmpDir, 'p6-adj1.json');
  const adj2 = join(tmpDir, 'p6-adj2.json');
  writeFileSync(adj1, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));
  writeFileSync(adj2, JSON.stringify(adjudication(projDir, CANDIDATES.atMostFee, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj1, '--adjudication', adj2);
  assert.equal(r.code, 0, `expected success (0), got ${r.code}: ${r.out}`);

  const promDir = join(projDir, 'promotions');
  const files = readdirSync(promDir).sort();
  assert.equal(files.length, 2, 'two entries created');
  assert.match(files[0], /^0001-/);
  assert.match(files[1], /^0002-/);
});

test('P6: a valid promotion succeeds, then a second conflicting one is refused, first remains', { skip: skipPolicy, timeout: 300_000 }, async () => {
  // Positive control.
  const name = 'promote-p6-valid';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p6-valid-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adj = join(tmpDir, 'p6-valid-adj.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj);
  assert.equal(r.code, 0, r.out);

  // Now test conflict on fresh project.
  const name2 = 'promote-p6-conflict-second';
  const key2 = makeKey(name2);
  const projDir2 = project(name2, SHOP_SOURCES, key2);
  const cand2 = candidatesFile(['atMostCharge', 'eligConflict']);
  const candFile2 = join(tmpDir, 'p6-conflict-candidates.json');
  writeFileSync(candFile2, JSON.stringify(cand2));
  const adj1 = join(tmpDir, 'p6-adj1-first.json');
  const adj2 = join(tmpDir, 'p6-adj2-conflict.json');
  writeFileSync(adj1, JSON.stringify(adjudication(projDir2, CANDIDATES.atMostCharge, 'real')));
  writeFileSync(adj2, JSON.stringify(adjudication(projDir2, CANDIDATES.eligConflict, 'real')));

  const r2 = poly('promote', projDir2, '--candidates', candFile2, '--adjudication', adj1, '--adjudication', adj2, '--scope', 'orders');
  assert.equal(r2.code, 2, `expected REFUSED (2), got ${r2.code}: ${r2.out}`);
  assert.match(r2.out, /PL6501/, 'conflict on second');

  // First promotion kept.
  const promDir = join(projDir2, 'promotions');
  assert.ok(existsSync(promDir), 'promotions directory exists');
  const files = readdirSync(promDir);
  assert.equal(files.length, 1, 'only first promotion kept');
});

// P7: synthetic corpus in a test certificate.
test('P7: a synthetic corpus is allowed in a test certificate', { timeout: 300_000 }, async () => {
  const name = 'promote-p7';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge'], { kind: 'synthetic' });
  const candFile = join(tmpDir, 'p7-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p7-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r.code, 0, `expected success (0), got ${r.code}: ${r.out}`);

  await signPolicies(projDir);
  const adm = await admit(projDir);
  assert.equal(adm.verdict, 'CLEAN');
  assert.equal(adm.certificate.poly.keyringChain.source, 'test', 'test certificate when synthetic corpus used');
  const prom = adm.certificate.poly.promotions[0];
  assert.equal(prom.corpus.kind, 'synthetic', 'corpus marked synthetic in certificate');
});

// P8: MCP registry check.
test('P8: promote is not served over MCP', async () => {
  const cmd = commandNamed('promote');
  assert.equal(cmd.mcp, null, 'promote has mcp: null');
});

// P9: idempotence guard.
test('P9: a valid promotion succeeds, then promoting the same candidate again is refused', { timeout: 300_000 }, async () => {
  // First promotion (positive control).
  const name = 'promote-p9';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);
  const cand = candidatesFile(['atMostCharge']);
  const candFile = join(tmpDir, 'p9-candidates.json');
  writeFileSync(candFile, JSON.stringify(cand));
  const adjFileData = join(tmpDir, 'p9-adjudication.json');
  writeFileSync(adjFileData, JSON.stringify(adjudication(projDir, CANDIDATES.atMostCharge, 'real')));

  const r1 = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r1.code, 0, `first promote should succeed (0), got ${r1.code}: ${r1.out}`);

  // Second call on same project.
  const r2 = poly('promote', projDir, '--candidates', candFile, '--adjudication', adjFileData);
  assert.equal(r2.code, 2, `second promote should refuse (2), got ${r2.code}`);
  assert.match(r2.out, /poly:.*already.*promoted|in source/i, 'duplicate promotion refused');

  const promDir = join(projDir, 'promotions');
  const files = readdirSync(promDir);
  assert.equal(files.length, 1, 'no second entry created');
});
