// The host interface of host.ts, restated here so src/ imports nothing outside src/.

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

export interface ClientView {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
}

export interface Host extends Network {
  acquire(client: string): Promise<Outcome>;
  release(client: string): Promise<Outcome>;
  write(client: string): Promise<Outcome>;
  expire(): Promise<Outcome>;
  lease(): Promise<{ holder: string | null; token: number; writes: number }>;
  client(client: string): Promise<ClientView | null>;
}

export type CreateHost = () => Promise<Host>;
