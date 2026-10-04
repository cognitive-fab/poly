// Signed heads, the anchor, archive with closure, export and verification of a run (PT16, S122, S123).
//
// Heads are signed off the step path: a remote signer cannot sign inside a transaction, so a signer pass signs
// the latest head of each run that moved since its last signature, periodically and at closure. A live run
// therefore verifies as `open-and-signed` through the seq its newest head covers, never as fully signed. The
// anchor is an RFC 6962 Merkle root over the latest signed heads of all runs, ordered by run, and signed: it
// proves that no run was dropped from the period.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { headMessage, verifyHead, type SignedHead } from '@cognitive-fab/polyflow-verify/sink';
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { canonical } from '@cognitive-fab/polyflow-kernel/canonical';
import type { JournalRow } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { lineageDigest, type LedgerStore } from './ledger-store.js';
import { verifyRunChain, type ChainResult, type LedgerEvent, type Run } from './ledger.js';

export type { SignedHead };

/** A signing key in process, or a remote signer that returns a base64 ed25519 signature of a message. */
export interface LedgerSigner {
  keyId: string;
  privateKeyPem?: string;
  sign?: (message: string) => Promise<string>;
}

const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS poly_head (
  run  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  head TEXT NOT NULL,
  PRIMARY KEY (run, seq)
);
CREATE TABLE IF NOT EXISTS poly_countersign (
  run    TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  hash   TEXT NOT NULL,
  scheme TEXT NOT NULL,
  sig    TEXT NOT NULL,
  PRIMARY KEY (run, seq, scheme)
);
CREATE TABLE IF NOT EXISTS poly_anchor (
  anchor_id INTEGER PRIMARY KEY AUTOINCREMENT,
  anchor    TEXT NOT NULL,
  heads     TEXT NOT NULL
);
`;

export function initJournalTables(store: LedgerStore): void { store.db.exec(JOURNAL_SCHEMA); }

async function signMessage(signer: LedgerSigner, message: string): Promise<string> {
  if (signer.sign) return signer.sign(message);
  if (!signer.privateKeyPem) throw new Error(`ledger signer ${signer.keyId} has neither a key nor a sign function`);
  return sign(null, Buffer.from(message, 'utf8'), createPrivateKey(signer.privateKeyPem)).toString('base64');
}

/** S123: signs the latest head of every run that moved since its last signature. Returns the heads signed. */
export async function signHeads(store: LedgerStore, signer: LedgerSigner, only?: string): Promise<SignedHead[]> {
  const rows = await store.txn(() => store.db.prepare(`
    SELECT l.run AS run, r.ns AS ns, r.wf AS wf, l.seq AS seq, l.hash AS hash
    FROM poly_ledger l JOIN poly_run r ON r.run = l.run
    WHERE l.seq = (SELECT MAX(seq) FROM poly_ledger WHERE run = l.run)
      AND l.seq > COALESCE((SELECT MAX(seq) FROM poly_head WHERE run = l.run), -1)
      ${only ? 'AND l.run = ?' : ''}
    ORDER BY l.run`).all(...(only ? [only] : [])));
  const out: SignedHead[] = [];
  for (const r of rows) {
    const run: Run = { ns: r.ns, wf: r.wf, run: r.run };
    const sig = await signMessage(signer, headMessage(run, { seq: r.seq, hash: r.hash }));
    const head: SignedHead = { run, seq: r.seq, hash: r.hash, keyId: signer.keyId, alg: 'ed25519', sig };
    await store.txn(() => store.db.prepare('INSERT OR IGNORE INTO poly_head (run, seq, head) VALUES (?, ?, ?)').run(r.run, r.seq, JSON.stringify(head)));
    out.push(head);
  }
  return out;
}

/**
 * PD5.4b, S108: a workload-identity countersignature. The host's adapter signs a signed head's hash with its own scheme
 * (an SVID, say), and checks one; the record is kept apart from the ed25519 head, which stays as it is.
 */
export interface CountersignAdapter {
  scheme: string;
  sign?: (hash: string) => Promise<string> | string;
  verify?: (hash: string, sig: string) => Promise<boolean> | boolean;
}
export interface Countersignature { run: string; seq: number; hash: string; scheme: string; sig: string }

/** Countersigns the latest signed head of every run that has none from this adapter's scheme yet. */
export async function countersignHeads(store: LedgerStore, adapter: CountersignAdapter): Promise<Countersignature[]> {
  if (!adapter.sign) throw new Error(`the countersignature adapter ${adapter.scheme} cannot sign`);
  const heads = await store.txn(() => store.db.prepare('SELECT head FROM poly_head h WHERE seq = (SELECT MAX(seq) FROM poly_head WHERE run = h.run) ORDER BY run').all().map((r) => JSON.parse(r.head) as SignedHead));
  const out: Countersignature[] = [];
  for (const h of heads) {
    const done = await store.txn(() => store.db.prepare('SELECT 1 FROM poly_countersign WHERE run = ? AND seq = ? AND scheme = ?').get(h.run.run, h.seq, adapter.scheme));
    if (done) continue;
    const c: Countersignature = { run: h.run.run, seq: h.seq, hash: h.hash, scheme: adapter.scheme, sig: await adapter.sign(h.hash) };
    await store.txn(() => store.db.prepare('INSERT INTO poly_countersign (run, seq, hash, scheme, sig) VALUES (?, ?, ?, ?, ?)').run(c.run, c.seq, c.hash, c.scheme, c.sig));
    out.push(c);
  }
  return out;
}

export async function countersignaturesOf(store: LedgerStore, run: string): Promise<Countersignature[]> {
  return store.txn(() => store.db.prepare('SELECT run, seq, hash, scheme, sig FROM poly_countersign WHERE run = ? ORDER BY seq').all(run) as Countersignature[]);
}

/**
 * PD5-A9: each countersignature names a signed head of the run, by seq and hash, and verifies through the adapter.
 * Without an adapter none is verified, and that is said (not run), never reported as ok.
 */
export async function verifyCountersignatures(rows: Countersignature[], heads: SignedHead[], adapter: CountersignAdapter | null): Promise<{ verified: number; notVerified: number; problems: string[] }> {
  const problems: string[] = [];
  let verified = 0;
  let notVerified = 0;
  for (const c of rows) {
    const h = heads.find((x) => x.seq === c.seq);
    if (!h || h.hash !== c.hash) { problems.push(`the countersignature at seq ${c.seq} names no signed head with its hash`); continue; }
    if (!adapter || adapter.scheme !== c.scheme || !adapter.verify) { notVerified++; continue; }
    let ok = false;
    try { ok = await adapter.verify(c.hash, c.sig); } catch { ok = false; }
    if (ok) verified++; else problems.push(`the ${c.scheme} countersignature at seq ${c.seq} does not verify`);
  }
  return { verified, notVerified, problems };
}

export async function headsOf(store: LedgerStore, instanceId: string): Promise<SignedHead[]> {
  return store.txn(() => store.db.prepare('SELECT head FROM poly_head WHERE run = ? ORDER BY seq').all(instanceId).map((r) => JSON.parse(r.head) as SignedHead));
}

// ── the anchor (RFC 6962 hashing) ─────────────────────────────────────────

const sha = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();

/** RFC 6962 §2.1: MTH over leaves; a leaf is 0x00 || data, a node 0x01 || left || right, split at the largest power of two below n. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return sha(Buffer.from([0]), leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha(Buffer.from([1]), merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

export interface Anchor {
  v: 1;
  period: { from: number; to: number };
  root: string;
  runs: number;
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

export const anchorMessage = (a: Pick<Anchor, 'root' | 'runs' | 'period'>): string => `poly-anchor\n${a.root}\n${a.runs}\n${a.period.from}\n${a.period.to}`;

const rootOf = (heads: SignedHead[]) => 'sha256:' + merkleRoot([...heads].sort((x, y) => (x.run.run < y.run.run ? -1 : x.run.run > y.run.run ? 1 : 0)).map((h) => Buffer.from(canonical(h), 'utf8'))).toString('hex');

/** S123: the latest signed head of every run, rooted and signed. Off the step path. */
export async function publishAnchor(store: LedgerStore, signer: LedgerSigner, period: { from: number; to: number }): Promise<{ anchor: Anchor; heads: SignedHead[] }> {
  const heads = await store.txn(() => store.db.prepare(`
    SELECT head FROM poly_head h WHERE seq = (SELECT MAX(seq) FROM poly_head WHERE run = h.run) ORDER BY run`).all().map((r) => JSON.parse(r.head) as SignedHead));
  const body = { root: rootOf(heads), runs: heads.length, period };
  const anchor: Anchor = { v: 1, ...body, keyId: signer.keyId, alg: 'ed25519', sig: await signMessage(signer, anchorMessage(body)) };
  await store.txn(() => store.db.prepare('INSERT INTO poly_anchor (anchor, heads) VALUES (?, ?)').run(JSON.stringify(anchor), JSON.stringify(heads)));
  return { anchor, heads };
}

/** An anchor verifies when its signature does and its root is the root of exactly these heads, each signed. */
export function verifyAnchor(anchor: Anchor, heads: SignedHead[], trust: Record<string, string>): string[] {
  const problems: string[] = [];
  const key = trust[anchor.keyId];
  let ok = false;
  try { ok = !!key && verify(null, Buffer.from(anchorMessage(anchor), 'utf8'), createPublicKey(key), Buffer.from(anchor.sig, 'base64')); } catch { ok = false; }
  if (!key) problems.push(`the anchor's key ${anchor.keyId} is not trusted`);
  else if (!ok) problems.push('the anchor signature does not verify');
  if (heads.length !== anchor.runs) problems.push(`the anchor covers ${anchor.runs} runs, and ${heads.length} heads are given`);
  if (rootOf(heads) !== anchor.root) problems.push('the heads given do not hash to the anchor root: a run was dropped, added or changed');
  for (const h of heads) { const v = verifyHead(h, trust); if (!v.ok) problems.push(`head of ${h.run.run} at ${h.seq}: ${v.reason}`); }
  return problems;
}

