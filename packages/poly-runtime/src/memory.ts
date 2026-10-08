// Memory at run time (PS17, M10): the taint of each body, kept in the content store's metadata by digest (PS17.4,
// S319), the item sets a retrieval returns (PS17.2), and the bodies a decision reads, resolved from the source only then
// (PF13.3). No item body, query value or credential enters the journal or the ledger (S310): a retrieval's record is its
// item set's reference and count, and a body a decision reads is kept in the erasable content store, with its taint.
import { createHash } from 'node:crypto';
import { canonical } from '@cognitive-fab/polyflow-kernel/canonical';
import type { LedgerStore } from './ledger-store.js';
import type { ItemRef, SourceAdapter } from './adapters.js';

/** PS17.1: a class's index in the audience order, and the owners, principals as the runtime holds them, sorted. */
export interface Taint { c: number; o: string[] }
export const BOTTOM: Taint = { c: 0, o: [] };
export const join = (a: Taint, b: Taint): Taint => ({ c: Math.max(a.c, b.c), o: [...new Set([...a.o, ...b.o])].sort() });

/** PS17.0: a source's descriptor, as the build wrote it and admission certified it (PT10i). */
export interface SourceDescriptor { v: 1; module: string; source: string; kind: string; adapter: string | null; audience: string; class: number; owned: boolean; freshnessMs: number | null; stale: 'escalate' | 'deny' }
/** PS17.3: a module's flow descriptor (PT10i). */
export interface FlowDescriptor { v: 1; module: string; audience: string[]; sources: Record<string, { class: number; owned: boolean }> }

