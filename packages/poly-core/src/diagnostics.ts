// The diagnostic model (PT12): `poly.diagnostic/1`, the code catalogue, node-
// addressed fixes with preconditions, verdicts, exit codes and the fold.

export type Stage =
  | 'parse'
  | 'types'
  | 'lower'
  | 'validate'
  | 'translation-validation'
  | 'model-check'
  | 'effects'
  | 'composition'
  | 'configuration'
  | 'deadlock'
  | 'liveness'
  | 'lint'
  | 'policy'
  | 'runtime'
  | 'replay';

/** `error` refuses the program; `finding` is a defect in the program; `inconclusive` is a bound. */
export type DiagSeverity = 'error' | 'finding' | 'inconclusive' | 'warning';

interface CodeInfo {
  name: string;
  stage: Stage;
  severity: DiagSeverity;
}

// Every code M0 can emit, from PT12.2 and the codes added by S4, S9, S12 and
// S13 (docs/decisions-m0.md). A code missing here cannot be emitted: the
// constructor below throws, so a typo is caught in tests, not in the field.
export const CODES: Record<string, CodeInfo> = {
  PL0001: { name: 'SYNTAX', stage: 'parse', severity: 'error' },
  PL0201: { name: 'STALE_FIX', stage: 'parse', severity: 'error' },
  PL0301: { name: 'OUTSIDE_EMBEDDED_SUBSET', stage: 'parse', severity: 'error' },
  PL0901: { name: 'NOT_IN_MILESTONE', stage: 'types', severity: 'error' },
  PL1001: { name: 'UNKNOWN_NAME', stage: 'types', severity: 'error' },
  PL1002: { name: 'DUPLICATE_DECLARATION', stage: 'types', severity: 'error' },
  // S22: its fix is the qualified form Type.C.
  PL1005: { name: 'AMBIGUOUS_CONSTRUCTOR', stage: 'types', severity: 'error' },
  PL1101: { name: 'UNBOUNDED_DOMAIN', stage: 'types', severity: 'error' },
  PL1201: { name: 'TYPE_MISMATCH', stage: 'types', severity: 'error' },
  PL1202: { name: 'READ_OF_PRIMED_FIELD', stage: 'types', severity: 'error' },
  PL1203: { name: 'TRI_WHERE_BOOL_EXPECTED', stage: 'types', severity: 'error' },
  PL1204: { name: 'DIVISION_BY_ZERO', stage: 'types', severity: 'error' },
  PL1205: { name: 'CONFIDENCE_NOT_COMPARED', stage: 'types', severity: 'error' },
  // S101, S127: a reason the runtime uses (PS3.2), so a rejection always says who refused the step.
  // PD5.1.2b, S109: a Principal used other than by equality, storage or passing.
  PL1206: { name: 'PRINCIPAL_NOT_OPAQUE', stage: 'types', severity: 'error' },
  PL1209: { name: 'CONTENT_NOT_OPAQUE', stage: 'types', severity: 'error' },
  PL1207: { name: 'RESERVED_REJECT_REASON', stage: 'types', severity: 'error' },
  // M4 review D1: an effect kind with a prefix the toolchain generates (decision.*, outcome.*).
  PL1208: { name: 'RESERVED_NAME', stage: 'types', severity: 'error' },
  // PT3.4a: a finding a person must accept (PT12.5), not a refusal.
  PL1301: { name: 'DISCLOSED_IRREVERSIBLE_INPUT', stage: 'types', severity: 'finding' },
  // S53: an explicit strict on a parameter of an action with no handler; the runtime never runs the check.
  PL1302: { name: 'STRICT_ON_UNHANDLED_ACTION', stage: 'types', severity: 'error' },
  PL1401: { name: 'TERMINAL_NOT_ON_CONTROL_FIELD', stage: 'types', severity: 'error' },
  PL1501: { name: 'NON_EXHAUSTIVE_MATCH', stage: 'types', severity: 'error' },
  PL1502: { name: 'INCOMPLETE_MAP_LITERAL', stage: 'types', severity: 'error' },
  // S21: a misspelled constructor cannot become a silent catch-all.
  PL1503: { name: 'UNREACHABLE_ARM', stage: 'types', severity: 'error' },
  PL1504: { name: 'UNUSED_BINDER', stage: 'types', severity: 'error' },
  PL1601: { name: 'PAYLOAD_TYPE_CONFLICT', stage: 'types', severity: 'error' },
  PL1602: { name: 'ARRAY_MAP_NOT_ZERO_BASED', stage: 'types', severity: 'error' },
  // S37: a path property whose shape is not prefix-closed by construction (PS5.4).
  PL1701: { name: 'NOT_PREFIX_CLOSED', stage: 'types', severity: 'error' },
  PL2101: { name: 'WRITE_BEFORE_REQUIRE', stage: 'types', severity: 'error' },
  PL2102: { name: 'DOUBLE_WRITE', stage: 'types', severity: 'error' },
  // S20: addressed to the toolchain, like PL2501.
  PL2001: { name: 'STRICT_VALIDATE', stage: 'validate', severity: 'error' },
  // A handler path with no write, no effect and no rejection (PT4.4).
  PL2201: { name: 'SILENT_NOOP', stage: 'types', severity: 'error' },
  // PT6.3: two `after` statements with one key on one control path.
  PL2301: { name: 'DUPLICATE_TIMER_KEY', stage: 'types', severity: 'error' },
  PL2501: { name: 'LOWERING_MISMATCH', stage: 'translation-validation', severity: 'error' },
  PL3001: { name: 'INVARIANT_REACHABLE', stage: 'model-check', severity: 'finding' },
  PL3002: { name: 'STEP_PROPERTY', stage: 'model-check', severity: 'finding' },
  PL3003: { name: 'REJECT_PROPERTY', stage: 'model-check', severity: 'finding' },
  PL3102: { name: 'DOMAIN_ESCAPE', stage: 'model-check', severity: 'finding' },
  PL3201: { name: 'DEADLOCK', stage: 'deadlock', severity: 'finding' },
  // PS6.4: a fair cycle that never reaches the goal, with its lasso.
  PL3301: { name: 'LIVENESS_LASSO', stage: 'liveness', severity: 'finding' },
  PL3901: { name: 'BOUND_HIT', stage: 'model-check', severity: 'inconclusive' },
  PL4001: { name: 'PATH_PROPERTY', stage: 'effects', severity: 'finding' },
  // S33: an accepted step that emits and leaves the state unchanged.
  PL4002: { name: 'EMIT_WITHOUT_STATE_CHANGE', stage: 'effects', severity: 'finding' },
  // S40: polyrun refuses a manifest whose completion action is outside the lowered action surface.
  // PS7.3: a compose invariant violated in a reachable joint state.
  PL5001: { name: 'COMPOSE_INVARIANT', stage: 'composition', severity: 'finding' },
  // PS7.2: a spawn that re-uses the key of a live child (the kernel would make a second instance).
  PL5101: { name: 'CHILDKEY_COLLISION', stage: 'composition', severity: 'finding' },
  // S47: a cascade delivery reaches an action with no handler.
  PL5102: { name: 'UNHANDLED_CASCADE_DELIVERY', stage: 'composition', severity: 'finding' },
  // S48: a compose invariant reads children.k.f without a `k spawned` narrowing.
  PL5103: { name: 'CHILD_READ_WITHOUT_SPAWNED', stage: 'types', severity: 'error' },
  // S50: a signal to a child that is not spawned; the runtime halts the parent.
  PL5104: { name: 'SIGNAL_TO_ABSENT_CHILD', stage: 'composition', severity: 'finding' },
  // S66 (provisional): one step signals one child with one action twice; the kernel poisons the step.
  PL5105: { name: 'DUPLICATE_SIGNAL', stage: 'types', severity: 'error' },
  // PS7.2: a cascade deeper than 8.
  PL5201: { name: 'CASCADE_DEPTH', stage: 'composition', severity: 'finding' },
  // PS13.5: a configuration's bounds, reported, never silently applied.
  PL5301: { name: 'TRANSIT_BOUND_HIT', stage: 'configuration', severity: 'inconclusive' },
  PL5302: { name: 'INSTANCE_BOUND_HIT', stage: 'configuration', severity: 'inconclusive' },
  // S62: a configuration with no transit bound; the exploration need not end.
  PL5303: { name: 'CONFIGURATION_WITHOUT_BOUNDS', stage: 'types', severity: 'error' },
  // PS13.6: a configuration invariant violated in a reachable global state.
  PL5401: { name: 'CONFIGURATION_INVARIANT', stage: 'configuration', severity: 'finding' },
  // PS13.6: a quiescent global state in which a non-service instance is not terminal.
  PL5402: { name: 'STUCK', stage: 'configuration', severity: 'finding' },
  // PS13.6: a group read outside a quantifier or an aggregate.
  PL5403: { name: 'UNQUANTIFIED_GROUP', stage: 'types', severity: 'error' },
  // S29: a step inside a configuration sends to none.
  PL5404: { name: 'SEND_TO_NONE', stage: 'configuration', severity: 'finding' },
  PL5406: { name: 'RECEIPT_REJECTED', stage: 'configuration', severity: 'finding' },
  PL5407: { name: 'REPLY_REFUSED', stage: 'configuration', severity: 'finding' },
  PL6101: { name: 'COMPLETION_WITHOUT_HANDLER', stage: 'types', severity: 'error' },
  PL6401: { name: 'AMBIENT_EFFECT_IN_HANDLER', stage: 'lint', severity: 'error' },
  // S142: an import of a handler file that the certificate cannot name (no such file, outside the project, a URL).
  PL6402: { name: 'HANDLER_NOT_CERTIFIABLE', stage: 'lint', severity: 'error' },
  // S142: at load, a certified handler file (or the lockfile) whose bytes are not the certified bytes.
  PL6403: { name: 'HANDLER_CHANGED', stage: 'runtime', severity: 'error' },
  // S142: rt.handle given a function that is not an export of a certified handler file the runtime loaded.
  PL6404: { name: 'HANDLER_NOT_CERTIFIED', stage: 'runtime', severity: 'error' },
  // S134, S151: at run time, a capability call outside its declared bounds (a URL, a redirect hop, a secret name,
  // a command or a table), refused before the host transport and audited.
  PL6406: { name: 'CAPABILITY_REFUSED', stage: 'runtime', severity: 'error' },
  // PT8.4: Polyaxion refuses a policy at admission (not fully mediated, an example that fails, an unreachable discharge).
  PL6001: { name: 'NOT_FULLY_MEDIATED', stage: 'policy', severity: 'error' },
  // PT8.4, S161: polycheck reaches a forbidden region over the scope's effects with no gate crossed.
  PL7001: { name: 'REGION_WITNESS', stage: 'policy', severity: 'finding' },
  // PT8.5, PS8.6: a mandate no path discharges under the obligations together (the minimal subset is named).
  // PD5.2.3, S156: in a scope that requires attribution, a compensable or irreversible effect from an origin with no claims.
  PL6701: { name: 'UNATTRIBUTED_EFFECT', stage: 'policy', severity: 'finding' },
  // PT10, S166: a workflow whose input is not a handled action of its machine.
  PL6801: { name: 'WORKFLOW_INPUT', stage: 'types', severity: 'error' },
  // PT10, S166: a workflow key whose fields are not the input's parameters, whose pattern does not compile, or that refuses a declared value.
  PL6802: { name: 'WORKFLOW_KEY', stage: 'types', severity: 'error' },
  // PT10, S166: an effect kind with no tool or two, or a tool for a kind that is no effect of the machine.
  PL6803: { name: 'WORKFLOW_TOOLS', stage: 'types', severity: 'error' },
  // PT10, S172: a workflow whose machine declares no path property, which polyflow's admission cannot admit.
  PL6804: { name: 'WORKFLOW_UNCHECKED', stage: 'types', severity: 'error' },
  // PT21.1, PS15 (M8b): a channel's kind, thread key and binding of the conversation's Peer.
  PL6811: { name: 'CHANNEL_KIND_UNKNOWN', stage: 'types', severity: 'error' },
  PL6812: { name: 'THREAD_KEY_INVALID', stage: 'types', severity: 'error' },
  PL6813: { name: 'CHANNEL_BINDING_INCOMPLETE', stage: 'types', severity: 'error' },
  PL6814: { name: 'CHANNEL_BINDING_NOT_ONE_TO_ONE', stage: 'types', severity: 'error' },
  PL6815: { name: 'CHANNEL_BINDING_MISTYPED', stage: 'types', severity: 'error' },
  // PT10e, S203 (M9): an effect's `uses` against its credential and the credential's provider profile.
  PL6821: { name: 'SCOPE_NOT_DECLARED', stage: 'types', severity: 'error' },
  PL6822: { name: 'HOLDER_NOT_NAMED', stage: 'types', severity: 'error' },
  PL6823: { name: 'TARGET_OUTSIDE_PROVIDER', stage: 'types', severity: 'error' },
  // PT10g, PT22.5 (M9): a handler reads a header that carries a credential; a token-shaped string in poly.json.
  PL6824: { name: 'TOKEN_READ_IN_HANDLER', stage: 'lint', severity: 'error' },
  PL6825: { name: 'SECRET_IN_CONFIG', stage: 'runtime', severity: 'error' },
  // PT10f, S200 (M9): admission refuses the development keychain in a build for production.
  PL6826: { name: 'VAULT_NOT_FOR_PRODUCTION', stage: 'runtime', severity: 'error' },
  PL6501: { name: 'UNDISCHARGEABLE_MANDATE', stage: 'policy', severity: 'finding' },
  // S147: a machine("m.M") read no proposal can carry: the policy form of a vacuous property.
  PL6502: { name: 'UNKNOWABLE_MACHINE_READ', stage: 'policy', severity: 'finding' },
  // S149: a policy allows a proposal its own `never` statement forbids.
  PL6503: { name: 'NEVER_VIOLATED', stage: 'policy', severity: 'finding' },
  // S150: at load, a people or agents keyring that differs from the one the certificate binds.
  PL6405: { name: 'KEYRING_CHANGED', stage: 'runtime', severity: 'error' },
  PL6408: { name: 'ADAPTER_NOT_CERTIFIED', stage: 'runtime', severity: 'error' },
  // S194, Q8 (M9): a policy scope with no `policy` record by a person over its document, source and engine.
  PL6409: { name: 'POLICY_NOT_SIGNED', stage: 'runtime', severity: 'error' },
  // S194 (M9): rings not anchored, or changed without a keyring record by a key of the previous people ring.
  PL6410: { name: 'KEYRING_NOT_SIGNED', stage: 'runtime', severity: 'error' },
  PL6407: { name: 'TYPE_MODULE_CHANGED', stage: 'runtime', severity: 'error' },
  PL6201: { name: 'UNGATED_DECISION', stage: 'effects', severity: 'finding' },
  PL6202: { name: 'DECISION_WITHOUT_FAILURE', stage: 'types', severity: 'error' },
  // M4 review C5, K10: a send of an action that completes one of the receiver's decisions.
  PL6204: { name: 'DECISION_COMPLETION_SENT', stage: 'types', severity: 'error' },
  // S52: one action wired as a child completion or cancel and as an effect completion or a timer action.
  PL6102: { name: 'SHARED_COMPLETION_ACTION', stage: 'types', severity: 'error' },
  // PT6.2: outside a labelled scope an unlabelled effect is a finding.
  PL6301: { name: 'UNLABELLED_EFFECT', stage: 'types', severity: 'finding' },
  // PS8.4: in a scope whose obligations read labels or class, an effect with no labels (refused at admission).
  PL6302: { name: 'UNLABELLED_IN_LABELLED_SCOPE', stage: 'policy', severity: 'error' },
  // PT6.5, S151: a target whose capability the effect's labels do not grant.
  PL6303: { name: 'TARGET_NOT_GRANTED', stage: 'types', severity: 'error' },
  // S129: an accepted adjudication reachable without a preceding accepted ok completion of its decision.
  PL6203: { name: 'ADJUDICATION_WITHOUT_DECISION', stage: 'effects', severity: 'finding' },
  // S125: a fifo pair, which polyrun's parallel message worker cannot serve; refused at load.
  PL5405: { name: 'FIFO_WITHOUT_IN_ORDER_WORKER', stage: 'runtime', severity: 'error' },
  // PT9.7, S119: a worker state or transition that the OutboxIntent machine does not have, in the runtime's CI.
  PL2401: { name: 'RUNTIME_MODEL_DRIFT', stage: 'runtime', severity: 'finding' },
  // PS11.4, S131: a post-state that differs from the fold of the journal through the step.
  PL9001: { name: 'SPEC_DIVERGENCE', stage: 'replay', severity: 'finding' },
  // S131: a chain, a signed head or an anchor that does not verify.
  PL9002: { name: 'LEDGER_BROKEN', stage: 'replay', severity: 'finding' },
  // PD2.2d, S131: a decision completion with no decision event, or with data that differs from it.
  PL9003: { name: 'DECISION_PROVENANCE', stage: 'replay', severity: 'finding' },
};

