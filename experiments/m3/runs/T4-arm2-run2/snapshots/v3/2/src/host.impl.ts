// Checkout across cart, inventory and payments: carts, one inventory and one
// payment service that only talk by messages held on a network until delivered.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export type CartStatus = 'open' | 'reserving' | 'paying' | 'paid' | 'failed' | 'cancelling' | 'cancelled' | 'returned' | 'declined' | 'abandoning';

export interface CartView {
  status: CartStatus;
  items: number;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  open(cart: string): Promise<Outcome>;
  add(cart: string): Promise<Outcome>;
  checkout(cart: string): Promise<Outcome>;
  cancel(cart: string): Promise<Outcome>;
  returnCart(cart: string): Promise<Outcome>;
  retry(cart: string): Promise<Outcome>;
  abandon(cart: string): Promise<Outcome>;
  paymentTimeout(cart: string): Promise<Outcome>;
  declineCards(): Promise<Outcome>;
  acceptCards(): Promise<Outcome>;
  cart(cart: string): Promise<CartView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
  payments(): Promise<{ charged: number; declining: boolean }>;
}

export const INVENTORY = 'inventory';
export const PAYMENTS = 'payments';
export const INITIAL_STOCK = 2;
export const MAX_ITEMS = 2;
export const CHARGE_LIMIT = 4;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

interface Cart {
  status: CartStatus;
  items: number;
}

export class Checkout implements Host {
  private available = INITIAL_STOCK;
  private reserved = 0;
  private charged = 0;
  private declining = false;
  private carts = new Map<string, Cart>();
  private network = new Map<string, Message>();
  private nextId = 1;

  private send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${this.nextId++}`;
    this.network.set(id, { id, from, to, action, data });
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async open(id: string): Promise<Outcome> {
    if (id === INVENTORY || id === PAYMENTS) return refuse('id is taken by a service');
    if (this.carts.has(id)) return refuse('cart already exists');
    this.carts.set(id, { status: 'open', items: 0 });
    return OK;
  }

  async add(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status !== 'open') return refuse(`cart is ${c.status}`);
    if (c.items >= MAX_ITEMS) return refuse('cart is full');
    c.items += 1;
    return OK;
  }

  async checkout(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status !== 'open') return refuse(`cart is ${c.status}`);
    if (c.items < 1) return refuse('cart is empty');
    c.status = 'reserving';
    this.send(id, INVENTORY, 'Reserve', { from: id, qty: c.items });
    return OK;
  }

  async cancel(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status === 'open') {
      c.status = 'cancelled';
      return OK;
    }
    if (c.status === 'reserving') {
      c.status = 'cancelling';
      return OK;
    }
    if (c.status === 'paying') return refuse('payment in progress');
    return refuse(`cart is ${c.status}`);
  }

  async returnCart(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status !== 'paid') return refuse(`cart is ${c.status}`);
    c.status = 'returned';
    this.send(id, PAYMENTS, 'Refund', { amount: c.items });
    this.send(id, INVENTORY, 'Release', { qty: c.items });
    return OK;
  }

  async retry(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status !== 'declined') return refuse(`cart is ${c.status}`);
    c.status = 'paying';
    this.send(id, PAYMENTS, 'Charge', { from: id, amount: c.items });
    return OK;
  }

  async abandon(id: string): Promise<Outcome> {
    const c = this.carts.get(id);
    if (!c) return refuse('no such cart');
    if (c.status !== 'declined') return refuse(`cart is ${c.status}`);
    c.status = 'failed';
    this.send(id, INVENTORY, 'Release', { qty: c.items });
    return OK;
  }

  async declineCards(): Promise<Outcome> {
    if (this.declining) return refuse('already declining');
    this.declining = true;
    return OK;
  }

  async acceptCards(): Promise<Outcome> {
    if (!this.declining) return refuse('already accepting');
    this.declining = false;
    return OK;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  async cart(id: string): Promise<CartView | null> {
    const c = this.carts.get(id);
    return c ? { status: c.status, items: c.items } : null;
  }

  async stock(): Promise<{ available: number; reserved: number }> {
    return { available: this.available, reserved: this.reserved };
  }

  async payments(): Promise<{ charged: number; declining: boolean }> {
    return { charged: this.charged, declining: this.declining };
  }

  // ── network ──────────────────────────────────────────────────────────────

  async inFlight(): Promise<Message[]> {
    return [...this.network.values()].map((m) => ({ ...m, data: { ...m.data } }));
  }

  async deliver(id: string): Promise<void> {
    const m = this.network.get(id);
    if (!m) return;
    this.network.delete(id);
    this.receive(m);
  }

  async deliverAll(): Promise<void> {
    while (this.network.size > 0) {
      const [id] = this.network.keys();
      await this.deliver(id);
    }
  }

  private receive(m: Message): void {
    if (m.to === INVENTORY) this.inventoryReceive(m);
    else if (m.to === PAYMENTS) this.paymentsReceive(m);
    else this.cartReceive(m);
  }

  private inventoryReceive(m: Message): void {
    if (m.action === 'Reserve') {
      const from = String(m.data.from);
      const qty = Number(m.data.qty);
      if (qty <= this.available) {
        this.available -= qty;
        this.reserved += qty;
        this.send(INVENTORY, from, 'Reserved', {});
      } else {
        this.send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (m.action === 'Release') {
      const qty = Number(m.data.qty);
      this.reserved -= qty;
      this.available += qty;
    }
  }

  private paymentsReceive(m: Message): void {
    if (m.action === 'Refund') {
      this.charged -= Number(m.data.amount);
      return;
    }
    if (m.action !== 'Charge') return;
    const from = String(m.data.from);
    const amount = Number(m.data.amount);
    if (this.declining || this.charged + amount > CHARGE_LIMIT) {
      this.send(PAYMENTS, from, 'Declined', {});
    } else {
      this.charged += amount;
      this.send(PAYMENTS, from, 'Charged', {});
    }
  }

  private cartReceive(m: Message): void {
    const id = m.to;
    const c = this.carts.get(id);
    if (!c) return;
    switch (m.action) {
      case 'Reserved':
        if (c.status === 'reserving') {
          c.status = 'paying';
          this.send(id, PAYMENTS, 'Charge', { from: id, amount: c.items });
        } else if (c.status === 'cancelling') {
          c.status = 'cancelled';
          this.send(id, INVENTORY, 'Release', { qty: c.items });
        }
        return;
      case 'OutOfStock':
        if (c.status === 'reserving') c.status = 'failed';
        else if (c.status === 'cancelling') c.status = 'cancelled';
        return;
      case 'Charged':
        if (c.status === 'paying') c.status = 'paid';
        return;
      case 'Declined':
        if (c.status === 'paying') c.status = 'declined';
        return;
    }
  }
}

export default async function createHost(): Promise<Host> {
  return new Checkout();
}
