// The workflow tools over poly-runtime (PT10, S164, S174, M8a step 2): polyflow's six MCP tools, with polyflow's names
// and schemas, served over a loaded runtime, so every work order an agent takes has crossed poly's gate and every report
// is journaled in poly's ledger (S173). Newline-delimited JSON-RPC 2.0 over stdio, with no SDK, as `poly mcp` and
// polyflow's own server are. The server serves no approve or accept tool: an escalated order waits for a person's
// signed approval, which never comes over MCP (PT12.5, S174). It knows no host.
import { createInterface } from 'node:readline';
import type { PolyRuntime, WorkOrder } from '@poly/runtime';

const PROTOCOL_VERSION = '2025-06-18';

// polyflow's output schemas (vendor/polyflow/src/tools.mjs), in its plain subset: no unions, no $ref, no `required`.
const obj = (properties: Record<string, unknown>, description?: string) => ({ type: 'object', properties, ...(description ? { description } : {}) });
const str = (description: string) => ({ type: 'string', description });

const WORK_ORDER = obj({
  order_id: str('pass this back to workflow_report'),
  tool: str('the tool to call'),
  target: str('what to call it against; absent when the tool needs no target'),
  args: { type: 'object', description: 'arguments for the call' },
  why: str('why this step exists'),
  attempt: { type: 'number', description: '1 on the first offer, higher after a retry' },
});

const RUN_VIEW = obj({
  instance: { type: 'string' },
  workflow: { type: 'string' },
  key: { type: 'string', description: 'the name identifying this run' },
  status: { type: 'string' },
  state: { type: 'object', description: 'the workflow-specific state tree' },
  done: { type: 'boolean' },
  already_complete: { type: 'boolean', description: 'present only when the run had already finished' },
  next: { type: 'array', items: WORK_ORDER, description: 'the work orders to carry out now' },
  waiting: str('present when the run is waiting on a timer or on a person'),
  note: { type: 'string' },
  key_note: { type: 'string' },
  error: str('present instead of a view when the call could not be applied'),
  hint: { type: 'string' },
  step_kind: str('workflow_signal only: accepted or rejected'),
  step_seq: { type: 'number', description: 'workflow_signal only: which step of the run this call became' },
  reason: str('workflow_signal only: why a step was rejected'),
}, 'the run as it stands, plus the work orders to carry out now');

/** Drop null and undefined fields: absent is representable in the schema subset, null is not. */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

export interface WorkflowTool { name: string; description: string; inputSchema: unknown; outputSchema: unknown; annotations: Record<string, boolean>; handler: (args: Record<string, any>) => Promise<Record<string, unknown>> }

/**
 * The six tools over a runtime. A call that writes (start, report, signal) takes every step that is due before it
 * answers, so its view is at rest. A read (list, state, journal) changes nothing, as polyflow keeps its reads pure; an
 * order past its deadline is not shown as open by a read, since the open orders are those within their deadline.
 */
