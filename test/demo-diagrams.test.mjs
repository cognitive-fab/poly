// DF25: State diagrams of the checked machines, for the pages (Ticket only).
// DAC29: Regenerates Ticket diagram and compares byte-for-byte, checks structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('DF25, DAC29: make-diagrams.mjs --only ticket regenerates byte-for-byte', () => {
  const outDir = join(tmpdir(), `demo-diagrams-ticket-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `make-diagrams.mjs failed with exit ${result.status}\nstderr: ${result.stderr}`);

    const generated = readFileSync(join(outDir, 'poly-kept-ticket.mmd'), 'utf8');
    const committed = readFileSync(join(ROOT, 'docs', 'demo', 'diagrams', 'poly-kept-ticket.mmd'), 'utf8');

    assert.equal(generated, committed, 'generated Ticket diagram must be byte-identical to committed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Ticket diagram has caption line with projection', () => {
  const outDir = join(tmpdir(), `demo-diagrams-ticket-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'poly-kept-ticket.mmd'), 'utf8');
    const lines = content.split('\n');

    // First lines should be comments, first comment should mention projection
    assert.match(content, /^%% .*projection/m, 'first comment line should contain projection');

    // Next non-comment line should be stateDiagram-v2
    let diagramLineIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('%%')) {
        diagramLineIdx = i;
        break;
      }
    }
    assert.match(lines[diagramLineIdx], /stateDiagram-v2/, 'next line after comments should be stateDiagram-v2');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Ticket diagram contains RefundUnknown edge into Review and Resolve edges', () => {
  const outDir = join(tmpdir(), `demo-diagrams-ticket-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'poly-kept-ticket.mmd'), 'utf8');

    // Check for RefundUnknown edge from Refunding to Review
    assert.match(content, /Refunding\s+-->\s+Review\s+:\s+RefundUnknown/, 'should have RefundUnknown edge from Refunding to Review');

    // Check for Resolve edges out of Review (to either Idle or Closed)
    assert.match(content, /Review\s+-->\s+(Idle|Closed)\s+:\s+Resolve/, 'should have Resolve edge from Review');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Ticket diagram has initial state and terminal state', () => {
  const outDir = join(tmpdir(), `demo-diagrams-ticket-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'poly-kept-ticket.mmd'), 'utf8');

    // Check for initial state: [*] --> New
    assert.match(content, /\[\*\]\s+-->\s+New/, 'should have initial state [*] --> New');

    // Check for terminal state: Closed --> [*]
    assert.match(content, /Closed\s+-->\s+\[\*\]/, 'should have terminal state Closed --> [*]');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Ticket diagram has no date and ends with newline', () => {
  const outDir = join(tmpdir(), `demo-diagrams-ticket-${Date.now()}`);
  try {
    mkdirSync(outDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, 'make-diagrams.mjs should succeed');

    const content = readFileSync(join(outDir, 'poly-kept-ticket.mmd'), 'utf8');

    // Check no date pattern YYYY-MM-DD
    assert.doesNotMatch(content, /\d{4}-\d{2}-\d{2}/, 'should not contain a date');

    // Check ends with newline
    assert.ok(content.endsWith('\n'), 'should end with newline');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('DF25, DAC29: Ticket diagram is deterministic (same bytes on two runs)', () => {
  const outDir1 = join(tmpdir(), `demo-diagrams-ticket-det1-${Date.now()}`);
  const outDir2 = join(tmpdir(), `demo-diagrams-ticket-det2-${Date.now()}`);
  try {
    mkdirSync(outDir1, { recursive: true });
    mkdirSync(outDir2, { recursive: true });

    const result1 = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir1,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result1.status, 0, 'first run should succeed');

    const result2 = spawnSync(process.execPath, [
      join(ROOT, 'demo', 'scripts', 'make-diagrams.mjs'),
      outDir2,
      '--only',
      'ticket',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result2.status, 0, 'second run should succeed');

    const content1 = readFileSync(join(outDir1, 'poly-kept-ticket.mmd'), 'utf8');
    const content2 = readFileSync(join(outDir2, 'poly-kept-ticket.mmd'), 'utf8');

    assert.equal(content1, content2, 'two runs must produce identical bytes');
  } finally {
    rmSync(outDir1, { recursive: true, force: true });
    rmSync(outDir2, { recursive: true, force: true });
  }
});
