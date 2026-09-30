// The adapter's test fixture: a host interface over examples/checkout/checkout.poly, one inventory and the
// orders that ask it for its one item (M3-4). Not a task of the experiment.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export interface Network {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface Host extends Network {
  /** Place a new order: it asks the inventory whether the item is available. */
  place(order: string): Promise<Outcome>;
  /** An order's status. */
  order(order: string): Promise<{ status: string } | null>;
  /** The items left. */
  stock(): Promise<{ onHand: number } | null>;
}

export type CreateHost = () => Promise<Host>;
