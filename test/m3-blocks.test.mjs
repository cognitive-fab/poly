// The batch script for the M3 runs (4c630d2): the blocks in the plan's order, where the batch starts, why it stops
// (a refused, unscored or capped run), and which processes on the PC count as overlapping a block. No run starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blockOrder, blockProblems, firstToRun, overlapping, CAPS } from '../experiments/m3/blocks.mjs';

test('the blocks go by run number, then by task: 50 of them, T1 run 1 first and T10 run 5 last', () => {
  const o = blockOrder();
  assert.equal(o.length, 50);
  assert.deepEqual([o[0], o[1], o[9], o[10], o[49]].map((b) => `${b.n}:${b.task}:${b.run}`), ['1:T1:1', '2:T2:1', '10:T10:1', '11:T1:2', '50:T10:5']);
  assert.deepEqual(CAPS, { tokens: 15_000_000, wallSeconds: 3600, usd: 15 });
});

test('a block stops the batch when a run was refused, is unscored or was stopped by a cap', () => {
  const b = { n: 2, task: 'T2', run: 1 };
  const ok = { versions: [{ n: 0, stopped: null }] };
  assert.deepEqual(blockProblems(b, { 1: ok, 2: ok, 3: ok, 4: ok }), []);
  assert.match(blockProblems(b, { 1: ok, 2: null, 3: ok, 4: ok }, { 2: 2 })[0], /T2-arm2-run1: refused .*exit 2/);
  assert.match(blockProblems(b, { 1: ok, 2: ok, 3: { unscored: 'synced' }, 4: ok })[0], /T2-arm3-run1: unscored \(synced\)/);
  assert.match(blockProblems(b, { 1: ok, 2: ok, 3: ok, 4: { versions: [{ n: 0 }, { n: 1, stopped: 'usd' }] } })[0], /T2-arm4-run1: stopped by a cap \(usd, version 1\)/);
});

test('the batch starts at the first block not fully recorded, and refuses a block recorded in part', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-blocks-'));
  try {
    const order = blockOrder(['T1', 'T2'], 1);
    const put = (task, arm, rec) => { mkdirSync(join(dir, `${task}-arm${arm}-run1`), { recursive: true }); writeFileSync(join(dir, `${task}-arm${arm}-run1`, 'run.json'), JSON.stringify(rec)); };
    for (const arm of [1, 2, 3, 4]) put('T1', arm, { versions: [] });
    assert.deepEqual(firstToRun(order, dir), { block: order[1], problems: [] });
    put('T2', 1, { versions: [] });
    assert.match(firstToRun(order, dir).problems[0], /partly recorded: arms 1/);
    for (const arm of [2, 3, 4]) put('T2', arm, { versions: [] });
    assert.deepEqual(firstToRun(order, dir), { block: null, problems: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlap: tests or a review outside the batch are flagged; the batch\'s own processes are not', () => {
  const ps = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: 'node blocks.mjs' },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: 'node run.mjs --arm 1' },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: 'node --test test/host.test.mjs' },
    { ProcessId: 20, ParentProcessId: 2, CommandLine: 'C:\\Program Files\\nodejs\\node.exe --test "packages/*/dist/test/*.test.js"' },
    { ProcessId: 21, ParentProcessId: 2, CommandLine: 'node --test C:\\Users\\jjdub\\code\\poly-m4\\test\\x.test.mjs' },
    { ProcessId: 24, ParentProcessId: 2, CommandLine: 'node c:\\Users\\jjdub\\code\\poly-m4\\node_modules\\typescript\\lib\\tsserver.js' },
    { ProcessId: 22, ParentProcessId: 2, CommandLine: 'node polywatch.mjs review' },
    { ProcessId: 23, ParentProcessId: 2, CommandLine: 'claude' },
  ];
  assert.deepEqual(overlapping(ps, 10).length, 3);
  assert.ok(!overlapping(ps, 10).some((c) => c.includes('test/host.test.mjs')));
});

test('an unreadable run.json stops the batch with its reason, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-blocks-bad-'));
  try {
    for (const arm of [1, 2, 3, 4]) { mkdirSync(join(dir, `T1-arm${arm}-run1`), { recursive: true }); writeFileSync(join(dir, `T1-arm${arm}-run1`, 'run.json'), arm === 2 ? '{"versions": [' : '{"versions": []}'); }
    const r = firstToRun(blockOrder(['T1'], 1), dir);
    assert.match(r.problems[0], /T1-arm2-run1: run\.json is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
