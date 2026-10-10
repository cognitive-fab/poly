// Memory at run time (PS17, M10): the taint of each body, kept in the content store's metadata by digest (PS17.4,
// S319), the item sets a retrieval returns (PS17.2), and the bodies a decision reads, resolved from the source only then
// (PF13.3). No item body, query value or credential enters the journal or the ledger (S310): a retrieval's record is its
// item set's reference and count, and a body a decision reads is kept in the erasable content store, with its taint.
import { createHash } from 'node:crypto';
import { canonical } from '@cognitive-fab/polyflow-kernel/canonical';
import type { LedgerStore } from './ledger-store.js';
import { canonicalize } from '@poly/core';
import type { EnvelopeAnswer, ItemRef, SourceAdapter } from './adapters.js';

/**
 * PS17.1: a class's index in the audience order, and the owners, principals as the runtime holds them, sorted. S326: a
 * retrieval with no owner predicate has the owners Ω, and keeps the owners of the items it returned in `k`, which only a
 * forget reads.
 */
export interface Taint { c: number; o: string[]; k?: string[] }
export const BOTTOM: Taint = { c: 0, o: [] };
/** S326: Ω, every principal: a mark no principal reads alone. */
export const OMEGA = '\u0000Ω';
const kept = (t: Taint): string[] => t.k ?? t.o.filter((x) => x !== OMEGA);
export const join = (a: Taint, b: Taint): Taint => {
  const omega = a.o.includes(OMEGA) || b.o.includes(OMEGA);
  const k = [...new Set([...kept(a), ...kept(b)])].sort();
  return { c: Math.max(a.c, b.c), o: omega ? [OMEGA] : k, ...(omega ? { k } : {}) };
};

/** PS17.0: a source's descriptor, as the build wrote it and admission certified it (PT10i); `credential` when it names one (S460). */
export interface SourceDescriptor { v: 1; module: string; source: string; kind: string; adapter: string | null; audience: string; class: number; owned: boolean; freshnessMs: number | null; stale: 'escalate' | 'deny'; credential?: string }
/** PS17.3: a module's flow descriptor (PT10i). */
export interface FlowDescriptor { v: 1; module: string; audience: string[]; sources: Record<string, { class: number; owned: boolean }>; claims?: Record<string, { class: string; principal: string | null }> }

/** PS17.3: whether a recipient of class c and principal p may read a taint. */
export const mayRead = (c: number, p: string | null, t: Taint): boolean => c > t.c || (c >= t.c && t.o.length === 0) || (t.o.length === 1 && t.o[0] !== OMEGA && p !== null && t.o[0] === p);

/** What the memory check of an intent gives: a final refusal, an escalation, or the proposal's fields; null when it has none. */
export type MemoryCheck = { deny: string } | { escalate: string; fields: ProposalMemory } | { fields: ProposalMemory } | null;
/** PT25.1: the proposal fields taint and items. */
export interface ProposalMemory { taint?: { class: string; owners: string[] }; items?: { count: number; class: string; ageMs: number; provenance: string } }

/** One item of a set: its id at the source, its owner and its asOf, and, for a memory item, its provenance. */
interface Item { id: string; owner: string | null; asOf: number; provenance?: string }

/** PS17.5: provenance, lowest first. */
const PROVENANCE = ['observed', 'derived', 'verified'];

/** A body's digest, as a Content is (PS1.4a). */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const isItems = (v: unknown): v is { ref: string; count: number } => !!v && typeof v === 'object' && typeof (v as { ref?: unknown }).ref === 'string' && (v as { ref: string }).ref.startsWith('items:');

