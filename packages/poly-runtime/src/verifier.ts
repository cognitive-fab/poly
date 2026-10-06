// PD5.1.4, K11: the verifier adapter. The host supplies a function from the transport's credentials (an X.509 SVID,
// a JWT-SVID, a workload token, an attestation result, a person's signature) to a value of the action's claims type,
// or null when it refuses them. poly checks the adapter's output against the type (the module's first acceptor, PS3.2's
// claims row); it never checks the adapter's cryptography. That boundary is K11.
//
// S107: a person's signature is one such adapter. Its credentials are a signed record of kind `invocation` whose
// subject binds the one dispatch it authorises, and its output is { kind: Person, attest: Verified, assurance: 3,
// principal: <key owner> }. An agent key, an unknown key, a bad signature, or a record for another dispatch give null.
import { invocationSubject, verifyRecord, type Keyrings } from '@poly/core';

export interface VerifierContext { instance: string; action: string; data: unknown; actionId: string }

/** PS8.9, PD6.2: a mandate, as the verifier adapter gives it (K12): its scope a conjunction of finite constraints. */
export interface Mandate {
  id: string;
  delegator: string;
  delegate: string;
  scope: { actions?: string[]; values?: Record<string, (string | number | boolean)[]>; max?: Record<string, number> };
  /** The expiry, in milliseconds since the epoch, by the runtime's clock. */
  expires: number;
}

/** PS8.8, PS8.9: the evidence an adapter may give beside a step's claims: its times, and the mandate chain, outermost first. */
export interface Evidence { verifiedAt?: number; statusAt?: number; mandates?: Mandate[] }

const EVIDENCE = Symbol('poly evidence');

/** PD6: the claims an adapter returns, with their evidence beside them (never inside the claims, whose type is the program's). */
export function withEvidence<C extends Record<string, unknown>>(claims: C, evidence: Evidence): C {
  return Object.defineProperty({ ...claims }, EVIDENCE, { value: evidence, enumerable: false }) as C;
}

/** The evidence an adapter gave beside claims, or null. */
export function evidenceOf(claims: unknown): Evidence | null {
  return claims && typeof claims === 'object' ? ((claims as Record<symbol, Evidence>)[EVIDENCE] ?? null) : null;
}

/**
 * PS8.9, K12: why a mandate chain is refused, or null. Each hop narrows (its scope within its parent's, its expiry no
 * later, its delegator the parent's delegate), and none is revoked.
 */
export function chainProblem(chain: Mandate[], revoked: (id: string) => boolean): 'mandate-widened' | 'mandate-revoked' | null {
  if (chain.some((m) => revoked(m.id))) return 'mandate-revoked';
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i - 1];
    const c = chain[i];
    if (c.delegator !== p.delegate || c.expires > p.expires) return 'mandate-widened';
    if (p.scope.actions && (!c.scope.actions || !c.scope.actions.every((a) => p.scope.actions!.includes(a)))) return 'mandate-widened';
    for (const [f, vs] of Object.entries(p.scope.values ?? {})) if (!c.scope.values?.[f] || !c.scope.values[f].every((v) => vs.includes(v))) return 'mandate-widened';
    for (const [f, max] of Object.entries(p.scope.max ?? {})) if (c.scope.max?.[f] === undefined || c.scope.max[f] > max) return 'mandate-widened';
  }
  return null;
}

/** PS8.9: whether an effect of a kind, with a payload, at a time, is within a mandate's scope. */
export function withinScope(m: Mandate, kind: string, payload: Record<string, unknown>, now: number): boolean {
  if (now > m.expires) return false;
  if (m.scope.actions && !m.scope.actions.includes(kind)) return false;
  for (const [f, vs] of Object.entries(m.scope.values ?? {})) if (!vs.includes(payload[f] as string | number | boolean)) return false;
  for (const [f, max] of Object.entries(m.scope.max ?? {})) if (typeof payload[f] !== 'number' || (payload[f] as number) > max) return false;
  return true;
}
export type Verifier = (credentials: unknown, ctx: VerifierContext) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

/** S107: the person-key adapter over the certified keyrings. */
export function personKeyVerifier(keyrings: Keyrings): (credentials: unknown, ctx: VerifierContext) => Record<string, unknown> | null {
  return (credentials, ctx) => {
    if (credentials === undefined || credentials === null) return null;
    const subject = invocationSubject({ instance: ctx.instance, action: ctx.action, data: ctx.data ?? {}, actionId: ctx.actionId });
    const v = verifyRecord(credentials, keyrings, { kind: 'invocation', subject });
    return v.ok ? { kind: 'Person', attest: 'Verified', assurance: 3, principal: v.person.name } : null;
  };
}
