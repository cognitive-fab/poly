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
