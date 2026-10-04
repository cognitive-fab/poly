// The stateful core: the lease service, the two clients and the network between them.
// Every command and every delivery is one step; a step listener (onStep) sees each one,
// which is the seam the trace capture in spec/ attaches to.

import type { Message, Outcome, ClientView } from './types.ts';

export const SERVICE = 'lease';
export const CLIENTS = ['c0', 'c1'] as const;
export const MAX_GRANTS = 2;
export const MAX_WRITES = 2;

export type ClientId = (typeof CLIENTS)[number];

export interface ServiceState {
  holder: ClientId | null;
  token: number; // the last token granted; also the number of grants so far
  writes: number;
  grantWritten: boolean; // a write was taken since the current grant
}

export interface ClientState {
  status: ClientView['status'];
  token: number; // the last token granted to this client
  writing: boolean;
  revoked: number; // the newest token revoked while not holding it (0 for none)
}

export interface StepEvent {
  kind: 'command' | 'deliver';
  name: string;
  args: Record<string, unknown>;
  outcome: Outcome | null;
}

export type StepListener = (phase: 'pre' | 'post', event: StepEvent) => void;

export function isClient(id: unknown): id is ClientId {
  return id === 'c0' || id === 'c1';
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export class LeaseSystem {
  service: ServiceState = { holder: null, token: 0, writes: 0, grantWritten: false };
  clients: Record<ClientId, ClientState> = {
    c0: { status: 'idle', token: 0, writing: false, revoked: 0 },
    c1: { status: 'idle', token: 0, writing: false, revoked: 0 },
  };
  network = new Map<string, Message>();
  private nextId = 1;
  private listeners: StepListener[] = [];

  onStep(listener: StepListener): void {
    this.listeners.push(listener);
  }

  private step<T extends Outcome | null>(event: Omit<StepEvent, 'outcome'>, body: () => T): T {
    const ev: StepEvent = { ...event, outcome: null };
    for (const l of this.listeners) l('pre', ev);
    const outcome = body();
    ev.outcome = outcome;
    for (const l of this.listeners) l('post', ev);
    return outcome;
  }

  private send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${this.nextId++}`;
    this.network.set(id, { id, from, to, action, data });
  }

  // ── commands ────────────────────────────────────────────────────────────

  acquire(client: string): Outcome {
    return this.step({ kind: 'command', name: 'acquire', args: { client } }, () => {
      if (!isClient(client)) return refuse('unknown client');
      const c = this.clients[client];
      if (c.status !== 'idle') return refuse('client is not idle');
      c.status = 'requesting';
      this.send(client, SERVICE, 'Acquire', { from: client });
      return ok;
    });
  }

  release(client: string): Outcome {
    return this.step({ kind: 'command', name: 'release', args: { client } }, () => {
      if (!isClient(client)) return refuse('unknown client');
      const c = this.clients[client];
      if (c.status !== 'holding') return refuse('client does not hold the lease');
      c.status = 'releasing';
      this.send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok;
    });
  }

  cancelAcquire(client: string): Outcome {
    return this.step({ kind: 'command', name: 'cancelAcquire', args: { client } }, () => {
      if (!isClient(client)) return refuse('unknown client');
      const c = this.clients[client];
      if (c.status !== 'requesting') return refuse('client is not requesting');
      c.status = 'abandoning';
      return ok;
    });
  }

  write(client: string): Outcome {
    return this.step({ kind: 'command', name: 'write', args: { client } }, () => {
      if (!isClient(client)) return refuse('unknown client');
      const c = this.clients[client];
      if (c.status !== 'holding') return refuse('client does not hold the lease');
      if (c.writing) return refuse('a write is already waiting for an answer');
      c.writing = true;
      this.send(client, SERVICE, 'Write', { from: client, token: c.token });
      return ok;
    });
  }

  expire(): Outcome {
    return this.step({ kind: 'command', name: 'expire', args: {} }, () => {
      const s = this.service;
      if (s.holder === null) return refuse('no client holds the lease');
      const former = s.holder;
      s.holder = null;
      this.send(SERVICE, former, 'Revoked', { token: s.token });
      return ok;
    });
  }

  // ── delivery ────────────────────────────────────────────────────────────

  deliver(id: string): void {
    const m = this.network.get(id);
    if (!m) return;
    this.step({ kind: 'deliver', name: 'deliver', args: { message: m } }, () => {
      this.network.delete(id);
      if (m.to === SERVICE) this.onService(m);
      else if (isClient(m.to)) this.onClient(m.to, m);
      return null;
    });
  }

  deliverAll(): void {
    while (this.network.size > 0) {
      const [id] = this.network.keys();
      this.deliver(id);
    }
  }

  private onService(m: Message): void {
    const s = this.service;
    const from = m.data.from;
    if (!isClient(from)) return;
    switch (m.action) {
      case 'Acquire':
        if (s.holder === null && s.token < MAX_GRANTS) {
          s.token += 1;
          s.holder = from;
          s.grantWritten = false;
          this.send(SERVICE, from, 'Granted', { token: s.token });
        } else {
          this.send(SERVICE, from, 'Denied', {});
        }
        return;
      case 'Release':
        if (s.holder === from && m.data.token === s.token) s.holder = null;
        this.send(SERVICE, from, 'Released', {});
        return;
      case 'Write':
        if (s.holder === from && m.data.token === s.token && !s.grantWritten && s.writes < MAX_WRITES) {
          s.writes += 1;
          s.grantWritten = true;
          this.send(SERVICE, from, 'WriteDone', {});
        } else {
          this.send(SERVICE, from, 'WriteRefused', {});
        }
        return;
    }
  }

  private onClient(id: ClientId, m: Message): void {
    const c = this.clients[id];
    switch (m.action) {
      case 'Granted': {
        const token = m.data.token as number;
        if (c.status === 'abandoning') {
          // give the lease straight back
          c.token = token;
          c.status = 'releasing';
          this.send(id, SERVICE, 'Release', { from: id, token });
          return;
        }
        if (c.status !== 'requesting') return;
        c.token = token;
        c.status = token <= c.revoked ? 'idle' : 'holding';
        return;
      }
      case 'Denied':
        if (c.status === 'requesting' || c.status === 'abandoning') c.status = 'idle';
        return;
      case 'Revoked': {
        const token = m.data.token as number;
        if (c.status === 'releasing') return;
        if (c.status === 'holding') {
          if (token === c.token) c.status = 'idle';
        } else if (token > c.revoked) {
          c.revoked = token;
        }
        return;
      }
      case 'Released':
        if (c.status === 'releasing') c.status = 'idle';
        return;
      case 'WriteDone':
      case 'WriteRefused':
        c.writing = false;
        return;
    }
  }

  // ── queries ─────────────────────────────────────────────────────────────

  lease(): { holder: string | null; token: number; writes: number } {
    const s = this.service;
    return { holder: s.holder, token: s.token, writes: s.writes };
  }

  client(id: string): ClientView | null {
    if (!isClient(id)) return null;
    const c = this.clients[id];
    return { status: c.status, token: c.token, writing: c.writing };
  }

  inFlight(): Message[] {
    return [...this.network.values()].map((m) => ({ ...m, data: { ...m.data } }));
  }
}
