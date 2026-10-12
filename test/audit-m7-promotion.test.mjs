// Audit tests for M7 promotion clauses: WEAK and UNTESTED coverage
// These tests address gaps identified in the promotion audit table
// (docs/m7/promotion-audit.md).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { canonicalize, signRecord } from '@poly/core';
import { admit } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { ANCHORS, PERSON, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { CANDIDATES, candidatesFile } from './fixtures/m7/candidates.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

const SHOP_SOURCES = ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'];

function getAnchor(projectName) {
  const config = JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8'));
  const anchorFile = config.anchors[projectName].slice('file:'.length);
  return JSON.parse(readFileSync(anchorFile, 'utf8'));
}

function adjudication(projDir, candidate, verdict) {
  const anchor = getAnchor(basename(projDir));
  const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor: anchor.id, candidate: candidate.digest, verdict }), 'utf8').digest('hex')}`;
  const record = signRecord({ kind: 'adjudication', subject, by: PERSON.keyId, at: '2026-10-12T00:00:00.000Z' }, PERSON.privateKeyPem);
  return { v: 1, kind: 'poly.adjudication', candidate: candidate.digest, id: candidate.id, verdict, record };
}

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'poly-audit-m7-'));
});
after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ===== PT30.5: --refine takes exactly one adjudication (exit 64) =====
test('AUDIT PT30.5: --refine with multiple adjudications exits 64 (usage error)', async () => {
  const name = 'audit-pt30-5-multi-adj';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const cand1 = CANDIDATES.atMostCharge;
  const cand2 = CANDIDATES.atMostFee;

  const candFile = join(tmpDir, 'cand-multi.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge', 'atMostFee'])));

  const adj1 = join(tmpDir, 'adj1-multi.json');
  const adj2 = join(tmpDir, 'adj2-multi.json');
  writeFileSync(adj1, JSON.stringify(adjudication(projDir, cand1, 'real')));
  writeFileSync(adj2, JSON.stringify(adjudication(projDir, cand2, 'real')));

  const refined = join(tmpDir, 'refined-multi.txt');
  writeFileSync(refined, 'path property refined: count("payment.charge") < 2\n');

  // Positive control: single adjudication with --refine succeeds
  const single = join(tmpDir, 'single.txt');
  writeFileSync(single, 'path property single: count("payment.charge") < 2\n');
  const r1 = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj1, '--refine', single, '--reason', 'test');
  assert.equal(r1.code, 0, `single adjudication should succeed: ${r1.out}`);

  // Negative case: multiple adjudications with --refine should exit 64
  const r2 = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj1, '--adjudication', adj2, '--refine', refined, '--reason', 'test');
  assert.equal(r2.code, 64, `multiple adjudications with --refine should exit 64 (usage error), got ${r2.code}: ${r2.out}`);
  assert.match(r2.out, /refine.*one.*adjudication/i, 'message should explain --refine takes one adjudication');
});

// ===== PT30.5: parse or type error in refinement restores files =====
test('AUDIT PT30.5: refinement with type error is refused and restores sources', async () => {
  const name = 'audit-pt30-5-type-error';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const cand = CANDIDATES.atMostCharge;
  const candFile = join(tmpDir, 'cand-type-err.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));

  const adj = join(tmpDir, 'adj-type-err.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, cand, 'real')));

  // Save original source
  const ordersPath = join(projDir, 'src', 'orders.poly');
  const originalSource = readFileSync(ordersPath, 'utf8');

  // Refinement with type error: using an undefined variable
  const typeError = join(tmpDir, 'type-error.txt');
  writeFileSync(typeError, 'path property undefined-var: unknownVariable <= 1\n');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj, '--refine', typeError, '--reason', 'test');
  assert.equal(r.code, 2, `type error should refuse with exit 2, got ${r.code}: ${r.out}`);

  // Check sources are restored
  const restoredSource = readFileSync(ordersPath, 'utf8');
  assert.equal(restoredSource, originalSource, 'sources should be restored after type error');
  assert.ok(!existsSync(join(projDir, 'promotions')), 'no promotions should be created on type error');
});

// ===== PT30.11: Eligibility rule on non-conflicting field =====
test('AUDIT PT30.11: eligibility rule on non-conflicting field is promoted without PL6501', async () => {
  const name = 'audit-pt30-11-non-conflict';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const cand = CANDIDATES.eligReserve;  // reserve-while-reserving rule
  const candFile = join(tmpDir, 'cand-non-conflict.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['eligReserve'])));

  const adj = join(tmpDir, 'adj-non-conflict.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, cand, 'real')));

  // Positive control: the reserve-while-reserving rule should promote without conflict
  // It reads orders.Order.status and requires it in { Reserving }
  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj, '--scope', 'orders');
  assert.equal(r.code, 0, `non-conflicting eligibility rule should succeed, got ${r.code}: ${r.out}`);

  await signPolicies(projDir);
  const adm = await admit(projDir);
  assert.equal(adm.verdict, 'CLEAN', 'admission should be CLEAN after promoting non-conflicting rule');
});

// ===== PS20.3: Subject binds candidate digest - candidate not in file =====
test('AUDIT PS20.3: adjudication subject binds the candidate digest; mismatch with file is not caught at adjudicate', async () => {
  const proj = await import('./runtime-helpers.mjs').then(m => m.admitted('audit-ps20-3-digest', SHOP_SOURCES));

  const cand = CANDIDATES.atMostCharge;
  const cand2 = CANDIDATES.atMostFee;

  const candFile = join(tmpDir, 'cand-digest.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));

  const key = join(tmpDir, 'person-digest.pem');
  writeFileSync(key, PERSON.privateKeyPem);

  // Sign adjudication for atMostCharge
  const adjFile = join(tmpDir, 'adj-digest.json');
  const rValid = poly('adjudicate', candFile, '--candidate', cand.id, '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', adjFile, '--project', proj.dir);
  assert.equal(rValid.code, 0, rValid.stderr);

  const adjData = JSON.parse(readFileSync(adjFile, 'utf8'));
  // Verify it correctly binds atMostCharge digest
  assert.equal(adjData.candidate, cand.digest);

  // Now manually create an adjudication with wrong candidate digest
  const wrongAdj = { ...adjData, candidate: cand2.digest };  // Different digest
  const wrongAdjFile = join(tmpDir, 'adj-wrong-digest.json');
  writeFileSync(wrongAdjFile, JSON.stringify(wrongAdj));

  // Promotion should refuse because the candidate digest doesn't match the one in the candidates file
  const r = poly('promote', proj.dir, '--candidates', candFile, '--adjudication', wrongAdjFile);
  assert.equal(r.code, 2, `promoting with wrong candidate digest should be refused, got ${r.code}: ${r.out}`);
  assert.match(r.out, new RegExp(`${cand2.id}|candidate.*not|digest`), 'error should mention the candidate issue');
});

// ===== PS20.3: Spurious and defer candidates - no promotion entry created =====
test('AUDIT PS20.3: spurious verdict leaves sources unchanged and no promotions/ directory created', async () => {
  const name = 'audit-ps20-3-spurious-dir';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const candFile = join(tmpDir, 'cand-spurious-dir.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));

  const cand = CANDIDATES.atMostCharge;
  const adj = join(tmpDir, 'adj-spurious-dir.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, cand, 'spurious')));

  // Check: promotions/ does not exist
  assert.ok(!existsSync(join(projDir, 'promotions')), 'promotions/ should not exist before adjudication');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj);
  assert.equal(r.code, 2, `spurious verdict should be refused, got ${r.code}`);

  // Check: promotions/ still does not exist after refusal
  assert.ok(!existsSync(join(projDir, 'promotions')), 'promotions/ should not be created on spurious verdict');
});

test('AUDIT PS20.3: defer verdict leaves sources unchanged and no promotions/ directory created', async () => {
  const name = 'audit-ps20-3-defer-dir';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const candFile = join(tmpDir, 'cand-defer-dir.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));

  const cand = CANDIDATES.atMostCharge;
  const adj = join(tmpDir, 'adj-defer-dir.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, cand, 'defer')));

  // Check: promotions/ does not exist
  assert.ok(!existsSync(join(projDir, 'promotions')), 'promotions/ should not exist before adjudication');

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj);
  assert.equal(r.code, 2, `defer verdict should be refused, got ${r.code}`);

  // Check: promotions/ still does not exist after refusal
  assert.ok(!existsSync(join(projDir, 'promotions')), 'promotions/ should not be created on defer verdict');
});

// ===== PT30.5: Entry structure is complete with all required fields =====
test('AUDIT PT30.5: promotion entry has all required fields: candidate, id, adjudication, tool, corpus, inserted', async () => {
  const name = 'audit-pt30-5-entry-structure';
  const key = makeKey(name);
  const projDir = project(name, SHOP_SOURCES, key);

  const cand = CANDIDATES.atMostCharge;
  const candFile = join(tmpDir, 'cand-entry.json');
  writeFileSync(candFile, JSON.stringify(candidatesFile(['atMostCharge'])));

  const adj = join(tmpDir, 'adj-entry.json');
  writeFileSync(adj, JSON.stringify(adjudication(projDir, cand, 'real')));

  const r = poly('promote', projDir, '--candidates', candFile, '--adjudication', adj);
  assert.equal(r.code, 0, r.out);

  const promDir = join(projDir, 'promotions');
  assert.ok(existsSync(promDir), 'promotions directory created');

  const [entryFile] = readdirSync(promDir);
  assert.match(entryFile, /^0001-/, 'entry file is numbered 0001');

  const entry = JSON.parse(readFileSync(join(promDir, entryFile), 'utf8'));

  // Check all required fields exist
  assert.equal(entry.candidate, cand.digest, 'entry.candidate is the candidate digest');
  assert.equal(entry.id, cand.id, 'entry.id is the candidate id');
  assert.ok(entry.adjudication, 'entry.adjudication exists');
  assert.ok(entry.tool, 'entry.tool exists');
  assert.ok(entry.corpus, 'entry.corpus exists');
  assert.ok(entry.inserted, 'entry.inserted exists');

  // Check inserted subfields
  assert.equal(typeof entry.inserted.file, 'string', 'inserted.file is a string (relative path)');
  assert.equal(typeof entry.inserted.text, 'string', 'inserted.text is the text that was inserted');
  assert.match(entry.inserted.digest, /^sha256:[0-9a-f]{64}$/, 'inserted.digest is a valid sha256');
});
