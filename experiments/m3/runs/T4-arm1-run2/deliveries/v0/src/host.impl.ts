import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const MAX_ITEMS = 2;
const INITIAL_STOCK = 2;
const CHARGE_LIMIT = 4;
const PRICE = 1;

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const inventory = { available: INITIAL_STOCK, reserved: 0 };
  const payment = { charged: 0, declining: false };
  const carts = new Map<string, Cart>();
  const transit: Message[] = [];
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    transit.push({ id: `m${nextId++}`, from, to, action, data });
  }

  function onInventory(m: Message): void {
    if (m.action === 'Reserve') {
      const from = m.data.from as string;
      const qty = m.data.qty as number;
      if (qty <= inventory.available) {
        inventory.available -= qty;
        inventory.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (m.action === 'Release') {
      const qty = m.data.qty as number;
      inventory.reserved -= qty;
      inventory.available += qty;
    }
  }

  function onPayments(m: Message): void {
    if (m.action !== 'Charge') return;
    const from = m.data.from as string;
    const amount = m.data.amount as number;
    if (payment.declining || payment.charged + amount > CHARGE_LIMIT) {
      send(PAYMENTS, from, 'Declined', {});
    } else {
      payment.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    }
  }

  function onCart(id: string, c: Cart, m: Message): void {
    switch (m.action) {
      case 'Reserved':
        if (c.status === 'reserving') {
          c.status = 'paying';
          send(id, PAYMENTS, 'Charge', { from: id, amount: c.items * PRICE });
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
        break;
      case 'Declined':
        if (c.status === 'paying') {
          c.status = 'failed';
          send(id, INVENTORY, 'Release', { qty: c.items });
        }
        break;
    }
  }

  function dispatch(m: Message): void {
    if (m.to === INVENTORY) return onInventory(m);
    if (m.to === PAYMENTS) return onPayments(m);
    const c = carts.get(m.to);
    if (c) onCart(m.to, c, m);
  }

  const host: Host = {
    async inFlight() {
      return transit.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const i = transit.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [m] = transit.splice(i, 1);
      dispatch(m);
    },
    async deliverAll() {
      while (transit.length > 0) dispatch(transit.shift()!);
    },

    async open(id) {
      if (carts.has(id)) return refuse('cart already exists');
      carts.set(id, { status: 'open', items: 0 });
      return ok;
    },
    async add(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse(`cart is ${c.status}`);
      if (c.items >= MAX_ITEMS) return refuse(`cart already holds ${MAX_ITEMS} units`);
      c.items++;
      return ok;
    },
    async checkout(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse(`cart is ${c.status}`);
      if (c.items === 0) return refuse('cart is empty');
      c.status = 'reserving';
      send(id, INVENTORY, 'Reserve', { from: id, qty: c.items });
      return ok;
    },
    async cancel(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status === 'open') {
        c.status = 'cancelled';
        return ok;
      }
      if (c.status === 'reserving') {
        c.status = 'cancelling';
        return ok;
      }
      if (c.status === 'paying') return refuse('payment in progress');
      return refuse(`cart is ${c.status}`);
    },
    async declineCards() {
      if (payment.declining) return refuse('already declining');
      payment.declining = true;
      return ok;
    },
    async acceptCards() {
      if (!payment.declining) return refuse('already accepting');
      payment.declining = false;
      return ok;
    },
    async cart(id) {
      const c = carts.get(id);
      return c ? { status: c.status, items: c.items } : null;
    },
    async stock() {
      return { available: inventory.available, reserved: inventory.reserved };
    },
    async payments() {
      return { charged: payment.charged, declining: payment.declining };
    },
  };
  return host;
};

export default createHost;