/** One item of a set: its id at the source, its owner and its asOf, and the digest of its body once a decision read it. */
interface Item { id: string; owner: string | null; asOf: number; body?: string }

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
  owners TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_items (
  ref    TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  class  INTEGER NOT NULL,
  owners TEXT NOT NULL,
  asof   INTEGER,
  items  TEXT NOT NULL
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

  /** PS17.4: a body's taint, or null when the store holds no record of it. */
  taintOf(digest: string): Taint | null {
    const r = this.store.db.prepare('SELECT class, owners FROM poly_taint WHERE digest = ?').get(digest) as { class: number; owners: string } | undefined;
    return r ? { c: r.class, o: JSON.parse(r.owners) as string[] } : null;
  }

  /** PS17.4, S319: records a body's taint, joined with what the store already holds for it. Inside a transaction. */
  taint(digest: string, t: Taint): void {
    const t2 = join(this.taintOf(digest) ?? BOTTOM, t);
    this.store.db.prepare('INSERT INTO poly_taint (digest, class, owners) VALUES (?, ?, ?) ON CONFLICT(digest) DO UPDATE SET class = excluded.class, owners = excluded.owners').run(digest, t2.c, JSON.stringify(t2.o));
  }

  /** An item set's taint, source and items. */
  itemsOf(ref: string): { source: string; taint: Taint; asOf: number | null; items: Item[] } | null {
    const r = this.store.db.prepare('SELECT source, class, owners, asof, items FROM poly_items WHERE ref = ?').get(ref) as { source: string; class: number; owners: string; asof: number | null; items: string } | undefined;
    return r ? { source: r.source, taint: { c: r.class, o: JSON.parse(r.owners) as string[] }, asOf: r.asof, items: JSON.parse(r.items) as Item[] } : null;
  }

  private keepItems(source: string, items: Item[], salt: string): { ref: string; count: number } {
    const d = this.sources.get(source)!;
    const ref = `items:${createHash('sha256').update(canonical({ source, salt, ids: items.map((i) => i.id) }), 'utf8').digest('hex')}`;
    const owners = d.owned ? [...new Set(items.flatMap((i) => (i.owner === null ? [] : [i.owner])))].sort() : [];
    const asOf = items.length ? Math.min(...items.map((i) => i.asOf)) : null;
    this.store.db.prepare('INSERT OR IGNORE INTO poly_items (ref, source, class, owners, asof, items) VALUES (?, ?, ?, ?, ?, ?)').run(ref, source, d.class, JSON.stringify(owners), asOf, JSON.stringify(items));
    return { ref, count: items.length };
  }

  /**
   * PS17.2: a retrieval, run by the runtime: the adapter's items by reference, kept as a set whose taint is the source's
   * class and its items' owners. With `where owner == p`, an item of another owner, or of none, is refused (K14).
   */
  async retrieve(source: string, spec: { owner: string | null; limit: number }, payload: Record<string, unknown>, intent: string): Promise<{ items: { ref: string; count: number } }> {
    const d = this.sources.get(source);
    if (!d) throw new SourceRefused(`no source ${source} in the certified build`);
    const adapter = this.adapters.get(source);
    if (!adapter) throw new Error(`source ${source} has no adapter connected (PT26): connect one with rt.connectSource`);
    const owner = spec.owner === null ? undefined : payload[spec.owner];
    if (spec.owner !== null && typeof owner !== 'string') throw new SourceRefused(`the retrieval from ${source} names no owner`);
    const got: ItemRef[] = await adapter.retrieve({ ...(owner !== undefined ? { owner: owner as string } : {}), limit: spec.limit });
    if (!Array.isArray(got) || got.length > spec.limit) throw new SourceRefused(`source ${source} answered ${Array.isArray(got) ? got.length : 'no list of'} items for a limit of ${spec.limit} (K14)`);
    const items: Item[] = [];
    for (const i of got) {
      if (!i || typeof i.id !== 'string' || !Number.isFinite(i.asOf)) throw new SourceRefused(`source ${source} answered an item with no id or asOf (K14)`);
      if (d.owned && typeof i.owner !== 'string') throw new SourceRefused(`source ${source} is owned, and answered an item with no owner (K14)`);
      if (owner !== undefined && i.owner !== owner) throw new SourceRefused(`source ${source} answered an item of another owner for a retrieval by owner (K14)`);
      items.push({ id: i.id, owner: d.owned ? i.owner : null, asOf: i.asOf });
    }
    let ref!: { ref: string; count: number };
    await this.store.txn(() => { ref = this.keepItems(source, items, intent); });
    return { items: ref };
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
    await this.store.txn(() => { ref = this.keepItems(set.source, cited, `${intent}:cites`); });
    return ref;
  }

  /**
   * PF13.3, PS17.2: what a decision reads, given to its provider and never recorded: each Content's body, and each
   * Items' bodies, resolved from the source now and kept in the erasable content store with the item's taint. The
   * decision's taint is the join of all of them.
   */
  async materials(payload: Record<string, unknown>, body: (d: string) => Promise<string | null>, put: (b: string) => Promise<string>): Promise<{ bodies: Record<string, string | null>; items: Record<string, { id: string; body: string | null }[]>; taint: Taint }> {
    const bodies: Record<string, string | null> = {};
    const items: Record<string, { id: string; body: string | null }[]> = {};
    let taint = BOTTOM;
    for (const [p, v] of Object.entries(payload)) {
      if (typeof v === 'string' && DIGEST.test(v)) {
        bodies[p] = await body(v);
        taint = join(taint, this.taintOf(v) ?? BOTTOM);
      } else if (isItems(v)) {
        const set = this.itemsOf(v.ref);
        if (!set) throw new SourceRefused(`${p} names an item set the runtime did not retrieve`);
        const adapter = this.adapters.get(set.source);
        if (!adapter) throw new Error(`source ${set.source} has no adapter connected (PT26)`);
        const out: { id: string; body: string | null }[] = [];
        for (const it of set.items) {
          const b = await adapter.resolve(it.id);
          // A body read is kept erasable, with the item's taint, so forgetting its owner erases it (PS17.7).
          if (b !== null) { const d = await put(b); await this.store.txn(() => this.taint(d, { c: set.taint.c, o: it.owner === null ? [] : [it.owner] })); }
          out.push({ id: it.id, body: b });
        }
        items[p] = out;
        taint = join(taint, set.taint);
      }
    }
    return { bodies, items, taint };
  }
}
