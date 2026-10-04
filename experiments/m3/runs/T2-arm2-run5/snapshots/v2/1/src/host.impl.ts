import type { CreateHost, Host, Message, Outcome, OrderView } from '../host.ts';

const INVENTORY = 'inventory';
const CAPACITY = 3;

type Status = OrderView['status'];

interface Order {
  status: Status;
  qty: number;
}

interface Inventory {
  available: number;
  reserved: number;
  open: boolean;
}

type Send = (from: string, to: string, action: string, data: Record<string, unknown>) => void;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

/** The inventory's handler for one delivered message. */
function inventoryReceive(inv: Inventory, msg: Message, send: Send): void {
  if (msg.action === 'Reserve') {
    const from = String(msg.data.from);
    const qty = Number(msg.data.qty);
    if (inv.available >= qty) {
      inv.available -= qty;
      inv.reserved += qty;
      send(INVENTORY, from, 'Reserved', {});
    } else {
      send(INVENTORY, from, 'OutOfStock', {});
    }
  } else if (msg.action === 'Release') {
    const qty = Number(msg.data.qty);
    inv.reserved -= qty;
    inv.available += qty;
  }
}

/** An order's handler for the inventory's answer. */
function orderReceive(id: string, o: Order, msg: Message, send: Send): void {
  const reserved = msg.action === 'Reserved';
  if (!reserved && msg.action !== 'OutOfStock') return;
  if (o.status === 'pending') {
    o.status = reserved ? 'confirmed' : 'rejected';
  } else if (o.status === 'cancelling') {
    o.status = 'cancelled';
    if (reserved) send(id, INVENTORY, 'Release', { qty: o.qty });
  }
}

const createHost: CreateHost = async () => {
  const inv: Inventory = { available: 1, reserved: 0 };
  const orders = new Map<string, Order>();
  const inTransit = new Map<string, Message>();
  let seq = 0;

  const send: Send = (from, to, action, data) => {
    const id = `m${++seq}`;
    inTransit.set(id, { id, from, to, action, data });
  };

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const deliverOne = (id: string): void => {
    const msg = inTransit.get(id);
    if (!msg) throw new Error(`no message in transit with id ${id}`);
    inTransit.delete(id);
    if (msg.to === INVENTORY) {
      inventoryReceive(inv, msg, send);
    } else {
      const o = orders.get(msg.to);
      if (o) orderReceive(msg.to, o, msg, send);
    }
  };

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map(copy);
    },
    async deliver(id) {
      deliverOne(id);
    },
    async deliverAll() {
      while (inTransit.size > 0) {
        const [id] = inTransit.keys();
        deliverOne(id);
      }
    },
    async place(order, qty) {
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(order)) return refuse('order already exists');
      orders.set(order, { status: 'pending', qty });
      send(order, INVENTORY, 'Reserve', { from: order, qty });
      return ok;
    },
    async cancel(order) {
      const o = orders.get(order);
      if (!o) return refuse('no such order');
      if (o.status === 'confirmed') {
        o.status = 'cancelled';
        send(order, INVENTORY, 'Release', { qty: o.qty });
        return ok;
      }
      if (o.status === 'pending') {
        o.status = 'cancelling';
        return ok;
      }
      return refuse(`order is ${o.status}`);
    },
    async expire(order) {
      const o = orders.get(order);
      if (!o) return refuse('no such order');
      if (o.status !== 'confirmed') return refuse(`order is ${o.status}`);
      o.status = 'expired';
      send(order, INVENTORY, 'Release', { qty: o.qty });
      return ok;
    },
    async restock() {
      if (inv.available + inv.reserved >= CAPACITY) return refuse('inventory is full');
      inv.available += 1;
      return ok;
    },
    async order(order) {
      const o = orders.get(order);
      return o ? { status: o.status, qty: o.qty } : null;
    },
    async stock() {
      return { available: inv.available, reserved: inv.reserved };
    },
  };
  return host;
};

export default createHost;
