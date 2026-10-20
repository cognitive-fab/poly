// DF25: State diagrams of the Desk (heavy test).
// DAC29: Regenerates Desk diagram and compares byte-for-byte, checks states and edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), '..');

test('DF25, DAC29: make-diagrams.mjs --only desk regenerates byte-for-byte', () => {
  const outDir = join(tmpdir(), `demo-diagrams-desk-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `make-diagrams.mjs failed with exit ${result.status}\nstderr: ${result.stderr}`);

    const generated = readFileSync(join(outDir, 'concierge-desk.mmd'), 'utf8');
    const committed = readFileSync(join(ROOT, 'docs', 'demo', 'diagrams', 'concierge-desk.mmd'), 'utf8');

    assert.equal(generated, committed, 'generated Desk diagram must be byte-identical to committed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Desk diagram has three refund ledger states', () => {
  const outDir = join(tmpdir(), `demo-diagrams-desk-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'concierge-desk.mmd'), 'utf8');

    // State ids for the Desk are <phase>_<refund>, so check for the three refund values
    assert.match(content, /_None/, 'should have states with refund=None (e.g. Idle_None)');
    assert.match(content, /_Unknown/, 'should have states with refund=Unknown (e.g. Answering_Unknown)');
    assert.match(content, /_Issued/, 'should have states with refund=Issued (e.g. Closed_Issued)');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Desk diagram has RefundUnknown edge into Answering with ledger Unknown', () => {
  const outDir = join(tmpdir(), `demo-diagrams-desk-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'concierge-desk.mmd'), 'utf8');

    // Look for edge from Refunding_Unknown to Answering_Unknown with RefundUnknown label
    assert.match(
      content,
      /Refunding_Unknown\s+-->\s+Answering_Unknown\s+:\s+RefundUnknown/,
      'should have RefundUnknown edge from Refunding_Unknown to Answering_Unknown'
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Desk diagram has Resolve edges from Unknown state', () => {
  const outDir = join(tmpdir(), `demo-diagrams-desk-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'concierge-desk.mmd'), 'utf8');

    // Check for Resolve edge from Unknown to Issued (when done=true)
    assert.match(
      content,
      /.*_Unknown\s+-->\s+.*_Issued\s+:\s+Resolve/,
      'should have Resolve edge from state ending _Unknown to state ending _Issued'
    );

    // Check for Resolve edge from Unknown to None (when done=false)
    assert.match(
      content,
      /.*_Unknown\s+-->\s+.*_None\s+:\s+Resolve/,
      'should have Resolve edge from state ending _Unknown to state ending _None'
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Desk diagram has initial state Idle_None', () => {
  const outDir = join(tmpdir(), `demo-diagrams-desk-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'concierge-desk.mmd'), 'utf8');

    // Check for initial state transition
    assert.match(content, /\[\*\]\s+-->\s+Idle_None/, 'should have initial state [*] --> Idle_None');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Desk diagram is deterministic (same bytes on two runs)', () => {
  const outDir1 = join(tmpdir(), `demo-diagrams-desk-det1-${Date.now()}`);
  const outDir2 = join(tmpdir(), `demo-diagrams-desk-det2-${Date.now()}`);
  try {
    mkdirSync(outDir1, { recursive: true });
    mkdirSync(outDir2, { recursive: true });

    const result1 = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir1,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result1.status, 0, 'first run should succeed');

    const result2 = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir2,
      '--only',
      'desk',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result2.status, 0, 'second run should succeed');

    const content1 = readFileSync(join(outDir1, 'concierge-desk.mmd'), 'utf8');
    const content2 = readFileSync(join(outDir2, 'concierge-desk.mmd'), 'utf8');

    assert.equal(content1, content2, 'two runs must produce identical bytes');
  } finally {
    rmSync(outDir1, { recursive: true, force: true });
    rmSync(outDir2, { recursive: true, force: true });
  }
});