export async function anchors(store: LedgerStore): Promise<{ anchor: Anchor; heads: SignedHead[] }[]> {
  return store.txn(() => store.db.prepare('SELECT anchor, heads FROM poly_anchor ORDER BY anchor_id').all().map((r) => ({ anchor: JSON.parse(r.anchor), heads: JSON.parse(r.heads) })));
}

// ── verification of a run ───────────────────────────────────────────────────

export type RunVerdict = 'closed-and-signed' | 'open-and-signed' | 'open-unsigned' | 'not-ok';

export interface RunVerification {
  run: string;
  verdict: RunVerdict;
  chain: ChainResult;
  signedThrough: number | null;
  /** S123: events after the newest signed head of a live run; they are not vouched for yet. */
  unsignedTail: number;
  closed: boolean;
  problems: string[];
}

/**
 * The chain, the signed heads, the closure, and the binding of every step event to the journal row it records
 * (while the journal exists; after an archive the step events and the content store are what remains).
 */
export function verifyRun(events: LedgerEvent[], heads: SignedHead[], trust: Record<string, string>, journal: JournalRow[] | null, lineage: Map<number, { origin: unknown; intent: string; prev: string | null; digest: string }> | null = null): RunVerification {
  const run = events[0]?.run.run ?? '';
  const chain = verifyRunChain(events);
  const problems: string[] = [];
  if (!chain.ok) problems.push(`chain breaks at seq ${chain.seq}: ${chain.reason}`);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const good: number[] = [];
  for (const h of heads) {
    const v = verifyHead(h, trust);
    const anchored = bySeq.get(h.seq)?.hash === h.hash;
    if (!v.ok) problems.push(`head at seq ${h.seq}: ${v.reason}`);
    else if (!anchored) problems.push(`signed head at seq ${h.seq} does not match the event at that seq`);
    else good.push(h.seq);
  }
  const signedThrough = good.length ? Math.max(...good) : null;
  const last = events.length ? events[events.length - 1].seq : -1;
  const closed = events.some((e) => e.kind === 'closure');
  // Review B8, S122: the closure is the last event of a run.
  const closure = events.findIndex((e) => e.kind === 'closure');
  if (closure >= 0 && closure < events.length - 1) problems.push(`seq ${events[closure + 1].seq} follows the closure at seq ${events[closure].seq}`);
  if (closed && (signedThrough === null || signedThrough < last)) problems.push(`the run is closed and seq ${(signedThrough ?? -1) + 1}..${last} are not covered by a trusted signed head`);
  // Binding: every journal row has its step event, with the digests of its bodies (S122).
  if (journal) {
    const steps = events.filter((e) => e.kind === 'step');
    if (steps.length !== journal.length) problems.push(`the journal has ${journal.length} rows and the chain ${steps.length} step events`);
    for (const row of journal) {
      const s = steps.find((e) => (e.body as { seq: number }).seq === row.seq);
      const b = s?.body as Record<string, unknown> | undefined;
      if (!b) { problems.push(`journal row ${row.seq} has no step event`); continue; }
      // Review B9: the action id (K4's dedupe key) and the machine version are bound with the rest of the row.
      if (b.action !== row.action || b.actionId !== row.action_id || b.machineVersion !== row.machine_version || b.stepKind !== row.step_kind || (b.rejectReason ?? null) !== (row.reject_reason ?? null) || b.data !== digest(row.data) || b.pre !== digest(row.pre) || b.post !== digest(row.post)) {
        problems.push(`journal row ${row.seq} differs from its step event`);
      }
      // PD5-A11: the claims that admitted the step, and its lineage record, which recomputes.
      if (b.claims !== undefined && b.claims !== digest((row.data as { $claims?: unknown } | null)?.$claims ?? null)) problems.push(`journal row ${row.seq}: its claims differ from the step event's claims digest`);
      if (b.lineage !== undefined && lineage) {
        const l = lineage.get(row.seq);
        if (!l || l.digest !== b.lineage || lineageDigest(run, row.seq, l.origin, l.intent, l.prev) !== l.digest) problems.push(`journal row ${row.seq}: its lineage record does not match the step event's lineage digest`);
      }
    }
  }
  const verdict: RunVerdict = problems.length ? 'not-ok' : closed ? 'closed-and-signed' : signedThrough === null ? 'open-unsigned' : 'open-and-signed';
  return { run, verdict, chain, signedThrough, unsignedTail: Math.max(0, last - (signedThrough ?? -1)), closed, problems };
}

