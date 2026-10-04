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
  let available = 1;
  let reserved = 0;
  const orders = new Map<string, OrderState>();
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  }

  function onInventory(msg: Message): void {
    if (msg.action === 'Reserve') {
      const from = msg.data.from as string;
      const qty = msg.data.qty as number;
      if (available >= qty) {
        available -= qty;
        reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = msg.data.qty as number;
      reserved -= qty;
      available += qty;
    }
  }

  function onOrder(msg: Message): void {
    const o = orders.get(msg.to);
    if (!o) return;
    if (msg.action === 'Reserved') {
      if (o.status === 'pending') o.status = 'confirmed';
      else if (o.status === 'cancelling') {
        o.status = 'cancelled';
        send(msg.to, INVENTORY, 'Release', { qty: o.qty });
      }
    } else if (msg.action === 'OutOfStock') {
      if (o.status === 'pending') o.status = 'rejected';
      else if (o.status === 'cancelling') o.status = 'cancelled';
    }
  }

  function dispatch(msg: Message): void {
    if (msg.to === INVENTORY) onInventory(msg);
    else onOrder(msg);
  }

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const msg = inFlight.get(id);
      if (!msg) return;
      inFlight.delete(id);
      dispatch(msg);
    },
    async deliverAll() {
      while (inFlight.size > 0) {
        const [id, msg] = inFlight.entries().next().value as [string, Message];
        inFlight.delete(id);
        dispatch(msg);
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
      if (available + reserved >= CAPACITY) return refuse('inventory full');
      available += 1;
      return ok();
    },
    async order(order) {
      const o = orders.get(order);
      return o ? { status: o.status, qty: o.qty } : null;
    },
    async stock() {
      return { available, reserved };
    },
  };
  return host;
};

export default createHost;
