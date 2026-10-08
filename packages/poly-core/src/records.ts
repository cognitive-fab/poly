// Signed records (PT12.5, S150): an approval of an escalation, or the acceptance of a finding, signed by a person.
//
// A record is `{ v: 1, kind, subject, by, at, sig }`. Its digest is the SHA-256 of the RFC 8785 canonical JSON of
// everything but `sig`, and `sig` is ed25519 over the fixed message `poly-record\n<digest>`, so a record cannot be
// mistaken for a certificate signature (`poly-certificate\n…`). An approval's subject is the hash of the escalated
// `verdict` event, so one record lifts one escalation; an acceptance's subject is `<module digest>:<witness id>`.
// `at` is recorded, never trusted (S150). The keys are the project's `people` and `agents` keyrings, which admission
// certifies; an agent key never signs either kind (PT12.5). Pure apart from node:crypto.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalize } from './jcs.js';

/** `invocation` (PD5.1.4, S107): a person's signature on one dispatch, which the person-key adapter turns into claims. */
/** `keyring` (S194, M9): a person's signature on a change of the people or agents ring, over { parent, rings }. */
/** `policy` (S194, Q8, M9): a person's signature on a policy scope, over its document, source and engine. */
/** `grant-request` (S210, B3, D6): a person's signature on asking a holder for a grant, over { credential, holder }. */
export type RecordKind = 'approval' | 'acceptance' | 'invocation' | 'keyring' | 'policy' | 'revocation' | 'grant-request' | 'verify' | 'forget';

export interface SignedRecord {
  v: 1;
  kind: RecordKind;
  subject: string;
  /** The signing key's id, in the `people` keyring. */
  by: string;
  /** When the signer says it signed. Recorded, not trusted. */
  at: string;
  sig: string;
}

export interface KeyHolder { name: string; keyId: string; publicKey: string }
export interface Keyrings { people: KeyHolder[]; agents: KeyHolder[] }

export const EMPTY_KEYRINGS: Keyrings = { people: [], agents: [] };

export const recordMessage = (digest: string): string => `poly-record\n${digest}`;

export function recordDigest(r: Omit<SignedRecord, 'sig'> & { sig?: string }): string {
  const { sig: _s, ...body } = r;
  return 'sha256:' + createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
}

/** The subject of an invocation record: the digest of the one dispatch it authorises, its action id included. */
export function invocationSubject(x: { instance: string; action: string; data: unknown; actionId: string }): string {
  return 'sha256:' + createHash('sha256').update(canonicalize({ instance: x.instance, action: x.action, data: x.data ?? {}, actionId: x.actionId }), 'utf8').digest('hex');
}

