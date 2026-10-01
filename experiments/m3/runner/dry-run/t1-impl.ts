// The dry run's TypeScript delivery for T1 (plan-m3 section 6): what the stub agent writes in arms 1 and 2.
// It is not an arm's work; it exists so the runner, the scoring and the budget cut-off can be tested without a
// model, and it is a second implementation O3 is checked against. VERSION is set by the stub for each turn.
const VERSION: number = 0;

type Status = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelling' | 'cancelled' | 'declined' | 'failed';
interface Order { status: Status; items: number; charges: number; refunds: number; held: boolean }
interface Effect { id: string; from: string; kind: string; data: Record<string, unknown> }
type Outcome = { ok: true } | { ok: false; reason: string };

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost() {
  const orders = new Map<string, Order>();
  const pending: Effect[] = [];
  let next = 0;
  const get = (id: string) => orders.get(id);
  const charge = (id: string, o: Order) => { o.charges++; pending.push({ id: `e${++next}`, from: id, kind: 'payment.charge', data: { amount: o.items } }); };
  const view = (o: Order) => (VERSION >= 3 ? { status: o.status, items: o.items, charges: o.charges, refunds: o.refunds, held: o.held } : { status: o.status, items: o.items, charges: o.charges, refunds: o.refunds });
  return {
    async pendingEffects() { return pending.map((e) => ({ ...e, data: { ...e.data } })); },
    async completeEffect(id: string, outcome: 'ok' | 'failed') {
      const i = pending.findIndex((e) => e.id === id);
      if (i < 0) throw new Error(`no effect ${id} is pending`);
      const [e] = pending.splice(i, 1);
      const o = get(e.from);
      if (!o) return;
      if (o.status === 'placed') o.status = outcome === 'ok' ? 'paid' : VERSION >= 1 && o.charges === 1 ? 'declined' : 'failed';
      else if (VERSION >= 2 && o.status === 'cancelling') { o.status = 'cancelled'; if (outcome === 'ok') o.refunds++; }
    },
    async create(id: string) { if (orders.has(id)) return no('exists'); orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0, held: false }); return ok(); },
    async addItem(id: string) { const o = get(id); if (!o || o.status !== 'draft') return no('not-draft'); if (o.items >= 3) return no('full'); o.items++; return ok(); },
    async removeItem(id: string) { const o = get(id); if (!o || o.status !== 'draft' || o.items === 0) return no('not-draft'); o.items--; return ok(); },
    async place(id: string) { const o = get(id); if (!o || o.status !== 'draft' || o.items === 0) return no('not-draft'); o.status = 'placed'; charge(id, o); return ok(); },
    async retryPayment(id: string) { const o = get(id); if (!o || o.status !== 'declined') return no('not-declined'); o.status = 'placed'; charge(id, o); return ok(); },
    async ship(id: string) { const o = get(id); if (!o || o.status !== 'paid' || o.held) return no('not-paid'); o.status = 'shipped'; return ok(); },
    async cancel(id: string) {
      const o = get(id);
      if (!o) return no('unknown');
      if (o.status === 'draft') { o.status = 'cancelled'; return ok(); }
      if (o.status === 'paid') { o.status = 'cancelled'; o.refunds++; o.held = false; return ok(); }
      if (VERSION >= 2 && o.status === 'placed') { o.status = 'cancelling'; return ok(); }
      return no('closed');
    },
    async hold(id: string) { const o = get(id); if (!o || o.status !== 'paid' || o.held) return no('not-paid'); o.held = true; return ok(); },
    async release(id: string) { const o = get(id); if (!o || !o.held) return no('not-held'); o.held = false; return ok(); },
    async order(id: string) { const o = get(id); return o ? view(o) : null; },
  };
}
