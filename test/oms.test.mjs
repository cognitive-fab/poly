// AC1, the OMS order (plan step 7, S24): the two corpora and the hand-written controls. The poly order's
// comparisons join this file once the poly OMS exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWindows, replaySpecResults } from '@cognitive-fab/polygraph/scripts/replay.mjs';
import { ROOT } from './helpers.mjs';
import { record } from '../scripts/record-oms-corpus.mjs';

const HAND = join(ROOT, 'conformance', 'field-studies', 'order');
const KERNEL = join(ROOT, 'conformance', 'field-studies', 'order-kernel');

const statuses = (spec, windows) => {
  const r = replaySpecResults(spec, windows);
  assert.ok(r.ok, r.error);
  return r.results.map((x) => x.status);
};
const pass = (xs) => xs.filter((x) => x === 'pass').length;

test('S24 (a): the copied corpus has 81 windows that never leave pending, and the hand-written order passes 53', () => {
  const windows = loadWindows(join(HAND, 'machines', 'order', 'traces'));
  assert.equal(windows.length, 81);
  assert.ok(windows.every((w) => JSON.stringify(w.pre) === JSON.stringify(w.post)));
  assert.equal(pass(statuses(join(HAND, 'machines', 'order', 'next.cjs'), windows)), 53);
});

test('S24 (b): the kernel-recorded corpus matches its PROVENANCE.md and the hand-written order passes all of it', () => {
  const text = readFileSync(join(KERNEL, 'PROVENANCE.md'), 'utf8');
  const rows = [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)];
  assert.equal(rows.length, 16);
  for (const [, f, h] of rows) assert.equal(createHash('sha256').update(readFileSync(join(KERNEL, f))).digest('hex'), h, f);
  const windows = loadWindows(join(KERNEL, 'traces'));
  assert.equal(windows.length, 58);
  assert.equal(pass(statuses(join(HAND, 'machines', 'order', 'next.cjs'), windows)), 58);
});

test('S24 (b): the recording script gives the same bytes on every run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-oms-'));
  try {
    const files = await record(dir);
    for (const f of files) assert.ok(readFileSync(join(dir, f)).equals(readFileSync(join(KERNEL, f))), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
