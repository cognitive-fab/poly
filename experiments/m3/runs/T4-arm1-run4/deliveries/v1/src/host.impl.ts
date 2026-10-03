import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const MAX_ITEMS = 2;
const INITIAL_STOCK = 2;
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
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  }

  function onInventory(msg: Message): void {
    if (msg.action === 'Reserve') {
      const from = String(msg.data.from);
      const qty = Number(msg.data.qty);
      if (qty > 0 && stock.available >= qty) {
        stock.available -= qty;
        stock.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Math.min(Number(msg.data.qty), stock.reserved);
      if (qty > 0) {
        stock.reserved -= qty;
        stock.available += qty;
      }
    }
  }

  function onPayments(msg: Message): void {
    if (msg.action === 'Refund') {
      const amount = Math.min(Number(msg.data.amount), pay.charged);
      if (amount > 0) pay.charged -= amount;
      return;
    }
    if (msg.action !== 'Charge') return;
    const from = String(msg.data.from);
    const amount = Number(msg.data.amount);
    if (pay.declining || !(amount > 0) || pay.charged + amount > CHARGE_LIMIT) {
      send(PAYMENTS, from, 'Declined', {});
    } else {
      pay.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    }
  }

  function onCart(id: string, cart: Cart, msg: Message): void {
    switch (msg.action) {
      case 'Reserved':
        if (cart.status === 'reserving') {
          cart.status = 'paying';
          send(id, PAYMENTS, 'Charge', { from: id, amount: cart.items });
        } else if (cart.status === 'cancelling') {
          cart.status = 'cancelled';
          send(id, INVENTORY, 'Release', { qty: cart.items });
        }
        break;
      case 'OutOfStock':
        if (cart.status === 'reserving') cart.status = 'failed';
        else if (cart.status === 'cancelling') cart.status = 'cancelled';
        break;
      case 'Charged':
        if (cart.status === 'paying') cart.status = 'paid';
        break;
      case 'Declined':
        if (cart.status === 'paying') {
          cart.status = 'failed';
          send(id, INVENTORY, 'Release', { qty: cart.items });
        }
        break;
    }
  }

  function dispatch(msg: Message): void {
    if (msg.to === INVENTORY) onInventory(msg);
    else if (msg.to === PAYMENTS) onPayments(msg);
    else {
      const cart = carts.get(msg.to);
      if (cart) onCart(msg.to, cart, msg);
    }
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
        const [id, msg] = inFlight.entries().next().value!;
        inFlight.delete(id);
        dispatch(msg);
      }
    },

    async open(id) {
      if (carts.has(id)) return refuse('cart already exists');
      carts.set(id, { status: 'open', items: 0 });
      return ok();
    },
    async add(id) {
      const cart = carts.get(id);
      if (!cart) return refuse('no such cart');
      if (cart.status !== 'open') return refuse(`cart is ${cart.status}`);
      if (cart.items >= MAX_ITEMS) return refuse(`cart already has ${MAX_ITEMS} units`);
      cart.items++;
      return ok();
    },
    async checkout(id) {
      const cart = carts.get(id);
      if (!cart) return refuse('no such cart');
      if (cart.status !== 'open') return refuse(`cart is ${cart.status}`);
      if (cart.items < 1) return refuse('cart is empty');
      cart.status = 'reserving';
      send(id, INVENTORY, 'Reserve', { from: id, qty: cart.items });
      return ok();
    },
    async cancel(id) {
      const cart = carts.get(id);
      if (!cart) return refuse('no such cart');
      if (cart.status === 'open') {
        cart.status = 'cancelled';
        return ok();
      }
      if (cart.status === 'reserving') {
        cart.status = 'cancelling';
        return ok();
      }
      if (cart.status === 'paying') return refuse('payment in progress');
      return refuse(`cart is ${cart.status}`);
    },
    async returnCart(id) {
      const cart = carts.get(id);
      if (!cart) return refuse('no such cart');
      if (cart.status !== 'paid') return refuse(`cart is ${cart.status}`);
      cart.status = 'returned';
      send(id, PAYMENTS, 'Refund', { amount: cart.items });
      send(id, INVENTORY, 'Release', { qty: cart.items });
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
      const cart = carts.get(id);
      return cart ? { status: cart.status, items: cart.items } : null;
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
