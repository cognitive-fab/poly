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
  const ok = (arm, more = {}) => ({ task: 'T2', arm, run: 1, finished: 'x', versions: [{ n: 0, stopped: null }], ...more });
  const recs = (more) => ({ 1: ok(1), 2: ok(2), 3: ok(3), 4: ok(4), ...more });
  assert.deepEqual(blockProblems(b, recs()), []);
  assert.match(blockProblems(b, recs({ 2: null }), { 2: 2 }).find((p) => /refused/.test(p)), /T2-arm2-run1: refused .*exit 2/);
  assert.match(blockProblems(b, recs({ 3: ok(3, { unscored: 'synced' }) }))[0], /T2-arm3-run1: unscored \(synced\)/);
  assert.match(blockProblems(b, recs({ 4: ok(4, { versions: [{ n: 0 }, { n: 1, stopped: 'usd' }] }) }))[0], /T2-arm4-run1: stopped by a cap \(usd, version 1\)/);
});

test('the batch starts at the first block not fully recorded, and refuses a block recorded in part', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-blocks-'));
  try {
    const order = blockOrder(['T1', 'T2'], 1);
    const put = (task, arm, rec) => { mkdirSync(join(dir, `${task}-arm${arm}-run1`), { recursive: true }); writeFileSync(join(dir, `${task}-arm${arm}-run1`, 'run.json'), JSON.stringify(rec)); };
    const rec = (task, arm) => ({ task, arm, run: 1, finished: 'x', versions: [{ n: 0, stopped: null }] });
    for (const arm of [1, 2, 3, 4]) put('T1', arm, rec('T1', arm));
    assert.deepEqual(firstToRun(order, dir), { block: order[1], problems: [] });
    put('T2', 1, rec('T2', 1));
    assert.match(firstToRun(order, dir).problems[0], /partly recorded: arms 1/);
    for (const arm of [2, 3, 4]) put('T2', arm, rec('T2', arm));
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
    for (const arm of [1, 2, 3, 4]) { mkdirSync(join(dir, `T1-arm${arm}-run1`), { recursive: true }); writeFileSync(join(dir, `T1-arm${arm}-run1`, 'run.json'), arm === 2 ? '{"versions": [' : JSON.stringify({ task: 'T1', arm, run: 1, finished: 'x', versions: [{ n: 0 }] })); }
    const r = firstToRun(blockOrder(['T1'], 1), dir);
    assert.match(r.problems[0], /T1-arm2-run1: run\.json is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runner that exits with an error stops the batch, even when it left a record (block 19: T9 arm 2 run 2)', () => {
  const b = { n: 19, task: 'T9', run: 2 };
  const ok = { task: 'T9', run: 2, finished: '2026-10-03T03:14:16.538Z', versions: [0, 1, 2, 3].map((n) => ({ n, stopped: null })) };
  const recs = Object.fromEntries([1, 2, 3, 4].map((a) => [a, { ...ok, arm: a }]));
  assert.deepEqual(blockProblems(b, recs, { 1: 0, 2: 0, 3: 0, 4: 0 }), []);
  assert.match(blockProblems(b, recs, { 1: 0, 2: 1, 3: 0, 4: 0 })[0], /T9-arm2-run2: the runner exited with code 1/);
});

test('a record that is not a finished run of its own task, arm and run stops the batch', () => {
  const b = { n: 3, task: 'T3', run: 1 };
  const good = (arm) => ({ task: 'T3', arm, run: 1, finished: 'x', versions: [0, 1, 2, 3].map((n) => ({ n, stopped: null })) });
  const recs = Object.fromEntries([1, 2, 3, 4].map((a) => [a, good(a)]));
  assert.deepEqual(blockProblems(b, recs), []);
  for (const [bad, why] of [[{ ...good(2), finished: undefined }, /not finished/], [{ ...good(2), versions: [] }, /versions/], [{ ...good(2), task: 'T4' }, /another run/]]) {
    assert.match(blockProblems(b, { ...recs, 2: bad })[0], why);
  }
});

test('overlap: a process whose parent was once this batch\'s own, and has exited since, is still the batch\'s', () => {
  // The arm's backgrounded test outlives the shell that started it: its parent PID is then gone from the table.
  const before = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: 'node blocks.mjs' },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: 'node run.mjs --arm 2' },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: 'claude.exe -p ...' },
    { ProcessId: 13, ParentProcessId: 12, CommandLine: 'bash -c "npm test"' },
    { ProcessId: 14, ParentProcessId: 13, CommandLine: '"C:/Program Files/Git/usr/bin/sh.exe" /c/Users/jjdub/AppData/Roaming/npm/npm test' },
  ];
  const after = [before[0], before[1], before[4], { ProcessId: 15, ParentProcessId: 14, CommandLine: 'node  --test' }];
  const seen = new Set();
  assert.deepEqual(overlapping(before, 10, seen), []);
  assert.deepEqual(overlapping(after, 10, seen), []);
  // A test outside the batch is still flagged, with its chain.
  const other = [...after, { ProcessId: 30, ParentProcessId: 29, CommandLine: 'node --test packages/x.test.js' }];
  const flagged = overlapping(other, 10, seen, { detail: true });
  assert.equal(flagged.length, 1);
  assert.deepEqual([flagged[0].pid, flagged[0].ppid], [30, 29]);
});

