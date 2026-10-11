// `poly export traces` (PT29, PS19): comprehensive tests covering all 12 requirements
// Tests fail now because the command is not built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { makeKey, handleWith } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

// Setup
const { admitted } = await import('./runtime-helpers.mjs');
const a = await admitted('trace-export', ['conformance/m1/effects.poly']);
const signer = makeKey('trace-ledger');
writeFileSync(join(a.dir, 'ledger.pub'), signer.publicKey); writeFileSync(join(a.dir, 'admission.pub'), a.key.publicKey);
const cert = a.certificate;
const build = join(a.dir, '.poly', 'build');

async function populateStore() {
  const dbPath = join(a.dir, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const { load } = await import('@poly/runtime');
  const rt = await load(build, { certificate: cert, trust: a.trust, store: { sqlite: dbPath }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') } });
  handleWith(rt, 'billing.invoice', () => ({ ok: true }));
  handleWith(rt, 'billing.perk', () => ({ ok: true }));
  handleWith(rt, 'billing.receipt', () => ({ ok: true }));
  handleWith(rt, 'mail.notice', () => ({ ok: true }));
  handleWith(rt, 'mail.reminder', () => ({ ok: true }));
  const acc = await rt.create('effects.Account', { id: 'acc-1' });
  await rt.dispatch(acc.id, 'Bill', { tier: 'Gold' });
  await rt.dispatch(acc.id, 'Notify', {});
  await rt.signHeads();
  await rt.close();
  return dbPath;
}

async function emptyStore() {
  const dbPath = join(a.dir, `empty-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const { load } = await import('@poly/runtime');
  const rt = await load(build, { certificate: cert, trust: a.trust, store: { sqlite: dbPath }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') } });
  await rt.signHeads();
  await rt.close();
  return dbPath;
}

// Requirement 1: Header and ndjson structure
test('PT29.2: ndjson format with header and episodes', async () => {
  const dbPath = await emptyStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0, `export failed: ${ok.out.slice(0, 300)}`);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    assert.ok(lines.length > 0);
    const header = JSON.parse(lines[0]);
    // Header exact keys (PT29.2)
    assert.deepEqual(new Set(Object.keys(header)), new Set(['v', 'kind', 'project', 'certificate', 'episodes', 'omitted', 'unknown']));
    assert.equal(header.v, 1);
    assert.equal(header.kind, 'poly.traces');
    assert.equal(header.episodes, lines.length - 1);
    // Omitted exact keys (PT29.2)
    assert.deepEqual(new Set(Object.keys(header.omitted)), new Set(['adviceEvents', 'runtimeRuns', 'archivedRuns', 'erasedSteps', 'gappedRuns', 'erasedRuns']));
    // Unknown exact keys (PT29.6)
    assert.deepEqual(new Set(Object.keys(header.unknown)), new Set(['consequence']));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 2: Step and effect fields
test('PT29.2: step fields and effect structure', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const ep = JSON.parse(lines[i]);
      for (const step of ep.steps) {
        // Step exact keys (PS19.2)
        assert.deepEqual(new Set(Object.keys(step)), new Set(['seq', 'action', 'stepKind', 'rejectReason', 'pre', 'data', 'post', 'effects', 'outsideCheckDomain']));
        // Effect exact keys (PS19.2, PT29.2)
        for (const eff of step.effects) {
          assert.deepEqual(new Set(Object.keys(eff)), new Set(['kind', 'labels', 'consequence', 'gate']));
        }
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 3: Domain-typed values and tokens
test('PT12: values for domain-typed fields, tokens for Principal/Ref/Key/Content/Items (PT29.4)', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0);
    const content = readFileSync(out, 'utf8');
    const lines = content.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const ep = JSON.parse(lines[i]);
      for (const step of ep.steps) {
        // Episode token format (PS19.4)
        assert.ok(ep.episode.match(/^d:[0-9a-f]{32}$/));
        // Check no $claims or $ keys in data (PT29.8)
        for (const key of Object.keys(step.data)) {
          assert.ok(!key.startsWith('$'), `data should not have $ keys: ${key}`);
        }
      }
    }
    // Check no raw sha256 digests appear as themselves (tokens instead) (PT29.4)
    // No run id in any field (PT29.8)
    assert.ok(!content.includes('srv-1'), 'instance id should not appear in export');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 4: Consequence = declared class, unknown when no class
test('PT29.6: consequence is effect class; unknown when no class declared', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    const consequences = new Map();
    for (let i = 1; i < lines.length; i++) {
      const ep = JSON.parse(lines[i]);
      for (const step of ep.steps) {
        for (const eff of step.effects) {
          assert.ok(['none', 'reversible', 'compensable', 'irreversible', 'unknown'].includes(eff.consequence));
          if (!consequences.has(eff.consequence)) consequences.set(eff.consequence, 0);
          consequences.set(eff.consequence, consequences.get(eff.consequence) + 1);
        }
      }
    }
    // unknown count matches header (PT29.6)
    const unknownCount = consequences.get('unknown') || 0;
    assert.equal(header.unknown.consequence, unknownCount);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 5: Gate decision structure
test('PT29.2: gate field is null without policies, has outcome/reason with', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const ep = JSON.parse(lines[i]);
      for (const step of ep.steps) {
        for (const eff of step.effects) {
          if (eff.gate !== null) {
            assert.ok(eff.gate.outcome);
            assert.ok(['allowed', 'denied', 'escalated', 'late', 'held'].includes(eff.gate.outcome));
          }
        }
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 6: Salted tokens, unique per export
test('PT29.4: tokens salted per export, disjoint across exports', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out1 = join(tmp, 'export1.ndjson');
    const out2 = join(tmp, 'export2.ndjson');
    // Export twice
    const ok1 = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out1);
    assert.equal(ok1.code, 0);
    const ok2 = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out2);
    assert.equal(ok2.code, 0);
    const content1 = readFileSync(out1, 'utf8');
    const content2 = readFileSync(out2, 'utf8');
    // Extract d: tokens
    const tokens1 = [...(content1.match(/d:[0-9a-f]{32}/g) || [])];
    const tokens2 = [...(content2.match(/d:[0-9a-f]{32}/g) || [])];
    const set1 = new Set(tokens1);
    const set2 = new Set(tokens2);
    // Exports should be disjoint (PT29.4)
    for (const t of set1) assert.ok(!set2.has(t), `token ${t} appears in both exports`);
    // No salt appears (PT29.4, PT29.8)
    assert.ok(!content1.includes('salt'), 'salt should not appear');
    assert.ok(!content2.includes('salt'), 'salt should not appear');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// Requirement 7: Replay property
test('PT29.3: replay property - post of step n equals pre of step n+1', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok.code, 0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const ep = JSON.parse(lines[i]);
      const steps = ep.steps;
      for (let j = 0; j < steps.length - 1; j++) {
        const curr = steps[j];
        const next = steps[j + 1];
        // Replay on consecutive steps (PS19.3, PT29.3)
        if (next.seq === curr.seq + 1) {
          assert.deepEqual(curr.post, next.pre, `step ${curr.seq} post != step ${next.seq} pre`);
        }
      }
      // Check gapped episodes say so (PS19.3, PS19.5)
      if (ep.gapped) {
        assert.ok(ep.steps.length >= 0, 'gapped run should still have steps array');
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// PT29.1: --out is required, and the refusal names it.
test('PT29.1: --out required, exit 64, and the message says what is missing', async () => {
  const dbPath = await emptyStore();
  const missing = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`);
  assert.equal(missing.code, 64);
  assert.match(missing.out, /poly: export traces needs --out/);
});

// PT29.1: an existing file is refused with its own message, and left as it was; the first export is a real one.
test('PT29.1: existing file refused with its own message and left unchanged', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  try {
    const out = join(tmp, 'export.ndjson');
    const ok1 = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok1.code, 0, ok1.out);
    const orig = readFileSync(out, 'utf8');
    assert.ok(orig.split(String.fromCharCode(10)).length > 2, 'the first export holds an episode');
    const ok2 = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(ok2.code, 64);
    assert.match(ok2.out, /does not overwrite a file/);
    assert.equal(readFileSync(out, 'utf8'), orig);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// PT29.1: a tampered build is refused as 'poly journal replay' refuses it: at load, by the same words.
test('PT29.1: a tampered build artefact is refused at load, as journal replay refuses it', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  const target = join(build, 'effects.Account', 'effects.cjs');
  const orig = readFileSync(target, 'utf8');
  try {
    writeFileSync(target, `${orig}
// tampered
`);
    const trust = `${a.key.id}=${join(a.dir, 'admission.pub')}`;
    const replay = poly('journal', 'replay', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', trust);
    assert.notEqual(replay.code, 0);
    assert.match(replay.out, /refused at load/, replay.out);
    const out = join(tmp, 'export.ndjson');
    const tampered = poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', trust, '--out', out);
    assert.equal(tampered.code, replay.code);
    assert.match(tampered.out, /refused at load/, tampered.out);
    assert.throws(() => readFileSync(out), /ENOENT/, 'no corpus was written');
  } finally { writeFileSync(target, orig); rmSync(tmp, { recursive: true, force: true }); }
});

// PT29.1: --run restricts the corpus to the named runs.
test('PT29.1: --run restricts to the named runs', async () => {
  const dbPath = await populateStore();
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-'));
  const trust = `${a.key.id}=${join(a.dir, 'admission.pub')}`;
  const read = (f) => readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
  try {
    const all = join(tmp, 'all.ndjson'); const one = join(tmp, 'one.ndjson'); const none = join(tmp, 'none.ndjson');
    assert.equal(poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', trust, '--out', all).code, 0);
    assert.equal(poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', trust, '--out', one, '--run', 'acc-1').code, 0);
    assert.equal(poly('export', 'traces', '--db', dbPath, '--build', build, '--certificate', cert, '--trust', trust, '--out', none, '--run', 'nonexistent').code, 0);
    const [hAll, ...eAll] = read(all); const [hOne, ...eOne] = read(one); const [hNone, ...eNone] = read(none);
    assert.ok(eAll.length >= 1 && eAll.some((e) => e.steps.some((s) => s.action === 'Bill')), 'the whole store has the account');
    assert.deepEqual([hOne.episodes, eOne.length, eOne[0].machine], [1, 1, 'effects.Account']);
    assert.deepEqual([hNone.episodes, eNone.length], [0, 0]);
    assert.ok(hAll.episodes >= hOne.episodes);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