/**
 * Review B1: what `poly journal verify` requires of a run, beyond verifyRun. A run must be signed (a run with no
 * signed head is not vouched for, whatever deleted its heads), and the latest anchor must verify and cover the
 * run's latest signed head, so a run dropped, truncated or re-signed since is found. Each problem is PL9002.
 */
export function ledgerProblems(run: string, heads: SignedHead[], latestAnchor: { anchor: Anchor; heads: SignedHead[] } | null, trust: Record<string, string>): string[] {
  const problems: string[] = [];
  const good = heads.filter((h) => verifyHead(h, trust).ok);
  const newest = good.length ? good.reduce((x, y) => (y.seq > x.seq ? y : x)) : null;
  if (!newest) problems.push('no signed head vouches for the run');
  if (!latestAnchor) { problems.push(`no anchor covers ${run}`); return problems; }
  for (const p of verifyAnchor(latestAnchor.anchor, latestAnchor.heads, trust)) problems.push(`the latest anchor: ${p}`);
  const anchored = latestAnchor.heads.find((h) => h.run.run === run);
  if (!anchored) problems.push(`no anchor covers ${run}`);
  else if (newest && (anchored.seq !== newest.seq || anchored.hash !== newest.hash)) problems.push(`the latest anchor covers ${run} at seq ${anchored.seq}, and its latest signed head is at seq ${newest.seq}`);
  return problems;
}

