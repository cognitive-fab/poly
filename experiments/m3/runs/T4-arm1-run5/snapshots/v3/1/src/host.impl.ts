import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const MAX_ITEMS = 2;
const MAX_CHARGED = 4;

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const carts = new Map<string, Cart>();
  const stock = { available: 2, reserved: 0 };
  const pay = { charged: 0, declining: false };
  let queue: Message[] = [];
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    queue.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const onInventory = (m: Message): void => {
    if (m.action === 'Reserve') {
      const from = String(m.data.from);
      const qty = Number(m.data.qty);
      if (qty <= stock.available) {
        stock.available -= qty;
        stock.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (m.action === 'Release') {
      const qty = Math.min(Number(m.data.qty), stock.reserved);
      stock.reserved -= qty;
      stock.available += qty;
    }
  };

  const onPayments = (m: Message): void => {
    if (m.action === 'Refund') {
      pay.charged = Math.max(0, pay.charged - Number(m.data.amount));
      return;
    }
    if (m.action !== 'Charge') return;
    const from = String(m.data.from);
    const amount = Number(m.data.amount);
    if (!pay.declining && pay.charged + amount <= MAX_CHARGED) {
      pay.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    } else {
      send(PAYMENTS, from, 'Declined', {});
    }
  };

  const onCart = (id: string, c: Cart, m: Message): void => {
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
  };

  const dispatch = (m: Message): void => {
    if (m.to === INVENTORY) return onInventory(m);
    if (m.to === PAYMENTS) return onPayments(m);
    const c = carts.get(m.to);
    if (c) onCart(m.to, c, m);
  };

  const host: Host = {
    async inFlight() {
      return queue.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const i = queue.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [m] = queue.splice(i, 1);
      dispatch(m);
    },
    async deliverAll() {
      while (queue.length > 0) {
        const m = queue.shift()!;
        dispatch(m);
      }
    },

    async open(id) {
      if (carts.has(id)) return no('cart already exists');
      carts.set(id, { status: 'open', items: 0 });
      return ok();
    },
    async add(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status !== 'open') return no(`cart is ${c.status}`);
      if (c.items >= MAX_ITEMS) return no('cart is full');
      c.items++;
      return ok();
    },
    async checkout(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status !== 'open') return no(`cart is ${c.status}`);
      if (c.items < 1) return no('cart is empty');
      c.status = 'reserving';
      send(id, INVENTORY, 'Reserve', { from: id, qty: c.items });
      return ok();
    },
    async cancel(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status === 'open') {
        c.status = 'cancelled';
        return ok();
      }
      if (c.status === 'reserving') {
        c.status = 'cancelling';
        return ok();
      }
      if (c.status === 'paying') return no('payment in progress');
      return no(`cart is ${c.status}`);
    },
    async returnCart(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status !== 'paid') return no(`cart is ${c.status}`);
      c.status = 'returned';
      send(id, PAYMENTS, 'Refund', { amount: c.items });
      send(id, INVENTORY, 'Release', { qty: c.items });
      return ok();
    },
    async retry(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status !== 'declined') return no(`cart is ${c.status}`);
      c.status = 'paying';
      send(id, PAYMENTS, 'Charge', { from: id, amount: c.items });
      return ok();
    },
    async abandon(id) {
      const c = carts.get(id);
      if (!c) return no('no such cart');
      if (c.status !== 'declined') return no(`cart is ${c.status}`);
      c.status = 'failed';
      send(id, INVENTORY, 'Release', { qty: c.items });
      return ok();
    },
    async declineCards() {
      if (pay.declining) return no('already declining');
      pay.declining = true;
      return ok();
    },
    async acceptCards() {
      if (!pay.declining) return no('already accepting');
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
