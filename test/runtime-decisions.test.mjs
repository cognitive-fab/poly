// M4e: decision provenance (PD2-A1 to PD2-A4, K10, S130) and model independence (PD3-A1, PD3-A3, and the half of
// PD3-A2 that needs no policy, S131), on the router of PD1.5 with outcomes. Every provider is recorded: no test
// calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { genesis, hashOf } from '@cognitive-fab/polyflow-kernel';
import { replayRuntime, evaluate, fit, samples } from '@poly/check';
import { load, RefusedDispatch, openJournal } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('decisions', ['conformance/m4/router.poly']);
const TEXT = { text: 'where is my refund' };

/** A recorded provider: the answers it gives, in order, and the questions it was asked. */
function recorded(answers, reported = 'jev-2026-09-18') {
  const asked = [];
  const provider = (q) => {
    asked.push(q);
    const next = typeof answers === 'function' ? answers(q, asked.length) : answers[Math.min(asked.length - 1, answers.length - 1)];
    return { reported, latencyMs: 5, ...next };
  };
  return { provider, asked };
}
const refund = (p) => ({ answer: 'Refund', distribution: [['Refund', p], ['Complaint', (1 - p) * 0.7], ['Other', (1 - p) * 0.3]] });

async function route(rt, id) {
  await rt.create('support.Ticket', { id });
  await rt.dispatch(id, 'Received', TEXT);
  await rt.worker.tick();
}

test('PD2-A1: every completion of a decision links its decision event, written in the completion\'s transaction', async () => {
  const { rt } = await loaded(a);
  try {
    rt.provide('route', { provider: recorded([refund(0.93)]).provider, model: 'jev-latest' });
    await route(rt, 't-1');
    assert.equal((await rt.getState('t-1')).state.status, 'Refunding');
    const chain = await rt.chain('t-1');
    const i = chain.findIndex((e) => e.kind === 'step' && e.body.action === 'Routed');
    assert.equal(chain[i - 1].kind, 'decision', 'the decision event comes just before its completion step');
    assert.equal(chain[i].body.decision, chain[i - 1].hash);
    const d = chain[i - 1].body;
    assert.deepEqual([d.decision, d.provider, d.answer, d.conf, d.margin, d.model], ['route', 'jev', 'Refund', 930, 881, { id: 'jev-latest', reported: 'jev-2026-09-18' }]);
    assert.deepEqual(d.calibration, { uncalibrated: true });
    assert.match(d.request, /^sha256:/);
    assert.deepEqual(await rt.verifyProvenance('t-1'), []);
  } finally { await rt.close(); }
});

test('PD2-A1: a crash between the provider\'s answer and the completion\'s commit leaves neither, and the run recovers and completes', async () => {
  const { rt, clock } = await loaded(a);
  try {
    const rec = recorded([refund(0.93)]);
    rt.provide('route', { provider: rec.provider, model: 'jev-latest' });
    await rt.create('support.Ticket', { id: 't-2' });
    await rt.dispatch('t-2', 'Received', TEXT);
    const commit = rt.store.commitStep.bind(rt.store);
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId === 't-2' && step.journal.action === 'Routed') throw new Error('crash before the commit');
    });
    await assert.rejects(rt.worker.tick(), /crash before the commit/);
    rt.store.commitStep = commit;
    const chain = await rt.chain('t-2');
    assert.equal(chain.filter((e) => e.kind === 'decision').length, 0);
    assert.equal(chain.filter((e) => e.body.action === 'Routed').length, 0);
    // A decision is tried once (PD1.7): after the lease, the recovered intent fails, and the run completes by RouteFailed.
    clock.advance(61_000);
    await rt.worker.tick();
    assert.equal((await rt.getState('t-2')).state.status, 'NeedsHuman');
    assert.equal(rec.asked.length, 1, 'the model was asked once');
    assert.deepEqual(await rt.verifyProvenance('t-2'), []);
  } finally { await rt.close(); }
});

