// T9 after change 2, electing and announcing a leader among three nodes, with candidates that give up: the host interface every arm implements (PT13, S91).

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

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  leader: string | null;
}

export interface Host extends Network {
  timeout(node: string): Promise<Outcome>;
  giveUp(node: string): Promise<Outcome>;
  /** The node "n0", "n1" or "n2", or null for any other id. */
  node(node: string): Promise<NodeView | null>;
}

/** The module's default export: a factory of a fresh system, with the three nodes. */
export type CreateHost = () => Promise<Host>;
