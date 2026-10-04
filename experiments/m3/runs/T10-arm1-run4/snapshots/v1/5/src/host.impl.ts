// T10, a lease with fencing tokens: the lease service, two clients and an in-memory network.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface ClientView {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  acquire(client: string): Promise<Outcome>;
  release(client: string): Promise<Outcome>;
  write(client: string): Promise<Outcome>;
  expire(): Promise<Outcome>;
  lease(): Promise<{ holder: string | null; token: number; writes: number }>;
  client(client: string): Promise<ClientView | null>;
}

const SERVICE = 'lease';
const CLIENTS = ['c0', 'c1'];
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ClientState {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
  /** The newest token revoked while this client did not hold the lease (0 if none). */
  revoked: number;
}

interface ServiceState {
  holder: string | null;
  token: number;
  writes: number;
  /** Whether a write was taken since the current grant. */
  wroteThisGrant: boolean;
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  const service: ServiceState = { holder: null, token: 0, writes: 0, wroteThisGrant: false };
  const clients = new Map<string, ClientState>();
  for (const c of CLIENTS) clients.set(c, { status: 'idle', token: 0, writing: false, revoked: 0 });

  const transit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    transit.set(id, { id, from, to, action, data });
  }

  function onService(m: Message): void {
    const from = m.data.from as string;
    const token = m.data.token as number;
    switch (m.action) {
      case 'Acquire':
        if (service.holder === null && service.token < MAX_GRANTS) {
          service.token += 1;
          service.holder = from;
          service.wroteThisGrant = false;
          send(SERVICE, from, 'Granted', { token: service.token });
        } else {
          send(SERVICE, from, 'Denied', {});
        }
        break;
      case 'Release':
        if (service.holder === from && token === service.token) service.holder = null;
        break;
      case 'Write':
        if (
          service.holder === from &&
          token === service.token &&
          !service.wroteThisGrant &&
          service.writes < MAX_WRITES
        ) {
          service.writes += 1;
          service.wroteThisGrant = true;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        break;
    }
  }

  function onClient(c: ClientState, m: Message): void {
    switch (m.action) {
      case 'Granted': {
        if (c.status !== 'requesting') break;
        const token = m.data.token as number;
        c.token = token;
        c.status = token <= c.revoked ? 'idle' : 'holding';
        break;
      }
      case 'Denied':
        if (c.status === 'requesting') c.status = 'idle';
        break;
      case 'Revoked': {
        const token = m.data.token as number;
        if (c.status === 'holding') {
          if (token === c.token) c.status = 'idle';
        } else if (token > c.revoked) {
          c.revoked = token;
        }
        break;
      }
      case 'WriteDone':
      case 'WriteRefused':
        c.writing = false;
        break;
    }
  }

  function deliverOne(m: Message): void {
    transit.delete(m.id);
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
  }

  return {
    async inFlight() {
      return [...transit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const m = transit.get(id);
      if (!m) throw new Error(`no message in transit with id ${id}`);
      deliverOne(m);
    },
    async deliverAll() {
      while (transit.size > 0) {
        const m = transit.values().next().value as Message;
        deliverOne(m);
      }
    },
    async acquire(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'idle') return refuse(`${client} is not idle`);
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return ok;
    },
    async release(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
      c.status = 'idle';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok;
    },
    async write(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
      if (c.writing) return refuse(`${client} already has a write waiting for an answer`);
      c.writing = true;
      send(client, SERVICE, 'Write', { from: client, token: c.token });
      return ok;
    },
    async expire() {
      if (service.holder === null) return refuse('no client holds the lease');
      const former = service.holder;
      service.holder = null;
      send(SERVICE, former, 'Revoked', { token: service.token });
      return ok;
    },
    async lease() {
      return { holder: service.holder, token: service.token, writes: service.writes };
    },
    async client(client) {
      const c = clients.get(client);
      if (!c) return null;
      return { status: c.status, token: c.token, writing: c.writing };
    },
  };
}
