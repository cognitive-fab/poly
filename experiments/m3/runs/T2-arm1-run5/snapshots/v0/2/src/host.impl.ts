import type { CreateHost, Host, Message, OrderView, Outcome } from './types.ts';

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
  const inventory = { available: 1, reserved: 0 };
  const orders = new Map<string, OrderState>();
  const transit: Message[] = [];
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    transit.push({ id: `m${nextId++}`, from, to, action, data });
  }

  function receiveAtInventory(msg: Message): void {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      if (inventory.available >= qty) {
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

  function receiveAtOrder(msg: Message): void {
    const o = orders.get(msg.to);
    if (!o) return;
    if (msg.action === 'Reserved') {
      if (o.status === 'pending') {
        o.status = 'confirmed';
      } else if (o.status === 'cancelling') {
        o.status = 'cancelled';
        send(msg.to, INVENTORY, 'Release', { qty: o.qty });
      }
    } else if (msg.action === 'OutOfStock') {
      if (o.status === 'pending') o.status = 'rejected';
      else if (o.status === 'cancelling') o.status = 'cancelled';
    }
  }

  function dispatch(msg: Message): void {
    if (msg.to === INVENTORY) receiveAtInventory(msg);
    else receiveAtOrder(msg);
  }

  const host: Host = {
    async inFlight() {
      return transit.map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id: string) {
      const i = transit.findIndex((m) => m.id === id);
      if (i < 0) throw new Error(`no message in transit with id ${id}`);
      const [msg] = transit.splice(i, 1);
      dispatch(msg);
    },

    async deliverAll() {
      while (transit.length > 0) {
        const msg = transit.shift()!;
        dispatch(msg);
      }
    },

    async place(order: string, qty: number) {
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(order)) return refuse('order already exists');
      orders.set(order, { status: 'pending', qty });
      send(order, INVENTORY, 'Reserve', { from: order, qty });
      return ok();
    },

    async cancel(order: string) {
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

    async restock() {
      if (inventory.available + inventory.reserved >= CAPACITY) {
        return refuse('inventory is full');
      }
      inventory.available += 1;
      return ok();
    },

    async order(order: string) {
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
