// The host interface of host.ts, copied under src/ so the delivery imports only files under src/.

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
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader' | 'down';
  term: number;
  votedFor: string | null;
  leader: string | null;
}

export interface Host extends Network {
  timeout(node: string): Promise<Outcome>;
  giveUp(node: string): Promise<Outcome>;
  crash(node: string): Promise<Outcome>;
  recover(node: string): Promise<Outcome>;
  node(node: string): Promise<NodeView | null>;
}

export type CreateHost = () => Promise<Host>;