/** Rewrites one event and re-chains everything after it, links included, as someone editing the ledger would. */
function rechain(rt, run, seq, mutate) {
  const rows = rt.store.db.prepare('SELECT seq, event FROM poly_ledger WHERE run = ? ORDER BY seq').all(run).map((r) => JSON.parse(r.event));
  let prev = seq === 0 ? genesis(rows[0].run) : rows[seq - 1].hash;
  const renamed = new Map();
  for (let k = seq; k < rows.length; k++) {
    const e = { ...rows[k], body: { ...rows[k].body }, prev };
    if (k === seq) mutate(e);
    if (renamed.has(e.body.decision)) e.body.decision = renamed.get(e.body.decision);
    const old = e.hash;
    delete e.hash;
    e.hash = hashOf(e);
    renamed.set(old, e.hash);
    prev = e.hash;
    rt.store.db.prepare('UPDATE poly_ledger SET event = ?, hash = ? WHERE run = ? AND seq = ?').run(JSON.stringify(e), e.hash, run, k);
  }
}

test('PD2-A2: a removed link and an altered answer are refused (PL9003), even with the chain rebuilt', async () => {
  for (const [what, mutate, pattern] of [
    ['link removed', (e) => { if (e.kind === 'step') delete e.body.decision; }, /links no decision event/],
    ['answer altered', (e) => { if (e.kind === 'decision') e.body.conf = 990; }, /conf is 930, and the decision event records 990/],
  ]) {
    const { rt } = await loaded(a);
    try {
      rt.provide('route', { provider: recorded([refund(0.93)]).provider, model: 'jev-latest' });
      await route(rt, 't-3');
      const chain = await rt.chain('t-3');
      const target = what === 'link removed' ? chain.find((e) => e.kind === 'step' && e.body.action === 'Routed') : chain.find((e) => e.kind === 'decision');
      rechain(rt, 't-3', target.seq, mutate);
      assert.equal((await rt.verifyChain('t-3')).ok, true, `${what}: the chain itself was rebuilt`);
      assert.match((await rt.verifyProvenance('t-3')).join('\n'), pattern, what);
    } finally { await rt.close(); }
  }
});

test('PD2-A3: replay reproduces every post-state with no model and no network', async () => {
  const { rt } = await loaded(a);
  const realFetch = globalThis.fetch;
  try {
    rt.provide('route', { provider: recorded([refund(0.93), refund(0.4)]).provider, model: 'jev-latest' });
    await route(rt, 't-4');
    await route(rt, 't-5');
    rt.provide('route', { provider: () => { throw new Error('replay called a model'); }, model: 'none' });
    globalThis.fetch = () => { throw new Error('replay used the network'); };
    const runs = await replayRuntime(rt);
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
    assert.ok(runs.some((r) => r.run === 't-5'));
  } finally { globalThis.fetch = realFetch; await rt.close(); }
});

test('PD2-A4: a reversed refund writes an outcome linked to the right decision event', async () => {
  const { rt } = await loaded(a);
  try {
    rt.provide('route', { provider: recorded([refund(0.93)]).provider, model: 'jev-latest' });
    await route(rt, 't-6');
    await rt.dispatch('t-6', 'RefundDone');
    await rt.dispatch('t-6', 'RefundReversed');
    const chain = await rt.chain('t-6');
    const decision = chain.find((e) => e.kind === 'decision');
    const outcome = chain.find((e) => e.kind === 'outcome');
    assert.deepEqual([outcome.body.decision, outcome.body.outcome, outcome.body.decisionEvent], ['route', 'Wrong', decision.hash]);
    const step = chain.find((e) => e.kind === 'step' && e.body.action === 'RefundReversed');
    assert.equal(outcome.seq, step.seq + 1, 'written with the adjudicating step, in its transaction');
    await rt.worker.tick(); // the outcome intent runs its built-in handler, through OutboxIntent like any effect
    const [row] = (await rt.outbox('t-6')).filter((r) => r.kind === 'outcome.route');
    assert.equal(row.status, 'done');
  } finally { await rt.close(); }
});

