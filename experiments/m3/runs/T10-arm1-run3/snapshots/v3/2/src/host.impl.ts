import type { CreateHost, Host, Message, Outcome, ClientView } from '../host.ts';

const CLIENTS = ['c0', 'c1'];
const SERVICE = 'lease';
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ClientState {
  status: 'idle' | 'requesting' | 'holding' | 'releasing';
  token: number;
  writing: boolean;
  /** The newest token revoked while this client did not hold the lease. */
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

const createHost: CreateHost = async () => {
  const service: ServiceState = { holder: null, token: 0, writes: 0, wroteThisGrant: false };
  const clients = new Map<string, ClientState>();
  for (const c of CLIENTS) clients.set(c, { status: 'idle', token: 0, writing: false, revoked: 0 });

  let transit: Message[] = [];
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    transit.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const onService = (m: Message): void => {
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
        send(SERVICE, from, 'Released', {});
        break;
      case 'Write':
        if (service.holder === from && token === service.token && service.writes < MAX_WRITES && !service.wroteThisGrant) {
          service.writes += 1;
          service.wroteThisGrant = true;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        break;
    }
  };

  const onClient = (c: ClientState, m: Message): void => {
    switch (m.action) {
      case 'Granted': {
        const token = m.data.token as number;
        if (c.status === 'abandoning') {
          c.token = token;
          c.status = 'releasing';
          send(m.to, SERVICE, 'Release', { from: m.to, token });
          break;
        }
        if (c.status !== 'requesting') break;
        c.token = token;
        c.status = token <= c.revoked ? 'idle' : 'holding';
        break;
      }
      case 'Denied':
        if (c.status === 'requesting' || c.status === 'abandoning') c.status = 'idle';
        break;
      case 'Revoked': {
        const token = m.data.token as number;
        if (c.status === 'releasing') break;
        if (c.status === 'holding') {
          if (token === c.token) c.status = 'idle';
        } else if (token > c.revoked) {
          c.revoked = token;
        }
        break;
      }
      case 'Released':
        if (c.status === 'releasing') c.status = 'idle';
        break;
      case 'WriteDone':
      case 'WriteRefused':
        c.writing = false;
        break;
    }
  };

  const deliverOne = (id: string): boolean => {
    const i = transit.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const [m] = transit.splice(i, 1);
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
    return true;
  };

  const host: Host = {
    async inFlight() {
      return transit.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (transit.length > 0) deliverOne(transit[0].id);
    },

    async acquire(client: string) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'idle') return refuse(`client ${client} is ${c.status}, not idle`);
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return ok;
    },
    async release(client: string) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`client ${client} does not hold the lease`);
      c.status = 'releasing';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok;
    },
    async write(client: string) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`client ${client} does not hold the lease`);
      if (c.writing) return refuse(`client ${client} has a write waiting for an answer`);
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
    async client(client: string): Promise<ClientView | null> {
      const c = clients.get(client);
      if (!c) return null;
      return { status: c.status, token: c.token, writing: c.writing };
    },
  };
  return host;
};

export default createHost;
