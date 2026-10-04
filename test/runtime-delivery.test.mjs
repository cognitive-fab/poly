// M4c (PT9.8, K8, S124, S125): the runtime's delivery traces replay against the Delivery machine. polyrun's
// message worker is the parallel one, so the traces replay against `delivery-parallel.poly`.
//
// The abstraction function, from what the store and the kernel show to Delivery's actions, is written here and
// reads only observations, never the harness's intent:
//   Emit        a sendTo row appears, pending, at the sender's commit
//   Send        the row is claimed for the first time            Resend  any later claim
//   DeliverReq  the kernel is asked to dispatch the message to its receiver (a step, or a dedupe)
//   LoseReq     a claim ends, back to pending, with no dispatch since it was made (a crash before delivery)
//   LoseAck     a claim ends, back to pending, after a dispatch and with no mark (a crash before the mark)
//   DeliverAck  the row is marked done
//   Archive     the receiver is purged
// A row marked dead has no Delivery action: such a trace does not replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { buildMachine, initialState, transition, alphaData } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const DELIVERY = parse(readFileSync(join(ROOT, 'examples', 'delivery', 'delivery-parallel.poly'), 'utf8')).module;
const a = await admitted('delivery', ['conformance/m4/delivery-pair.poly']);
const LEASE = 60_000;

class Observer {
  constructor(rt, clock, sender, receiver) {
    Object.assign(this, { rt, clock, sender, receiver, trace: [], names: new Map(), last: new Map(), dispatched: new Map(), purged: false });
    const kernel = rt.kernel;
    const dispatch = kernel.dispatch.bind(kernel);
    kernel.dispatch = async (instanceId, action, data, actionId) => {
      if (!this.names.has(actionId)) return dispatch(instanceId, action, data, actionId);
      this.dispatched.set(actionId, (this.dispatched.get(actionId) ?? 0) + 1);
      try { return await dispatch(instanceId, action, data, actionId); } finally { await this.observe(); }
    };
    // Every change the store makes to an outbox row is read right after it, so no state between two of them is missed.
    for (const name of ['claimMessage', 'markEffectDone', 'markEffectRetry', 'markEffectDead']) {
      const original = rt.store[name].bind(rt.store);
      rt.store[name] = async (...args) => { try { return await original(...args); } finally { await this.observe(); } };
    }
  }
  async rows() { return (await this.rt.outbox(this.sender)).filter((r) => r.kind === 'sendTo'); }
  /** Reads the store and appends the Delivery actions its changes stand for. */
  async observe() {
    for (const row of await this.rows()) {
      if (!this.names.has(row.intent_id)) this.names.set(row.intent_id, `M${this.names.size + 1}`);
      const m = this.names.get(row.intent_id);
      const prev = this.last.get(row.intent_id) ?? { status: null, claimed: null, claims: 0, dispatchedAtClaim: 0 };
      const dispatched = this.dispatched.get(row.intent_id) ?? 0;
      const next = { ...prev, status: row.status, claimed: row.claimed_until };
      if (prev.status === null) this.trace.push(['Emit', m]);
      for (let k = (prev.dispatchSeen ?? 0); k < dispatched; k++) this.trace.push(['DeliverReq', m]);
      next.dispatchSeen = dispatched;
      if (row.status === 'inflight' && (prev.status !== 'inflight' || prev.claimed !== row.claimed_until)) {
        this.trace.push([next.claims === 0 ? 'Send' : 'Resend', m]);
        next.claims = prev.claims + 1;
        next.dispatchedAtClaim = dispatched;
      }
      if (prev.status === 'inflight' && row.status === 'pending') this.trace.push([dispatched > prev.dispatchedAtClaim ? 'LoseAck' : 'LoseReq', m]);
      if (row.status === 'done' && prev.status !== 'done') this.trace.push(['DeliverAck', m]);
      if (row.status === 'dead' && prev.status !== 'dead') this.trace.push(['Dead', m]);
      this.last.set(row.intent_id, next);
    }
    if (!this.purged && !(await this.rt.store.getInstance(this.receiver))) { this.purged = true; this.trace.push(['Archive']); }
  }
  id(m) { return [...this.names].find(([, v]) => v === m)[0]; }
}

