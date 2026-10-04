import type { CartView, CreateHost, Host, Message, Outcome } from '../host.ts';

const INVENTORY = 'inventory';
const PAYMENTS = 'payments';
const INITIAL_STOCK = 2;
const MAX_ITEMS = 2;
const CHARGE_LIMIT = 4;
const UNIT_PRICE = 1;

type Status = CartView['status'];

interface Cart {
  status: Status;
  items: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const carts = new Map<string, Cart>();
  const inventory = { available: INITIAL_STOCK, reserved: 0 };
  const payments = { charged: 0, declining: false };
  const transit: Message[] = [];
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    transit.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const onInventory = (msg: Message): void => {
    if (msg.action === 'Reserve') {
      const qty = Number(msg.data.qty);
      const from = String(msg.data.from);
      if (qty > 0 && inventory.available >= qty) {
        inventory.available -= qty;
        inventory.reserved += qty;
        send(INVENTORY, from, 'Reserved', {});
      } else {
        send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Math.min(Number(msg.data.qty), inventory.reserved);
      if (qty > 0) {
        inventory.reserved -= qty;
        inventory.available += qty;
      }
    }
  };

  const onPayments = (msg: Message): void => {
    if (msg.action === 'Refund') {
      const amount = Math.min(Number(msg.data.amount), payments.charged);
      if (amount > 0) payments.charged -= amount;
      return;
    }
    if (msg.action !== 'Charge') return;
    const amount = Number(msg.data.amount);
    const from = String(msg.data.from);
    if (!payments.declining && amount > 0 && payments.charged + amount <= CHARGE_LIMIT) {
      payments.charged += amount;
      send(PAYMENTS, from, 'Charged', {});
    } else {
      send(PAYMENTS, from, 'Declined', {});
    }
  };

  const onCart = (id: string, cart: Cart, msg: Message): void => {
    switch (msg.action) {
      case 'Reserved':
        if (cart.status === 'reserving') {
          cart.status = 'paying';
          send(id, PAYMENTS, 'Charge', { from: id, amount: cart.items * UNIT_PRICE });
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
  };

  const dispatch = (msg: Message): void => {
    if (msg.to === INVENTORY) onInventory(msg);
    else if (msg.to === PAYMENTS) onPayments(msg);
    else {
      const cart = carts.get(msg.to);
      if (cart) onCart(msg.to, cart, msg);
    }
  };

  const take = (id: string): Message | undefined => {
    const i = transit.findIndex((m) => m.id === id);
    return i < 0 ? undefined : transit.splice(i, 1)[0];
  };

  const host: Host = {
    async inFlight() {
      return transit.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const msg = take(id);
      if (msg) dispatch(msg);
    },
    async deliverAll() {
      while (transit.length > 0) dispatch(transit.shift()!);
    },

    async open(id) {
      if (id === INVENTORY || id === PAYMENTS) return refuse('reserved id');
      if (carts.has(id)) return refuse('cart already exists');
      carts.set(id, { status: 'open', items: 0 });
      return ok();
    },
    async add(id) {
      const cart = carts.get(id);
      if (!cart) return refuse('no such cart');
      if (cart.status !== 'open') return refuse(`cart is ${cart.status}`);
      if (cart.items >= MAX_ITEMS) return refuse('cart is full');
      cart.items += 1;
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
      send(id, PAYMENTS, 'Refund', { amount: cart.items * UNIT_PRICE });
      send(id, INVENTORY, 'Release', { qty: cart.items });
      return ok();
    },
    async declineCards() {
      if (payments.declining) return refuse('already declining');
      payments.declining = true;
      return ok();
    },
    async acceptCards() {
      if (!payments.declining) return refuse('already accepting');
      payments.declining = false;
      return ok();
    },

    async cart(id) {
      const cart = carts.get(id);
      return cart ? { status: cart.status, items: cart.items } : null;
    },
    async stock() {
      return { ...inventory };
    },
    async payments() {
      return { ...payments };
    },
  };
  return host;
};

export default createHost;
