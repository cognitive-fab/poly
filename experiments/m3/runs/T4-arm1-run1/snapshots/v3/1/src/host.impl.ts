import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const MAX_ITEMS = 2;
const CHARGE_LIMIT = 4;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const carts = new Map<string, Cart>();
  const stock = { available: 2, reserved: 0 };
  const pay = { charged: 0, declining: false };
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  }

  function receiveInventory(m: Message): void {
    if (m.action === 'Reserve') {
      const from = m.data.from as string;
      const qty = m.data.qty as number;
      if (qty <= stock.available) {
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

  function receivePayments(m: Message): void {
    if (m.action === 'Refund') {
      pay.charged -= m.data.amount as number;
      return;
    }
    if (m.action !== 'Charge') return;
    const from = m.data.from as string;
    const amount = m.data.amount as number;
    if (!pay.declining && pay.charged + amount <= CHARGE_LIMIT) {
      pay.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    } else {
      send(PAYMENTS, from, 'Declined', {});
    }
  }

  function receiveCart(id: string, m: Message): void {
    const c = carts.get(id);
    if (!c) return;
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

  function dispatch(m: Message): void {
    if (m.to === INVENTORY) receiveInventory(m);
    else if (m.to === PAYMENTS) receivePayments(m);
    else receiveCart(m.to, m);
  }

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const m = inFlight.get(id);
      if (!m) return;
      inFlight.delete(id);
      dispatch(m);
    },
    async deliverAll() {
      while (inFlight.size > 0) {
        const [id, m] = inFlight.entries().next().value as [string, Message];
        inFlight.delete(id);
        dispatch(m);
      }
    },
    async open(cart) {
      if (carts.has(cart)) return refuse('cart already exists');
      carts.set(cart, { status: 'open', items: 0 });
      return ok;
    },
    async add(cart) {
      const c = carts.get(cart);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse('cart is not open');
      if (c.items >= MAX_ITEMS) return refuse('cart is full');
      c.items++;
      return ok;
    },
    async checkout(cart) {
      const c = carts.get(cart);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse('cart is not open');
      if (c.items < 1) return refuse('cart is empty');
      c.status = 'reserving';
      send(cart, INVENTORY, 'Reserve', { from: cart, qty: c.items });
      return ok;
    },
    async cancel(cart) {
      const c = carts.get(cart);
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
    async returnCart(cart) {
      const c = carts.get(cart);
      if (!c) return refuse('no such cart');
      if (c.status !== 'paid') return refuse('cart is not paid');
      c.status = 'returned';
      send(cart, PAYMENTS, 'Refund', { amount: c.items });
      send(cart, INVENTORY, 'Release', { qty: c.items });
      return ok;
    },
    async retry(cart) {
      const c = carts.get(cart);
      if (!c) return refuse('no such cart');
      if (c.status !== 'declined') return refuse('cart is not declined');
      c.status = 'paying';
      send(cart, PAYMENTS, 'Charge', { from: cart, amount: c.items });
      return ok;
    },
    async abandon(cart) {
      const c = carts.get(cart);
      if (!c) return refuse('no such cart');
      if (c.status !== 'declined') return refuse('cart is not declined');
      c.status = 'failed';
      send(cart, INVENTORY, 'Release', { qty: c.items });
      return ok;
    },
    async declineCards() {
      if (pay.declining) return refuse('already declining');
      pay.declining = true;
      return ok;
    },
    async acceptCards() {
      if (!pay.declining) return refuse('already accepting');
      pay.declining = false;
      return ok;
    },
    async cart(cart) {
      const c = carts.get(cart);
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