export function signRecord(body: Omit<SignedRecord, 'sig' | 'v'>, privateKeyPem: string): SignedRecord {
  const r = { v: 1 as const, kind: body.kind, subject: body.subject, by: body.by, at: body.at };
  const sig = sign(null, Buffer.from(recordMessage(recordDigest(r)), 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
  return { ...r, sig };
}

/** The record verified against the certified keyrings, for the kind and subject the caller expects, or why not. */
export function verifyRecord(record: unknown, keyrings: Keyrings, expect: { kind: RecordKind; subject?: string }): { ok: true; person: KeyHolder; digest: string } | { ok: false; problem: string } {
  const r = record as Partial<SignedRecord> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, problem: 'not a signed record: an unsigned approval has no effect (PT12.5)' };
  const fields = Object.keys(r).sort().join(',');
  if (fields !== 'at,by,kind,sig,subject,v' || r.v !== 1 || typeof r.sig !== 'string' || typeof r.by !== 'string' || typeof r.subject !== 'string' || typeof r.at !== 'string') {
    return { ok: false, problem: 'not a signed record { v: 1, kind, subject, by, at, sig }: an unsigned approval has no effect (PT12.5)' };
  }
  if (r.kind !== expect.kind) return { ok: false, problem: `a ${r.kind} record, where a record of the kind ${expect.kind} is needed` };
  if (expect.subject !== undefined && r.subject !== expect.subject) return { ok: false, problem: `the record is for ${r.subject}, not for ${expect.subject}` };
  if (keyrings.agents.some((a) => a.keyId === r.by)) return { ok: false, problem: `${r.by} is an agent key, and an agent key never signs a record of the kind ${r.kind} (PT12.5)` };
  const person = keyrings.people.find((p) => p.keyId === r.by);
  if (!person) return { ok: false, problem: `${r.by} is not a key in the certified people keyring (PT12.5)` };
  const digest = recordDigest(r as SignedRecord);
  let ok = false;
  try { ok = verify(null, Buffer.from(recordMessage(digest), 'utf8'), createPublicKey(person.publicKey), Buffer.from(r.sig, 'base64')); } catch { ok = false; }
  if (!ok) return { ok: false, problem: `the signature by ${r.by} does not verify` };
  return { ok: true, person, digest };
}

/**
 * S194: the digest of a pair of rings, as admission certifies them: each holder's name, id and SPKI public key,
 * sorted by key id, under RFC 8785. Two spellings of one key give one digest.
 */
export function keyringDigest(k: Keyrings): string {
  const norm = (l: KeyHolder[]) => [...l].map((p) => ({ name: p.name, keyId: p.keyId, publicKey: createPublicKey(p.publicKey).export({ type: 'spki', format: 'pem' }).toString().trim() })).sort((x, y) => (x.keyId < y.keyId ? -1 : x.keyId > y.keyId ? 1 : 0));
  return 'sha256:' + createHash('sha256').update(canonicalize({ people: norm(k.people), agents: norm(k.agents) }), 'utf8').digest('hex');
}

/** S194, Q8: what a person signs for a policy scope. */
export interface PolicySubjectParts {
  scope: string;
  /** S210, D7: the scope's signature sequence, which the anchor keeps the highest admitted of, so no older one returns. */
  sequence: number;
  /** The digest of the scope's lowered document, the bytes the engine runs. */
  document: string;
  /** The digest of each source file that declares a policy of the scope, by its path in the project. */
  sources: Record<string, string>;
  engine: { name: string; commit: string };
}

/** S194, Q8: the subject of a policy record. */
export function policySubject(p: PolicySubjectParts): string {
  return 'sha256:' + createHash('sha256').update(canonicalize({ scope: p.scope, sequence: p.sequence, document: p.document, sources: p.sources, engine: { name: p.engine.name, commit: p.engine.commit } }), 'utf8').digest('hex');
}

/**
 * S194: the subject of a keyring record, binding the rings it admits to the rings it replaces; S210, D3: and to its
 * project, by the id of the project's anchor.
 */
export function keyringSubject(anchor: string, parent: string, rings: string): string {
  return 'sha256:' + createHash('sha256').update(canonicalize({ anchor, parent, rings }), 'utf8').digest('hex');
}

/** Keyrings compared as admission certifies them: the same holders, ids and public keys, in any order. */
export function sameKeyrings(a: Keyrings, b: Keyrings): boolean {
  const norm = (k: Keyrings) => canonicalize({
    people: [...k.people].map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey.trim() })).sort((x, y) => (x.keyId < y.keyId ? -1 : 1)),
    agents: [...k.agents].map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey.trim() })).sort((x, y) => (x.keyId < y.keyId ? -1 : 1)),
  });
  return norm(a) === norm(b);
}

/** PS16.4: what a person's revocation of a grant signs: the grant's instance id, whose holder part is a keyed digest. */
export function revocationSubject(grantId: string): string {
  return `sha256:${createHash('sha256').update(canonicalize({ grant: grantId }), 'utf8').digest('hex')}`;
}

/** PS17.5, S309: what a person signs to promote a memory item to verified: the item's id. */
export function memoryVerifySubject(item: string): string {
  return `sha256:${createHash('sha256').update(canonicalize({ item }), 'utf8').digest('hex')}`;
}

/** PS17.7, S306: what a person signs to forget a subject, a principal, or a whole source. */
export function forgetSubject(target: { subject: string } | { source: string }): string {
  return `sha256:${createHash('sha256').update(canonicalize('subject' in target ? { subject: target.subject } : { source: target.source }), 'utf8').digest('hex')}`;
}

/** S210, B3, D6: what a person signs to ask a holder for a grant of a credential (holder null for the service's own). */
export function grantRequestSubject(credential: string, holder: string | null): string {
  return `sha256:${createHash('sha256').update(canonicalize({ credential, holder }), 'utf8').digest('hex')}`;
}
