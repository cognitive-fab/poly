// The polyflow daemon — a polyrun runtime whose effect handlers are the agent.
//
// Startup is the admission gate: every workflow in the library is exhaustively
// emission-checked before it is registered. A workflow that fails, or whose
// exploration was bounded, is NOT registered — it cannot be started at all.
// Nothing runs here on the strength of "it worked once".

import { createRuntime } from './polyrun.mjs';
import { Library, deriveKey } from './library.mjs';
import { Broker } from './broker.mjs';
import { Area } from './areas.mjs';

/**
 * Two effect specs a library may share a kind under. A WHOLE-object compare,
 * key order aside: descriptors are carried through unvalidated, so the moment a
 * spec grows a field this does not know about, a three-field comparison would
 * call two different specs identical and hand runs of one workflow the other's
 * work orders - the exact silent-wrong-answer the caller exists to refuse.
 */
const canon = (v) => (v === null || typeof v !== 'object' ? v
  : Array.isArray(v) ? v.map(canon)
    : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])));
const sameSpec = (a = {}, b = {}) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Marks the daemon that owns a broker, so a second one cannot share it. */
const OWNER = Symbol.for('polyflow.brokerOwner');

export class Polyflow {
  constructor({
    workflowsDir = 'workflows',
    dbPath = '.polyflow/polyflow.sqlite',
    agent = 'default',
    instance = 'default',
    leaseMs = 5 * 60_000,
    pollMs = 100,
    // polycrew supplies a store-backed broker shared across processes; the
    // default one keeps its parked handlers in this process's memory.
    broker = new Broker(),
  } = {}) {
    this.area = new Area({ agent, instance });
    this.library = new Library(workflowsDir);
    // `abort` fails EVERY parked handler by design, so two daemons sharing a
    // broker means either can fail the other's orders on shutdown — and for a
    // store-backed broker, write `aborted` into rows another session is
    // reading. One broker, one owner.
    if (broker[OWNER]) throw new Error('this broker already belongs to another Polyflow');
    broker[OWNER] = this;
    this.broker = broker;
    this.dbPath = dbPath;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.certificates = new Map();
    this.rt = null;
  }

  async start() {
    this.library.load();
    const machines = [];
    const handlers = {};
    const specs = new Map();   // effect kind -> the workflow that claimed it

    for (const wf of this.library.workflows.values()) {
      const cert = await this.library.certify(wf);
      this.certificates.set(wf.name, cert);
      if (!cert.ok) continue; // refused: not registered, cannot be started
      machines.push(this.library.machineSpec(wf));
      for (const [kind, spec] of Object.entries(wf.tools)) {
        // polyrun keys handlers by effect kind across the WHOLE runtime, but a
        // spec (tool, target, why) belongs to one workflow. Two workflows
        // declaring the same kind differently would silently overwrite each
        // other, and runs of the first would hand the agent work orders naming
        // the second's tool and target — wrong, with no error anywhere. So the
        // library is refused instead: same kind, same spec, or rename it.
        const prior = specs.get(kind);
        if (prior && !sameSpec(prior.spec, spec)) {
          throw new Error(
            `effect '${kind}' is declared differently by '${prior.workflow}' and '${wf.name}': `
            + `${JSON.stringify(prior.spec)} vs ${JSON.stringify(spec)}. `
            + 'Effect kinds are global to a library — rename one, or make the specs identical.'
          );
        }
        specs.set(kind, { workflow: wf.name, spec });
        handlers[kind] = this.broker.handler(kind, spec);
      }
    }

    this.rt = await createRuntime({
      store: { sqlite: this.dbPath },
      machines,
      handlers,
      worker: { leaseMs: this.leaseMs },
      poll: { effectPollMs: this.pollMs, timerPollMs: this.pollMs },
    });
    this.rt.startWorkers({ effectPollMs: this.pollMs, timerPollMs: this.pollMs });
    return this;
  }

  admitted(name) {
    const cert = this.certificates.get(name);
    return Boolean(cert && cert.ok);
  }

  catalog() {
    return this.library.list().map((w) => ({
      ...w,
      admitted: this.admitted(w.name),
      guarantees: this._guarantees(w.name),
    }));
  }

  // The invariant names are the sentences the user is actually approving.
  _guarantees(name) {
    return this.certificates.get(name)?.invariantNames ?? [];
  }

  /**
   * Start a run, or re-attach to the one this key already names.
   *
   * When the workflow declares a key policy the key is DERIVED from validated
   * input fields and whatever key the caller passed is ignored. That is what
   * stops an agent which finds a completed run from inventing a fresh key and
   * doing the job a second time (FINDINGS-phase3.md §6).
   */
  async begin(workflow, key, input = {}) {
    const wf = this.library.get(workflow);
    if (!wf) throw new Error(`unknown workflow '${workflow}'`);
    if (!this.admitted(workflow)) {
      const cert = this.certificates.get(workflow);
      throw new Error(
        `workflow '${workflow}' was refused by the admission gate and cannot be started:\n${cert?.report ?? 'no certificate'}`
      );
    }
    let note;
    if (wf.key) {
      const derived = deriveKey(wf.key, input);
      if (key && key !== derived) {
        note = `key '${key}' ignored: this workflow's runs are identified by ` +
               `${wf.key.template} = '${derived}', derived from the input you gave.`;
      }
      key = derived;
    } else if (!key) {
      throw Object.assign(new Error(`workflow '${workflow}' needs a key`), { expected: true });
    }
    const instanceId = this.area.instanceId(workflow, key);
    await this.rt.create(workflow, instanceId, { action: wf.inputAction, data: input });
    return { instanceId, key, note };
  }

