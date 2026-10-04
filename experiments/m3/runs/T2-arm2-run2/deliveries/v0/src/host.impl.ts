import type { CreateHost, Host, Message, Outcome, OrderView } from '../host.ts';

const INVENTORY = 'inventory';
const CAPACITY = 3;

type Status = OrderView['status'];

/** One step of the system, reported to an optional observer (the trace seam). */
export interface StepEvent {
  kind: 'place' | 'cancel' | 'restock' | 'deliver';
  data: Record<string, unknown>;
  outcome?: Outcome;
}

export interface Snapshot {
  available: number;
  reserved: number;
  orders: Record<string, OrderView>;
  inFlight: Message[];
}

class Network {
  private seq = 0;
  readonly queue: Message[] = [];

  send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    this.seq += 1;
    this.queue.push({ id: `m${this.seq}`, from, to, action, data });
  }

  take(id: string): Message | undefined {
    const i = this.queue.findIndex((m) => m.id === id);
    if (i < 0) return undefined;
    return this.queue.splice(i, 1)[0];
  }
}

class Inventory {
  available = 1;
  reserved = 0;
  private readonly net: Network;

  constructor(net: Network) {
    this.net = net;
  }

  restock(): Outcome {
    if (this.available + this.reserved >= CAPACITY) return { ok: false, reason: 'inventory is full' };
    this.available += 1;
    return { ok: true };
  }

  receive(m: Message): void {
    if (m.action === 'Reserve') {
      const qty = m.data.qty as number;
      const from = m.data.from as string;
      if (this.available >= qty) {
        this.available -= qty;
        this.reserved += qty;
        this.net.send(INVENTORY, from, 'Reserved', {});
      } else {
        this.net.send(INVENTORY, from, 'OutOfStock', {});
      }
    } else if (m.action === 'Release') {
      const qty = m.data.qty as number;
      this.reserved -= qty;
      this.available += qty;
    }
  }
}

class Order {
  status: Status = 'pending';
  readonly id: string;
  readonly qty: number;
  private readonly net: Network;

  constructor(net: Network, id: string, qty: number) {
    this.net = net;
    this.id = id;
    this.qty = qty;
    this.net.send(id, INVENTORY, 'Reserve', { from: id, qty });
  }

  cancel(): Outcome {
    if (this.status === 'confirmed') {
      this.status = 'cancelled';
      this.release();
      return { ok: true };
    }
    if (this.status === 'pending') {
      this.status = 'cancelling';
      return { ok: true };
    }
    return { ok: false, reason: `order is ${this.status}` };
  }

  receive(m: Message): void {
    if (m.action === 'Reserved') {
      if (this.status === 'pending') this.status = 'confirmed';
      else if (this.status === 'cancelling') {
        this.status = 'cancelled';
        this.release();
      }
    } else if (m.action === 'OutOfStock') {
      if (this.status === 'pending') this.status = 'rejected';
      else if (this.status === 'cancelling') this.status = 'cancelled';
    }
  }

  private release(): void {
    this.net.send(this.id, INVENTORY, 'Release', { qty: this.qty });
  }
}

export class System implements Host {
  private readonly net = new Network();
  private readonly inventory = new Inventory(this.net);
  private readonly orders = new Map<string, Order>();
  private readonly observer?: (e: StepEvent) => void;

  constructor(observer?: (e: StepEvent) => void) {
    this.observer = observer;
  }

  private report(e: StepEvent): void {
    if (this.observer) this.observer(e);
  }

  async place(order: string, qty: number): Promise<Outcome> {
    const outcome = this.placeNow(order, qty);
    this.report({ kind: 'place', data: { order, qty }, outcome });
    return outcome;
  }

  private placeNow(order: string, qty: number): Outcome {
    if (typeof order !== 'string') return { ok: false, reason: 'order id must be a string' };
    if (order === INVENTORY) return { ok: false, reason: 'order id is reserved for the inventory' };
    if (qty !== 1 && qty !== 2) return { ok: false, reason: 'qty must be 1 or 2' };
    if (this.orders.has(order)) return { ok: false, reason: 'order already exists' };
    this.orders.set(order, new Order(this.net, order, qty));
    return { ok: true };
  }

  async cancel(order: string): Promise<Outcome> {
    const o = this.orders.get(order);
    const outcome: Outcome = o ? o.cancel() : { ok: false, reason: 'no such order' };
    this.report({ kind: 'cancel', data: { order }, outcome });
    return outcome;
  }

  async restock(): Promise<Outcome> {
    const outcome = this.inventory.restock();
    this.report({ kind: 'restock', data: {}, outcome });
    return outcome;
  }

  async order(order: string): Promise<OrderView | null> {
    const o = this.orders.get(order);
    return o ? { status: o.status, qty: o.qty } : null;
  }

  async stock(): Promise<{ available: number; reserved: number }> {
    return { available: this.inventory.available, reserved: this.inventory.reserved };
  }

  async inFlight(): Promise<Message[]> {
    return this.net.queue.map((m) => ({ ...m, data: { ...m.data } }));
  }

  async deliver(id: string): Promise<void> {
    this.deliverNow(id);
  }

  async deliverAll(): Promise<void> {
    while (this.net.queue.length > 0) this.deliverNow(this.net.queue[0].id);
  }

  private deliverNow(id: string): void {
    const m = this.net.take(id);
    if (!m) return;
    if (m.to === INVENTORY) this.inventory.receive(m);
    else this.orders.get(m.to)?.receive(m);
    this.report({ kind: 'deliver', data: { from: m.from, to: m.to, action: m.action, msg: { ...m.data } } });
  }

  /** The whole observable state, for tracing and tests. */
  snapshot(): Snapshot {
    const orders: Record<string, OrderView> = {};
    for (const [id, o] of this.orders) orders[id] = { status: o.status, qty: o.qty };
    return {
      available: this.inventory.available,
      reserved: this.inventory.reserved,
      orders,
      inFlight: this.net.queue.map((m) => ({ ...m, data: { ...m.data } })),
    };
  }
}

const createHost: CreateHost = async () => new System();

export default createHost;
