// PT30.4, PS20.3: poly adjudicate signs an adjudication record (a person's verdict on one candidate).
// The record's subject is sha256 of canonical JSON of { anchor, candidate, verdict }. The command
// refuses an agent key, a verdict 'narrowed', and a candidate id the file does not have.
// Never over MCP (PT30.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalize, loadProject, readAnchor, verifyRecord } from '@poly/core';
const anchorIdOf = (dir) => readAnchor(dir, loadProject(dir).manifest.name).anchor.id;
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { PERSON, AGENT, makePerson, makeKey, project, admitted } from './runtime-helpers.mjs';
import { candidate, candidatesFile, CANDIDATES, ID as CID } from './fixtures/m7/candidates.mjs';

const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const KEYS = mkdtempSync(join(tmpdir(), 'poly-adjudicate-cli-'));

function run(args) {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, cli, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writePersonKey(who = PERSON) {
  const keyFile = join(KEYS, `${who.name}.pem`);
  writeFileSync(keyFile, who.privateKeyPem);
  return keyFile;
}

function writeCandidatesFile(names) {
  const candidatesFilePath = join(KEYS, 'candidates.json');
  writeFileSync(candidatesFilePath, JSON.stringify(candidatesFile(names)));
  return candidatesFilePath;
}

function adjudicateSync(candidatesFilePath, candidateId, verdict, keyFile, outFile, projectDir = null) {
  const args = [
    'adjudicate', candidatesFilePath,
    '--candidate', candidateId,
    '--verdict', verdict,
    '--by', PERSON.keyId,
    '--key', keyFile,
    '--out', outFile,
  ];
  if (projectDir) {
    args.push('--project', projectDir);
  }
  return run(args);
}

// A1: usage errors - all exit 64
test('A1.1: missing --candidate exits 64 with message naming the option', async () => {
  const proj = await admitted('adjudicate-cli-a1-1', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control: valid invocation
  const outValid = join(KEYS, 'a1-1-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));
  const adj = JSON.parse(readFileSync(outValid, 'utf8'));
  assert.equal(adj.kind, 'poly.adjudication');

  // Negative case: missing --candidate
  const outInvalid = join(KEYS, 'a1-1-invalid.json');
  const r = run(['adjudicate', cand, '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /poly:.*--candidate/i);
  assert(!existsSync(outInvalid));
});

test('A1.2: missing --verdict exits 64 with message naming the option', async () => {
  const proj = await admitted('adjudicate-cli-a1-2', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-2-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: missing --verdict
  const outInvalid = join(KEYS, 'a1-2-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /poly:.*--verdict/i);
  assert(!existsSync(outInvalid));
});

test('A1.3: missing --by exits 64 with message naming the option', async () => {
  const proj = await admitted('adjudicate-cli-a1-3', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-3-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: missing --by
  const outInvalid = join(KEYS, 'a1-3-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /poly:.*--by/i);
  assert(!existsSync(outInvalid));
});

test('A1.4: missing --key exits 64 with message naming the option', async () => {
  const proj = await admitted('adjudicate-cli-a1-4', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-4-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: missing --key
  const outInvalid = join(KEYS, 'a1-4-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', PERSON.keyId, '--out', outInvalid]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /poly:.*--key/i);
  assert(!existsSync(outInvalid));
});

test('A1.5: missing --out exits 64 with message naming the option', async () => {
  const proj = await admitted('adjudicate-cli-a1-5', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-5-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: missing --out
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', PERSON.keyId, '--key', key]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /poly:.*--out/i);
});

test('A1.6: candidate id not in file exits 2 and names the id', async () => {
  const proj = await admitted('adjudicate-cli-a1-6', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-6-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: unknown candidate id
  const outInvalid = join(KEYS, 'a1-6-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', 'a000000000000099', '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a000000000000099/);
  assert(!existsSync(outInvalid));
});

test('A1.7: invalid verdict exits 2', async () => {
  const proj = await admitted('adjudicate-cli-a1-7', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-7-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: invalid verdict
  const outInvalid = join(KEYS, 'a1-7-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'invalid', '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid|verdict/i);
  assert(!existsSync(outInvalid));
});

test('A1.8: verdict narrowed exits 2', async () => {
  const proj = await admitted('adjudicate-cli-a1-8', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-8-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: verdict 'narrowed'
  const outInvalid = join(KEYS, 'a1-8-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'narrowed', '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /narrowed/);
  assert(!existsSync(outInvalid));
});

test('A1.9: existing --out file exits 2 and file is unchanged', async () => {
  const proj = await admitted('adjudicate-cli-a1-9', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-9-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: existing output file
  const out = join(KEYS, 'a1-9.json');
  const original = JSON.stringify({ v: 1, kind: 'existing' });
  writeFileSync(out, original);
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', out]);
  assert.equal(r.status, 2);
  assert.equal(readFileSync(out, 'utf8'), original);
});

test('A1.10: candidates file that is not poly.candidates v1 exits 2', async () => {
  const proj = await admitted('adjudicate-cli-a1-10', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a1-10-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: bad candidates file
  const badCand = join(KEYS, 'a1-10-bad.json');
  writeFileSync(badCand, JSON.stringify({ v: 1, kind: 'wrong-kind' }));
  const outInvalid = join(KEYS, 'a1-10-invalid.json');
  const r = run(['adjudicate', badCand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', outInvalid]);
  assert.equal(r.status, 2);
  assert(!existsSync(outInvalid));
});

// A2: output file structure
test('A2: the adjudication file has exactly the required keys and structure', async () => {
  const proj = await admitted('adjudicate-cli-a2', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a2.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);
  assert(existsSync(out));
  const adj = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(adj.v, 1);
  assert.equal(adj.kind, 'poly.adjudication');
  assert.equal(adj.id, CID.atMostCharge);
  assert.equal(adj.verdict, 'real');
  assert.equal(typeof adj.candidate, 'string');
  assert.match(adj.candidate, /^sha256:[0-9a-f]+$/);
  assert(adj.record);
  assert.deepEqual(Object.keys(adj).sort(), ['candidate', 'id', 'kind', 'record', 'v', 'verdict']);

  // Record has exactly the required fields
  const rec = adj.record;
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, 'adjudication');
  assert.equal(typeof rec.subject, 'string');
  assert.match(rec.subject, /^sha256:[0-9a-f]+$/);
  assert.equal(rec.by, PERSON.keyId);
  assert.equal(typeof rec.at, 'string');
  assert.equal(typeof rec.sig, 'string');
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'by', 'kind', 'sig', 'subject', 'v']);
});

// A3: record verification
test('A3.1: the record verifies for real verdict', async () => {
  const proj = await admitted('adjudicate-cli-a3-real', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a3-1.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  const anchor = anchorIdOf(proj.dir);
  const expectedSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict: 'real' }), 'utf8').digest('hex')}`;
  assert.equal(adj.record.subject, expectedSubject);

  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: expectedSubject });
  assert.equal(verd.ok, true, verd.problem);
});

test('A3.2: the record verifies for spurious verdict', async () => {
  const proj = await admitted('adjudicate-cli-a3-spurious', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a3-2.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'spurious', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  const anchor = anchorIdOf(proj.dir);
  const expectedSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict: 'spurious' }), 'utf8').digest('hex')}`;
  assert.equal(adj.record.subject, expectedSubject);

  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: expectedSubject });
  assert.equal(verd.ok, true, verd.problem);
});

test('A3.3: the record verifies for defer verdict', async () => {
  const proj = await admitted('adjudicate-cli-a3-defer', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a3-3.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'defer', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  const anchor = anchorIdOf(proj.dir);
  const expectedSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict: 'defer' }), 'utf8').digest('hex')}`;
  assert.equal(adj.record.subject, expectedSubject);

  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: expectedSubject });
  assert.equal(verd.ok, true, verd.problem);
});

// A4: tamper detection
test('A4.1: changing verdict in file invalidates the subject', async () => {
  const proj = await admitted('adjudicate-cli-a4-1', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a4-1.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  const anchor = anchorIdOf(proj.dir);
  const tamperedVerdictSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict: 'spurious' }), 'utf8').digest('hex')}`;

  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: tamperedVerdictSubject });
  assert.equal(verd.ok, false);
  assert.match(verd.problem, /not for/i);
});

test('A4.2: changing candidate in file invalidates the subject', async () => {
  const proj = await admitted('adjudicate-cli-a4-2', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a4-2.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  const anchor = anchorIdOf(proj.dir);
  const otherCandDigest = CANDIDATES.beforeCharge.digest;
  const tamperedCandidateSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: otherCandDigest, verdict: 'real' }), 'utf8').digest('hex')}`;

  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: tamperedCandidateSubject });
  assert.equal(verd.ok, false);
});

test('A4.3: changing by field invalidates signature', async () => {
  const proj = await admitted('adjudicate-cli-a4-3', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a4-3.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj = JSON.parse(readFileSync(out, 'utf8'));
  adj.record.by = 'key-different';

  const anchor = anchorIdOf(proj.dir);
  const expectedSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict: 'real' }), 'utf8').digest('hex')}`;
  const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: expectedSubject });
  assert.equal(verd.ok, false);
});

