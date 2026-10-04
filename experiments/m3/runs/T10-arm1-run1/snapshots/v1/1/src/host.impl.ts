import type { ClientView, CreateHost, Host, Message, Outcome } from '../host.ts';

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

const createHost: CreateHost = async () => {
  let nextId = 1;
  const inFlight: Message[] = [];
  const service = { holder: null as string | null, token: 0, writes: 0, grants: 0 };
  const clients = new Map<string, ClientState>();
  for (const c of CLIENTS) clients.set(c, { status: 'idle', token: 0, writing: false, revoked: 0 });

  const refuse = (reason: string): Outcome => ({ ok: false, reason });
  const send = (from: string, to: string, action: string, data: Record<string, unknown>) => {
    inFlight.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const onService = (m: Message) => {
    const from = m.data.from as string;
    const token = m.data.token as number;
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
        if (service.holder === from && token === service.token) service.holder = null;
        break;
      case 'Write':
        if (service.holder === from && token === service.token && !service.wroteThisGrant && service.writes < MAX_WRITES) {
          service.writes++;
          service.wroteThisGrant = true;
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

  const deliverMessage = (m: Message) => {
    if (m.to === SERVICE) onService(m);
    else {
      const c = clients.get(m.to);
      if (c) onClient(c, m);
    }
  };

  const view = (c: ClientState): ClientView => ({ status: c.status, token: c.token, writing: c.writing });

  const host: Host = {
    async inFlight() {
      return inFlight.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      const i = inFlight.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [m] = inFlight.splice(i, 1);
      deliverMessage(m);
    },
    async deliverAll() {
      while (inFlight.length > 0) deliverMessage(inFlight.shift()!);
    },
    async acquire(client: string) {
      const c = clients.get(client);
      if (!c) return refuse('unknown client');
      if (c.status !== 'idle') return refuse('client is not idle');
      c.status = 'requesting';
      send(client, SERVICE, 'Acquire', { from: client });
      return { ok: true };
    },
    async release(client: string) {
      const c = clients.get(client);
      if (!c) return refuse('unknown client');
      if (c.status !== 'holding') return refuse('client does not hold the lease');
      c.status = 'idle';
      send(client, SERVICE, 'Release', { from: client, token: c.token });
      return { ok: true };
    },
    async write(client: string) {
      const c = clients.get(client);
      if (!c) return refuse('unknown client');
      if (c.status !== 'holding') return refuse('client does not hold the lease');
      if (c.writing) return refuse('a write is waiting for an answer');
      c.writing = true;
      send(client, SERVICE, 'Write', { from: client, token: c.token });
      return { ok: true };
    },
    async expire() {
      if (service.holder === null) return refuse('no client holds the lease');
      const former = service.holder;
      service.holder = null;
      send(SERVICE, former, 'Revoked', { token: service.token });
      return { ok: true };
    },
    async lease() {
      return { holder: service.holder, token: service.token, writes: service.writes };
    },
    async client(client: string) {
      const c = clients.get(client);
      return c ? view(c) : null;
    },
  };
  return host;
};

export default createHost;