/** The harness's moves; each is a real path of the runtime, and the observer reads what it did. */
async function setup() {
  const { rt, clock } = await loaded(a, { worker: { leaseMs: LEASE } });
  await rt.create('pair.Receiver', { id: 'r' });
  await rt.create('pair.Sender', { id: 's' });
  await rt.dispatch('s', 'Wire', { to: 'r' });
  const o = new Observer(rt, clock, 's', 'r');
  const moves = {
    emit: async (k) => { await rt.dispatch('s', `Send${k}`); },
    deliver: async (m) => { await rt.kernel.workers.deliverMessage(o.id(m), clock.now()); },
    claimAndCrash: async (m) => { await rt.store.claimMessage(o.id(m), clock.now(), LEASE); },
    deliverAndCrash: async (m) => {
      const mark = rt.store.markEffectDone;
      rt.store.markEffectDone = async () => { throw new Error('crash before the mark'); };
      try { await rt.kernel.workers.deliverMessage(o.id(m), clock.now()); } finally { rt.store.markEffectDone = mark; }
    },
    expire: async () => { clock.advance(LEASE + 1); await rt.recoverMessages(clock.now()); },
    archive: async () => { await rt.archive('r'); },
  };
  const step = async (name, ...args) => { await moves[name](...args); await o.observe(); };
  return { rt, o, step };
}

/** Replays an abstract trace through poly-ref's Delivery: every action accepted, at-most-once on every state. */
function replay(trace) {
  const M = buildMachine(DELIVERY, 'Delivery');
  let s = initialState(M);
  const out = [];
  for (const [action, m] of trace) {
    if (action === 'Dead') return { ok: false, at: out.length, reason: `${m} was dead-lettered, which no Delivery action stands for` };
    const r = transition(M, s, action, m ? alphaData({ m }, action, M) : {});
    if (r.verdict.kind !== 'accepted') return { ok: false, at: out.length, reason: `${action}(${m ?? ''}) is ${r.verdict.kind} ${r.verdict.reason ?? ''}` };
    s = r.next;
    out.push(action);
  }
  const steps = s.steps.entries.map(([, v]) => v);
  return { ok: steps.every((n) => n <= 1), state: s, steps };
}

async function receiverSteps(rt) {
  return (await rt.getJournal('r')).filter((row) => row.action === 'Got' && row.step_kind === 'accepted').length;
}

const TRACES = {
  'both delivered in order': async (step) => { await step('emit', 1); await step('emit', 2); await step('deliver', 'M1'); await step('deliver', 'M2'); },
  'M2 overtakes M1 (the parallel worker)': async (step) => { await step('emit', 1); await step('emit', 2); await step('deliver', 'M2'); await step('deliver', 'M1'); },
  'the request of M1 is lost, and M1 is sent again': async (step) => {
    await step('emit', 1); await step('emit', 2); await step('claimAndCrash', 'M1'); await step('deliver', 'M2'); await step('expire'); await step('deliver', 'M1');
  },
  'the acknowledgement of M2 is lost, and the duplicate is deduplicated': async (step) => {
    await step('emit', 1); await step('emit', 2); await step('deliver', 'M1'); await step('deliverAndCrash', 'M2'); await step('deliver', 'M2');
  },
};

for (const [name, drive] of Object.entries(TRACES)) {
  test(`M4c: ${name}`, async () => {
    const { rt, o, step } = await setup();
    try {
      await drive(step);
      const r = replay(o.trace);
      assert.equal(r.ok, true, `${JSON.stringify(o.trace)}: ${r.reason ?? 'at-most-once violated'}`);
      // The abstraction agrees with the receiver: Delivery's step count is the receiver's journal.
      assert.equal(r.steps.reduce((x, y) => x + y, 0), await receiverSteps(rt));
      assert.deepEqual(r.steps, [1, 1]);
    } finally { await rt.close(); }
  });
}

// K4 after an archive (S124): polyrun 8.3.2 deletes the dedupe keys with the journal, so a duplicate of M1 that
// arrives after the receiver is archived is dead-lettered and never acknowledged. Delivery has no action for
// that, so the trace does not replay. It runs, and it waits on E1 (tombstones), which makes it pass.
test('M4c across an archive: a late duplicate after the receiver is purged (K4)',
  { todo: 'waiting on E1 (polyrun tombstones at archive, S124): polyrun 8.3.2 dead-letters the duplicate' },
  async () => {
    const { rt, o, step } = await setup();
    try {
      await step('emit', 1); await step('emit', 2);
      await step('deliverAndCrash', 'M1'); await step('deliver', 'M2'); await step('archive');
      await step('deliver', 'M1');
      const r = replay(o.trace);
      assert.equal(r.ok, true, `${JSON.stringify(o.trace)}: ${r.reason ?? 'at-most-once violated'}`);
    } finally { await rt.close(); }
  });
