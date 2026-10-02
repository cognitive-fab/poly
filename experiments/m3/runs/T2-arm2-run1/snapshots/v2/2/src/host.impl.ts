import type { CreateHost, Host, Message, OrderView, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const CAPACITY = 3;

type Status = OrderView['status'];

interface OrderState {
  status: Status;
  qty: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  let seq = 0;
  const inTransit = new Map<string, Message>();
  const stock = { available: 1, reserved: 0, open: true };
  const orders = new Map<string, OrderState>();

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${++seq}`;
    inTransit.set(id, { id, from, to, action, data });
  };

  // The inventory's message handler.
  const inventoryReceive = (msg: Message): void => {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      // A closed inventory answers every Reserve with OutOfStock.
      if (stock.open && stock.available >= qty) {
        stock.available -= qty;
        stock.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Number(msg.data.qty);
      stock.reserved -= qty;
      stock.available += qty;
    }
  };

  // An order's message handler: only a pending or cancelling order awaits an answer.
  const orderReceive = (id: string, msg: Message): void => {
    const o = orders.get(id);
    if (!o) return;
    if (msg.action === 'Reserved') {
      if (o.status === 'pending') o.status = 'confirmed';
      else if (o.status === 'cancelling') {
        o.status = 'cancelled';
        send(id, INVENTORY, 'Release', { qty: o.qty });
      }
    } else if (msg.action === 'OutOfStock') {
      if (o.status === 'pending') o.status = 'rejected';
      else if (o.status === 'cancelling') o.status = 'cancelled';
    }
  };

  const deliver = async (id: string): Promise<void> => {
    const msg = inTransit.get(id);
    if (!msg) return;
    inTransit.delete(id);
    if (msg.to === INVENTORY) inventoryReceive(msg);
    else orderReceive(msg.to, msg);
  };

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (inTransit.size > 0) {
        const [id] = inTransit.keys();
        await deliver(id);
      }
    },

    async place(order, qty) {
      if (typeof order !== 'string') return refuse('invalid order id');
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(order)) return refuse('order already exists');
      orders.set(order, { status: 'pending', qty });
      send(order, INVENTORY, 'Reserve', { from: order, qty });
      return ok();
    },

    async cancel(order) {
      const o = orders.get(order);
      if (!o) return refuse('unknown order');
      if (o.status === 'confirmed') {
        o.status = 'cancelled';
        send(order, INVENTORY, 'Release', { qty: o.qty });
        return ok();
      }
      if (o.status === 'pending') {
        o.status = 'cancelling';
        return ok();
      }
      return refuse(`order is ${o.status}`);
    },

    async expire(order) {
      const o = orders.get(order);
      if (!o) return refuse('unknown order');
      if (o.status !== 'confirmed') return refuse(`order is ${o.status}`);
      o.status = 'expired';
      send(order, INVENTORY, 'Release', { qty: o.qty });
      return ok();
    },

    async restock() {
      if (stock.available + stock.reserved >= CAPACITY) return refuse('inventory is full');
      stock.available += 1;
      return ok();
    },

    async order(order) {
      const o = orders.get(order);
      return o ? { status: o.status, qty: o.qty } : null;
    },

    async stock() {
      return { available: stock.available, reserved: stock.reserved };
    },
  };
  return host;
};

export default createHost;
