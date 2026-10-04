// The agent-facing surface. Six tools, one loop:
//
//   workflow_start  -> instance + first work order
//   workflow_report -> next work order, or done
//
// The agent never decides what comes next. It reasons about HOW to fulfil one
// order (which is where a model is actually good), runs the tool through its
// own permission gates, and reports the result. The order of operations, the
// retries, the timers and the terminal conditions are the machine's.

const str = (t, d) => ({ type: t, description: d });

// MCP tool annotations. Hosts with a per-server trust tier (Hermes' `untrusted`
// is one) prompt on every call that is not marked read-only, so a server that
// declines to say which of its tools are reads makes itself unusable there.
// Nothing here reaches the network: openWorldHint is false throughout.
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// Output schemas. Hosts that validate `structuredContent` against an advertised
// outputSchema (DeepSeek Harness does) fall back to unconstrained JSON when the
// schema uses vocabulary they do not support, so this stays in the plain
// subset: object/array/string/number/boolean, properties, items. No unions, no
// $ref, and no `required` — an error reply carries `error` instead of a view,
// and a schema that insisted on the view would reject it.
const obj = (properties, description) => ({ type: 'object', properties, description });

const WORK_ORDER = {
  type: 'object',
  properties: {
    order_id: { type: 'string', description: 'pass this back to workflow_report' },
    tool: { type: 'string', description: 'the tool to call' },
    target: { type: 'string', description: 'what to call it against; absent when the tool needs no target' },
    args: { type: 'object', description: 'arguments for the call' },
    why: { type: 'string', description: 'why this step exists' },
    attempt: { type: 'number', description: '1 on the first offer, higher after a retry' },
    // Present only when more than one actor can reach the run. A single-agent
    // run leaves all three absent, so its work orders read exactly as before.
    role: { type: 'string', description: 'the kind of participant this order is addressed to' },
    claimed_by: { type: 'string', description: 'the actor holding this order; absent means nobody' },
    claimed_until: { type: 'number', description: 'when that claim lapses if it is not renewed' },
  },
};

const RUN_VIEW = obj({
  instance: { type: 'string' },
  workflow: { type: 'string' },
  key: { type: 'string', description: 'the name identifying this run' },
  status: { type: 'string' },
  state: { type: 'object', description: 'the workflow-specific state tree' },
  done: { type: 'boolean' },
  already_complete: { type: 'boolean', description: 'present only when the run had already finished' },
  next: { type: 'array', items: WORK_ORDER, description: 'the work orders to carry out now' },
  waiting: { type: 'string', description: 'present when the run is waiting on a timer' },
  note: { type: 'string' },
  key_note: { type: 'string' },
  error: { type: 'string', description: 'present instead of a view when the call could not be applied' },
  hint: { type: 'string' },
  step_kind: { type: 'string', description: 'workflow_signal only: accepted or rejected' },
  step_seq: { type: 'number', description: 'workflow_signal only: which step of the run this call became' },
  reason: { type: 'string', description: 'workflow_signal only: why a step was rejected' },
}, 'the run as it stands, plus the work orders to carry out now');

/** Drop null and undefined fields: absent is representable in the schema subset, null is not. */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * The six tools. `extra` lets a layer above add its own — polycrew appends
 * claiming and the crew view — without forking this file or the server.
 */