/** A store opened for reading its ledger and journal only, with the types a tool outside the runtime needs. */
export interface JournalReader {
  runs(): Promise<Run[]>;
  chain(instanceId: string): Promise<LedgerEvent[]>;
  heads(instanceId: string): Promise<SignedHead[]>;
  /** The journal while the instance exists; null after an archive. */
  journal(instanceId: string): Promise<JournalRow[] | null>;
  body(digest: string): Promise<unknown>;
  /** The anchors published, oldest first. */
  anchors(): Promise<{ anchor: Anchor; heads: SignedHead[] }[]>;
  /** PD5-A9: the run's countersignatures. */
  countersignatures(instanceId: string): Promise<Countersignature[]>;
  /** PD5-A11: the run's lineage records, by seq. */
  lineage(instanceId: string): Promise<Map<number, { origin: unknown; intent: string; prev: string | null; digest: string }>>;
  close(): Promise<void>;
}

export function readerOf(store: LedgerStore): JournalReader {
  return {
    runs: () => store.runs(),
    chain: (id) => store.chain(id),
    heads: (id) => headsOf(store, id),
    journal: async (id) => ((await store.getInstance(id)) ? store.getJournal(id) : null),
    body: (d) => store.body(d),
    anchors: () => anchors(store),
    countersignatures: (id) => countersignaturesOf(store, id),
    lineage: async (id) => new Map((store.db.prepare('SELECT seq, origin, intent, prev, digest FROM poly_lineage WHERE run = ?').all(id) as { seq: number; origin: string; intent: string; prev: string | null; digest: string }[]).map((r) => [r.seq, { origin: JSON.parse(r.origin), intent: r.intent, prev: r.prev, digest: r.digest }])),
    close: () => store.close(),
  };
}
