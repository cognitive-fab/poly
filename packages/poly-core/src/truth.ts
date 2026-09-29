// The two truth types (PS8.0) and Kleene's strong three-valued logic (PS8.1).
//
// Machine expressions have type Bool. Policy expressions have type Tri,
// because the inputs a policy reads are optional. Policies are lowered from
// M5; the types and the rule table are fixed here so that the checker can
// refuse a Tri where a Bool is expected (PL1203) from the start.

export type Bool = boolean;
export type Tri = 'T' | 'F' | 'U';

export const tri = (b: boolean): Tri => (b ? 'T' : 'F');

export function triNot(a: Tri): Tri {
  return a === 'U' ? 'U' : a === 'T' ? 'F' : 'T';
}

export function triAnd(a: Tri, b: Tri): Tri {
  if (a === 'F' || b === 'F') return 'F';
  if (a === 'U' || b === 'U') return 'U';
  return 'T';
}

export function triOr(a: Tri, b: Tri): Tri {
  if (a === 'T' || b === 'T') return 'T';
  if (a === 'U' || b === 'U') return 'U';
  return 'F';
}

/** A comparison with an unknown operand is U (PS8.1); undefined stands for a missing value. */
export function triEq<T>(a: T | undefined, b: T | undefined): Tri {
  if (a === undefined || b === undefined) return 'U';
  return tri(a === b);
}

/** `unknown(x)` is T or F, never U (PS8.1). */
export function isUnknown<T>(x: T | undefined): Bool {
  return x === undefined;
}

export type Severity = 'deny' | 'warn' | 'escalate';
export type OnUnknown = 'escalate' | 'deny' | 'skip' | 'warn';
export type RuleOutcome = 'not-applicable' | 'satisfied' | Severity | 'skip';

/** The default for `on unknown` (PS8.2): escalate for deny rules, warn for warn rules. */
export function defaultOnUnknown(severity: Severity): OnUnknown {
  if (severity === 'deny') return 'escalate';
  if (severity === 'warn') return 'warn';
  return 'escalate';
}

/** The rule table of PS8.2: `when W require Q else s on unknown u`. */
export function ruleOutcome(W: Tri, Q: Tri, s: Severity, u: OnUnknown = defaultOnUnknown(s)): RuleOutcome {
  if (W === 'F') return 'not-applicable';
  if (W === 'U') return u;
  return Q === 'T' ? 'satisfied' : s; // an unknown value never satisfies a requirement
}