export function workflowTools(rt: PolyRuntime): WorkflowTool[] {
  const READ = { readOnlyHint: true };
  const WRITE = { readOnlyHint: false, destructiveHint: false };
  const order = (o: WorkOrder) => compact({ order_id: o.orderId, tool: o.tool, target: o.target, args: o.args, why: o.why, attempt: o.attempt });
  const runView = async (instance: string, extra: Record<string, unknown> = {}) => {
    await rt.advance();
    const v = await rt.workflowView(instance);
    return compact({
      instance: v.instance, workflow: v.workflow, status: v.status, state: v.state, done: v.done, key: v.key,
      already_complete: v.done ? true : undefined,
      next: v.orders.map(order),
      waiting: !v.done && v.orders.length === 0 ? 'nothing to do right now: the run is waiting on a timer, or on a person\'s approval. Re-attach later.' : undefined,
      note: v.done ? 'this run is finished. Do NOT start another run of the same work under a different key: report what this one did.' : undefined,
      ...extra,
    });
  };
  // As polyflow's server: a refusal the tool returns ({ error }) is a view the agent reasons about; a call that throws
  // is answered with isError (polywatch on step 2).
  const guard = (f: (a: Record<string, any>) => Promise<Record<string, unknown>>) => (a: Record<string, any>) => f(a ?? {});
  return [
    {
      name: 'workflow_list', annotations: READ,
      description: 'List the workflows this agent can run, with the guarantees each was admitted under. Every work order of these runs crosses poly\'s gate.',
      inputSchema: obj({}),
      outputSchema: obj({ workflows: { type: 'array', description: 'the workflows this agent can run', items: obj({ name: { type: 'string' }, admitted: { type: 'boolean' }, guarantees: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, key: obj({ template: { type: 'string' }, derived_from: { type: 'array', items: { type: 'string' } } }) }) } }),
      handler: guard(async () => ({ workflows: rt.workflowList() })),
    },
    {
      name: 'workflow_start', annotations: { ...WRITE, idempotentHint: true },
      description: 'Start a run of a workflow, or re-attach to the run this input already names. The run key is derived from the input; any key you pass is ignored. A run that comes back finished is the answer: do not retry it under another name. Returns the first work order.',
      inputSchema: { type: 'object', required: ['workflow'], properties: { workflow: str('workflow name from workflow_list'), input: { type: 'object', description: 'data for the start action; it must carry the fields workflow_list names under key.derived_from' }, key: str('ignored: runs are identified by their derived key') } },
      outputSchema: RUN_VIEW,
      handler: guard(async ({ workflow, input, key }) => {
        const s = await rt.startWorkflow(String(workflow), (input ?? {}) as Record<string, unknown>, key === undefined ? undefined : String(key));
        return runView(s.instanceId, s.note ? { key_note: s.note } : {});
      }),
    },
    {
      name: 'workflow_report', annotations: { ...WRITE, idempotentHint: false },
      description: 'Report the result of a work order and receive the next one. ok:false is a failure to retry; ok:false with permanent:true is a result that is not a fault (the person declined), which takes the failure branch.',
      inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: str('order_id from the work order you fulfilled'), ok: { type: 'boolean', description: 'did the tool succeed (default true)' }, result: { type: 'object', description: 'the tool result; its fields become the completion action data' }, error: str('failure message when ok is false'), permanent: { type: 'boolean', description: 'true if this failure is a result, not a fault' } } },
      outputSchema: RUN_VIEW,
      handler: guard(async ({ order_id, ok = true, result = {}, error = '', permanent = false }) => {
        const id = String(order_id);
        const r = await rt.reportWorkOrder(id, { ok: Boolean(ok), result, error: String(error), permanent: Boolean(permanent) });
        if (r.status === 'refused') return { error: `order '${id}': ${r.reason}`, hint: 'take the open orders from workflow_state; a replaced or lapsed order is never credited' };
        return runView(rt.orderRun(id)!);
      }),
    },
    {
      name: 'workflow_state', annotations: READ,
      description: 'Current state and open work orders for a run, without changing anything.',
      inputSchema: { type: 'object', required: ['instance'], properties: { instance: str('instance id') } },
      outputSchema: RUN_VIEW,
      handler: guard(async ({ instance }) => {
        const v = await rt.workflowView(String(instance));
        return compact({ instance: v.instance, workflow: v.workflow, status: v.status, state: v.state, done: v.done, key: v.key, next: v.orders.map(order) });
      }),
    },
    {
      name: 'workflow_signal', annotations: { ...WRITE, idempotentHint: false },
      description: 'Send an event that did not come from a work order. A work order\'s completion is never accepted here: only the runtime delivers it, from the order\'s report (K9). An action that does not apply in the current state is an observable reject.',
      inputSchema: { type: 'object', required: ['instance', 'action'], properties: { instance: str('instance id'), action: str('action name from the contract'), data: { type: 'object', description: 'action data' } } },
      outputSchema: RUN_VIEW,
      handler: guard(async ({ instance, action, data = {} }) => {
        await rt.workflowView(String(instance));
        const step = await rt.dispatch(String(instance), String(action), data);
        return runView(String(instance), compact({ step_kind: step.stepKind, step_seq: step.seq, reason: step.rejectReason }));
      }),
    },
    {
      name: 'workflow_journal', annotations: READ,
      description: 'The full journal of a run: every step, accepted or rejected, with its reason.',
      inputSchema: { type: 'object', required: ['instance'], properties: { instance: str('instance id') } },
      outputSchema: obj({ journal: { type: 'array', description: 'every step of the run, accepted or rejected', items: obj({ seq: { type: 'number' }, action: { type: 'string' }, action_id: { type: 'string' }, step_kind: { type: 'string' }, reason: { type: 'string' }, post: { type: 'object' } }) } }),
      handler: guard(async ({ instance }) => {
        await rt.workflowView(String(instance));
        return { journal: (await rt.getJournal(String(instance))).map((r) => compact({ seq: r.seq, action: r.action, action_id: r.action_id, step_kind: r.step_kind, reason: r.reject_reason, post: r.post })) };
      }),
    },
  ];
}

interface Message { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export interface WorkflowServerOptions { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; version?: string }

/** Serves the six tools over stdio until the client closes it. One call at a time, in arrival order. */
export function serveWorkflows(rt: PolyRuntime, opts: WorkflowServerOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const tools = workflowTools(rt);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const write = (m: unknown) => stdout.write(JSON.stringify(m) + '\n');
  const reply = (id: Message['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: Message['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = async (msg: Message) => {
    const { id, method, params } = msg;
    if (id === undefined || id === null) return;
    switch (method) {
      case 'initialize': return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'poly-run', version: opts.version ?? '0.0.0' } });
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: tools.map(({ handler: _h, ...t }) => t) });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const t = byName.get(name);
        if (!t) return fail(id, -32602, `unknown tool ${name}`);
        try {
          const out = await t.handler((params?.arguments ?? {}) as Record<string, unknown>);
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: `${name}: ${(e as Error).message}` }], isError: true });
        }
      }
      default: return fail(id, -32601, `method not found: ${method}`);
    }
  };
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin });
    let chain: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      let msg: Message;
      try { msg = JSON.parse(line) as Message; } catch { fail(null, -32700, 'parse error'); return; }
      if (!msg || typeof msg !== 'object' || !msg.method) return; // a response is never answered
      if (msg.method === 'ping' && msg.id !== undefined && msg.id !== null) { reply(msg.id, {}); return; }
      chain = chain.then(() => handle(msg)).then(() => undefined, (e) => {
        process.stderr.write(`[poly run] ${(e as Error).stack ?? e}\n`);
        if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, `${msg.method}: ${(e as Error).message}`);
      });
    });
    rl.on('close', () => { void chain.then(resolve); });
  });
}
