// Routes and budgets at run time (PS18.2, PS18.4, S351 to S354, PT10r). A routed decision's intent runs no provider:
// once started it creates the route's instance `route:<intent>` and starts it, and each tier's call is an intent of
// that instance, proposed with its reservation and run by the tier's provider. When the route ends, the decision's
// intent completes with the answering tier's answer, or fails with `route-exhausted`.
//
// Each cap of a budget has an instance of m.b.Budget per address (PS18.4). The runtime reads every one before the
// policy, reserves on each in the transaction that records the allow, settles each in the transaction of the call's
// completion, and releases each when the intent dies; each step has an action id derived from the intent, so a step
// repeated after a crash is deduplicated (K4) and no reservation is lost or counted twice.
import { digest } from '@poly/core';
import type { OutboxRow, Runtime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import type { LedgerStore } from './ledger-store.js';
import { isItems } from './memory.js';
import { answerProbability, calibrate, chargeOf, type DecisionRecord, type Provider } from './provider.js';
import type { VerifiedBudget, VerifiedRoute, VerifiedTier } from './load.js';
import type { Proposal } from './worker.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS poly_route (
  intent   TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  run      TEXT NOT NULL,
  route    TEXT NOT NULL,
  status   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_reservation (
  intent TEXT NOT NULL,
  budget TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (intent, budget)
);
CREATE TABLE IF NOT EXISTS poly_route_call (
  intent TEXT PRIMARY KEY,
  record TEXT NOT NULL
);
`;

/** One instance a tier's call reserves on: its address, the cap it is opened with, and the reservation. */
export interface ReservationPlan { instance: string; cap: number; amount: number }

/** What the runtime's budget check gives the worker for a tier's call (PS18.4), or a budgeted decision's, with no route (PS18.4a). */
export type BudgetCheck =
  | { refuse: 'deny' | 'escalate'; route: NonNullable<Proposal['route']> | null; budget: NonNullable<Proposal['budget']> | null }
  | { route: NonNullable<Proposal['route']> | null; budget: NonNullable<Proposal['budget']> | null; plan: ReservationPlan[]; held: boolean };

/**
 * PS18.4a, PT10r (S454): an unrouted decision's budget, as its certified manifest entry gives it: the budget it reserves
 * on, its price table as a tier's, both token limits and the reservation of PS18.3.
 */
export interface DecisionBudget {
  budget: string;
  prices: VerifiedTier['prices'];
  maxInputTokens: number;
  maxTokens: number;
  reservation: number;
}

type BudgetState = { b?: string; cap?: number; spent?: number; reserved?: number; overrun?: number };

/** PS18.4: the period that holds a time, in UTC: an hour, a day or a month. */
export function periodKey(period: 'hour' | 'day' | 'month', at: number): string {
  const iso = new Date(at).toISOString();
  return period === 'month' ? iso.slice(0, 7) : period === 'day' ? iso.slice(0, 10) : iso.slice(0, 13);
}

export class RoutingHost {
  /** S402, PS18.2: the decision's materials for a tier's call, as an unrouted decision's provider gets them; the runtime sets it. */
  materials: ((payload: Record<string, unknown>) => Promise<{ bodies: Record<string, string | null>; items: Record<string, { id: string; body: string | null }[]> }>) | null = null;

  /** The tier providers, by the provider name a tier gives (S356): host code, never certified, recorded in tests. */
  readonly providers = new Map<string, Provider>();

  /** PS18.4a: each unrouted decision's budget, by its machine and kind, from the certified manifests; the runtime sets it. */
  readonly decisionBudgets = new Map<string, DecisionBudget>();

  /**
   * Review B2 (M11), PS18.4a: a priced call's record, kept as soon as its provider answered, so the call is charged
   * however its intent ends; settle reads it. The question is kept in the content store by digest.
   */
  async keep(intent: string, record: DecisionRecord & Record<string, unknown>): Promise<void> {
    const { question: q, ...rest } = record;
    await this.store.txn(() => { this.store.db.prepare('INSERT OR REPLACE INTO poly_route_call (intent, record) VALUES (?, ?)').run(intent, JSON.stringify({ ...rest, request: this.store.keep(q) })); });
  }

  /** `resultOf` gives a routed decision's result values, as its certified manifest lists them. */
  constructor(private readonly kernel: Runtime, private readonly store: LedgerStore, readonly routes: VerifiedRoute[], readonly budgets: VerifiedBudget[], private readonly now: () => number, private readonly records: Map<string, DecisionRecord>, private readonly resultOf: (route: VerifiedRoute) => unknown = () => null) {
    store.db.exec(SCHEMA);
  }

  /** The route a decision kind of a machine names, or null for a decision with one provider. */
  routeOfDecision(machineId: string, kind: string): VerifiedRoute | null {
    return this.routes.find((r) => r.decision.machine === machineId && `decision.${r.decision.name}` === kind) ?? null;
  }

  /** Whether an instance is a route's or a budget's, which only the runtime steps (PS18.4). */
  internal(machineId: string): boolean {
    return this.routes.some((r) => r.machine === machineId) || this.budgets.some((b) => b.machine === machineId);
  }

  private machineOf(instance: string): string | null {
    return (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instance)?.machine_id as string | undefined) ?? null;
  }
  private stateOf(instance: string): { seq: number; state: Record<string, unknown> } | null {
    const r = this.store.db.prepare('SELECT seq, state FROM pr_instance WHERE instance_id = ?').get(instance) as { seq: number; state: string } | undefined;
    return r ? { seq: r.seq, state: JSON.parse(r.state) } : null;
  }

  /** A tier's call: its route, its tier and the decision it serves, or null for any other intent. */
  tierOf(row: OutboxRow): { route: VerifiedRoute; index: number; tier: VerifiedTier; decision: { intent: string; run: string; payload: unknown } } | null {
    const route = this.routes.find((r) => r.effectKind === row.kind);
    if (!route || this.machineOf(row.instance_id) !== route.machine) return null;
    const link = this.store.db.prepare('SELECT intent, run FROM poly_route WHERE instance = ?').get(row.instance_id) as { intent: string; run: string } | undefined;
    const index = (row.payload as { tier?: unknown } | null)?.tier;
    if (!link || typeof index !== 'number' || !route.tiers[index]) return null;
    const d = this.store.db.prepare('SELECT payload FROM pr_outbox WHERE intent_id = ?').get(link.intent) as { payload: string } | undefined;
    return { route, index, tier: route.tiers[index], decision: { intent: link.intent, run: link.run, payload: d ? JSON.parse(d.payload) : {} } };
  }

  /**
   * PS18.2: the decision's intent, started, starts its route: the instance `route:<intent>` of m.r.Route is created and
   * takes Start(), both journaled, in the caller's transaction.
   */
  async issue(row: OutboxRow, route: VerifiedRoute): Promise<string> {
    const instance = `route:${row.intent_id}`;
    if (!this.machineOf(instance)) await this.kernel.create(route.machine, instance);
    await this.kernel.dispatch(instance, 'Start', {}, 'start');
    this.store.db.prepare('INSERT OR IGNORE INTO poly_route (intent, instance, run, route, status) VALUES (?, ?, ?, ?, ?)').run(row.intent_id, instance, row.instance_id, route.name, 'running');
    return instance;
  }

  /** PS18.4: the addresses of a budget's caps for a call of the decision instance `run`, at the runtime's clock. */
  addresses(budget: VerifiedBudget, run: string, at: number): ReservationPlan[] {
    const machine = this.machineOf(run) ?? '';
    const scope = machine.slice(0, machine.lastIndexOf('.'));
    return budget.caps.map((c) => {
      const where = c.run ? `run:${run}` : [c.scope ? `scope:${scope}` : null, c.period ? `${c.period}:${periodKey(c.period, at)}` : null].filter(Boolean).join(':');
      return { instance: `budget:${budget.name}:${where}`, cap: c.amount, amount: 0 };
    });
  }

  /** Whether a reservation fits an instance as it is now: a missing one is opened with its cap, so it fits up to it. */
  private fits(p: ReservationPlan, r: number): boolean {
    const s = this.stateOf(p.instance)?.state as BudgetState | undefined;
    if (!s || s.b === 'Closed') return r <= p.cap;
    return s.b === 'Open' && (s.spent ?? 0) + (s.reserved ?? 0) + r <= (s.cap ?? 0);
  }

  /** The least a budget has left, over its instances for this call: the cap less what is spent and reserved. */
  private remaining(plan: ReservationPlan[]): number {
    return Math.min(...plan.map((p) => {
      const s = this.stateOf(p.instance)?.state as BudgetState | undefined;
      return s && s.b !== 'Closed' ? (s.cap ?? 0) - (s.spent ?? 0) - (s.reserved ?? 0) : p.cap;
    }));
  }

  /**
   * PS18.4, S353: the budget check of a tier's call, before the policy. A reservation that does not fit some instance
   * refuses the call, denied or escalated as the budget says; an approved call is never escalated again. A call whose
   * reservation is already held (a proposal made again after a stale allow) is not reserved twice.
   */
  budgetCheck(row: OutboxRow, approved: boolean): BudgetCheck | null {
    const t = this.tierOf(row);
    if (t) return this.check(row, approved, { route: t.route.name, tier: t.tier.name, reservation: t.tier.reservation }, t.route.budget, t.decision.run, t.tier.reservation);
    // PS18.4a: an unrouted decision's own intent is read against its budget as a tier's call is; its run is its instance.
    const d = this.decisionBudget(row);
    return d ? this.check(row, approved, null, d.budget, row.instance_id, d.reservation) : null;
  }

  /** PS18.4a: the budget of an unrouted decision's intent, from its certified manifest entry, or null. */
  decisionBudget(row: Pick<OutboxRow, 'instance_id' | 'kind'>): DecisionBudget | null {
    const machine = this.machineOf(row.instance_id);
    return machine ? this.decisionBudgets.get(`${machine}\u0000${row.kind}`) ?? null : null;
  }

  private check(row: OutboxRow, approved: boolean, route: NonNullable<Proposal['route']> | null, name: string | null, run: string, reservation: number): BudgetCheck {
    const b = name === null ? null : this.budgets.find((x) => x.name === name);
    if (name === null) return { route, budget: null, plan: [], held: false };
    // Review B5 (M11): a call that names a budget the runtime did not load is refused, fail closed (S353).
    if (!b) return { refuse: 'deny', route, budget: null };
    const held = !!this.store.db.prepare("SELECT 1 FROM poly_reservation WHERE intent = ? AND status = 'held'").get(row.intent_id);
    const plan = this.addresses(b, run, this.now()).map((p) => ({ ...p, amount: reservation }));
    const scope = plan.find((p) => p.instance.includes(':scope:'))?.instance.split(':scope:')[1]?.split(':')[0] ?? null;
    const budget = { budget: b.name, scope, remaining: this.remaining(plan) };
    if (held) return { route, budget, plan, held: true };
    if (plan.every((p) => this.fits(p, p.amount))) return { route, budget, plan, held: false };
    return { refuse: b.onExhausted === 'escalate' && !approved ? 'escalate' : 'deny', route, budget };
  }

  /**
   * PS18.4: the reservation, in the transaction that records the allow. Each instance is read again inside it, and
   * the reservation is taken on every one or on none: false when one no longer fits, and nothing is written.
   */
  async reserve(row: OutboxRow, plan: ReservationPlan[]): Promise<boolean> {
    if (!plan.every((p) => this.fits(p, p.amount))) return false;
    for (const p of plan) {
      if (!this.machineOf(p.instance)) {
        const machine = this.budgets.find((b) => p.instance.startsWith(`budget:${b.name}:`))!.machine;
        await this.kernel.create(machine, p.instance);
      }
      const s = this.stateOf(p.instance)!.state as BudgetState;
      if (s.b === 'Closed') await this.kernel.dispatch(p.instance, 'Open', { limit: p.cap }, 'open');
      const r = await this.kernel.dispatch(p.instance, 'Reserve', { r: p.amount }, `reserve:${row.intent_id}`);
      if (r.stepKind !== 'accepted') throw new Error(`the budget ${p.instance} refused a reservation it was read to fit (${r.rejectReason ?? r.stepKind}): PL2401 RUNTIME_MODEL_DRIFT`);
      this.store.db.prepare('INSERT OR IGNORE INTO poly_reservation (intent, budget, amount, status) VALUES (?, ?, ?, ?)').run(row.intent_id, p.instance, p.amount, 'held');
    }
    return true;
  }

  /**
   * PS18.4: settles with the call's cost, when its provider answered, or else releases, every reservation the intent
   * holds, in the caller's transaction, once: a reservation already settled or released is passed over.
   */
  async settle(row: OutboxRow, action: string): Promise<void> {
    const intent = row.intent_id;
    const held = this.store.db.prepare("SELECT budget, amount FROM poly_reservation WHERE intent = ? AND status = 'held'").all(intent) as { budget: string; amount: number }[];
    // Review B2, C1 (M11): a call whose provider answered is settled with its cost whatever ends its intent (a lost
    // completion, a refused settle, a completion outside its type), and only a call with no answer is released. Its
    // record was kept when the provider answered; when no completion wrote it, it is written here (PS18.6).
    const kept = this.store.db.prepare('SELECT record FROM poly_route_call WHERE intent = ?').get(intent) as { record: string } | undefined;
    const record = kept ? (JSON.parse(kept.record) as Record<string, any>) : null;
    const cost: number | null = record && typeof record.cost?.units === 'number' ? record.cost.units : null;
    if (record && action !== 'SettleOk') this.store.appendEvent(row.instance_id, 'decision', { ...record, completed: false, ended: action }, this.now());
    // Polywatch on the rulings: a route with no budget holds no reservation, and its answered call is still recorded above.
    if (!held.length) return;
    // S352 as ruled, PT24.3: each settlement is journaled on the call's run, an overrun named in it, never hidden.
    this.store.appendEvent(row.instance_id, 'verdict', { stage: 'budget', intent, outcome: cost === null ? 'released' : 'settled', budgets: held.map((h) => (cost === null ? { instance: h.budget, reserved: h.amount, released: true } : { instance: h.budget, reserved: h.amount, actual: cost, overrun: Math.max(0, cost - h.amount) })) }, this.now());
    for (const h of held) {
      const r = cost === null
        ? await this.kernel.dispatch(h.budget, 'Release', { r: h.amount }, `release:${intent}`)
        : await this.kernel.dispatch(h.budget, 'Settle', { r: h.amount, actual: cost }, `settle:${intent}`);
      if (r.stepKind !== 'accepted') throw new Error(`the budget ${h.budget} refused to ${cost === null ? 'release' : 'settle'} the reservation of ${intent} (${r.rejectReason ?? r.stepKind}): PL2401 RUNTIME_MODEL_DRIFT`);
      this.store.db.prepare('UPDATE poly_reservation SET status = ? WHERE intent = ? AND budget = ?').run(cost === null ? 'released' : 'settled', intent, h.budget);
    }
  }

  /**
   * The handler of a route's call: tier t's provider, given the decision's question and the tier's token limit, its
   * answer calibrated by the tier's map, and the record (with usage, cost and reservation) kept for the completion's
   * decision event. The handler's result is what Answer(conf, margin) takes.
   */
  handler(route: VerifiedRoute) {
    return async (_payload: unknown, _caps: unknown, ctx: { idempotencyKey: string; instanceId: string }) => {
      const row = this.store.db.prepare('SELECT * FROM pr_outbox WHERE intent_id = ?').get(ctx.idempotencyKey) as OutboxRow & { payload: string };
      const t = this.tierOf({ ...row, payload: JSON.parse(row.payload as unknown as string) } as OutboxRow);
      if (!t) throw new Error(`${ctx.idempotencyKey} is not a call of route ${route.name}`);
      const provider = this.providers.get(t.tier.provider);
      if (!provider) throw new Error(`no provider ${t.tier.provider} is registered for tier ${t.tier.name} of route ${route.name} (rt.provideTier, S356)`);
      const question = { decision: route.decision.name, payload: t.decision.payload, intent: t.decision.intent, tier: t.tier.name, limits: { maxInputTokens: t.tier.maxInputTokens, maxTokens: t.tier.maxTokens } };
      const t0 = this.now();
      // S402: a decision that reads a Content or an Items gives each tier its materials; the question keeps digests only.
      const payload = (t.decision.payload ?? {}) as Record<string, unknown>;
      const reads = Object.values(payload).some((v) => (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)) || isItems(v));
      const m = reads && this.materials ? await this.materials(payload) : null;
      const a = await (m ? provider(question, { bodies: m.bodies, items: m.items }) : provider(question));
      const dist = [...a.distribution].sort((x, y) => y[1] - x[1]);
      const map = t.tier.calibration ? { decision: t.tier.calibration.decision, version: t.tier.calibration.version, fittedFor: t.tier.calibration.fittedFor, digest: t.tier.calibration.mapDigest, points: t.tier.calibration.points } : null;
      const first = answerProbability(dist, a.answer);
      const sameAnswer = (x: unknown) => JSON.stringify(x) === JSON.stringify(a.answer);
      const second = Math.max(0, ...dist.filter(([x]) => !sameAnswer(x)).map(([, p]) => p));
      const conf = calibrate(map, first);
      const margin = Math.max(0, conf - calibrate(map, second));
      // S361, ruled: a call that answered with no usage report, or with a count that is not a whole number of tokens, is
      // charged its full reservation, the violation recorded and its counts not; it is never released for free.
      const { usage, cost, unpriced, violation } = chargeOf(a.usage, t.tier.prices, t.tier.reservation);
      const machine = this.machineOf(t.decision.run) ?? '';
      // S310, PS18.6, F1 as ruled: an answer outside the decision's type is a provider's free text, which may carry what
      // the question held. It is recorded by its digest only, in the answer and the distribution alike; the completion
      // still fails outside its type (S140). A decision whose result values are not listed is read as holding none.
      const values = this.resultOf(route);
      const inType = (x: unknown) => Array.isArray(values) && values.some((v) => digest(v) === digest(x ?? null));
      const kept = (x: unknown) => (inType(x) ? x : { digest: digest(x ?? null) });
      const outside = !inType(a.answer);
      const record: DecisionRecord & Record<string, unknown> = {
        decision: route.decision.name, intent: ctx.idempotencyKey, provider: t.tier.provider,
        model: { id: t.tier.model, reported: a.reported ?? null },
        calibration: map ? { version: map.version, fittedFor: map.fittedFor, digest: map.digest } : { uncalibrated: true },
        question, inputs: [], answer: kept(a.answer), raw: first, conf, margin, distribution: dist.map(([x, p]): [unknown, number] => [kept(x), p]),
        latencyMs: a.latencyMs ?? this.now() - t0, cost: { units: cost, unit: `micro-${t.tier.prices.currency}` },
        route: route.name, tier: t.tier.name, tierIndex: t.index, usage, ...(violation ? { usageViolation: violation } : {}), ...(outside ? { answerOutsideType: true } : {}), ...(unpriced.length ? { unpriced } : {}),
        reservation: t.tier.reservation, prices: t.tier.prices.digest,
        run: t.decision.run, scope: machine.slice(0, machine.lastIndexOf('.')),
      };
      this.records.set(ctx.idempotencyKey, record);
      // Review B2 (M11): kept as soon as the provider answered, so a call that ran is charged however its intent ends.
      await this.keep(ctx.idempotencyKey, record);
      return { conf, margin };
    };
  }
}