export function makeTools(pf, extra = []) {
  const view = async (instanceId, sinceSeq, actionId = null) => {
    const v = sinceSeq === undefined
      ? await pf.view(instanceId)
      : await pf.settle(instanceId, { sinceSeq, actionId });
    return {
      instance: v.instanceId,
      workflow: v.workflow,
      status: v.status,
      state: v.state,
      done: v.done,
      key: v.key,
      already_complete: v.done ? true : undefined,
      next: v.orders.map((o) => compact({
        order_id: o.orderId,
        tool: o.tool,
        target: o.target,
        args: o.args,
        why: o.why,
        attempt: o.attempt,
        role: o.role,
        claimed_by: o.claimedBy,
        claimed_until: o.claimedUntil,
      })),
      waiting: !v.done && v.orders.length === 0
        ? 'nothing to do right now — the run is waiting on a timer. Re-attach later.'
        : undefined,
      note: v.done
        ? 'this run is finished. Do NOT start another run of the same work under a ' +
          'different key — report what this one did.'
        : undefined,
    };
  };
  const runView = async (...args) => compact(await view(...args));

  const tools = [
    {
      name: 'workflow_list',
      outputSchema: obj({
        workflows: {
          type: 'array',
          description: 'the workflows this agent can run',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              area: { type: 'string' },
              admitted: { type: 'boolean', description: 'false means it failed its check and cannot be started' },
              guarantees: { type: 'array', items: { type: 'string' }, description: 'the rules it was admitted under' },
              tools: { type: 'array', items: { type: 'string' } },
              key: obj({
                template: { type: 'string' },
                derived_from: { type: 'array', items: { type: 'string' } },
              }, 'how a run of this workflow is identified; absent when the caller names it'),
            },
          },
        },
      }),
      annotations: READ,
      description:
        'List the workflows this agent knows how to run, with the guarantees each one was ' +
        'admitted under. A workflow that failed its emission check is listed as admitted:false ' +
        'and cannot be started.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ workflows: pf.catalog().map(({ certified, ...w }) => compact(w)) }),
    },
    {
      name: 'workflow_start',
      outputSchema: RUN_VIEW,
      annotations: { ...WRITE, idempotentHint: true },
      description:
        'Start a run of a workflow, or re-attach to the run this input already names. Idempotent: ' +
        'calling it again for the same run returns the run in progress (or its finished state) ' +
        'rather than starting a second one — this is how a nightly automation picks up where it ' +
        'left off. Most workflows DERIVE the run identity from `input` (see the `key` field in ' +
        'workflow_list); for those, any `key` you pass is ignored. If a run comes back already ' +
        'finished, that is the answer — do not retry it under a different name. Returns the ' +
        'first work order.',
      inputSchema: {
        type: 'object',
        required: ['workflow'],
        properties: {
          workflow: str('string', 'workflow name from workflow_list'),
          input: {
            type: 'object',
            description: 'data for the start action. For a workflow that derives its run identity, '
              + 'this must carry the fields workflow_list names under `key.derived_from`.',
          },
          key: str('string',
            'only for workflows with no derived identity; ignored otherwise'),
        },
      },
      handler: async ({ workflow, key, input }) => {
        const started = await pf.begin(workflow, key ?? null, input ?? {});
        const v = await runView(started.instanceId, -1);
        return started.note ? { ...v, key_note: started.note } : v;
      },
    },
    {
      name: 'workflow_report',
      outputSchema: RUN_VIEW,
      annotations: { ...WRITE, idempotentHint: false },
      description:
        'Report the result of a work order and receive the next one. Set ok:false for an ' +
        'infrastructure failure (it will be retried). Set ok:false with permanent:true for a ' +
        'RESULT that is not a fault — the human denied it, the card declined — which advances ' +
        'the workflow down its failure branch instead of retrying.',
      inputSchema: {
        type: 'object',
        required: ['order_id'],
        properties: {
          order_id: str('string', 'order_id from the work order you fulfilled'),
          ok: { type: 'boolean', description: 'did the tool succeed (default true)' },
          result: { type: 'object', description: 'the tool result; its fields become the completion action data' },
          error: str('string', 'failure message when ok is false'),
          permanent: { type: 'boolean', description: 'true if this failure is a result, not a fault' },
        },
      },
      // `actor` is the second argument, never a schema field: a model that
      // could name the reporter could report as someone else. The host that
      // knows who is calling supplies it (polycrew does); on the single-agent
      // path it is undefined and the broker accepts an unclaimed order.
      handler: async ({ order_id, ok = true, result = {}, error = '', permanent = false }, actor) => {
        const order = pf.broker.orderById(order_id);
        if (!order) return { error: `unknown order '${order_id}'` };
        const before = (await pf.view(order.instanceId)).seq;
        // Awaited: a store-backed broker may answer asynchronously, and
        // reading .ok off a promise would report every failure as a success.
        const ack = await pf.report(order_id, { ok, result, error, permanent, actor });
        if (!ack.ok) return { error: ack.reason, hint: ack.hint };
        if (ack.deferred) {
          // The broker RECORDED the result but had nothing parked to deliver
          // it to — the process holding the handler is gone. The work is safe
          // and the engine will take it up when it re-offers the order, so
          // there is no completion step to wait for here.
          return { ...(await runView(order.instanceId)), note: ack.hint };
        }
        // Wait for THIS report's own step, not merely for the run to move:
        // with two actors on one run, someone else's completion can arrive
        // first and the view would describe their work rather than this call's.
        //
        // Only on success. A failure has three possible outcomes and two of
        // them journal nothing to wait for: a permanent one dispatches
        // `:failed`, an exhausted one `:exhausted`, and an ordinary one
        // schedules a RETRY that writes no row at all. Waiting for a step that
        // is never coming would stall every retry for the full timeout.
        return runView(order.instanceId, before, ok ? `${order_id}:done` : null);
      },
    },
    {
      name: 'workflow_state',
      outputSchema: RUN_VIEW,
      annotations: READ,
      description: 'Current state and open work orders for a run, without changing anything.',
      inputSchema: {
        type: 'object',
        required: ['instance'],
        properties: { instance: str('string', 'instance id') },
      },
      handler: async ({ instance }) => runView(instance),
    },
    {
      name: 'workflow_signal',
      outputSchema: RUN_VIEW,
      annotations: { ...WRITE, idempotentHint: false },
      description:
        'Send an event that did not come from a work order — an out-of-band cancel, or an ' +
        'approval that arrived through another surface. An action that does not apply in the ' +
        'current state is an observable reject, never an error.',
      inputSchema: {
        type: 'object',
        required: ['instance', 'action'],
        properties: {
          instance: str('string', 'instance id'),
          action: str('string', 'action name from the contract'),
          data: { type: 'object', description: 'action data' },
        },
      },
      handler: async ({ instance, action, data = {} }) => {
        const step = await pf.dispatch(instance, action, data);
        // `step_seq` locates this call's own row in the journal. A caller that
        // has to find it by reading back and matching the action name gets the
        // wrong row as soon as a second session signals the same action.
        return compact({
          step_kind: step.stepKind, step_seq: step.seq, reason: step.rejectReason,
          ...(await runView(instance)),
        });
      },
    },
    {
      name: 'workflow_journal',
      outputSchema: obj({
        journal: {
          type: 'array',
          description: 'every step of the run, accepted or rejected',
          items: {
            type: 'object',
            properties: {
              seq: { type: 'number' },
              action: { type: 'string' },
              action_id: {
                type: 'string',
                description: 'what caused this step, and the key the engine dedupes it by: '
                  + '$create for the run starting, <order_id>:done for a work order being '
                  + 'reported, timer:<id> for a timer firing, child:<instance>:complete for a '
                  + 'child finishing',
              },
              step_kind: { type: 'string', description: 'accepted or rejected' },
              reason: { type: 'string', description: 'why a step was rejected; absent when accepted' },
              post: { type: 'object', description: 'the state after the step' },
            },
          },
        },
      }),
      annotations: READ,
      description:
        'The full journal of a run: every step, accepted or rejected, with its reason. This is ' +
        'also a valid Polygraph trace corpus — the run can be audited against the machine later.',
      inputSchema: {
        type: 'object',
        required: ['instance'],
        properties: { instance: str('string', 'instance id') },
      },
      handler: async ({ instance }) => ({
        journal: (await pf.journal(instance)).map((r) => compact({
          seq: r.seq, action: r.action, action_id: r.action_id, step_kind: r.step_kind,
          reason: r.reject_reason ?? r.reason, post: r.post,
        })),
      }),
    },
  ];

  const builtIn = new Set(tools.map((t) => t.name));
  const names = new Set(builtIn);
  for (const t of extra) {
    if (names.has(t.name)) {
      // Two extras colliding is a bug in the layer above; blaming a built-in
      // sends the reader hunting through this file for one that isn't there.
      throw new Error(`extra tool '${t.name}' collides with `
        + (builtIn.has(t.name) ? 'a built-in' : 'another extra tool'));
    }
    names.add(t.name);
  }
  return [...tools, ...extra];
}
