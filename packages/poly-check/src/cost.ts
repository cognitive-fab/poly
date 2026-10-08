// `poly cost` (PT24.4, PS18.6, S358): cost per run, per scope and per period, summed from the ledger alone, with no
// provider call. Each answered tier's call has one `decision` event with its cost in micro-units, its usage, its model
// and its price table's digest; a routed decision's own event repeats its answering tier's and links it (`via`), so it
// is not counted again. Given another price table, each call of that table's model is priced again from its recorded
// usage, under that table's digest. A cost is exact for the usage reported; the usage is K15's.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { costOf, priceTableProblem, type PriceTable } from '@poly/core';

export interface CostCall {
  provider: string;
  run: string;
  scope: string;
  at: number;
  route: string;
  tier: string;
  model: string;
  usage: Record<string, number>;
  cost: number;
  currency: string;
  prices: string;
}

export interface CostReport {
  calls: number;
  /** Per currency, in micro-units. */
  total: Record<string, number>;
  byRun: Record<string, Record<string, number>>;
  byScope: Record<string, Record<string, number>>;
  /** By UTC day, YYYY-MM-DD. */
  byDay: Record<string, Record<string, number>>;
  /** Review C3 (M11): the runs whose chain does not verify, which are not summed. */
  refused: { run: string; reason: string }[];
  /** With --prices: the calls of that table's provider and model priced again under it, by its digest. */
  repriced?: { prices: string; model: string; calls: number; total: Record<string, number> };
}

type Reader = { runs(): Promise<{ run: string }[]>; chain(run: string): Promise<{ kind: string; at: number; body: unknown }[]> };
type Verify = (events: never[]) => { ok: boolean; reason?: string };

/** Review C5 (M11): a period is a UTC month, YYYY-MM, or day, YYYY-MM-DD, that names a real date. */
export function periodProblem(p: string): string | null {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(p)) return `the period ${JSON.stringify(p)} is a month YYYY-MM or a day YYYY-MM-DD`;
  const day = p.length === 7 ? `${p}-01` : p;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ? `the period ${p} names no date` : null;
}

/** Every tier's call the ledger records, filtered by run, scope and period (a day YYYY-MM-DD or a month YYYY-MM). */
export async function costCalls(reader: Reader, filter: { run?: string; scope?: string; period?: string } = {}, verify?: Verify, refused: { run: string; reason: string }[] = []): Promise<CostCall[]> {
  const out: CostCall[] = [];
  for (const { run } of await reader.runs()) {
    const chain = await reader.chain(run);
    // Review C3 (M11): a run whose chain does not verify is not summed, and is reported.
    const v = verify?.(chain as never[]);
    if (v && !v.ok) { refused.push({ run, reason: v.reason ?? 'the chain does not verify' }); continue; }
    for (const e of chain) {
      if (e.kind !== 'decision') continue;
      const b = e.body as Record<string, any>;
      // Only a tier's call carries usage; the decision's own event links it with `via`, and is not counted again.
      // S361: a call whose usage could not be priced has none, and its violation; it is charged its reservation.
      if (b.via !== undefined || (!b.usage && !b.usageViolation) || typeof b.cost?.units !== 'number' || typeof b.cost?.unit !== 'string' || !b.cost.unit.startsWith('micro-')) continue;
      const call: CostCall = { provider: b.provider, run: b.run, scope: b.scope, at: e.at, route: b.route, tier: b.tier, model: b.model?.id, usage: b.usage, cost: b.cost.units, currency: b.cost.unit.slice('micro-'.length), prices: b.prices };
      if (filter.run && call.run !== filter.run) continue;
      if (filter.scope && call.scope !== filter.scope) continue;
      if (filter.period && !new Date(call.at).toISOString().startsWith(filter.period)) continue;
      out.push(call);
    }
  }
  return out;
}

const add = (m: Record<string, Record<string, number>>, k: string, cur: string, v: number) => { m[k] ??= {}; m[k][cur] = (m[k][cur] ?? 0) + v; };

export function costReport(calls: CostCall[], table?: { table: PriceTable; digest: string }, refused: { run: string; reason: string }[] = []): CostReport {
  const total: Record<string, number> = {};
  const byRun = {}, byScope = {}, byDay = {};
  for (const c of calls) {
    total[c.currency] = (total[c.currency] ?? 0) + c.cost;
    add(byRun, c.run, c.currency, c.cost);
    add(byScope, c.scope, c.currency, c.cost);
    add(byDay, new Date(c.at).toISOString().slice(0, 10), c.currency, c.cost);
  }
  const report: CostReport = { calls: calls.length, total, byRun, byScope, byDay, refused };
  if (table) {
    // Review C2 (M11): a table prices its own provider's model, so a call of another provider is not priced again.
    // S361: a call with no usage to price again keeps its recorded charge, and is not counted among those priced again.
    const mine = calls.filter((c) => c.model === table.table.model && c.provider === table.table.provider && c.usage);
    const t: Record<string, number> = {};
    for (const c of mine) t[table.table.currency] = (t[table.table.currency] ?? 0) + costOf(c.usage, table.table).cost;
    report.repriced = { prices: table.digest, model: table.table.model, calls: mine.length, total: t };
  }
  return report;
}

/** A price table file for --prices, checked as PS18.3 says, with the digest of its bytes. */
export function readPriceTable(file: string): { table: PriceTable; digest: string } {
  const bytes = readFileSync(file);
  let table: unknown;
  try { table = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${file} is not JSON`); }
  const provider = (table as { provider?: unknown })?.provider;
  const problem = priceTableProblem(table, typeof provider === 'string' ? provider : '');
  if (problem) throw new Error(`${file} ${problem.message} (${problem.code})`);
  return { table: table as PriceTable, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}
