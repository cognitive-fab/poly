// A copy of the interface in host.ts, so the delivery imports only from src/.

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

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  leader: string | null;
}

export interface Host extends Network {
  timeout(node: string): Promise<Outcome>;
  node(node: string): Promise<NodeView | null>;
}

export type CreateHost = () => Promise<Host>;
