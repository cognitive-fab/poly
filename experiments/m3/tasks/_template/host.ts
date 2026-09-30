// The host interface of a task (PT13): the API every arm implements. This template shows the shape; each task
// replaces the methods and queries with its own, and keeps Network only when it is multi-machine (S91).

/** A message sent by one part of the system to another, not yet delivered. */
export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

/** The network of a multi-machine task (S91): nothing is delivered until deliver or deliverAll is called. */
export interface Network {
  /** Every message in transit, in no promised order. */
  inFlight(): Promise<Message[]>;
  /** Deliver one message in transit, by its id. */
  deliver(id: string): Promise<void>;
  /** Deliver every message in transit, and every message those deliveries send, until none is left. */
  deliverAll(): Promise<void>;
}

/** The outcome of a command: accepted, or refused with a reason the brief names. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface Host extends Network {
  /** An example command. */
  example(id: string): Promise<Outcome>;
  /** An example query: plain JSON, or null for an id the host does not know. */
  status(id: string): Promise<{ state: string } | null>;
}

/** Every arm's module default-exports a factory of a fresh host. */
export type CreateHost = () => Promise<Host>;
