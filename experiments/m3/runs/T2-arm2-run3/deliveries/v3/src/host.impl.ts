import type { CreateHost, Host, Message, OrderView, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const CAPACITY = 3;

type Status = OrderView['status'];

interface Order {
  status: Status;
  qty: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const stock = { available: 1, reserved: 0, open: true };
  const orders = new Map<string, Order>();
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  // The inventory's handlers.
  const onReserve = (from: string, qty: number): void => {
    if (stock.open && stock.available >= qty) {
      stock.available -= qty;
      stock.reserved += qty;
      send(INVENTORY, from, 'Reserved', {});
    } else {
      send(INVENTORY, from, 'OutOfStock', {});
    }
  };

  const onRelease = (qty: number): void => {
    stock.reserved -= qty;
    stock.available += qty;
  };

  // An order's handlers: the answer to its Reserve.
  const onAnswer = (id: string, reserved: boolean): void => {
    const order = orders.get(id);
    if (!order) return;
    if (order.status === 'pending') {
      order.status = reserved ? 'confirmed' : 'rejected';
    } else if (order.status === 'cancelling') {
      order.status = 'cancelled';
      if (reserved) send(id, INVENTORY, 'Release', { qty: order.qty });
    }
  };

  // Routing is by message name: Reserve and Release go to the inventory,
  // Reserved and OutOfStock to the order (whatever its id).
  const receive = (m: Message): void => {
    switch (m.action) {
      case 'Reserve':
        onReserve(String(m.data.from), Number(m.data.qty));
        break;
      case 'Release':
        onRelease(Number(m.data.qty));
        break;
      case 'Reserved':
        onAnswer(m.to, true);
        break;
      case 'OutOfStock':
        onAnswer(m.to, false);
        break;
    }
  };

  const deliverOne = (id: string): void => {
    const m = inFlight.get(id);
    if (!m) return;
    inFlight.delete(id);
    receive(m);
  };

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id) {
      deliverOne(id);
    },

    async deliverAll() {
      while (inFlight.size > 0) {
        const [id] = inFlight.keys();
        deliverOne(id);
      }
    },

    async place(id, qty) {
      if (typeof id !== 'string') return refuse('order id must be a string');
      if (qty !== 1 && qty !== 2) return refuse('qty must be 1 or 2');
      if (orders.has(id)) return refuse('order already exists');
      orders.set(id, { status: 'pending', qty });
      send(id, INVENTORY, 'Reserve', { from: id, qty });
      return ok();
    },

    async cancel(id) {
      const order = orders.get(id);
      if (!order) return refuse('no such order');
      switch (order.status) {
        case 'confirmed':
          order.status = 'cancelled';
          send(id, INVENTORY, 'Release', { qty: order.qty });
          return ok();
        case 'pending':
          order.status = 'cancelling';
          return ok();
        default:
          return refuse(`order is ${order.status}`);
      }
    },

    async expire(id) {
      const order = orders.get(id);
      if (!order) return refuse('no such order');
      if (order.status !== 'confirmed') return refuse(`order is ${order.status}`);
      order.status = 'expired';
      send(id, INVENTORY, 'Release', { qty: order.qty });
      return ok();
    },

    async reduce(id) {
      const order = orders.get(id);
      if (!order) return refuse('no such order');
      if (order.status !== 'confirmed') return refuse(`order is ${order.status}`);
      if (order.qty !== 2) return refuse('order is for 1 unit');
      order.qty = 1;
      send(id, INVENTORY, 'Release', { qty: 1 });
      return ok();
    },

    async restock() {
      if (!stock.open) return refuse('inventory is closed');
      if (stock.available + stock.reserved >= CAPACITY) return refuse('inventory is full');
      stock.available += 1;
      return ok();
    },

    async close() {
      if (!stock.open) return refuse('inventory is already closed');
      stock.open = false;
      return ok();
    },

    async open() {
      if (stock.open) return refuse('inventory is already open');
      stock.open = true;
      return ok();
    },

    async order(id) {
      const order = orders.get(id);
      return order ? { status: order.status, qty: order.qty } : null;
    },

    async stock() {
      return { ...stock };
    },
  };

  return host;
};

export default createHost;
