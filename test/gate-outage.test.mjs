// The outage test (plan-m5 section 6, accepted as written): the gate never fails open.
//
// Faults are injected at the seams the gate host owns: the engine's calls (through PolicyGateOptions.wrap), the
// ledger's write of a verdict, the worker's start of a handler, and the keyring at an approval. A seeded schedule of
// engine outages runs over a stream of orders, and the run is then judged from a log of handler calls the gate host
// cannot write:
//   1. no effect without a recorded allow: every handler call follows an `allowed` verdict for its intent, the
//      sessions replay, and no handler runs in a pass where the engine was out;
//   2. nothing allowed that the healthy gate would deny: each order's outcome equals a fault-free run's;
//   3. the machine is followed: every intent trace replays through OutboxIntent;
//   4. held work resumes: once the faults clear, every intent ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer } from '@poly/runtime';
import { workerConformance, replaySessions } from '@poly/check';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith, approveAs } from './runtime-helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;
const WORKER_SOURCE = join(ROOT, 'packages', 'poly-runtime', 'src', 'worker.ts');
const SOURCES = ['conformance/m5/orders.poly', 'conformance/m5/orders-rules.policy.poly'];

/** A small deterministic generator, so a failing schedule replays from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** The engine, wrapped: each call consults the active fault (O1, O2, O3, O6 on merge; O8 on settle). */
function faulty(state) {
  return (raw) => new Proxy(raw, {
    get(target, prop) {
      if (prop === '__raw') return target;
      if (prop === 'merge') return async (args) => {
        const f = state.active;
        if (f === 'O1') throw new Error('injected: the engine throws');
        if (f === 'O2') return new Promise(() => {}); // never answers
        // O3: the engine's own store fails, so it decides nothing and says so.
        if (f === 'O3') return { decision: 'deny', class: 'unavailable', reason: 'unavailable:policy (injected)', state_before: null, state_after: null };
        const v = await target.merge(args);
        if (f === 'O6' && v.decision === 'allow') return { ...v, record: 'degraded' };
        return v;
      };
      if (prop === 'settle') return async (args) => {
        if (state.active === 'O8') throw new Error('injected: settle fails');
        return target.settle(args);
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const ACTIONS = ['Reserve', 'Charge', 'Cancel'];

/** Runs `orders` orders, one batch per pass, under a fault schedule; returns the runtime, the handler log, the outages. */
async function run(name, schedule) {
  const a = await admitted(name, SOURCES);
  const state = { active: null };
  const { rt, clock } = await loaded(a, { gate: { policy: { wrap: faulty(state), proposeTimeoutMs: 50 } }, worker: { leaseMs: 60_000 } });
  const log = [];
  const starts = [];
  let pass = 0;
  handleWith(rt, 'stock.reserve', (p, caps, ctx) => { log.push({ intent: ctx.idempotencyKey, instance: ctx.instanceId, pass, fault: state.active }); return 'ok'; });
  const h = rt.handlerExports('src/handlers.ts');
  rt.handle('payment.charge', h.handle);
  rt.handle('payment.fee', h.handle);
  const ids = [];
  for (pass = 1; pass <= schedule.length + 12; pass++) {
    state.active = schedule[pass - 1] ?? null;
    if (pass <= schedule.length) for (let k = 0; k < 3; k++) {
      const id = `o${pass}-${k}`;
      ids.push(id);
      await rt.create('orders.Order', { id });
      await rt.dispatch(id, ACTIONS[(pass + k) % 3]);
    }
    clock.advance(61_000);
    starts[pass] = clock.now(); // the time of this pass's tick, as its events record it
    try { await rt.worker.tick(); } catch { /* an outage the worker reports; the row recovers by its lease */ }
  }
  return { rt, log, ids, a, starts, clock };
}

const outcome = async (rt, id) => {
  const v = (await rt.chain(id)).filter((e) => e.kind === 'verdict');
  return v.some((e) => e.body.outcome === 'allowed') ? 'allowed' : v.some((e) => e.body.outcome === 'denied') ? 'denied' : 'pending';
};

test('the gate never fails open under a seeded schedule of engine outages (O1, O2, O3, O6, O8)', { skip }, async (t) => {
  const seed = 20261002;
  const next = rng(seed);
  const kinds = ['O1', 'O2', 'O3', 'O6', 'O8'];
  // Every kind appears, in a seeded order, each for 1 to 3 passes after 1 or 2 healthy ones.
  const order = [...kinds, ...kinds].sort(() => next() - 0.5);
  const schedule = [];
  for (const f of order) {
    for (let k = 0, gap = 1 + Math.floor(next() * 2); k < gap; k++) schedule.push(null);
    for (let k = 0, len = 1 + Math.floor(next() * 3); k < len; k++) schedule.push(f);
  }
  t.diagnostic(`seed ${seed}: ${schedule.map((f) => f ?? '-').join(' ')}`);
  const faulted = await run('outage', schedule);
  const clean = await run('outage-clean', schedule.map(() => null));
  try {
    const { rt, log, ids, starts } = faulted;
    const passOf = (at) => { let p = 0; for (let k = 1; k < starts.length; k++) if (starts[k] !== undefined && starts[k] <= at) p = k; return p; };
    // 1. No effect without a recorded allow, and no allow obtained while the engine was out. A handler may run
    // during an outage only under an allow recorded before it (a retry, which PT9.7 keeps under its allow).
    let duringOutage = 0;
    for (const call of log) {
      const allow = (await rt.chain(call.instance)).find((e) => e.kind === 'verdict' && e.body.intent === call.intent && e.body.outcome === 'allowed');
      assert.ok(allow, `${call.instance}: a handler ran with no recorded allow`);
      if (['O1', 'O2', 'O3', 'O6'].includes(call.fault)) { duringOutage++; assert.ok(passOf(allow.at) < call.pass, `${call.instance}: the allow behind a handler run in an outage was not recorded before it`); }
    }
    for (const id of ids) for (const e of (await rt.chain(id)).filter((x) => x.kind === 'verdict' && x.body.outcome === 'allowed')) {
      const f = schedule[passOf(e.at) - 1];
      assert.ok(!['O1', 'O2', 'O3', 'O6'].includes(f), `${id}: an allow was recorded in a pass where the engine was out (${f})`);
    }
    t.diagnostic(`handler calls during outages: ${duringOutage}, each under an allow recorded before the outage`);
    const sessions = await replaySessions(rt);
    for (const s of sessions) { assert.deepEqual(s.diagnostics.map((d) => d.message), [], s.session); assert.deepEqual(s.notRun, [], s.session); }
    // 2. Each order's outcome is the fault-free run's.
    for (const id of ids) assert.equal(await outcome(rt, id), await outcome(clean.rt, id), id);
    // 3. The machine is followed.
    assert.deepEqual((await workerConformance(rt, WORKER_SOURCE)).diagnostics.map((d) => d.message), []);
    // 4. Held work resumed: every order's effect ended.
    for (const id of ids) {
      const [row] = await rt.outbox(id);
      assert.ok(['done', 'dead'].includes(row.status), `${id}: ${row.status} ${row.last_error ?? ''}`);
    }
    const counts = Object.fromEntries(kinds.map((k) => [k, schedule.filter((f) => f === k).length]));
    t.diagnostic(`passes per fault: ${JSON.stringify(counts)}; handler calls ${log.length}; sessions ${sessions.map((s) => `${s.session} ${s.proposals}+${s.settles}`).join(', ')}`);
  } finally { await faulted.rt.close(); await clean.rt.close(); }
});

test('O4: a governed scope whose policy is gone denies; nothing is allowed for want of a policy', { skip }, async () => {
  const { rt, log } = await run('outage-o4', []);
  try {
    const engine = rt.policyGate.engine.__raw ?? rt.policyGate.engine;
    engine.undeclare('poly/orders');
    await rt.create('orders.Order', { id: 'x' });
    await rt.dispatch('x', 'Reserve');
    await rt.worker.tick();
    const v = (await rt.chain('x')).filter((e) => e.kind === 'verdict').map((e) => e.body);
    assert.ok(v.some((b) => b.outcome === 'denied' && /no-policy-in-scope/.test(b.engineReason ?? b.reason)), JSON.stringify(v));
    assert.equal(log.filter((c) => c.instance === 'x').length, 0);
  } finally { await rt.close(); }
});

test('O5: a verdict the ledger cannot write is not acted on; the next proposal takes a new sseq', { skip }, async () => {
  const a = await admitted('outage-o5', SOURCES);
  const { rt, clock } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    let calls = 0;
    handleWith(rt, 'stock.reserve', () => { calls++; return 'ok'; });
    const append = rt.store.appendEvent.bind(rt.store);
    let fail = true;
    rt.store.appendEvent = (run, kind, body, at) => { if (fail && kind === 'verdict' && body?.outcome === 'allowed') throw new Error('injected: the ledger cannot write'); return append(run, kind, body, at); };
    await rt.create('orders.Order', { id: 'y' });
    await rt.dispatch('y', 'Reserve');
    await assert.rejects(rt.worker.tick(), /ledger cannot write/);
    assert.equal(calls, 0, 'no handler ran on an allow the ledger does not hold');
    const [row] = await rt.outbox('y');
    assert.equal((await rt.worker.intentState(row)).intent, 'Proposed');
    fail = false;
    clock.advance(61_000);
    await rt.worker.tick();
    clock.advance(61_000);
    await rt.worker.tick();
    assert.equal(calls, 1);
    const allowed = (await rt.chain('y')).find((e) => e.kind === 'verdict' && e.body.outcome === 'allowed').body;
    assert.equal(allowed.sseq, 2, 'the lost decision\'s sseq is not reused');
    const [s] = await replaySessions(rt);
    assert.ok(s.notRun.some((x) => /sseq 1 is missing/.test(x)), 'the gap is listed, not replayed past');
  } finally { await rt.close(); }
});

test('O7: a crash after the allow commits recovers through HandlerFailed under the same allow', { skip }, async () => {
  const a = await admitted('outage-o7', SOURCES);
  const { rt, clock } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    let calls = 0;
    handleWith(rt, 'stock.reserve', () => { calls++; return 'ok'; });
    const execute = rt.worker.execute.bind(rt.worker);
    let crashed = false;
    rt.worker.execute = (...x) => { if (!crashed) { crashed = true; return new Promise(() => {}); } return execute(...x); };
    await rt.create('orders.Order', { id: 'z' });
    await rt.dispatch('z', 'Reserve');
    void rt.worker.tick(); // the worker dies inside the attempt: it never returns
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(61_000);
    await rt.worker.tick(); // the lease expired: Running is HandlerFailed, and the retry waits its backoff
    clock.advance(61_000);
    await rt.worker.tick();
    assert.equal(calls, 1);
    const vs = (await rt.chain('z')).filter((e) => e.kind === 'verdict').map((e) => e.body.outcome);
    assert.equal(vs.filter((o) => o === 'allowed').length, 1, 'one allow, and the retry runs under it');
    const journal = (await rt.getJournal(`intent:${(await rt.outbox('z'))[0].intent_id}`)).map((r) => r.action);
    assert.ok(journal.includes('HandlerFailed') && journal.filter((x) => x === 'Start').length === 2, journal.join(' '));
  } finally { await rt.close(); }
});

test('O9: an approval while the keyring cannot be read is refused, and the escalation stays until it times out', { skip }, async () => {
  const a = await admitted('outage-o9', ['conformance/m5/switch.poly', 'conformance/m5/shop.poly', 'conformance/m5/shop-escalate.policy.poly']);
  const { rt, clock } = await loaded(a, { gate: { escalationTimeoutMs: 600_000 } });
  try {
    let calls = 0;
    handleWith(rt, 'till.charge', () => { calls++; return 'ok'; });
    await rt.create('shop.Till', { id: 't' });
    await rt.dispatch('t', 'Charge');
    await rt.worker.tick();
    const [row] = await rt.outbox('t');
    const poly = rt.verified.certificate.poly;
    const keyrings = poly.keyrings;
    Object.defineProperty(poly, 'keyrings', { get() { throw new Error('injected: the keyring is unavailable'); }, configurable: true });
    await assert.rejects(approveAs(rt, row.intent_id), (e) => e.name === 'ApprovalRefused' && /keyring cannot be read/.test(e.message));
    Object.defineProperty(poly, 'keyrings', { value: keyrings, configurable: true, writable: true });
    assert.equal((await rt.worker.intentState(row)).intent, 'Escalated');
    clock.advance(11 * 60_000);
    await rt.worker.tick();
    assert.equal((await rt.worker.intentState(row)).intent, 'Denied');
    assert.equal(calls, 0);
  } finally { await rt.close(); }
});

test('O10: the claims verifier is M5b\'s (PD5.1); its outage is tested there', { todo: 'M5b: claims-unverified before the module (PD5-A1)' }, () => {});
