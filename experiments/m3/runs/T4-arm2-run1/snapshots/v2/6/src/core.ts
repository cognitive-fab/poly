// The stateful core of the checkout: carts, one inventory, one payment service,
// and the network between them. Every change goes through step(action, data).

import type { CartStatus, Message, Outcome } from './types.ts';

export const INVENTORY = 'inventory';
export const PAYMENTS = 'payments';
export const INITIAL_STOCK = 2;
export const MAX_ITEMS = 2;
export const CHARGE_LIMIT = 4;

export interface Cart {
  status: CartStatus;
  items: number;
}

export interface State {
  carts: Record<string, Cart>;
  available: number;
  reserved: number;
  charged: number;
  declining: boolean;
  inFlight: Message[];
  nextId: number;
}

export type Action = 'open' | 'add' | 'checkout' | 'cancel' | 'returnCart' | 'retry' | 'abandon' | 'declineCards' | 'acceptCards' | 'deliver';

export interface StepEvent {
  action: Action;
  data: Record<string, unknown>;
  outcome: Outcome;
}

export type StepListener = (event: StepEvent, core: Core) => void;

export function initialState(): State {
  return {
    carts: Object.create(null) as Record<string, Cart>,
    available: INITIAL_STOCK,
    reserved: 0,
    charged: 0,
    declining: false,
    inFlight: [],
    nextId: 1,
  };
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export class Core {
  state: State = initialState();
  #listener: StepListener | null;

  constructor(listener: StepListener | null = null) {
    this.#listener = listener;
  }

  /** The single step boundary: apply one named action and report its outcome. */
  step(action: Action, data: Record<string, unknown>): Outcome {
    const outcome = this.#apply(action, data);
    if (this.#listener) this.#listener({ action, data, outcome }, this);
    return outcome;
  }

  #apply(action: Action, data: Record<string, unknown>): Outcome {
    switch (action) {
      case 'open': return this.#open(String(data.cart));
      case 'add': return this.#add(String(data.cart));
      case 'checkout': return this.#checkout(String(data.cart));
      case 'cancel': return this.#cancel(String(data.cart));
      case 'returnCart': return this.#returnCart(String(data.cart));
      case 'retry': return this.#retry(String(data.cart));
      case 'abandon': return this.#abandon(String(data.cart));
      case 'declineCards': return this.#declineCards();
      case 'acceptCards': return this.#acceptCards();
      case 'deliver': return this.#deliver(String(data.id));
      default: return refuse(`unknown action ${String(action)}`);
    }
  }

  #send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${this.state.nextId++}`;
    this.state.inFlight.push({ id, from, to, action, data });
  }

  #open(id: string): Outcome {
    if (id === INVENTORY || id === PAYMENTS) return refuse(`"${id}" is reserved for a service`);
    if (this.state.carts[id]) return refuse(`cart ${id} already exists`);
    this.state.carts[id] = { status: 'open', items: 0 };
    return ok;
  }

  #add(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status !== 'open') return refuse(`cart ${id} is ${cart.status}, not open`);
    if (cart.items >= MAX_ITEMS) return refuse(`cart ${id} already holds ${MAX_ITEMS} units`);
    cart.items += 1;
    return ok;
  }

  #checkout(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status !== 'open') return refuse(`cart ${id} is ${cart.status}, not open`);
    if (cart.items < 1) return refuse(`cart ${id} is empty`);
    cart.status = 'reserving';
    this.#send(id, INVENTORY, 'Reserve', { from: id, qty: cart.items });
    return ok;
  }

  #cancel(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status === 'open') { cart.status = 'cancelled'; return ok; }
    if (cart.status === 'reserving') { cart.status = 'cancelling'; return ok; }
    if (cart.status === 'paying') return refuse(`cart ${id} is paying: the payment is in progress`);
    return refuse(`cart ${id} is ${cart.status}`);
  }

  #returnCart(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status !== 'paid') return refuse(`cart ${id} is ${cart.status}, not paid`);
    cart.status = 'returned';
    this.#send(id, PAYMENTS, 'Refund', { amount: cart.items });
    this.#send(id, INVENTORY, 'Release', { qty: cart.items });
    return ok;
  }

  #retry(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status !== 'declined') return refuse(`cart ${id} is ${cart.status}, not declined`);
    cart.status = 'paying';
    this.#send(id, PAYMENTS, 'Charge', { from: id, amount: cart.items });
    return ok;
  }

  #abandon(id: string): Outcome {
    const cart = this.state.carts[id];
    if (!cart) return refuse(`no cart ${id}`);
    if (cart.status !== 'declined') return refuse(`cart ${id} is ${cart.status}, not declined`);
    cart.status = 'failed';
    this.#send(id, INVENTORY, 'Release', { qty: cart.items });
    return ok;
  }

  #declineCards(): Outcome {
    if (this.state.declining) return refuse('the payment service already declines');
    this.state.declining = true;
    return ok;
  }

  #acceptCards(): Outcome {
    if (!this.state.declining) return refuse('the payment service already accepts');
    this.state.declining = false;
    return ok;
  }

  #deliver(id: string): Outcome {
    const i = this.state.inFlight.findIndex((m) => m.id === id);
    if (i < 0) return refuse(`no message ${id} in transit`);
    const [msg] = this.state.inFlight.splice(i, 1);
    if (msg.to === INVENTORY) this.#inventory(msg);
    else if (msg.to === PAYMENTS) this.#payments(msg);
    else this.#cart(msg);
    return ok;
  }

  #inventory(msg: Message): void {
    const s = this.state;
    if (msg.action === 'Reserve') {
      const qty = Number(msg.data.qty);
      const from = String(msg.data.from);
      if (qty <= s.available) {
        s.available -= qty;
        s.reserved += qty;
        this.#send(INVENTORY, from, 'Reserved', {});
      } else {
        this.#send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (msg.action === 'Release') {
      const qty = Number(msg.data.qty);
      s.reserved -= qty;
      s.available += qty;
    }
  }

  #payments(msg: Message): void {
    const s = this.state;
    if (msg.action === 'Refund') {
      s.charged -= Number(msg.data.amount);
      return;
    }
    if (msg.action !== 'Charge') return;
    const amount = Number(msg.data.amount);
    const from = String(msg.data.from);
    if (s.declining || s.charged + amount > CHARGE_LIMIT) {
      this.#send(PAYMENTS, from, 'Declined', {});
    } else {
      s.charged += amount;
      this.#send(PAYMENTS, from, 'Charged', {});
    }
  }

  #cart(msg: Message): void {
    const cart = this.state.carts[msg.to];
    if (!cart) return;
    const id = msg.to;
    switch (msg.action) {
      case 'Reserved':
        if (cart.status === 'reserving') {
          cart.status = 'paying';
          this.#send(id, PAYMENTS, 'Charge', { from: id, amount: cart.items });
        } else if (cart.status === 'cancelling') {
          cart.status = 'cancelled';
          this.#send(id, INVENTORY, 'Release', { qty: cart.items });
        }
        return;
      case 'OutOfStock':
        if (cart.status === 'reserving') cart.status = 'failed';
        else if (cart.status === 'cancelling') cart.status = 'cancelled';
        return;
      case 'Charged':
        if (cart.status === 'paying') cart.status = 'paid';
        return;
      case 'Declined':
        // The units stay reserved: the customer may retry or abandon.
        if (cart.status === 'paying') cart.status = 'declined';
        return;
    }
  }
}
