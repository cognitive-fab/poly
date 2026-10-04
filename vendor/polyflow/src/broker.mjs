// The inversion that makes polyflow work for agents.
//
// In polyrun, the runtime executes effects itself via `handlers`. polyflow has
// no credentials, no connectors and no permission engine — the AGENT has all
// three. So every effect kind becomes a **work order** handed back to the agent:
// the handler parks, the agent claims the order, runs the tool with its own
// gates, and reports the result. Only then does the completion action dispatch.
//
// Durability falls out of polyrun's lease machinery: the pending map is
// in-memory, so a crash loses the promise, the lease expires, the effect is
// re-claimed and the order is re-offered. Nothing is lost, nothing double-runs
// (the completion dispatch is deduped by `${intentId}:done`).

const OPEN = 'open';

/**
 * The broker contract, so a different one can be swapped in (polycrew's is
 * store-backed, shared across processes). Anything outside this file that
 * reaches into a broker's internals is a bug in this interface, not a
 * convenience:
 *
 *   handler(kind, spec)     a polyrun handler for that effect kind
 *   open(instanceId, opts)  the open work orders for one run
 *   orderById(orderId)      one order, whatever its status, or undefined
 *   issued(instanceId)      every order ever issued for one run
 *   report(orderId, result) resolve or reject the parked handler
 *   abort(reason)           fail every parked handler, for shutdown
 *
 * Three obligations that are easy to miss, because a substitute that ignores
 * them passes every fast test and only fails against a real agent:
 *
 *   1. `handler` MUST keep the worker lease alive for as long as it parks. The
 *      agent is the callback and may take turns, not milliseconds; a handler
 *      that never calls `ctx.extendLease` lets the lease expire, polyrun
 *      re-claims the effect, and the order is re-offered at a higher attempt
 *      WHILE THE FIRST ACTOR IS STILL WORKING IT. That is the duplicate
 *      execution this whole design exists to prevent.
 *
 *   2. `orderById` MUST return at least `{ orderId, instanceId }`. It is the
 *      only way a report gets from an order id back to its run, so it cannot
 *      be the same projection `open()` returns — that one drops `instanceId`
 *      deliberately, because the caller already knows the run.
 *
 *   3. `open` MUST be a pure read under `{ sweep: false }`, and its rows MUST
 *      carry `role`, `claimedBy` and `claimedUntil` beside the obvious fields:
 *      the run view and the crew's page both show them, and a substitute that
 *      omits them renders a busy run as if nobody held anything. `view()`
 *      always asks for the pure read, because `workflow_state` is annotated
 *      read-only and a broker repairing anything there would make it a tool
 *      that writes while advertising that it does not.
 *
 *   4. `report` and `abort` are AWAITED. Settling synchronously is fine and
 *      returning a promise is fine; what is not fine is a substitute whose
 *      caller reads `.ok` off an unawaited promise, which answers `{}` to
 *      every report while the run advances behind it.
 *
 *   5. `report` MUST resolve with an OBJECT.
 *
 *   6. `report` MAY answer `{ ok: true, deferred: true, hint }` when it has
 *      RECORDED the result but has nothing parked to deliver it to — a
 *      store-backed broker whose predecessor died holds the order row but not
 *      the promise. The caller then skips waiting for a completion step that
 *      is not coming. The alternative is losing a piece of work that was
 *      actually done, which is how a run ends up doing it twice. The resolved value becomes the
 *      completion action's data, and an action whose data is a bare string has
 *      no fields for the machine to read. Wrap a non-object as `{ value }`.
 *
 * A broker is owned by exactly one Polyflow: `abort` is unscoped by design, so
 * sharing one across two daemons means either can fail the other's parked
 * handlers. `Polyflow` claims its broker at construction and refuses a second.
 */
export class Broker {
  constructor({ heartbeatMs = 60_000 } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.orders = new Map();   // orderId -> order record
    this.pending = new Map();  // orderId -> { resolve, reject, timer }
  }

  /** A polyrun handler for `kind` that parks instead of executing. */
  handler(kind, spec = {}) {
    return (payload, intentId, ctx) => new Promise((resolve, reject) => {
      const order = {
        orderId: intentId,
        instanceId: ctx.instanceId,
        seq: ctx.seq,
        attempt: ctx.attempt,
        kind,
        tool: spec.tool ?? kind,
        target: spec.target ?? null,
        why: spec.why ?? '',
        args: payload ?? {},
        status: OPEN,
        issuedAt: Date.now(),
      };
      this.orders.set(order.orderId, order);
      // The agent is the callback and may take turns, not milliseconds. polyrun
      // calls this the second-class escape hatch; for a human-in-the-loop tool
      // it is the honest one. Heartbeat until reported.
      const timer = setInterval(() => {
        ctx.extendLease(this.heartbeatMs * 2).catch(() => {});
      }, this.heartbeatMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(order.orderId, { resolve, reject, timer });
    });
  }

  /** One order by id, whatever its status. Carries `instanceId` (contract 2). */
  orderById(orderId) { return this.orders.get(orderId); }

  /** Every order ever issued for one instance — introspection, not routing. */
  issued(instanceId) {
    return [...this.orders.values()].filter((o) => o.instanceId === instanceId);
  }

  /** Open work orders for one instance — what the agent must do next. */
  open(instanceId) {
    return [...this.orders.values()]
      .filter((o) => o.status === OPEN && o.instanceId === instanceId)
      .map(({ orderId, kind, tool, target, args, why, attempt }) =>
        ({ orderId, kind, tool, target, args, why, attempt }));
  }

  /**
   * The agent reports a tool result.
   *   ok:true              -> effect succeeded; onSuccess action dispatches
   *   ok:false             -> retryable failure (infrastructure)
   *   ok:false, permanent  -> a RESULT, not a fault (denied, declined) ->
   *                           onFailure action dispatches immediately
   */
  report(orderId, { ok = true, result = {}, error = '', permanent = false } = {}) {
    const order = this.orders.get(orderId);
    const waiter = this.pending.get(orderId);
    if (!order) return { ok: false, reason: 'unknown-order' };
    if (!waiter) {
      // Lease expired and the handler was re-entered, or the process restarted.
      return { ok: false, reason: 'order-expired', hint: 'call workflow_next again' };
    }
    clearInterval(waiter.timer);
    this.pending.delete(orderId);
    order.status = ok ? 'done' : 'failed';
    order.closedAt = Date.now();
    if (ok) waiter.resolve(result && typeof result === 'object' ? result : { value: result });
    else waiter.reject(Object.assign(new Error(error || 'tool failed'), { permanent }));
    return { ok: true };
  }

  /** Shutdown: fail every parked handler so the runtime's timers can drain.
   *  The effect rows stay inflight; a restart re-claims and re-offers them. */
  abort(reason = 'polyflow shutting down') {
    for (const [id, waiter] of this.pending) {
      clearInterval(waiter.timer);
      waiter.reject(new Error(reason));
      const order = this.orders.get(id);
      if (order) order.status = 'aborted';
    }
    this.pending.clear();
  }

  forget(instanceId) {
    for (const [id, o] of this.orders) if (o.instanceId === instanceId && o.status !== OPEN) this.orders.delete(id);
  }
}
