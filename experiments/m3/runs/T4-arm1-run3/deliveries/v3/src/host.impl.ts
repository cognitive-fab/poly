import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const INITIAL_STOCK = 2;
const MAX_ITEMS = 2;
const CHARGE_LIMIT = 4;

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const carts = new Map<string, Cart>();
  const stock = { available: INITIAL_STOCK, reserved: 0 };
  const pay = { charged: 0, declining: false };
  const transit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    transit.set(id, { id, from, to, action, data });
  }

  function inventoryReceive(m: Message): void {
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

  function paymentsReceive(m: Message): void {
    if (m.action === 'Refund') {
      pay.charged -= m.data.amount as number;
      return;
    }
    if (m.action !== 'Charge') return;
    const from = m.data.from as string;
    const amount = m.data.amount as number;
    if (pay.declining || pay.charged + amount > CHARGE_LIMIT) {
      send(PAYMENTS, from, 'Declined', {});
    } else {
      pay.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    }
  }

  function cartReceive(id: string, c: Cart, m: Message): void {
    switch (m.action) {
      case 'Reserved':
        if (c.status === 'reserving') {
          c.status = 'paying';
          send(id, PAYMENTS, 'Charge', { from: id, amount: c.items });
        } else if (c.status === 'cancelling') {
          c.status = 'cancelled';
          send(id, INVENTORY, 'Release', { qty: c.items });
        }
        break;
      case 'OutOfStock':
        if (c.status === 'reserving') c.status = 'failed';
        else if (c.status === 'cancelling') c.status = 'cancelled';
        break;
      case 'Charged':
        if (c.status === 'paying') c.status = 'paid';
        else if (c.status === 'abandoning') {
          c.status = 'failed';
          send(id, PAYMENTS, 'Refund', { amount: c.items });
        }
        break;
      case 'Declined':
        if (c.status === 'paying') c.status = 'declined';
        else if (c.status === 'abandoning') c.status = 'failed';
        break;
    }
  }

  function receive(m: Message): void {
    if (m.to === INVENTORY) inventoryReceive(m);
    else if (m.to === PAYMENTS) paymentsReceive(m);
    else {
      const c = carts.get(m.to);
      if (c) cartReceive(m.to, c, m);
    }
  }

  const host: Host = {
    async inFlight() {
      return [...transit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const m = transit.get(id);
      if (!m) return;
      transit.delete(id);
      receive(m);
    },
    async deliverAll() {
      while (transit.size > 0) {
        const [id, m] = transit.entries().next().value as [string, Message];
        transit.delete(id);
        receive(m);
      }
    },

    async open(id) {
      if (carts.has(id)) return refuse('cart already exists');
      carts.set(id, { status: 'open', items: 0 });
      return ok();
    },
    async add(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse(`cart is ${c.status}`);
      if (c.items >= MAX_ITEMS) return refuse(`cart already has ${MAX_ITEMS} units`);
      c.items++;
      return ok();
    },
    async checkout(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse(`cart is ${c.status}`);
      if (c.items < 1) return refuse('cart is empty');
      c.status = 'reserving';
      send(id, INVENTORY, 'Reserve', { from: id, qty: c.items });
      return ok();
    },
    async cancel(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status === 'open') {
        c.status = 'cancelled';
        return ok();
      }
      if (c.status === 'reserving') {
        c.status = 'cancelling';
        return ok();
      }
      if (c.status === 'paying') return refuse('payment is in progress');
      return refuse(`cart is ${c.status}`);
    },
    async returnCart(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'paid') return refuse(`cart is ${c.status}`);
      c.status = 'returned';
      send(id, PAYMENTS, 'Refund', { amount: c.items });
      send(id, INVENTORY, 'Release', { qty: c.items });
      return ok();
    },
    async retry(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'declined') return refuse(`cart is ${c.status}`);
      c.status = 'paying';
      send(id, PAYMENTS, 'Charge', { from: id, amount: c.items });
      return ok();
    },
    async abandon(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'declined') return refuse(`cart is ${c.status}`);
      c.status = 'failed';
      send(id, INVENTORY, 'Release', { qty: c.items });
      return ok();
    },
    async paymentTimeout(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'paying') return refuse(`cart is ${c.status}`);
      c.status = 'abandoning';
      send(id, INVENTORY, 'Release', { qty: c.items });
      return ok();
    },
    async declineCards() {
      if (pay.declining) return refuse('already declining');
      pay.declining = true;
      return ok();
    },
    async acceptCards() {
      if (!pay.declining) return refuse('already accepting');
      pay.declining = false;
      return ok();
    },
    async cart(id) {
      const c = carts.get(id);
      return c ? { status: c.status, items: c.items } : null;
    },
    async stock() {
      return { ...stock };
    },
    async payments() {
      return { ...pay };
    },
  };
  return host;
};

export default createHost;
