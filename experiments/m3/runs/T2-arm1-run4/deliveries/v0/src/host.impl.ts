import type { CreateHost, Host, Message, OrderView, Outcome } from './types.ts';

export const INVENTORY = 'inventory';
export const MAX_UNITS = 3;

type Status = OrderView['status'];

interface Order {
  status: Status;
  qty: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const stock = { available: 1, reserved: 0 };
  const orders = new Map<string, Order>();
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  }

  function inventoryReceives(m: Message): void {
    if (m.action === 'Reserve') {
      const from = m.data.from as string;
      const qty = m.data.qty as number;
      if (stock.available >= qty) {
        stock.available -= qty;
        stock.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (m.action === 'Release') {
      const qty = m.data.qty as number;
      stock.reserved -= qty;
      stock.available += qty;
    }
  }

  function orderReceives(id: string, m: Message): void {
    const o = orders.get(id);
    if (!o) return;
    if (m.action === 'Reserved') {
      if (o.status === 'pending') {
        o.status = 'confirmed';
      } else if (o.status === 'cancelling') {
        o.status = 'cancelled';
        send(id, INVENTORY, 'Release', { qty: o.qty });
      }
    } else if (m.action === 'OutOfStock') {
      if (o.status === 'pending') o.status = 'rejected';
      else if (o.status === 'cancelling') o.status = 'cancelled';
    }
  }

  function receive(m: Message): void {
    if (m.to === INVENTORY) inventoryReceives(m);
    else orderReceives(m.to, m);
  }

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id) {
      const m = inTransit.get(id);
      if (!m) return;
      inTransit.delete(id);
      receive(m);
    },

    async deliverAll() {
      while (inTransit.size > 0) {
        const [id, m] = inTransit.entries().next().value as [string, Message];
        inTransit.delete(id);
        receive(m);
      }
    },

    async place(id, qty) {
      if (typeof id !== 'string') return refuse('order id must be a string');
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(id)) return refuse(`order ${id} already exists`);
      orders.set(id, { status: 'pending', qty });
      send(id, INVENTORY, 'Reserve', { from: id, qty });
      return ok();
    },

    async cancel(id) {
      const o = orders.get(id);
      if (!o) return refuse(`no order ${id}`);
      if (o.status === 'confirmed') {
        o.status = 'cancelled';
        send(id, INVENTORY, 'Release', { qty: o.qty });
        return ok();
      }
      if (o.status === 'pending') {
        o.status = 'cancelling';
        return ok();
      }
      return refuse(`order ${id} is ${o.status}`);
    },

    async restock() {
      if (stock.available + stock.reserved >= MAX_UNITS) {
        return refuse(`inventory already holds ${MAX_UNITS} units`);
      }
      stock.available += 1;
      return ok();
    },

    async order(id) {
      const o = orders.get(id);
      return o ? { status: o.status, qty: o.qty } : null;
    },

    async stock() {
      return { available: stock.available, reserved: stock.reserved };
    },
  };
  return host;
};

export default createHost;
