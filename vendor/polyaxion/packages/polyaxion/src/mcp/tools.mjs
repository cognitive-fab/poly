// The verbs as MCP tools (advisory mount). `declare` is offered only with
// opts.admin: the governed agent must not be able to rewrite its own gate
// (06 §3; AGCP CR-117).
//
// `gate` is anything implementing the engine interface (declare/merge/recall/
// journal/begin/status/replay/verifyChain) — the in-process engine or the HTTP
// client of the daemon. Handlers may be sync or async.
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const ACTION_SCHEMA = {
  type: 'object',
  description: 'A canonical action: {kind, ...fields}. Kinds: run.begin, run.end, shell, fs.read, fs.write, fs.delete, fs.rename, vcs.push, vcs.commit, http.request, mcp.call, agent.spawn, tool.call, message, log.write, process.run, package.install, custom.*',
  required: ['kind'],
  properties: { kind: { type: 'string' } },
  additionalProperties: true,
};

export function makeTools(gate, opts = {}) {
  const runIdOf = (args) => String(args.run_id ?? opts.defaultRunId ?? 'default');
  const tools = [
    {
      name: 'polyaxion_declare',
      description: 'Register (or replace) a policy of obligations: rules, machines, invariants, and recalled text. The policy is validated, compiled, admitted (unenforceable machines are refused with findings), hashed, and journaled. Operators call this once; agents normally do not.',
      inputSchema: {
        type: 'object', required: ['policy'],
        properties: {
          policy: { type: 'object', description: 'A polyaxion policy document (polyaxion: "1", id, scope, obligations[])' },
          replace: { type: 'boolean', description: 'replace an existing policy with the same id (default true)' },
          dryRun: { type: 'boolean', description: 'validate and admit without storing' },
        },
      },
      annotations: WRITE,
      handler: (args) => gate.declare(args),
    },
    {
      name: 'polyaxion_merge',
      description: 'Propose one or more actions and/or a state patch for this run. Returns allow, or deny with a witness per violated obligation (the concrete sequence and bindings). Deterministic; only allowed effects should execute. Call before any effectful step when no mandatory hook is mounted.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'run/session id (defaults to the server session)' },
          scope: { type: 'string', description: 'scope path for a new run, e.g. acme/payments (ignored for existing runs)' },
          action: ACTION_SCHEMA,
          actions: { type: 'array', items: ACTION_SCHEMA, description: 'a sequence of actions evaluated in order' },
          patch: { type: 'object', description: 'RFC 7386 merge patch on the run state vars' },
          meta: { type: 'object', description: 'free-form context recorded in the journal' },
        },
      },
      annotations: WRITE,
      handler: (args) => gate.merge({ ...args, run_id: runIdOf(args) }),
    },
    {
      name: 'polyaxion_recall',
      description: 'Return the active obligations for the current scope, fresh from the store — never summarized, never stale. Use after compaction, at task start, or whenever unsure what must hold. Includes each machine\'s current state.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          scope: { type: 'string', description: 'scope path (when no run exists yet)' },
          include: { type: 'string', enum: ['all', 'enforced', 'recalled'] },
        },
      },
      annotations: READ,
      handler: (args) => gate.recall({ ...args, run_id: args.run_id ?? opts.defaultRunId ?? undefined }),
    },
    {
      name: 'polyaxion_journal',
      description: 'Read the append-only verdict journal (every proposal, verdict, witness), verify its hash chain, or replay a run to prove the verdicts are reproducible.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          since: { type: 'number', description: 'return entries after this seq' },
          limit: { type: 'number' },
          decision: { type: 'string', enum: ['allow', 'deny', 'escalate'] },
          mode: { type: 'string', enum: ['read', 'verify', 'replay', 'sign', 'status'], description: 'default read' },
        },
      },
      annotations: READ,
      handler: async (args) => {
        const mode = args.mode ?? 'read';
        if (mode === 'verify') return gate.verifyChain(runIdOf(args));
        if (mode === 'replay') return gate.replay(runIdOf(args));
        if (mode === 'sign') return gate.sign({ run_id: runIdOf(args) });
        if (mode === 'status') return gate.status();
        return gate.journal(args);
      },
    },
  ];
  return opts.admin ? tools : tools.filter((t) => t.name !== 'polyaxion_declare');
}

export const INSTRUCTIONS = `polyaxion is the constraint plane for this session. Obligations (rules, state machines, invariants) live outside the context window and are enforced by a deterministic gate.
- Call polyaxion_recall at the start of a task and after any compaction to see the active obligations and machine states.
- When no mandatory hook is mounted, call polyaxion_merge with the canonical action before any effectful step; execute only if the verdict is allow.
- A deny carries a witness: the obligation, the bindings, and the sequence that violates it. Re-plan around that reason.`;
