// M11 step 7 (PT24.4, PS18.6, S358, AC25's replay half): the records of routed decisions, `poly cost` from the ledger
// alone, a cost priced again under another table by its digest, replay of every tier choice with no provider
// registered, and no completion body in a record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '@poly/runtime';
import { replayRuntime } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admittedDesk, answer, FIX } from './routing-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const TEXT = { text: 'where is my refund' };
// A completion body a provider returns beside its answer: it must reach no record (S358).
const CANARY = 'canary-completion-7f3a9c';

const a = await admittedDesk('routing-cost');
const db = join(a.dir, 'run.db');
const T0 = Date.UTC(2026, 9, 7, 12);

/** A provider that answers each call in turn, as recorded, with a completion body beside each answer. */
const inTurn = (answers) => { let i = 0; return () => ({ ...answers[Math.min(i++, answers.length - 1)], reasoning: CANARY }); };

/** Three runs: k-1 escalates and the large tier answers; k-2 is answered on the small tier; k-3 is exhausted. */
async function populate() {
  rmSync(db, { force: true });
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => T0 });
  try {
    rt.provideTier('flash', inTurn([answer('Refund', 0.6), answer('Status', 0.96), answer('Refund', 0.6)]));
    rt.provideTier('opus', inTurn([answer('Refund', 0.96, { input: 2000, output: 1000 }), answer('Refund', 0.6, { input: 2000, output: 1000 })]));
    const out = {};
    for (const id of ['k-1', 'k-2', 'k-3']) {
      await rt.create('desk.Ticket', { id });
      await rt.dispatch(id, 'Received', TEXT);
      for (let i = 0; i < 6; i++) await rt.worker.tick();
      out[id] = (await rt.getState(id)).state.status;
    }
    return out;
  } finally { await rt.close(); }
}

test('PS18.6, S358: poly cost sums every call\'s cost from the ledger alone, per run, scope and day', { timeout: 300_000 }, async () => {
  assert.deepEqual(await populate(), { 'k-1': 'Routed', 'k-2': 'Routed', 'k-3': 'NeedsHuman' });
  const r = poly('cost', '--db', db, '--json');
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(r.out);
  // Five calls: k-1's two (180 + 21,000), k-2's one (180), k-3's two (180 + 21,000), in micro-units (PS18.3). The
  // decisions' own events repeat their answering tier's and are not counted again.
  assert.equal(report.calls, 5);
  assert.deepEqual(report.total, { usd: 42_540 });
  assert.deepEqual(report.byRun, { 'k-1': { usd: 21_180 }, 'k-2': { usd: 180 }, 'k-3': { usd: 21_180 } });
  assert.deepEqual(report.byScope, { desk: { usd: 42_540 } });
  assert.deepEqual(report.byDay, { '2026-10-07': { usd: 42_540 } });
  assert.equal(JSON.parse(poly('cost', '--db', db, '--run', 'k-2', '--json').out).calls, 1);
  assert.equal(JSON.parse(poly('cost', '--db', db, '--period', '2026-11', '--json').out).calls, 0);
  assert.equal(JSON.parse(poly('cost', '--db', db, '--scope', 'other', '--json').out).calls, 0);
  assert.match(poly('cost', '--db', db).out, /total 0\.042540 usd/);
  assert.equal(poly('cost').code, 64);
});

test('S358: a cost is priced again under another table version, named by its digest', { timeout: 300_000 }, async () => {
  const table = { ...JSON.parse(readFileSync(join(FIX, 'prices', 'opus.json'), 'utf8')), perMillionTokens: { input: 1_000_000, output: 5_000_000 }, readOn: '2026-11-01' };
  const file = join(a.dir, 'opus-2026-11.json');
  writeFileSync(file, JSON.stringify(table));
  const digest = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
  const report = JSON.parse(poly('cost', '--db', db, '--prices', file, '--json').out);
  // The two large calls, 2000 input and 1000 output tokens each: 7,000 micro-units each under the new table.
  assert.deepEqual(report.repriced, { prices: digest, model: 'opus-2026-08', calls: 2, total: { usd: 14_000 } });
  assert.deepEqual(report.total, { usd: 42_540 }, 'the recorded costs are unchanged');
  const { readOn, ...unsourced } = table;
  writeFileSync(file, JSON.stringify(unsourced));
  assert.ok(readOn);
  const bad = poly('cost', '--db', db, '--prices', file);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /PL6843/);
});

test('AC25: replay reproduces every tier choice from the ledger, with no provider registered', { timeout: 300_000 }, async () => {
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => T0 });
  try {
    const runs = await replayRuntime(rt);
    const routes = runs.filter((r) => r.machine === 'desk.triage.Route');
    const budgets = runs.filter((r) => r.machine === 'desk.support.Budget');
    assert.equal(routes.length, 3);
    assert.ok(budgets.length >= 2);
    for (const r of runs) assert.deepEqual([r.run, r.diagnostics.map((d) => d.message)], [r.run, []]);
    // Every Answer and Fail of every route was folded again through poly-ref's step and polygraph's replay.
    assert.ok(routes.every((r) => r.folded === r.rows && r.windows > 0));
  } finally { await rt.close(); }
});

test('S358: no completion body enters the journal, the ledger or the content store', { timeout: 300_000 }, async () => {
  for (const f of [db, `${db}-wal`]) {
    let bytes;
    try { bytes = readFileSync(f); } catch { continue; }
    assert.equal(bytes.includes(Buffer.from(CANARY)), false, f);
  }
  // The control: the canary is found where it is written.
  writeFileSync(join(a.dir, 'control.txt'), CANARY);
  assert.equal(readFileSync(join(a.dir, 'control.txt')).includes(Buffer.from(CANARY)), true);
});
