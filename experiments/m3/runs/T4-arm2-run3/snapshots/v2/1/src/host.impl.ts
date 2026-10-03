import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const MAX_ITEMS = 2;
const INITIAL_STOCK = 2;
const CHARGE_CAP = 4;
const PRICE = 1;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const carts = new Map<string, Cart>();
  const stock = { available: INITIAL_STOCK, reserved: 0 };
  const pay = { charged: 0, declining: false };
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  // --- receivers ---------------------------------------------------------
  // Messages are routed by action name, so a cart may even be called
  // "inventory" or "payments" without colliding with the services.

  const inventoryReceive = (msg: Message): void => {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      if (qty <= stock.available) {
        stock.available -= qty;
        stock.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Number(msg.data.qty);
      stock.reserved -= qty;
      stock.available += qty;
    }
  };

  const paymentsReceive = (msg: Message): void => {
    if (msg.action === 'Refund') {
      pay.charged -= Number(msg.data.amount);
      return;
    }
    const from = String(msg.data.from);
    const amount = Number(msg.data.amount);
    if (pay.declining || pay.charged + amount > CHARGE_CAP) {
      send(PAYMENTS, from, 'Declined', {});
    } else {
      pay.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    }
  };

  const cartReceive = (id: string, msg: Message): void => {
    const c = carts.get(id);
    if (!c) return;
    switch (msg.action) {
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
        // Declined: the cart keeps its units until it retries or abandons.
        if (c.status === 'paying') c.status = 'declined';
        break;
    }
  };

  const receive = (msg: Message): void => {
    switch (msg.action) {
      case 'Reserve':
      case 'Release':
        return inventoryReceive(msg);
      case 'Charge':
      case 'Refund':
        return paymentsReceive(msg);
      default:
        return cartReceive(msg.to, msg);
    }
  };

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const msg = inFlight.get(id);
      if (!msg) return;
      inFlight.delete(id);
      receive(msg);
    },
    async deliverAll() {
      while (inFlight.size > 0) {
        const [id, msg] = inFlight.entries().next().value as [string, Message];
        inFlight.delete(id);
        receive(msg);
      }
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
      if (c.items >= MAX_ITEMS) return refuse('cart is full');
      c.items += 1;
      return ok;
    },
    async checkout(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'open') return refuse(`cart is ${c.status}`);
      if (c.items < 1) return refuse('cart is empty');
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
    async returnCart(id) {
      const c = carts.get(id);
      if (!c) return refuse('no such cart');
      if (c.status !== 'paid') return refuse(`cart is ${c.status}`);
      c.status = 'returned';
      send(id, PAYMENTS, 'Refund', { amount: c.items * PRICE });
      send(id, INVENTORY, 'Release', { qty: c.items });
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