  /** State + open work orders. The agent's only view of the run. */
  async view(instanceId) {
    const { state, status, seq, machineId } = await this.rt.getState(instanceId);
    // The pure read. workflow_state is annotated read-only, and a broker that
    // released lapsed claims here would quietly make it a writer. The writers
    // - claim, report, and the crew's offer list - do that repair.
    const orders = this.broker.open(instanceId, { sweep: false });
    return {
      instanceId, workflow: machineId, status, seq, state,
      orders,
      // 'active' is polyrun's live status; anything else (terminal, poisoned)
      // means the run is over regardless of what the state tree says.
      done: status !== 'active' || this._isTerminal(machineId, state),
      key: Area.parse(instanceId).key,
    };
  }

  _isTerminal(machineId, state) {
    const wf = this.library.get(machineId);
    if (!wf || !wf.terminal) return false;
    return wf.terminal.values.has(state[wf.terminal.key]);
  }

  report(orderId, payload) { return this.broker.report(orderId, payload); }

  /**
   * Wait for the run to come to rest after a report: the completion action is
   * dispatched by the worker loop, so the next work order appears a tick later.
   * Returns as soon as the journal advances past `sinceSeq` AND either an order
   * is open or the instance is terminal.
   */
  async settle(instanceId, { sinceSeq = -1, actionId = null, timeoutMs = 5000, stepMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // A bare seq watermark stops being enough once two actors share a run:
    // another session's completion can push the seq past it while this
    // caller's own step is still landing, and the view returned would be
    // about someone else's work. When the caller knows which step it is
    // waiting for, wait for THAT one.
    const landed = async () => (actionId
      ? Boolean(await this.rt.store.getJournalByActionId(instanceId, actionId))
      : true);

    let view = await this.view(instanceId);
    while (Date.now() < deadline) {
      if (view.seq > sinceSeq && (view.orders.length > 0 || view.done) && await landed()) return view;
      await new Promise((r) => setTimeout(r, stepMs));
      view = await this.view(instanceId);
    }
    return { ...view, settled: false };
  }

  /** An event that did not come from a work order (an out-of-band signal). */
  dispatch(instanceId, action, data = {}, actionId) {
    return this.rt.dispatch(instanceId, action, data, actionId);
  }

  /**
   * Every run of this area, newest first. polyrun lists instances per machine,
   * so this asks each admitted workflow and keeps what belongs to this area —
   * a second agent or a second project writing to the same file is a different
   * area, and none of its runs are ours to show.
   *
   * @param {{status?: string}} o  'active' for runs still in flight; omit for all
   */
  async runs({ status } = {}) {
    const mine = `${this.area}|`;
    const out = [];
    for (const name of this.library.workflows.keys()) {
      // NOT filtered by admission. A workflow edited until it fails the gate
      // cannot be STARTED any more, but its runs are still in flight with open
      // orders waiting on people, and hiding them is the opposite of what a
      // "what needs a person" view is for. They are marked instead.
      const admitted = this.admitted(name);
      for (const r of await this.rt.store.listInstances(name, status)) {
        if (!String(r.instance_id).startsWith(mine)) continue;
        out.push({
          instanceId: r.instance_id,
          workflow: name,
          key: Area.parse(r.instance_id).key,
          status: r.status,
          state: r.state,
          seq: r.seq,
          updatedAt: r.updated_at ?? null,
          admitted,
          done: r.status !== 'active' || this._isTerminal(name, r.state),
        });
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /** Timers armed on one run — what the machine is waiting for, and until when. */
  async timers(instanceId) {
    const rows = await this.rt.store.getTimers(instanceId);
    return rows
      .filter((r) => r.status === 'scheduled')
      .map((r) => ({ key: r.key, action: r.action, fireAt: r.fire_at, instanceId: r.instance_id }));
  }

  journal(instanceId) { return this.rt.getJournal(instanceId); }
  traces(instanceId) { return this.rt.exportTraces(instanceId); }

  /** Clean shutdown. A real crash skips all of this — the lease is what makes
   *  either path recoverable, so `drainMs` only reduces log noise. */
  async close({ drainMs = 50 } = {}) {
    // Released even when start() never ran, so a replacement Polyflow - an
    // in-process re-election, a restart after a library reload - can take the
    // same broker. The claim guards against two LIVE owners, not against reuse.
    if (this.broker?.[OWNER] === this) delete this.broker[OWNER];
    if (!this.rt) return;
    await this.broker.abort();
    if (drainMs) await new Promise((r) => setTimeout(r, drainMs));
    await this.rt.stopWorkers();
    await this.rt.close?.();
  }
}
