import type { CreateHost, Host, Message, OrderView, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const MAX_UNITS = 3;

type Status = OrderView['status'];

interface Order {
  status: Status;
  qty: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const inventory = { available: 1, reserved: 0, open: true };
  const orders = new Map<string, Order>();
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  }

  function receiveAtInventory(msg: Message): void {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      if (inventory.open && inventory.available >= qty) {
        inventory.available -= qty;
        inventory.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Number(msg.data.qty);
      inventory.reserved -= qty;
      inventory.available += qty;
    }
  }

  function receiveAtOrder(id: string, msg: Message): void {
    const o = orders.get(id);
    if (!o) return;
    if (msg.action === 'Reserved') {
      if (o.status === 'pending') {
        o.status = 'confirmed';
      } else if (o.status === 'cancelling') {
        o.status = 'cancelled';
        send(id, INVENTORY, 'Release', { qty: o.qty });
      }
    } else if (msg.action === 'OutOfStock') {
      if (o.status === 'pending') o.status = 'rejected';
      else if (o.status === 'cancelling') o.status = 'cancelled';
    }
  }

  function receive(msg: Message): void {
    if (msg.to === INVENTORY) receiveAtInventory(msg);
    else receiveAtOrder(msg.to, msg);
  }

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id) {
      const msg = inTransit.get(id);
      if (!msg) return;
      inTransit.delete(id);
      receive(msg);
    },

    async deliverAll() {
      while (inTransit.size > 0) {
        const [id, msg] = inTransit.entries().next().value!;
        inTransit.delete(id);
        receive(msg);
      }
    },

    async place(order, qty) {
      if (typeof order !== 'string') return refuse('order id must be a string');
      if (order === INVENTORY) return refuse('order id is reserved');
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(order)) return refuse('order already exists');
      orders.set(order, { status: 'pending', qty });
      send(order, INVENTORY, 'Reserve', { from: order, qty });
      return ok();
    },

    async cancel(order) {
      const o = orders.get(order);
      if (!o) return refuse('no such order');
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
      if (!o) return refuse('no such order');
      if (o.status !== 'confirmed') return refuse(`order is ${o.status}`);
      o.status = 'expired';
      send(order, INVENTORY, 'Release', { qty: o.qty });
      return ok();
    },

    async restock() {
      if (inventory.available + inventory.reserved >= MAX_UNITS) {
        return refuse('inventory is full');
      }
      inventory.available += 1;
      return ok();
    },

    async order(order) {
      const o = orders.get(order);
      return o ? { status: o.status, qty: o.qty } : null;
    },

    async stock() {
      return { available: inventory.available, reserved: inventory.reserved };
    },
  };

  return host;
};

export default createHost;
