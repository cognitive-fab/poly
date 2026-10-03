import type { CreateHost, Host, Message, Outcome, ClientView } from '../host.ts';

const CLIENTS = ['c0', 'c1'];
const SERVICE = 'lease';
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ClientState {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
  revoked: number; // newest token revoked while not holding
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const service = { holder: null as string | null, token: 0, writes: 0 };
  const clients = new Map<string, ClientState>();
  for (const c of CLIENTS) clients.set(c, { status: 'idle', token: 0, writing: false, revoked: 0 });

  const inTransit = new Map<string, Message>();
  let nextId = 1;
  const send = (from: string, to: string, action: string, data: Record<string, unknown>) => {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  };

  const onService = (m: Message) => {
    const from = m.data.from as string;
    const token = m.data.token as number;
    switch (m.action) {
      case 'Acquire':
        if (service.holder === null && service.token < MAX_GRANTS) {
          service.token += 1;
          service.holder = from;
          send(SERVICE, from, 'Granted', { token: service.token });
        } else {
          send(SERVICE, from, 'Denied', {});
        }
        break;
      case 'Release':
        if (service.holder === from && token === service.token) service.holder = null;
        break;
      case 'Write':
        if (service.holder === from && token === service.token && service.writes < MAX_WRITES) {
          service.writes += 1;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        break;
    }
  };

  const onClient = (c: ClientState, m: Message) => {
    switch (m.action) {
      case 'Granted': {
        const token = m.data.token as number;
        if (c.status !== 'requesting') break;
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

  const deliverOne = (id: string) => {
    const m = inTransit.get(id);
    if (!m) return;
    inTransit.delete(id);
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
  };

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      deliverOne(id);
    },
    async deliverAll() {
      while (inTransit.size > 0) deliverOne(inTransit.keys().next().value as string);
    },
    async acquire(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'idle') return refuse(`client ${client} is ${c.status}, not idle`);
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return ok;
    },
    async release(client) {
      const c = clients.get(client);
      if (!c) return refuse(`unknown client ${client}`);
      if (c.status !== 'holding') return refuse(`client ${client} does not hold the lease`);
      c.status = 'idle';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return ok;
    },
    async write(client) {
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
    async client(client): Promise<ClientView | null> {
      const c = clients.get(client);
      if (!c) return null;
      return { status: c.status, token: c.token, writing: c.writing };
    },
  };
  return host;
};

export default createHost;
