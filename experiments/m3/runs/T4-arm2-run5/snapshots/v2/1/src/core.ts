// The stateful core of the checkout: carts, inventory, payment service and the
// messages in transit between them. Every function takes the whole system state
// and mutates it in place; a refused command returns before any mutation.

import type { Message, Outcome, CartView } from '../host.ts';

export type Status = CartView['status'];

export interface Cart {
  status: Status;
  items: number;
}

export interface System {
  carts: Map<string, Cart>;
  inventory: { available: number; reserved: number };
  payments: { charged: number; declining: boolean };
  inFlight: Message[];
  nextMessage: number;
}

export const INVENTORY = 'inventory';
export const PAYMENTS = 'payments';
export const INITIAL_STOCK = 2;
export const MAX_ITEMS = 2;
export const CHARGE_LIMIT = 4;
export const PRICE = 1;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export function createSystem(): System {
  return {
    carts: new Map(),
    inventory: { available: INITIAL_STOCK, reserved: 0 },
    payments: { charged: 0, declining: false },
    inFlight: [],
    nextMessage: 1,
  };
}

function send(sys: System, from: string, to: string, action: string, data: Record<string, unknown>): void {
  sys.inFlight.push({ id: `m${sys.nextMessage++}`, from, to, action, data });
}

// ── Commands ────────────────────────────────────────────────────────────────

export function open(sys: System, id: string): Outcome {
  if (id === INVENTORY || id === PAYMENTS) return refuse(`"${id}" is reserved for a service`);
  if (sys.carts.has(id)) return refuse('cart already exists');
  sys.carts.set(id, { status: 'open', items: 0 });
  return OK;
}

export function add(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  if (cart.status !== 'open') return refuse(`cart is ${cart.status}`);
  if (cart.items >= MAX_ITEMS) return refuse(`cart already holds ${MAX_ITEMS} units`);
  cart.items += 1;
  return OK;
}

export function checkout(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  if (cart.status !== 'open') return refuse(`cart is ${cart.status}`);
  if (cart.items < 1) return refuse('cart is empty');
  cart.status = 'reserving';
  send(sys, id, INVENTORY, 'Reserve', { from: id, qty: cart.items });
  return OK;
}

export function cancel(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  switch (cart.status) {
    case 'open':
      cart.status = 'cancelled';
      return OK;
    case 'reserving':
      cart.status = 'cancelling';
      return OK;
    case 'paying':
      return refuse('payment in progress');
    default:
      return refuse(`cart is ${cart.status}`);
  }
}

export function returnCart(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  if (cart.status !== 'paid') return refuse(`cart is ${cart.status}`);
  cart.status = 'returned';
  send(sys, id, PAYMENTS, 'Refund', { amount: cart.items * PRICE });
  send(sys, id, INVENTORY, 'Release', { qty: cart.items });
  return OK;
}

export function retry(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  if (cart.status !== 'declined') return refuse(`cart is ${cart.status}`);
  cart.status = 'paying';
  send(sys, id, PAYMENTS, 'Charge', { from: id, amount: cart.items * PRICE });
  return OK;
}

export function abandon(sys: System, id: string): Outcome {
  const cart = sys.carts.get(id);
  if (!cart) return refuse('no such cart');
  if (cart.status !== 'declined') return refuse(`cart is ${cart.status}`);
  cart.status = 'failed';
  send(sys, id, INVENTORY, 'Release', { qty: cart.items });
  return OK;
}

export function declineCards(sys: System): Outcome {
  if (sys.payments.declining) return refuse('already declining');
  sys.payments.declining = true;
  return OK;
}

export function acceptCards(sys: System): Outcome {
  if (!sys.payments.declining) return refuse('already accepting');
  sys.payments.declining = false;
  return OK;
}

// ── Message handling ────────────────────────────────────────────────────────

function onInventory(sys: System, msg: Message): void {
  const inv = sys.inventory;
  if (msg.action === 'Reserve') {
    const from = String(msg.data.from);
    const qty = Number(msg.data.qty);
    if (qty <= inv.available) {
      inv.available -= qty;
      inv.reserved += qty;
      send(sys, INVENTORY, from, 'Reserved', {});
    } else {
      send(sys, INVENTORY, from, 'OutOfStock', {});
    }
  } else if (msg.action === 'Release') {
    const qty = Number(msg.data.qty);
    inv.reserved -= qty;
    inv.available += qty;
  }
}

function onPayments(sys: System, msg: Message): void {
  const pay = sys.payments;
  if (msg.action === 'Refund') {
    pay.charged -= Number(msg.data.amount);
    return;
  }
  if (msg.action !== 'Charge') return;
  const from = String(msg.data.from);
  const amount = Number(msg.data.amount);
  if (pay.declining || pay.charged + amount > CHARGE_LIMIT) {
    send(sys, PAYMENTS, from, 'Declined', {});
  } else {
    pay.charged += amount;
    send(sys, PAYMENTS, from, 'Charged', {});
  }
}

function onCart(sys: System, id: string, msg: Message): void {
  const cart = sys.carts.get(id);
  if (!cart) return;
  switch (`${cart.status}/${msg.action}`) {
    case 'reserving/Reserved':
      cart.status = 'paying';
      send(sys, id, PAYMENTS, 'Charge', { from: id, amount: cart.items * PRICE });
      break;
    case 'reserving/OutOfStock':
      cart.status = 'failed';
      break;
    case 'cancelling/Reserved':
      cart.status = 'cancelled';
      send(sys, id, INVENTORY, 'Release', { qty: cart.items });
      break;
    case 'cancelling/OutOfStock':
      cart.status = 'cancelled';
      break;
    case 'paying/Charged':
      cart.status = 'paid';
      break;
    case 'paying/Declined':
      cart.status = 'failed';
      send(sys, id, INVENTORY, 'Release', { qty: cart.items });
      break;
    default:
      // An answer the cart is not waiting for: ignored.
      break;
  }
}

/** Deliver one message in transit; returns false when no message has that id. */
export function deliver(sys: System, messageId: string): boolean {
  const i = sys.inFlight.findIndex((m) => m.id === messageId);
  if (i < 0) return false;
  const [msg] = sys.inFlight.splice(i, 1);
  if (msg.to === INVENTORY) onInventory(sys, msg);
  else if (msg.to === PAYMENTS) onPayments(sys, msg);
  else onCart(sys, msg.to, msg);
  return true;
}
