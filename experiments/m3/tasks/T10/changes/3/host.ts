// T10 after change 3, a lease with fencing tokens, acknowledged releases and cancelled requests: the host interface every arm implements (PT13, S91).

/** A message sent by one part of the system to another, not yet delivered. */
export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

/** The network: nothing is delivered until deliver or deliverAll is called. */
export interface Network {
  /** Every message in transit, in no promised order. */
  inFlight(): Promise<Message[]>;
  /** Deliver one message in transit, by its id. */
  deliver(id: string): Promise<void>;
  /** Deliver every message in transit, and every message those deliveries send, until none is left. */
  deliverAll(): Promise<void>;
}

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface ClientView {
  status: 'idle' | 'requesting' | 'holding' | 'releasing' | 'abandoning';
  token: number;
  writing: boolean;
}

export interface Host extends Network {
  acquire(client: string): Promise<Outcome>;
  release(client: string): Promise<Outcome>;
  cancelAcquire(client: string): Promise<Outcome>;
  write(client: string): Promise<Outcome>;
  expire(): Promise<Outcome>;
  lease(): Promise<{ holder: string | null; token: number; writes: number }>;
  /** The client "c0" or "c1", or null for any other id. */
  client(client: string): Promise<ClientView | null>;
}

/** The module's default export: a factory of a fresh system, with the lease service and two idle clients. */
export type CreateHost = () => Promise<Host>;
