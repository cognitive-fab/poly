// Orders and inventory: an inventory actor and one actor per order, talking only by messages
// held in an explicit network until deliver/deliverAll hands them over.

import type { CreateHost, Host, Message, OrderStatus, OrderView, Outcome } from './types.ts';

export const INVENTORY = 'inventory';
export const CAPACITY = 3;
export const INITIAL_AVAILABLE = 1;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

type Send = (from: string, to: string, action: string, data: Record<string, unknown>) => void;

class Inventory {
  available = INITIAL_AVAILABLE;
  reserved = 0;
  open = true;
  private send: Send;

  constructor(send: Send) {
    this.send = send;
  }

  close(): Outcome {
    if (!this.open) return refuse('inventory is closed');
    this.open = false;
    return ok;
  }

  reopen(): Outcome {
    if (this.open) return refuse('inventory is open');
    this.open = true;
    return ok;
  }

  restock(): Outcome {
    if (!this.open) return refuse('inventory is closed');
    if (this.available + this.reserved >= CAPACITY) return refuse('inventory is full');
    this.available += 1;
    return ok;
  }

  receive(msg: Message): void {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      if (this.open && qty <= this.available) {
        this.available -= qty;
        this.reserved += qty;
        this.send(INVENTORY, from, 'Reserved', {});
      } else {
        this.send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Number(msg.data.qty);
      this.reserved -= qty;
      this.available += qty;
    }
  }
}

class Order {
  readonly id: string;
  qty: number;
  status: OrderStatus = 'pending';
  private send: Send;

  constructor(id: string, qty: number, send: Send) {
    this.id = id;
    this.qty = qty;
    this.send = send;
    this.send(id, INVENTORY, 'Reserve', { from: id, qty });
  }

  cancel(): Outcome {
    if (this.status === 'confirmed') {
      this.status = 'cancelled';
      this.release();
      return ok;
    }
    if (this.status === 'pending') {
      this.status = 'cancelling';
      return ok;
    }
    return refuse(`order is ${this.status}`);
  }

  expire(): Outcome {
    if (this.status !== 'confirmed') return refuse(`order is ${this.status}`);
    this.status = 'expired';
    this.release();
    return ok;
  }

  reduce(): Outcome {
    if (this.status !== 'confirmed') return refuse(`order is ${this.status}`);
    if (this.qty !== 2) return refuse('order is for 1 unit');
    this.qty = 1;
    this.send(this.id, INVENTORY, 'Release', { qty: 1 });
    return ok;
  }

  receive(msg: Message): void {
    if (msg.action === 'Reserved') {
      if (this.status === 'pending') this.status = 'confirmed';
      else if (this.status === 'cancelling') {
        this.status = 'cancelled';
        this.release();
      }
    } else if (msg.action === 'OutOfStock') {
      if (this.status === 'pending') this.status = 'rejected';
      else if (this.status === 'cancelling') this.status = 'cancelled';
    }
  }

  private release(): void {
    this.send(this.id, INVENTORY, 'Release', { qty: this.qty });
  }
}

const createHost: CreateHost = async () => {
  const network = new Map<string, Message>();
  let nextId = 1;
  const send: Send = (from, to, action, data) => {
    const id = `m${nextId++}`;
    network.set(id, { id, from, to, action, data });
  };

  const inventory = new Inventory(send);
  const orders = new Map<string, Order>();

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const deliverOne = (id: string): void => {
    const msg = network.get(id);
    if (!msg) return;
    network.delete(id);
    if (msg.to === INVENTORY) inventory.receive(msg);
    else orders.get(msg.to)?.receive(msg);
  };

  const host: Host = {
    async inFlight() {
      return [...network.values()].map(copy);
    },
    async deliver(id) {
      deliverOne(id);
    },
    async deliverAll() {
      while (network.size > 0) deliverOne(network.keys().next().value as string);
    },
    async place(id, qty) {
      if (typeof id !== 'string') return refuse('order id must be a string');
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(id)) return refuse('order already exists');
      orders.set(id, new Order(id, qty, send));
      return ok;
    },
    async cancel(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      return o.cancel();
    },
    async expire(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      return o.expire();
    },
    async restock() {
      return inventory.restock();
    },
    async close() {
      return inventory.close();
    },
    async open() {
      return inventory.reopen();
    },
    async order(id): Promise<OrderView | null> {
      const o = orders.get(id);
      return o ? { status: o.status, qty: o.qty } : null;
    },
    async stock() {
      return { available: inventory.available, reserved: inventory.reserved, open: inventory.open };
    },
  };
  return host;
};

export default createHost;
