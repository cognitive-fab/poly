import type { ClientView, CreateHost, Host, Message, Outcome } from '../host.ts';

const CLIENTS = ['c0', 'c1'];
const SERVICE = 'lease';
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ClientState {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
  /** Newest token revoked while the client did not hold the lease. */
  revoked: number;
}

const createHost: CreateHost = async () => {
  const service = { holder: null as string | null, token: 0, writes: 0, grants: 0 };
  const clients = new Map<string, ClientState>();
  for (const c of CLIENTS) clients.set(c, { status: 'idle', token: 0, writing: false, revoked: 0 });

  const inTransit: Message[] = [];
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    inTransit.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const ok = (): Outcome => ({ ok: true });
  const refuse = (reason: string): Outcome => ({ ok: false, reason });

  const onService = (m: Message): void => {
    const from = m.data.from as string;
    switch (m.action) {
      case 'Acquire':
        if (service.holder === null && service.grants < MAX_GRANTS) {
          service.grants++;
          service.token++;
          service.holder = from;
          send(SERVICE, from, 'Granted', { token: service.token });
        } else {
          send(SERVICE, from, 'Denied', {});
        }
        break;
      case 'Release':
        if (service.holder === from && m.data.token === service.token) service.holder = null;
        break;
      case 'Write':
        if (
          service.holder === from &&
          m.data.token === service.token &&
          !service.wroteThisGrant &&
          service.writes < MAX_WRITES
        ) {
          service.writes++;
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
  };

  const deliver = async (id: string): Promise<void> => {
    const i = inTransit.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [m] = inTransit.splice(i, 1);
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
  };

  const host: Host = {
    async inFlight() {
      return inTransit.map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (inTransit.length > 0) await deliver(inTransit[0].id);
    },
    async acquire(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'idle') return refuse(`${client} is not idle`);
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return ok();
    },
    async release(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
      c.status = 'idle';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok();
    },
    async write(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
      if (c.writing) return refuse(`${client} has a write waiting for an answer`);
      c.writing = true;
      send(client, SERVICE, 'Write', { from: client, token: c.token });
      return ok();
    },
    async expire() {
      if (service.holder === null) return refuse('no client holds the lease');
      const former = service.holder;
      service.holder = null;
      send(SERVICE, former, 'Revoked', { token: service.token });
      return ok();
    },
    async lease() {
      return { holder: service.holder, token: service.token, writes: service.writes };
    },
    async client(client) {
      const c = clients.get(client);
      if (!c) return null;
      const view: ClientView = { status: c.status, token: c.token, writing: c.writing };
      return view;
    },
  };
  return host;
};

export default createHost;