export interface NodeAt {
  module?: string;
  machine?: string;
  node?: string;
  line?: number;
  col?: number;
}

export interface WitnessStep {
  pre: unknown;
  action: string;
  data: unknown;
  post: unknown;
  verdict?: string;
  /** The kinds of the step's intents, in order, when it emits (PS2.1). */
  effects?: string[];
  /** A global step of a configuration (PS13.3): an input or a delivery, at its instance. */
  global?: { kind: 'input' | 'deliver' | 'gate'; instance: string; text: string };
}

export interface Witness {
  id: string;
  length: number;
  trace: WitnessStep[];
  /** A liveness lasso (S74): the index in trace where the cycle begins; the trace is the prefix, then the cycle. */
  cycle?: number;
  /**
   * PS4.4, PS5.2a (S178): the witness takes a completion no earlier step asked for, or a message nothing sent. A
   * configuration that includes the machine confirms it or rules it out.
   */
  environment?: 'unconstrained';
}

/** A typed edit addressed to an AST node, applied only if the node still has digest `pre` (PT12.1). */
export interface Fix {
  id: string;
  pre: string;
  edit: Record<string, unknown>;
}

export interface Diagnostic {
  code: string;
  name: string;
  severity: DiagSeverity;
  stage: Stage;
  engine?: string;
  at: NodeAt;
  message: string;
  witness?: Witness;
  fixes?: Fix[];
  /** The property a finding is about (PL3001 to PL3003): results merge on it, never on message text. */
  property?: string;
  /** The field a finding is about (PL3102, PL3901). */
  field?: string;
  /** The names a fix needs (S70): the unread binder (PL1504), the types that declare an ambiguous constructor (PL1005). */
  names?: string[];
  /** `sha256:` of the state the finding names. */
  stateDigest?: string;
  /** A witness no exported test can judge yet: "no test export until M4" (ruling after the M2 review). */
  testExport?: string;
}