test('K10 (S130): an outside dispatch of a decision\'s completion is refused before any step, with an audit row', async () => {
  const { rt } = await loaded(a);
  try {
    await rt.create('support.Ticket', { id: 't-7' });
    await rt.dispatch('t-7', 'Received', TEXT);
    const before = (await rt.getJournal('t-7')).length;
    for (const action of ['Routed', 'RouteFailed']) {
      await assert.rejects(rt.dispatch('t-7', action, { branch: 'Refund', conf: 1000, margin: 1000 }, { actionId: `outside-${action}` }), (e) => e instanceof RefusedDispatch && e.rule === 'K10');
    }
    assert.equal((await rt.getJournal('t-7')).length, before);
    assert.deepEqual((await rt.audit('t-7')).map((r) => [r.action, r.rule]), [['Routed', 'K10'], ['RouteFailed', 'K10']]);
  } finally { await rt.close(); }
});

function hashTree(dir) {
  const h = createHash('sha256');
  const walk = (d) => { for (const e of readdirSync(d).sort()) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
  walk(dir);
  return h.digest('hex');
}

test('PD3-A1: swapping the provider\'s model changes no file of the build and not the certificate', async () => {
  const build = hashTree(a.build);
  const cert = readFileSync(a.certificate);
  for (const model of ['jev-2026-09-18', 'other-2026-10-01']) {
    const { rt } = await loaded(a);
    try {
      rt.provide('route', { provider: recorded([refund(0.93)], model).provider, model });
      await route(rt, `t-${model}`);
      assert.equal((await rt.chain(`t-${model}`)).find((e) => e.kind === 'decision').body.model.reported, model);
    } finally { await rt.close(); }
  }
  assert.equal(hashTree(a.build), build);
  assert.ok(readFileSync(a.certificate).equals(cert));
  assert.equal(a.cert.poly.decisions[0].modelBound, false);
});

test('PD3-A2, the half without a policy (S131): each decision event records the model and the map, so a mismatch is visible', async () => {
  const { rt } = await loaded(a);
  try {
    const map = { decision: 'route', version: 3, fittedFor: 'jev-2026-09-18', points: [[0, 0], [500, 400], [900, 950]] };
    const { mapDigest } = await import('@poly/runtime');
    const fitted = { ...map, digest: mapDigest(map) };
    rt.provide('route', { provider: recorded([refund(0.93)], 'new-2026-10-01').provider, model: 'new', calibration: fitted });
    await route(rt, 't-8');
    const d1 = (await rt.chain('t-8')).find((e) => e.kind === 'decision').body;
    assert.deepEqual(d1.calibration, { version: 3, fittedFor: 'jev-2026-09-18', digest: fitted.digest });
    assert.notEqual(d1.calibration.fittedFor, d1.model.reported, 'a map fitted for another model is visible');
    assert.equal(d1.conf, 950, 'the map was applied');
    rt.provide('route', { provider: recorded([refund(0.93)], 'new-2026-10-01').provider, model: 'new' });
    await route(rt, 't-9');
    assert.deepEqual((await rt.chain('t-9')).find((e) => e.kind === 'decision').body.calibration, { uncalibrated: true });
  } finally { await rt.close(); }
});

test('PD3-A3: an evaluation over 100 recorded questions reports agreement and calibration, and writes to no chain', async () => {
  const db = join(a.dir, 'eval.db');
  try { (await import('node:fs')).rmSync(db, { force: true }); } catch { /* none */ }
  let t = 1_790_000_000_000;
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => t });
  // The recorded model: confident and right above 0.9, confident and often wrong below.
  const p = (k) => 0.8 + (k % 20) / 100;
  rt.provide('route', { provider: recorded((q, n) => refund(p(n - 1))).provider, model: 'jev-latest' });
  for (let k = 0; k < 100; k++) {
    const id = `q-${String(k).padStart(3, '0')}`;
    await route(rt, id);
    await rt.dispatch(id, 'RefundDone');
    await rt.dispatch(id, p(k) >= 0.9 || k % 3 === 0 ? 'Close' : 'RefundReversed');
    t += 1000;
  }
  await rt.close();
  const reader = openJournal(db);
  try {
    const before = JSON.stringify(await Promise.all((await reader.runs()).map(async (r) => (await reader.chain(r.run)).at(-1).hash)));
    assert.equal((await samples(reader, 'route')).length, 100);
    // A candidate that answers Refund at 0.95 to every question: right where the refund was closed, wrong where it was reversed.
    const candidate = () => refund(0.95);
    const r = await evaluate(reader, 'route', candidate);
    assert.equal(r.scored, 100);
    assert.ok(r.agreement > 0 && r.agreement < 1, String(r.agreement));
    assert.ok(r.brier >= 0 && r.brier <= 1);
    assert.equal(r.bins.reduce((n, b) => n + b.n, 0), 100);
    const map = await fit(reader, 'route', 'jev-2026-09-18', 4);
    assert.equal(map.fittedFor, 'jev-2026-09-18');
    for (let k = 1; k < map.points.length; k++) assert.ok(map.points[k][1] >= map.points[k - 1][1], 'monotone');
    const after = JSON.stringify(await Promise.all((await reader.runs()).map(async (r) => (await reader.chain(r.run)).at(-1).hash)));
    assert.equal(after, before, 'no chain changed');
    writeFileSync(join(a.dir, 'candidate.mjs'), "export default () => ({ answer: 'Refund', distribution: [['Refund', 0.95], ['Other', 0.05]] });\n");
  } finally { await reader.close(); }
  const { execFileSync } = await import('node:child_process');
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'journal', 'eval', '--db', db, '--decision', 'route', '--candidate', join(a.dir, 'candidate.mjs')], { encoding: 'utf8' }));
  assert.equal(out.scored, 100);
  const m = JSON.parse(execFileSync(process.execPath, [cli, 'journal', 'fit', '--db', db, '--decision', 'route', '--model', 'jev-2026-09-18', '--version', '5'], { encoding: 'utf8' }));
  assert.equal(m.version, 5);
});

