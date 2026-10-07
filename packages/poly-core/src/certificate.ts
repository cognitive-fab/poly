// The certificate (PT15, PF8.1, S126): what `poly admit` writes and what the runtime checks at load.
//
// It has the polyflow certificate's shape (v, subject, artefacts, guarantees, checks, domains, boundAccepted,
// toolchain, issuedAt, buildId, signatures, digest) with poly's own fields under `poly`. Its digest is the
// SHA-256 of the RFC 8785 canonical JSON of everything but `digest` and `signatures`, as polyflow's is, and a
// signature covers the fixed message `poly-certificate\n<digest>`, ed25519. Building, digesting, signing and
// verifying are here, pure apart from node:crypto; reading files is the caller's.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalize } from './jcs.js';

/** The artefacts of one machine's build directory that a certificate covers (PT17, S74). */
export const CERTIFIED_ARTEFACTS = ['contract.json', 'next.cjs', 'invariants.mjs', 'effects.cjs', 'effects.manifest.json', 'effect-invariants.mjs', 'invariants.compose.mjs', 'liveness.mjs', 'migrate.cjs', 'openshell.policies.yaml'] as const;

export interface CertifiedMachine {
  /** polyrun's machine id, `<module>.<Machine>`, which is also its build directory's name (PT1.5). */
  id: string;
  module: string;
  machine: string;
  /** The build directory, relative to the project root, with forward slashes. */
  dir: string;
}

export interface CertificateSignature { keyId: string; alg: 'ed25519'; sig: string }

export interface Certificate {
  v: 1;
  /** S139: a witness certificate, for an exported witness test only; the runtime refuses it unless allowWitness. */
  purpose?: 'witness';
  /** S139: the findings a witness certificate is issued for. */
  findings?: { code: string; property: string | null; subject: string; witness: string }[];
  subject: { kind: 'poly.program'; project: string; machines: CertifiedMachine[] };
  /** Every certified file by its path relative to the project root, as `sha256:<hex>` of its bytes. */
  artefacts: Record<string, string>;
  guarantees: string[];
  checks: { name: string; ok: true; engine: string; verdict: 'CLEAN' }[];
  domains: Record<string, string[]>;
  /** PT12.5: the findings a person accepted, each with its signed acceptance; null when none was. */
  boundAccepted: null | { code: string; property: string | null; subject: string; witness: string; by: string; record: string }[];
  toolchain: Record<string, string>;
  issuedAt: string;
  buildId: string;
  poly: {
    /** Each source file by path relative to the project root, and each module's AST digest (PT1.4). */
    sources: Record<string, string>;
    moduleDigests: Record<string, string>;
    /**
     * S190: each module whose enums a machine's build uses: its source file by path relative to the project root, or
     * `std:<path>` under the std root, never absolute; the SHA-256 of that file's bytes, which alone decides at load; and
     * its AST digest, which each contract records too. Absent when no build uses another module's types.
     */
    typeModules?: Record<string, { path: string; file: string; digest: string }>;
    /** The checked instance of each machine and configuration (PT12.3a). */
    instances: Record<string, unknown>;
    kernelAssumptions: string[];
    /** PD3.2b: per decision, its domain and labels; the model is never bound, the calibration map is configuration. */
    decisions: { machine: string; kind: string; provider: string; result: unknown; labels: string[]; modelBound: false; calibration: 'runtime configuration' }[];
    /** What this build's runtime does not do, printed with every verdict about it (S118, S134, S135). */
    limits: string[];
    /**
     * S142: the handlers the certificate binds. `files` holds each handler file poly.json names (`roots`) and every
     * file reached from them through relative imports, by path relative to the project root and SHA-256; `load`
     * refuses any difference, and `rt.handle` takes only exports of the roots as loaded. The lint ran over `files`.
     * S154: installed packages are named, and every file reached inside them and each package.json is hashed under
     * `packageFiles`; `lockfile` is the nearest lockfile and its digest.
     */
    handlers: {
      roots: string[];
      files: Record<string, string>;
      lint: { version: string; verdict: 'CLEAN' | 'FINDINGS' | 'not-run'; reason?: string };
      packages: string[];
      packageFiles: Record<string, string>;
      lockfile: { path: string; digest: string } | null;
    };
    /** PT8, S146: each trust scope's lowered policy document (its digest is under `artefacts`), and the machines it reads. */
    /** S194: each scope's `policy` record, by a person, over its document, source and engine. */
    policies: { scope: string; policies: string[]; path: string; reads: string[]; source?: string; sequence?: number; signature?: { v: 1; kind: string; subject: string; by: string; at: string; sig: string } }[];
    /**
     * PT10, S164, S175: each workflow, run on poly-runtime with every work order through the gate (S173). Its
     * descriptor's digest is under `artefacts`. Absent in a certificate with no workflow.
     */
    workflows?: { name: string; machine: string; runtime: 'poly-runtime'; gated: true; descriptor: string }[];
    /** PS15: each channel, its application's machine id and its descriptor, whose digest is under `artefacts`. */
    channels?: { name: string; application: string; descriptor: string }[];
    /** PT10e: each credential an effect uses, by name, and its descriptor, whose digest is under `artefacts`. */
    credentials?: { name: string; descriptor: string }[];
    /** PT10f, S200: each credential's vault: its store, and the adapter package by name, version and digest. */
    vaults?: { credential: string; store: 'dev-keychain' | 'kms'; package: string; version: string; digest: string }[];
    /** Plan step 9: the gate engine that decides this build's policies, pinned by commit (Polyaxion is a peer, S145). */
    policyEngine?: { name: 'polyaxion'; commit: string };
    /** S182, plan step 10: each channel's runtime adapter, bound by package name, version and digest. */
    adapters?: { channel: string; adapter: string; package: string; version: string; digest: string }[];
    /** PT12.5, S150: the keys that may sign approvals and acceptances (people), and those that never may (agents). */
    keyrings: { people: { name: string; keyId: string; publicKey: string }[]; agents: { name: string; keyId: string; publicKey: string }[] };
    /** S194: the anchor's digest and the digest of the last rings of the signed history; absent when no ring is kept. */
    keyringChain?: { anchor: string; head: string; source: 'user' | 'test' };
  };
  signatures: CertificateSignature[];
  digest: string;
}