export function diag(code: string, at: NodeAt, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  const info = CODES[code];
  if (!info) throw new Error(`unknown diagnostic code ${code}`);
  return { code, name: info.name, severity: info.severity, stage: info.stage, at, message, ...extra };
}

/** The JSON form, schema `poly.diagnostic/1`. */
export function toJson(d: Diagnostic): Record<string, unknown> {
  return { schema: 'poly.diagnostic/1', ...d };
}

// ── Verdicts and exit codes (PT12.3) ──────────────────────────────────────

export type Verdict = 'CLEAN' | 'FINDINGS' | 'REFUSED' | 'UNDERPOWERED' | 'INCONCLUSIVE';

export const EXIT_CODES: Record<Verdict | 'NONDETERMINISM' | 'ERROR' | 'USAGE', number> = {
  CLEAN: 0,
  FINDINGS: 1,
  REFUSED: 2,
  UNDERPOWERED: 2,
  INCONCLUSIVE: 2,
  NONDETERMINISM: 3,
  ERROR: 4,
  USAGE: 64,
};

// The folding rule of 02 §5: the worst stage verdict, in the order
// REFUSED > FINDINGS > INCONCLUSIVE > UNDERPOWERED > CLEAN. A stage that did
// not run does not lower the verdict; it is listed as not run.
const RANK: Verdict[] = ['CLEAN', 'UNDERPOWERED', 'INCONCLUSIVE', 'FINDINGS', 'REFUSED'];

export function fold(verdicts: Verdict[]): Verdict {
  let worst: Verdict = 'CLEAN';
  for (const v of verdicts) if (RANK.indexOf(v) > RANK.indexOf(worst)) worst = v;
  return worst;
}

/** The verdict a set of diagnostics implies on its own. */
export function verdictOf(diags: Diagnostic[]): Verdict {
  return fold(
    diags.map((d) =>
      d.severity === 'error' ? 'REFUSED' : d.severity === 'finding' ? 'FINDINGS' : d.severity === 'inconclusive' ? 'INCONCLUSIVE' : 'CLEAN',
    ),
  );
}