/** A retrieval the source answered wrongly: it is refused, and retried no more (K14). */
export class SourceRefused extends Error {
  readonly permanent = true;
  constructor(message: string) { super(message); this.name = 'SourceRefused'; }
}

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS poly_taint (
  digest TEXT PRIMARY KEY,
  class  INTEGER NOT NULL,
  owners TEXT NOT NULL,
  kept   TEXT
);
CREATE TABLE IF NOT EXISTS poly_thread_sender (
  instance TEXT PRIMARY KEY,
  sender   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_memory (
  item       TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  digest     TEXT NOT NULL,
  subject    TEXT,
  provenance TEXT NOT NULL,
  class      INTEGER NOT NULL,
  run        TEXT NOT NULL,
  intent     TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_body_source (
  digest TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (digest, source)
);
CREATE TABLE IF NOT EXISTS poly_items (
  ref    TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  class  INTEGER NOT NULL,
  owners TEXT NOT NULL,
  kept   TEXT,
  asof   INTEGER,
  items  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_envelope (
  digest TEXT PRIMARY KEY,
  source TEXT NOT NULL
);
`;

/** PS17.6, S304: an answer that cites a reference it was not given; the decision's failed outcome runs instead. */
export class Uncited extends Error {
  readonly permanent = true;
  readonly reason = 'uncited';
  constructor(message: string) { super(message); this.name = 'Uncited'; }
}

export class Memory {
  readonly sources = new Map<string, SourceDescriptor>();
  readonly flows = new Map<string, FlowDescriptor>();
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor(private readonly store: LedgerStore, sources: SourceDescriptor[], flows: FlowDescriptor[]) {
    for (const s of sources) this.sources.set(s.source, s);
    for (const f of flows) this.flows.set(f.module, f);
  }

  /** PT26: binds a source's adapter, of the kind its descriptor names; the runtime checks it was made by the certified package. */
  connect(source: string, adapter: SourceAdapter): void {
    const d = this.sources.get(source);
    if (!d) throw new Error(`no source ${source} in the certified build`);
    if (d.kind === 'memory') throw new Error(`source ${source} is the project's memory, which the runtime keeps itself (PS17.5)`);
    if (adapter.kind !== d.adapter) throw new Error(`source ${source} declares the adapter ${d.adapter}, and was given a ${adapter.kind} adapter`);
    this.adapters.set(source, adapter);
  }

  /** The flow descriptor of the module a machine belongs to: its own, or, for a channel's conversation m.c.M, m's. */
  flowOf(machineId: string): FlowDescriptor | null {
    const parts = machineId.split('.');
    for (let n = parts.length - 1; n >= 1; n--) { const f = this.flows.get(parts.slice(0, n).join('.')); if (f) return f; }
    // PS17.4, review D1: the runtime applies the flow rule to every intent of a program with memory. A module with no
    // descriptor of its own has no source and no claims map; the program's one audience (PS1.4b) is every descriptor's.
    const any = this.flows.values().next().value as FlowDescriptor | undefined;
    return any ? { v: 1, module: parts.slice(0, -1).join('.'), audience: any.audience, sources: {}, claims: {} } : null;
  }

  /**
   * PT10k, PS17.3, PS17.6 (S302, S305, S307): the memory check of one intent, before the grant check and the policy. The
   * flow rule over each Content of its payload (a body with no taint record is refused, fail closed), the freshness of
   * each Items, and the proposal's fields taint and items.
   */
  check(i: { instance?: string; machineId: string; kind: string; payload: Record<string, unknown>; decl: any; step: { action: string | null; claims: Record<string, unknown> | null }; channelAudience: string | null; approved: boolean; now: number; keyed: (s: string) => string }): MemoryCheck {
    const flow = this.flowOf(i.machineId);
    if (!flow) return null;
    if (i.kind.startsWith('outcome.') || i.decl?.retrieve) return null;
    // PS17.5: a remember may not write an item with a wider audience than its content, over every class and principal.
    if (i.decl?.remember) {
      const src = this.sources.get(i.decl.remember.source as string);
      const subject = typeof i.payload[i.decl.remember.about] === 'string' ? (i.payload[i.decl.remember.about] as string) : null;
      // PS17.0, K14, review C4: an item of an owned source has one owner, so a remember with no subject is refused.
      if (src?.owned && subject === null) return { deny: 'audience' };
      const item: Taint = { c: src?.class ?? 0, o: src?.owned && subject !== null ? [subject] : [] };
      for (const v of Object.values(i.payload)) {
        if (typeof v !== 'string' || !DIGEST.test(v)) continue;
        const t = this.taintOf(v);
        if (!t) return { deny: 'audience' };
        const readers: (string | null)[] = [subject, '$other', null];
        if (flow.audience.some((_, c) => readers.some((p) => mayRead(c, p, item) && !mayRead(c, p, t)))) return { deny: 'audience' };
      }
      return null;
    }
    const name = (c: number) => flow.audience[c] ?? String(c);
    const fields: ProposalMemory = {};
    const contents = Object.values(i.payload).filter((v): v is string => typeof v === 'string' && DIGEST.test(v));
    const sets = Object.values(i.payload).filter(isItems);
    let escalate: string | null = null;
    // PS17.6, S307: each item set's age, by the runtime's clock now, against its source's freshness.
    if (sets.length) {
      let count = 0, cls = 0, age = 0, prov = PROVENANCE.length - 1;
      for (const v of sets) {
        const set = this.itemsOf(v.ref);
        if (!set) return { deny: 'audience' };
        const ageMs = set.asOf === null ? 0 : Math.max(0, i.now - set.asOf);
        count += set.items.length; cls = Math.max(cls, set.taint.c); age = Math.max(age, ageMs);
        for (const it of set.items) prov = Math.min(prov, PROVENANCE.indexOf(it.provenance ?? 'observed'));
        const src = this.sources.get(set.source);
        if (src && src.freshnessMs !== null && ageMs > src.freshnessMs) {
          if (src.stale === 'deny') return { deny: 'stale-items' };
          if (!i.approved) escalate = 'stale-items';
        }
      }
      // An empty item set holds nothing verified: its provenance is the lowest.
      fields.items = { count, class: name(cls), ageMs: age, provenance: PROVENANCE[count ? prov : 0] };
    }
    const shown = (o: string[]) => o.map((x) => (x === OMEGA ? 'Ω' : i.keyed(x)));
    // S323: a decision is proposed with the taint of what it reads, so a policy may deny it by effect.taint.class; it is
    // judged by the taint it gives its answer, not as a send (PS17.3).
    if (i.decl?.decision && (contents.length || sets.length)) {
      let joined = BOTTOM;
      for (const d of contents) { const t = this.taintOf(d); if (!t) return { deny: 'audience' }; joined = join(joined, t); }
      for (const v of sets) { const s = this.itemsOf(v.ref); if (s) joined = join(joined, s.taint); }
      fields.taint = { class: name(joined.c), owners: shown(joined.o) };
    }
    if (contents.length && !i.decl?.decision) {
      const to = i.decl?.recipient?.to as string | null | undefined;
      // PS17.4, S327: the recipient of a channel's send on a thread is the thread's sender.
      const principal = to && typeof i.payload[to] === 'string' ? (i.payload[to] as string) : i.kind.startsWith('channel.') && i.instance ? this.threadSender(i.instance) : null;
      const entry = i.step.action ? flow.claims?.[i.machineId.slice(i.machineId.lastIndexOf('.') + 1) + '.' + i.step.action] : undefined;
      // S324: the claims class is the recipient's only when the recipient is the claimant.
      const claimant = entry?.principal && i.step.claims && typeof i.step.claims[entry.principal] === 'string' ? (i.step.claims[entry.principal] as string) : null;
      const theClaimant = !to || (principal !== null && principal === claimant);
      const claimed = entry && theClaimant && i.step.claims && typeof i.step.claims[entry.class] === 'string' ? flow.audience.indexOf(i.step.claims[entry.class] as string) : -1;
      const declared = i.decl?.recipient?.audience ?? (i.kind.startsWith('channel.') ? i.channelAudience : null);
      const cls = claimed >= 0 ? claimed : declared ? Math.max(0, flow.audience.indexOf(declared)) : 0;
      let joined = BOTTOM;
      for (const d of contents) {
        const t = this.taintOf(d);
        if (!t || !mayRead(cls, principal, t)) return { deny: 'audience' };
        joined = join(joined, t);
      }
      fields.taint = { class: name(joined.c), owners: shown(joined.o) };
    }
    if (escalate) return { escalate, fields };
    return Object.keys(fields).length ? { fields } : null;
  }

  /** PS17.5: the project's memory, read as a source adapter reads its index. */
  private memoryAdapter(source: string): SourceAdapter {
    const db = this.store.db;
    return {
      kind: 'postgres',
      retrieve: async (q) => (q.owner !== undefined
        ? db.prepare('SELECT item, subject, at, provenance FROM poly_memory WHERE source = ? AND subject = ? ORDER BY at DESC, item LIMIT ?').all(source, q.owner, q.limit)
        : db.prepare('SELECT item, subject, at, provenance FROM poly_memory WHERE source = ? ORDER BY at DESC, item LIMIT ?').all(source, q.limit)).map((r: any) => ({ id: r.item, owner: r.subject, asOf: r.at, provenance: r.provenance })),
      resolve: async (id) => { const r = db.prepare('SELECT digest FROM poly_memory WHERE item = ?').get(id) as { digest: string } | undefined; return r ? this.body?.(r.digest) ?? null : null; },
      forget: async () => ({ removed: 0 }),
    };
  }

  /** How the memory reads a body from the content store; the runtime sets it. */
  body: ((d: string) => Promise<string | null>) | null = null;

  /**
   * PS17.5 (S309): a remember, run by the runtime: each Content of the payload becomes an item of the memory source, its
   * subject the about field's value, its taint the source's class and that subject, joined into the body's own.
   */
  async remember(spec: { source: string; provenance: string; about: string }, payload: Record<string, unknown>, run: string, intent: string, now: number): Promise<{ items: string[] }> {
    const d = this.sources.get(spec.source);
    if (!d || d.kind !== 'memory') throw new SourceRefused(`${spec.source} is no memory source`);
    const subject = typeof payload[spec.about] === 'string' ? (payload[spec.about] as string) : null;
    if (d.owned && subject === null) throw new SourceRefused(`${spec.source} is owned, and the remember names no subject (K14)`);
    const items: string[] = [];
    await this.store.txn(() => {
      for (const v of Object.values(payload)) {
        if (typeof v !== 'string' || !DIGEST.test(v)) continue;
        const item = `mem:${createHash('sha256').update(canonical({ intent, digest: v }), 'utf8').digest('hex')}`;
        this.store.db.prepare('INSERT OR IGNORE INTO poly_memory (item, source, digest, subject, provenance, class, run, intent, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(item, spec.source, v, subject, spec.provenance, d.class, run, intent, now);
        this.taint(v, { c: d.class, o: d.owned && subject !== null ? [subject] : [] });
        items.push(item);
      }
    });
    return { items };
  }

  /** PS17.5: a memory item's subject and provenance, or null. */
  memoryItem(item: string): { source: string; subject: string | null; provenance: string } | null {
    return (this.store.db.prepare('SELECT source, subject, provenance FROM poly_memory WHERE item = ?').get(item) as { source: string; subject: string | null; provenance: string } | undefined) ?? null;
  }

  /** PS17.5: an item made verified. Inside a transaction. */
  markVerified(item: string): void {
    this.store.db.prepare("UPDATE poly_memory SET provenance = 'verified' WHERE item = ?").run(item);
  }

  /**
   * PS17.7 (S306): what forgetting a subject or a source erases: every body whose taint names the subject among its owners
   * or that was read from the source, every memory item's body of either; and the item sets and memory items to remove.
   */
  forgettable(target: { subject: string } | { source: string }): { bodies: string[] } {
    const db = this.store.db;
    const bodies = new Set<string>();
    if ('subject' in target) {
      const names = this.subjectNames(target.subject);
      for (const r of db.prepare('SELECT digest, owners, kept FROM poly_taint').all() as { digest: string; owners: string; kept: string | null }[]) if ([...JSON.parse(r.owners), ...JSON.parse(r.kept ?? '[]')].some((x: string) => names.includes(x))) bodies.add(r.digest);
      for (const r of db.prepare('SELECT digest FROM poly_memory WHERE subject = ?').all(target.subject) as { digest: string }[]) bodies.add(r.digest);
    } else {
      for (const r of db.prepare('SELECT digest FROM poly_body_source WHERE source = ?').all(target.source) as { digest: string }[]) bodies.add(r.digest);
      for (const r of db.prepare('SELECT digest FROM poly_memory WHERE source = ?').all(target.source) as { digest: string }[]) bodies.add(r.digest);
    }
    return { bodies: [...bodies].sort() };
  }

  /** PS17.7: removes the item sets and memory items that name the subject or come from the source. Inside a transaction. */
  removeItems(target: { subject: string } | { source: string }): void {
    const db = this.store.db;
    if ('subject' in target) {
      db.prepare('DELETE FROM poly_memory WHERE subject = ?').run(target.subject);
      const names = this.subjectNames(target.subject);
      for (const r of db.prepare('SELECT ref, owners, kept FROM poly_items').all() as { ref: string; owners: string; kept: string | null }[]) if ([...JSON.parse(r.owners), ...JSON.parse(r.kept ?? '[]')].some((x: string) => names.includes(x))) db.prepare('DELETE FROM poly_items WHERE ref = ?').run(r.ref);
      for (const r of db.prepare('SELECT instance, sender FROM poly_thread_sender').all() as { instance: string; sender: string }[]) if (names.includes(r.sender)) db.prepare('DELETE FROM poly_thread_sender WHERE instance = ?').run(r.instance);
    } else {
      db.prepare('DELETE FROM poly_memory WHERE source = ?').run(target.source);
      db.prepare('DELETE FROM poly_items WHERE source = ?').run(target.source);
    }
  }

  /** S327: a subject as an owner may hold it: as given, and as the keyed digest a channel's sender is kept by. */
  private subjectNames(subject: string): string[] { return [subject, this.store.recipientDigest(subject)]; }

  /** S327: records a thread's sender, the principal its conversation's sends go to. Inside a transaction. */
  setThreadSender(instance: string, sender: string): void {
    this.store.db.prepare('INSERT INTO poly_thread_sender (instance, sender) VALUES (?, ?) ON CONFLICT(instance) DO UPDATE SET sender = excluded.sender').run(instance, sender);
  }

  /** S327: a thread's sender, or null. */
  threadSender(instance: string): string | null {
    return (this.store.db.prepare('SELECT sender FROM poly_thread_sender WHERE instance = ?').get(instance) as { sender: string } | undefined)?.sender ?? null;
  }

  /** Whether the certified build has the source. */
  hasSource(source: string): boolean { return this.sources.has(source); }

  /** Records that a body was read from a source (PS17.7). Inside a transaction. */
  fromSource(d: string, source: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO poly_body_source (digest, source) VALUES (?, ?)').run(d, source);
  }

  /** PS17.7, review C5: drops the taint records of erased bodies. Inside a transaction. */
  dropTaint(digests: string[]): void {
    for (const d of digests) this.store.db.prepare('DELETE FROM poly_taint WHERE digest = ?').run(d);
  }

  /** PS17.7: each connected adapter, to forget a subject at its source. */
  connected(): SourceAdapter[] { return [...this.adapters.values()]; }

  /** PS17.4: a body's taint, or null when the store holds no record of it. */
  taintOf(digest: string): Taint | null {
    const r = this.store.db.prepare('SELECT class, owners, kept FROM poly_taint WHERE digest = ?').get(digest) as { class: number; owners: string; kept: string | null } | undefined;
    return r ? { c: r.class, o: JSON.parse(r.owners) as string[], ...(r.kept !== null ? { k: JSON.parse(r.kept) as string[] } : {}) } : null;
  }

  /** PS17.4, S319: records a body's taint, joined with what the store already holds for it. Inside a transaction. */
  taint(digest: string, t: Taint): void {
    const t2 = join(this.taintOf(digest) ?? BOTTOM, t);
    this.store.db.prepare('INSERT INTO poly_taint (digest, class, owners, kept) VALUES (?, ?, ?, ?) ON CONFLICT(digest) DO UPDATE SET class = excluded.class, owners = excluded.owners, kept = excluded.kept').run(digest, t2.c, JSON.stringify(t2.o), t2.k ? JSON.stringify(t2.k) : null);
  }

  /** An item set's taint, source and items. */
  itemsOf(ref: string): { source: string; taint: Taint; asOf: number | null; items: Item[] } | null {
    const r = this.store.db.prepare('SELECT source, class, owners, kept, asof, items FROM poly_items WHERE ref = ?').get(ref) as { source: string; class: number; owners: string; kept: string | null; asof: number | null; items: string } | undefined;
    return r ? { source: r.source, taint: { c: r.class, o: JSON.parse(r.owners) as string[], ...(r.kept !== null ? { k: JSON.parse(r.kept) as string[] } : {}) }, asOf: r.asof, items: JSON.parse(r.items) as Item[] } : null;
  }

  private keepItems(source: string, items: Item[], salt: string, omega = false): { ref: string; count: number } {
    const d = this.sources.get(source)!;
    const ref = `items:${createHash('sha256').update(canonical({ source, salt, ids: items.map((i) => i.id) }), 'utf8').digest('hex')}`;
    const real = d.owned ? [...new Set(items.flatMap((i) => (i.owner === null ? [] : [i.owner])))].sort() : [];
    const asOf = items.length ? Math.min(...items.map((i) => i.asOf)) : null;
    // S326: with no owner predicate on an owned source the set's owners are Ω; the real ones are kept for a forget.
    this.store.db.prepare('INSERT OR IGNORE INTO poly_items (ref, source, class, owners, kept, asof, items) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ref, source, d.class, JSON.stringify(omega ? [OMEGA] : real), omega ? JSON.stringify(real) : null, asOf, JSON.stringify(items));
    return { ref, count: items.length };
  }

  /**
   * PS17.2: a retrieval, run by the runtime: the adapter's items by reference, kept as a set whose taint is the source's
   * class and its items' owners. With `where owner == p`, an item of another owner, or of none, is refused (K14). S451:
   * with `k == x`, an item whose key k is not x's value, or that carries no such key, is refused the same way; the key
   * narrows the items and never their taint.
   */
  async retrieve(source: string, spec: { owner: string | null; key?: { name: string; param: string }; limit: number }, payload: Record<string, unknown>, intent: string): Promise<{ items: { ref: string; count: number } }> {
    const d = this.sources.get(source);
    if (!d) throw new SourceRefused(`no source ${source} in the certified build`);
    const owner = spec.owner === null ? undefined : payload[spec.owner];
    if (spec.owner !== null && typeof owner !== 'string') throw new SourceRefused(`the retrieval from ${source} names no owner`);
    const key = spec.key ? { name: spec.key.name, value: payload[spec.key.param] } : undefined;
    if (key && (typeof key.value !== 'string' || key.value === '')) throw new SourceRefused(`the retrieval from ${source} names no ${key.name} key`);
    const adapter = d.kind === 'memory' ? this.memoryAdapter(source) : this.adapters.get(source);
    if (!adapter) throw new Error(`source ${source} has no adapter connected (PT26): connect one with rt.connectSource`);
    const got: (ItemRef & { provenance?: string })[] = await adapter.retrieve({ ...(owner !== undefined ? { owner: owner as string } : {}), ...(key ? { key: { name: key.name, value: key.value as string } } : {}), limit: spec.limit });
    if (!Array.isArray(got) || got.length > spec.limit) throw new SourceRefused(`source ${source} answered ${Array.isArray(got) ? got.length : 'no list of'} items for a limit of ${spec.limit} (K14)`);
    const items: Item[] = [];
    for (const i of got) {
      if (!i || typeof i.id !== 'string' || !Number.isFinite(i.asOf)) throw new SourceRefused(`source ${source} answered an item with no id or asOf (K14)`);
      if (d.owned && typeof i.owner !== 'string') throw new SourceRefused(`source ${source} is owned, and answered an item with no owner (K14)`);
      if (owner !== undefined && i.owner !== owner) throw new SourceRefused(`source ${source} answered an item of another owner for a retrieval by owner (K14)`);
      if (key && (!i.keys || typeof i.keys !== 'object' || i.keys[key.name] !== key.value)) throw new SourceRefused(`source ${source} answered an item whose ${key.name} key is not the one asked for a retrieval by key (K14, S451)`);
      items.push({ id: i.id, owner: d.owned ? i.owner : null, asOf: i.asOf, ...(i.provenance ? { provenance: i.provenance } : {}) });
    }
    let ref!: { ref: string; count: number };
    await this.store.txn(() => { ref = this.keepItems(source, items, intent, d.owned && spec.owner === null); });
    return { items: ref };
  }

  /**
   * PS17.2, PT10j (S459): an envelope retrieval, run by the runtime. The adapter gives the envelope of a reply to the
   * newest item with the key's value (and the owner's, with `where owner == p`). Each wrong answer is refused, and
   * retried no more: an adapter with no envelope method, an answer of another owner or of none on an owned source
   * (K14), a `to` that is empty, a value holding CR or LF (a header written into another), a `references` that is no
   * list of strings. null fails the retrieval and may be retried: the item may not be there yet. The body is the RFC
   * 8785 canonical JSON of the envelope, kept erasable with the taint a retrieval of the source with the same owner
   * predicate has, and its digest is recorded as an envelope of the source, which the origin check reads (PS17.3a).
   */
  async envelope(source: string, spec: { owner: string | null; key: { name: string; param: string } }, payload: Record<string, unknown>): Promise<{ envelope: string }> {
    const d = this.sources.get(source);
    if (!d) throw new SourceRefused(`no source ${source} in the certified build`);
    const owner = spec.owner === null ? undefined : payload[spec.owner];
    if (spec.owner !== null && typeof owner !== 'string') throw new SourceRefused(`the envelope retrieval from ${source} names no owner`);
    const value = spec.key ? payload[spec.key.param] : undefined;
    if (typeof value !== 'string' || value === '') throw new SourceRefused(`the envelope retrieval from ${source} names no ${spec.key?.name ?? ''} key (S459)`);
    // PS17.0: the project's memory names no adapter and gives no envelope.
    const adapter = d.kind === 'memory' ? null : this.adapters.get(source);
    if (d.kind !== 'memory' && !adapter) throw new Error(`source ${source} has no adapter connected (PT26): connect one with rt.connectSource`);
    if (!adapter || typeof adapter.envelope !== 'function') throw new SourceRefused(`source ${source}'s adapter gives no envelope (S459)`);
    const got: EnvelopeAnswer | null = await adapter.envelope({ ...(owner !== undefined ? { owner: owner as string } : {}), key: { name: spec.key.name, value } });
    // PT10j: null fails the retrieval, its failed completion, as for any refusal: with no item there is no reply to address.
    if (got === null) throw new SourceRefused(`source ${source} holds no item whose ${spec.key.name} key is the one asked, so there is no envelope (S459)`);
    if (!got || typeof got !== 'object' || typeof got.id !== 'string' || !Number.isFinite(got.asOf)) throw new SourceRefused(`source ${source} answered an envelope with no id or asOf (K14)`);
    if (d.owned && typeof got.owner !== 'string') throw new SourceRefused(`source ${source} is owned, and answered an envelope of no owner (K14)`);
    if (owner !== undefined && got.owner !== owner) throw new SourceRefused(`source ${source} answered an envelope of another owner for a retrieval by owner (K14)`);
    const e = got.envelope as Partial<EnvelopeAnswer['envelope']> | null | undefined;
    if (!e || typeof e !== 'object') throw new SourceRefused(`source ${source} answered no envelope (S459)`);
    if (typeof e.to !== 'string' || e.to.trim() === '') throw new SourceRefused(`source ${source} answered an envelope whose recipient is empty (S459)`);
    if (typeof e.subject !== 'string') throw new SourceRefused(`source ${source} answered an envelope with no subject (S459)`);
    if (e.inReplyTo !== null && typeof e.inReplyTo !== 'string') throw new SourceRefused(`source ${source} answered an envelope whose inReplyTo is neither a string nor null (S459)`);
    if (!Array.isArray(e.references) || e.references.some((r) => typeof r !== 'string')) throw new SourceRefused(`source ${source} answered an envelope whose references are not a list of strings (S459)`);
    const values = [e.to, e.subject, ...(e.inReplyTo === null ? [] : [e.inReplyTo]), ...e.references];
    if (values.some((v) => /[\r\n]/.test(v))) throw new SourceRefused(`source ${source} answered an envelope holding a carriage return or a line feed, a header written into another (S459)`);
    // Only the four fields are kept, so nothing else the adapter answered rides in the body a handler reads.
    const body = canonicalize({ inReplyTo: e.inReplyTo, references: [...e.references], subject: e.subject, to: e.to });
    // PS17.2: the taint a retrieval of the source with the same owner predicate has. S326: with no owner predicate on an
    // owned source it is Ω, and the real owner is kept for a forget.
    const real = d.owned && typeof got.owner === 'string' ? [got.owner] : [];
    const t: Taint = !d.owned ? { c: d.class, o: [] } : owner !== undefined ? { c: d.class, o: [owner as string] } : { c: d.class, o: [OMEGA], k: real };
    const digest = `sha256:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')}`;
    // Review B3: the body, its taint, its source and its envelope record are kept in one transaction.
    await this.store.txn(() => {
      this.store.keepErasable(digest, body);
      this.taint(digest, t);
      this.fromSource(digest, source);
      this.store.db.prepare('INSERT OR IGNORE INTO poly_envelope (digest, source) VALUES (?, ?)').run(digest, source);
    });
    return { envelope: digest };
  }

  /**
   * PS17.3a (S459): whether a value is the digest of a body the runtime stored as an envelope and has not erased since
   * (PS17.7, ruled 2026-10-09): no recipient survives an erasure.
   */
  isEnvelope(v: unknown): boolean {
    return typeof v === 'string' && DIGEST.test(v) && !!this.store.db.prepare('SELECT 1 FROM poly_envelope WHERE digest = ?').get(v) && !this.store.erased(v);
  }

  /**
   * PS17.6, S304: the items an answer cites, by id, a subset of the set the decision was given: a new set of those items,
   * with their taint. Any other id refuses the answer with the reserved reason uncited, recorded on the run.
   */
  async cite(given: unknown, ids: unknown, run: string, intent: string, now: number): Promise<{ ref: string; count: number }> {
    const set = isItems(given) ? this.itemsOf(given.ref) : null;
    const list = ids === undefined || ids === null ? [] : ids;
    const bad = !set || !Array.isArray(list) || list.some((x) => typeof x !== 'string' || !set.items.some((i) => i.id === x));
    if (bad) {
      await this.store.txn(() => { this.store.appendEvent(run, 'observation', { stage: 'citation', intent, outcome: 'uncited' }, now); });
      throw new Uncited('uncited: the answer cites an item it was not given (PS17.6)');
    }
    const cited = set.items.filter((i) => (list as string[]).includes(i.id));
    let ref!: { ref: string; count: number };
    await this.store.txn(() => { ref = this.keepItems(set.source, cited, `${intent}:cites`, set.taint.o.includes(OMEGA)); });
    return ref;
  }

  /**
   * PF13.3, PS17.2: what a decision reads, given to its provider and never recorded: each Content's body, and each
   * Items' bodies, resolved from the source now and kept in the erasable content store with the item's taint. The
   * decision's taint is the join of all of them.
   */
  async materials(payload: Record<string, unknown>, body: (d: string) => Promise<string | null>, put: (b: string, t: Taint, source: string | null) => Promise<string>): Promise<{ bodies: Record<string, string | null>; items: Record<string, { id: string; body: string | null }[]>; taint: Taint }> {
    const bodies: Record<string, string | null> = {};
    const items: Record<string, { id: string; body: string | null }[]> = {};
    let taint = BOTTOM;
    for (const [p, v] of Object.entries(payload)) {
      if (typeof v === 'string' && DIGEST.test(v)) {
        bodies[p] = await body(v);
        // S302, review B: a Content with no taint record is one the runtime never stored, and fails closed here too.
        const t = this.taintOf(v);
        if (!t) throw new SourceRefused(`${p} names a body with no taint record (S302)`);
        taint = join(taint, t);
      } else if (isItems(v)) {
        const set = this.itemsOf(v.ref);
        if (!set) throw new SourceRefused(`${p} names an item set the runtime did not retrieve`);
        const adapter = this.sources.get(set.source)?.kind === 'memory' ? this.memoryAdapter(set.source) : this.adapters.get(set.source);
        if (!adapter) throw new Error(`source ${set.source} has no adapter connected (PT26)`);
        const out: { id: string; body: string | null }[] = [];
        for (const it of set.items) {
          const b = await adapter.resolve(it.id);
          // A body read is kept erasable, with the item's taint, so forgetting its owner erases it (PS17.7).
          // Review B3: the body, its taint and its source are stored in one transaction.
          // S326: an item's body under Ω is Ω for the flow rule, and keeps its real owner for a forget.
          if (b !== null) await put(b, set.taint.o.includes(OMEGA) ? { c: set.taint.c, o: [OMEGA], k: it.owner === null ? [] : [it.owner] } : { c: set.taint.c, o: it.owner === null ? [] : [it.owner] }, set.source);
          out.push({ id: it.id, body: b });
        }
        items[p] = out;
        taint = join(taint, set.taint);
      }
    }
    return { bodies, items, taint };
  }
}