// A5: agent and unknown key rejection
test('A5.1: agent key is refused with message saying agent key', async () => {
  const proj = await admitted('adjudicate-cli-a5-1', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a5-1-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: agent key
  const agentKeyFile = writePersonKey(AGENT);
  const outInvalid = join(KEYS, 'a5-1-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', AGENT.keyId, '--key', agentKeyFile, '--out', outInvalid, '--project', proj.dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is an agent key, and an agent key never signs/);
  assert(!existsSync(outInvalid));
});

test('A5.2: unknown key is refused with message', async () => {
  const proj = await admitted('adjudicate-cli-a5-2', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a5-2-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: unknown key
  const proj_dir = project('adjudicate-cli-a5-2-proj', ['test/fixtures/m7/shop/orders.poly'], makeKey('adjudicate-cli-a5-2'));
  const stranger = makePerson('unknown');
  const unknownKeyFile = writePersonKey(stranger);
  const outInvalid = join(KEYS, 'a5-2-invalid.json');
  const r = run(['adjudicate', cand, '--candidate', CID.atMostCharge, '--verdict', 'real', '--by', stranger.keyId, '--key', unknownKeyFile, '--out', outInvalid, '--project', proj_dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a key|keyring/i);
  assert(!existsSync(outInvalid));
});

// A6: three verdicts
test('A6.1: real, spurious, and defer all produce valid records', async () => {
  const proj = await admitted('adjudicate-cli-a6', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge', 'beforeCharge', 'eligReserve']);
  const key = writePersonKey();

  for (const [verdict, candidateId] of [['real', CID.atMostCharge], ['spurious', CID.beforeCharge], ['defer', CID.eligReserve]]) {
    const out = join(KEYS, `a6-${verdict}.json`);
    const r = adjudicateSync(cand, candidateId, verdict, key, out, proj.dir);
    assert.equal(r.status, 0, `${verdict}: ${r.stderr}`);

    const adj = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(adj.verdict, verdict);
    const anchor = anchorIdOf(proj.dir);
    const expectedSubject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: adj.candidate, verdict }), 'utf8').digest('hex')}`;
    const verd = verifyRecord(adj.record, proj.cert.poly.keyrings, { kind: 'adjudication', subject: expectedSubject });
    assert.equal(verd.ok, true, `${verdict}: ${verd.problem}`);
  }
});

test('A6.2: different verdicts for the same candidate give different subjects', async () => {
  const proj = await admitted('adjudicate-cli-a6-2', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  const out1 = join(KEYS, 'a6-2-real.json');
  const out2 = join(KEYS, 'a6-2-spurious.json');

  let r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out1, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  r = adjudicateSync(cand, CID.atMostCharge, 'spurious', key, out2, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj1 = JSON.parse(readFileSync(out1, 'utf8'));
  const adj2 = JSON.parse(readFileSync(out2, 'utf8'));

  assert.notEqual(adj1.record.subject, adj2.record.subject);
});

test('A6.3: same verdict twice gives the same subject', async () => {
  const proj = await admitted('adjudicate-cli-a6-3', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  const out1 = join(KEYS, 'a6-3-1.json');
  const out2 = join(KEYS, 'a6-3-2.json');

  let r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out1, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  r = adjudicateSync(cand, CID.atMostCharge, 'real', key, out2, proj.dir);
  assert.equal(r.status, 0, r.stderr);

  const adj1 = JSON.parse(readFileSync(out1, 'utf8'));
  const adj2 = JSON.parse(readFileSync(out2, 'utf8'));

  assert.equal(adj1.record.subject, adj2.record.subject);
});

// A7: never over MCP
test('A7.1: commandNamed("adjudicate") exists with mcp: null', async () => {
  const { commandNamed } = await import('@poly/check');
  const cmd = commandNamed('adjudicate');
  assert(cmd, 'commandNamed("adjudicate") must exist');
  assert.equal(cmd.mcp, null, 'mcp must be null');
});

test('A7.2: no MCP tool names adjudicate (depends on A7.1)', async () => {
  const { commandNamed } = await import('@poly/check');
  const cmd = commandNamed('adjudicate');
  assert(cmd, 'A7.1 must pass first: commandNamed("adjudicate") exists');

  const { mcpTools } = await import('@poly/agent');
  const tools = mcpTools();
  const adjudicateTools = tools.filter((t) => t.name === 'adjudicate' || (t.description && t.description.toLowerCase().includes('adjudicate')));
  assert.equal(adjudicateTools.length, 0, 'no MCP tool should be named adjudicate or mention adjudication');
});

// A8: spurious and defer don't change project sources
test('A8.1: spurious verdict leaves project sources byte-identical', async () => {
  const proj = await admitted('adjudicate-cli-a8-spurious', ['test/fixtures/m7/shop/orders.poly']);
  const projSources = readdirSync(join(proj.dir, 'src')).map((f) => readFileSync(join(proj.dir, 'src', f), 'utf8'));

  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a8-1.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'spurious', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);
  assert(existsSync(out));

  const projSourcesAfter = readdirSync(join(proj.dir, 'src')).map((f) => readFileSync(join(proj.dir, 'src', f), 'utf8'));
  assert.deepEqual(projSources, projSourcesAfter);
});

test('A8.2: defer verdict leaves project sources byte-identical', async () => {
  const proj = await admitted('adjudicate-cli-a8-defer', ['test/fixtures/m7/shop/orders.poly']);
  const projSources = readdirSync(join(proj.dir, 'src')).map((f) => readFileSync(join(proj.dir, 'src', f), 'utf8'));

  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();
  const out = join(KEYS, 'a8-2.json');
  const r = adjudicateSync(cand, CID.atMostCharge, 'defer', key, out, proj.dir);
  assert.equal(r.status, 0, r.stderr);
  assert(existsSync(out));

  const projSourcesAfter = readdirSync(join(proj.dir, 'src')).map((f) => readFileSync(join(proj.dir, 'src', f), 'utf8'));
  assert.deepEqual(projSources, projSourcesAfter);
});

// A9: candidates digest verification
test('A9: hand-made candidates file with wrong digest is refused', async () => {
  const proj = await admitted('adjudicate-cli-a9', ['test/fixtures/m7/shop/orders.poly']);
  const cand = writeCandidatesFile(['atMostCharge']);
  const key = writePersonKey();

  // Positive control
  const outValid = join(KEYS, 'a9-valid.json');
  const rValid = adjudicateSync(cand, CID.atMostCharge, 'real', key, outValid, proj.dir);
  assert.equal(rValid.status, 0, rValid.stderr);
  assert(existsSync(outValid));

  // Negative case: bad digest
  const badCandidate = candidate({
    id: 'a000000000000009',
    pattern: 'at-most-one-X',
    support: { holds: 5, of: 5 },
    form: 'path-property',
    target: { machine: 'orders.Order' },
    text: 'fake text',
    source: 'path property mined-a000000000000009: count("X") <= 1',
  });
  badCandidate.digest = 'sha256:' + '0'.repeat(64);

  const badCandidatesFilePath = join(KEYS, 'a9-bad.json');
  const cands = candidatesFile(['atMostCharge']);
  cands.candidates.push(badCandidate);
  writeFileSync(badCandidatesFilePath, JSON.stringify(cands));

  const outInvalid = join(KEYS, 'a9-invalid.json');
  const r = run(['adjudicate', badCandidatesFilePath, '--candidate', 'a000000000000009', '--verdict', 'real', '--by', PERSON.keyId, '--key', key, '--out', outInvalid, '--project', proj.dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a000000000000009|digest/i);
  assert(!existsSync(outInvalid));
});