export const sha256OfBytes = (bytes: Uint8Array | string): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Everything but `digest` and `signatures`, digested. */
export function certificateDigest(cert: Omit<Certificate, 'digest' | 'signatures'> & Partial<Pick<Certificate, 'digest' | 'signatures'>>): string {
  const { digest: _d, signatures: _s, ...body } = cert;
  return 'sha256:' + createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
}

/** The message a certificate signature covers. Fixed format. */
export const certificateMessage = (digest: string): string => `poly-certificate\n${digest}`;

/** The build id is a function of what was certified, never of when (as polyflow's). */
export function buildIdOf(artefacts: Record<string, string>, sources: Record<string, string>, toolchain: Record<string, string>): string {
  return 'cert-' + createHash('sha256').update(canonicalize({ artefacts, sources, toolchain }), 'utf8').digest('hex').slice(0, 12);
}

export function signDigest(digest: string, keyId: string, privateKeyPem: string): CertificateSignature {
  const sig = sign(null, Buffer.from(certificateMessage(digest), 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
  return { keyId, alg: 'ed25519', sig };
}

/** The public key of a private key, PEM, so a writer can check its own signature without a second key. */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

export interface CertificateProblem {
  name: string;
  problem: string;
  want?: string;
  have?: string;
}

/**
 * Every way a certificate fails to describe `actual` (path to digest) or to be vouched for by a trusted key.
 * Empty means: these files, this certificate, a trusted signature. `trust` maps a key id to a public key, PEM.
 */
export function certificateProblems(cert: Certificate, actual: Record<string, string>, trust: Record<string, string>): CertificateProblem[] {
  const problems: CertificateProblem[] = [];
  if (cert.v !== 1 || cert.subject?.kind !== 'poly.program') problems.push({ name: 'certificate', problem: 'not a poly certificate (v 1)' });
  if (certificateDigest(cert) !== cert.digest) problems.push({ name: 'certificate', problem: 'the certificate was edited after it was sealed', want: cert.digest, have: certificateDigest(cert) });
  for (const name of [...new Set([...Object.keys(cert.artefacts ?? {}), ...Object.keys(actual)])].sort()) {
    const want = cert.artefacts?.[name];
    const have = actual[name];
    if (want && !have) problems.push({ name, problem: 'certified but missing', want });
    else if (!want && have) problems.push({ name, problem: 'present but not certified', have });
    else if (want !== have) problems.push({ name, problem: 'changed since certification', want, have });
  }
  const sigs = Array.isArray(cert.signatures) ? cert.signatures : [];
  if (!sigs.length) problems.push({ name: 'signature', problem: 'the certificate is not signed' });
  let trusted = 0;
  for (const s of sigs) {
    const key = trust[s.keyId];
    if (!key) { problems.push({ name: 'signature', problem: `key ${s.keyId} is not trusted` }); continue; }
    let ok = false;
    try { ok = s.alg === 'ed25519' && verify(null, Buffer.from(certificateMessage(cert.digest), 'utf8'), createPublicKey(key), Buffer.from(s.sig, 'base64')); } catch { ok = false; }
    if (ok) trusted++;
    else problems.push({ name: 'signature', problem: `the signature by ${s.keyId} does not verify` });
  }
  if (sigs.length && !trusted && !problems.some((p) => p.name === 'signature')) problems.push({ name: 'signature', problem: 'no trusted signature' });
  return problems;
}