test('resuming: a run a cap stopped is a recorded outcome, so the batch resumes after its block once the owner has ruled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-blocks-cap-'));
  try {
    const order = blockOrder(['T1', 'T2'], 1);
    for (const arm of [1, 2, 3, 4]) {
      mkdirSync(join(dir, `T1-arm${arm}-run1`), { recursive: true });
      const versions = [{ n: 0, stopped: null }, { n: 1, stopped: arm === 2 ? 'wall' : null }];
      writeFileSync(join(dir, `T1-arm${arm}-run1`, 'run.json'), JSON.stringify({ task: 'T1', arm, run: 1, finished: 'x', versions }));
    }
    assert.deepEqual(firstToRun(order, dir), { block: order[1], problems: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlap: a test process born while an arm\'s shell command was running is the arm\'s; one born outside every such command is flagged', async () => {
  // Measured: under Git Bash the sh.exe that runs `npm test` has a parent that is already gone, for a foreground
  // command as for a backgrounded one, so no parent chain reaches the arm's claude.exe. The journals give each
  // arm's shell commands with their times instead.
  const { armCommandWindows, attribute } = await import('../experiments/m3/blocks.mjs');
  const t0 = Date.parse('2026-10-03T09:00:00.000Z');
  const record = { arm: 2, started: new Date(t0).toISOString(), finished: new Date(t0 + 900_000).toISOString(), versions: [{ n: 0, wallMs: 600_000 }, { n: 1, wallMs: 300_000 }] };
  const line = (turn, at, event) => JSON.stringify({ at, turn, type: 'stream', event });
  const use = (id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const journal = [
    line(0, 10_000, use('a', 'npm test 2>&1 | tail -5')), line(0, 40_000, res('a', 'ok')),
    line(1, 5_000, use('b', 'npm test')), line(1, 125_000, res('b', 'Command did not complete within its 120s timeout and was moved to the background (ID: x).')),
  ].join('\n');
  const w = armCommandWindows(record, journal);
  assert.deepEqual(w.map((x) => [x.arm, x.from - t0, x.to === Infinity ? 'open' : x.to - t0]), [[2, 10_000, 40_000], [2, 605_000, 'open']]);
  const flagged = [
    { pid: 1, command: 'node  --test', created: t0 + 20_000 },
    { pid: 2, command: 'node  --test', created: t0 + 300_000 },
    { pid: 3, command: 'node  --test', created: t0 + 2_000_000 },
    { pid: 4, command: 'node polywatch.mjs worker x.json', created: t0 + 20_000 },
    { pid: 5, command: 'node --test "packages/*/dist/test/*.test.js"', created: t0 + 20_000 },
  ];
  assert.deepEqual(attribute(flagged, w).map((p) => p.arm ?? null), [2, null, 2, null, null]);
});