// Review B2: no decision without its record.
test('review B2: a decision handler can only come from the provider host, and a completion with no record is refused', async () => {
  const { rt, clock } = await loaded(a);
  try {
    assert.throws(() => rt.handle('decision.route', () => ({ answer: 'Refund', conf: 900, margin: 900 })), /provide/);
    // Around the API, a handler that keeps no record: the completion's commit is refused, and no refund is issued.
    rt.handlers.set('decision.route', () => ({ answer: 'Refund', conf: 900, margin: 900 }));
    await rt.create('support.Ticket', { id: 'b2' });
    await rt.dispatch('b2', 'Received', TEXT);
    await rt.worker.tick();
    clock.advance(61_000);
    await rt.worker.tick();
    const actions = (await rt.getJournal('b2')).map((r) => r.action);
    assert.ok(!actions.includes('Routed'), actions.join(','));
    assert.equal((await rt.outbox('b2')).filter((r) => r.kind === 'payments.refund').length, 0);
    assert.ok((await rt.audit('b2')).some((r) => r.rule === 'K10' && r.action === 'Routed'));
  } finally { await rt.close(); }
});

// Review B3: conf is the calibrated probability of the answer returned, not of the most probable one.
test('review B3: an engine that picks Refund at 0.1 gets conf 100, margin 0, and the refund gate holds', async () => {
  const { rt } = await loaded(a);
  try {
    rt.provide('route', { provider: () => ({ answer: 'Refund', distribution: [['Complaint', 0.9], ['Refund', 0.1]] }), model: 'm' });
    await route(rt, 'b3');
    const d = (await rt.chain('b3')).find((e) => e.kind === 'decision').body;
    assert.deepEqual([d.answer, d.raw, d.conf, d.margin], ['Refund', 0.1, 100, 0]);
    assert.equal((await rt.getState('b3')).state.status, 'NeedsHuman');
    assert.equal((await rt.outbox('b3')).filter((r) => r.kind === 'payments.refund').length, 0);
  } finally { await rt.close(); }
});
