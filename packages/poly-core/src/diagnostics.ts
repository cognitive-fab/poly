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
  | 'deadlock';

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
  // PS7.2: a cascade deeper than 8.
  PL5201: { name: 'CASCADE_DEPTH', stage: 'composition', severity: 'finding' },
  // PS13.5: a configuration's bounds, reported, never silently applied.
  PL5301: { name: 'TRANSIT_BOUND_HIT', stage: 'configuration', severity: 'inconclusive' },
  PL5302: { name: 'INSTANCE_BOUND_HIT', stage: 'configuration', severity: 'inconclusive' },
  // PS13.6: a configuration invariant violated in a reachable global state.
  PL5401: { name: 'CONFIGURATION_INVARIANT', stage: 'configuration', severity: 'finding' },
  // PS13.6: a quiescent global state in which a non-service instance is not terminal.
  PL5402: { name: 'STUCK', stage: 'configuration', severity: 'finding' },
  // PS13.6: a group read outside a quantifier or an aggregate.
  PL5403: { name: 'UNQUANTIFIED_GROUP', stage: 'types', severity: 'error' },
  // S29: a step inside a configuration sends to none.
  PL5404: { name: 'SEND_TO_NONE', stage: 'configuration', severity: 'finding' },
  PL6101: { name: 'COMPLETION_WITHOUT_HANDLER', stage: 'types', severity: 'error' },
  // S52: one action wired as a child completion or cancel and as an effect completion or a timer action.
  PL6102: { name: 'SHARED_COMPLETION_ACTION', stage: 'types', severity: 'error' },
  // PT6.2: outside a labelled scope an unlabelled effect is a finding.
  PL6301: { name: 'UNLABELLED_EFFECT', stage: 'types', severity: 'finding' },
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
  global?: { kind: 'input' | 'deliver'; instance: string; text: string };
}

export interface Witness {
  id: string;
  length: number;
  trace: WitnessStep[];
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
  /** `sha256:` of the state the finding names. */
  stateDigest?: string;
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
