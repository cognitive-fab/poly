// T10, a lease with fencing tokens: the lease service "lease", clients "c0" and "c1",
// and a network that delivers nothing until asked to, in any order.
import type { CreateHost, Host, Message, Outcome, ClientView } from '../host.ts';

const SERVICE = 'lease';
const CLIENTS = ['c0', 'c1'];
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ClientState {
  status: 'idle' | 'requesting' | 'holding' | 'releasing';
  token: number;
  writing: boolean;
  /** The newest token revoked while the client did not hold the lease (0 for none). */
  revoked: number;
}

interface ServiceState {
  holder: string | null;
  token: number;
  writes: number;
  /** Whether a write was taken since the last grant. */
  wroteThisGrant: boolean;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const service: ServiceState = { holder: null, token: 0, writes: 0, wroteThisGrant: false };
  const clients = new Map<string, ClientState>(
    CLIENTS.map((c) => [c, { status: 'idle', token: 0, writing: false, revoked: 0 }]),
  );
  const network = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    network.set(id, { id, from, to, action, data });
  }

  function onService(m: Message): void {
    const from = m.data.from as string;
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
        return;
      case 'Release':
        if (service.holder === from && m.data.token === service.token) service.holder = null;
        send(SERVICE, from, 'Released', {});
        return;
      case 'Write':
        if (
          service.holder === from && m.data.token === service.token &&
          !service.wroteThisGrant && service.writes < MAX_WRITES
        ) {
          service.writes += 1;
          service.wroteThisGrant = true;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        return;
    }
  }

  function onClient(c: ClientState, m: Message): void {
    switch (m.action) {
      case 'Granted': {
        if (c.status !== 'requesting') return;
        const token = m.data.token as number;
        c.token = token;
        c.status = token <= c.revoked ? 'idle' : 'holding';
        return;
      }
      case 'Denied':
        if (c.status === 'requesting') c.status = 'idle';
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

  async function deliver(id: string): Promise<void> {
    const m = network.get(id);
    if (!m) return;
    network.delete(id);
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
  }

  const host: Host = {
    async inFlight() {
      return [...network.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (network.size > 0) {
        const [id] = network.keys();
        await deliver(id);
      }
    },

    async acquire(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'idle') return refuse(`client ${client} is ${c.status}, not idle`);
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return ok();
    },
    async release(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`client ${client} does not hold the lease`);
      c.status = 'idle';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok();
    },
    async write(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`client ${client} does not hold the lease`);
      if (c.writing) return refuse(`client ${client} has a write waiting for an answer`);
      c.writing = true;
      send(client, SERVICE, 'Write', { from: client, token: c.token });
      return ok();
    },
    async expire() {
      const holder = service.holder;
      if (holder === null) return refuse('no client holds the lease');
      service.holder = null;
      send(SERVICE, holder, 'Revoked', { token: service.token });
      return ok();
    },

    async lease() {
      return { holder: service.holder, token: service.token, writes: service.writes };
    },
    async client(client): Promise<ClientView | null> {
      const c = clients.get(client);
      if (!c) return null;
      return { status: c.status, token: c.token, writing: c.writing };
    },
  };
  return host;
};

export default createHost;
