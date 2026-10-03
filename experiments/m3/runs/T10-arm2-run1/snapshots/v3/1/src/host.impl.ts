// T10, a lease with fencing tokens: the lease service, two clients, and a network
// that delivers nothing until asked to.
import type { CreateHost, Host, Message, Outcome, ClientView } from '../host.ts';

export const CLIENTS = ['c0', 'c1'] as const;
export const SERVICE = 'lease';
export const MAX_GRANTS = 2;
export const MAX_WRITES = 2;

type Status = 'idle' | 'requesting' | 'holding' | 'releasing';

interface ClientState {
  status: Status;
  token: number; // last token granted to this client (0 before any)
  writing: boolean; // a write of this client waits for an answer
  revoked: number; // newest token revoked while the client did not hold it (0: none)
}

interface ServiceState {
  holder: string | null;
  token: number; // last token granted; also the number of grants so far
  writes: number;
  wroteSinceGrant: boolean; // a write was taken since the last grant
}

export interface SystemState {
  service: ServiceState;
  clients: Record<string, ClientState>;
  net: Message[];
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const isClient = (id: string): boolean => (CLIENTS as readonly string[]).includes(id);

export function initialState(): SystemState {
  const clients: Record<string, ClientState> = {};
  for (const c of CLIENTS) clients[c] = { status: 'idle', token: 0, writing: false, revoked: 0 };
  return { service: { holder: null, token: 0, writes: 0, wroteSinceGrant: false }, clients, net: [] };
}

export function createSystem() {
  const s = initialState();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>) => {
    s.net.push({ id: `m${nextId++}`, from, to, action, data });
  };

  // ── commands ───────────────────────────────────────────────────────────────
  const acquire = (client: string): Outcome => {
    if (!isClient(client)) return refuse(`unknown client ${client}`);
    const c = s.clients[client];
    if (c.status !== 'idle') return refuse(`${client} is ${c.status}, not idle`);
    c.status = 'requesting';
    send(client, SERVICE, 'Acquire', { from: client });
    return ok;
  };

  const release = (client: string): Outcome => {
    if (!isClient(client)) return refuse(`unknown client ${client}`);
    const c = s.clients[client];
    if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
    c.status = 'releasing';
    send(client, SERVICE, 'Release', { from: client, token: c.token });
    return ok;
  };

  const cancelAcquire = (client: string): Outcome => {
    if (!isClient(client)) return refuse(`unknown client ${client}`);
    const c = s.clients[client];
    if (c.status !== 'requesting') return refuse(`${client} is ${c.status}, not requesting`);
    c.status = 'abandoning';
    return ok;
  };

  const write = (client: string): Outcome => {
    if (!isClient(client)) return refuse(`unknown client ${client}`);
    const c = s.clients[client];
    if (c.status !== 'holding') return refuse(`${client} does not hold the lease`);
    if (c.writing) return refuse(`${client} has a write waiting for an answer`);
    c.writing = true;
    send(client, SERVICE, 'Write', { from: client, token: c.token });
    return ok;
  };

  const expire = (): Outcome => {
    const holder = s.service.holder;
    if (holder === null) return refuse('no client holds the lease');
    s.service.holder = null;
    send(SERVICE, holder, 'Revoked', { token: s.service.token });
    return ok;
  };

  // ── message handlers ───────────────────────────────────────────────────────
  const onService = (m: Message) => {
    const sv = s.service;
    const from = String(m.data.from);
    const isCurrentHolder = sv.holder !== null && sv.holder === from && m.data.token === sv.token;
    switch (m.action) {
      case 'Acquire':
        if (sv.holder === null && sv.token < MAX_GRANTS) {
          sv.token += 1;
          sv.holder = from;
          sv.wroteSinceGrant = false;
          send(SERVICE, from, 'Granted', { token: sv.token });
        } else {
          send(SERVICE, from, 'Denied', {});
        }
        return;
      case 'Release':
        if (isCurrentHolder) sv.holder = null;
        send(SERVICE, from, 'Released', {});
        return;
      case 'Write':
        if (isCurrentHolder && !sv.wroteSinceGrant && sv.writes < MAX_WRITES) {
          sv.writes += 1;
          sv.wroteSinceGrant = true;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        return;
    }
  };

  const onClient = (client: string, m: Message) => {
    const c = s.clients[client];
    const token = Number(m.data.token);
    switch (m.action) {
      case 'Granted':
        if (c.status !== 'requesting') return;
        c.token = token;
        c.status = token <= c.revoked ? 'idle' : 'holding';
        return;
      case 'Denied':
        if (c.status === 'requesting') c.status = 'idle';
        return;
      case 'Released':
        if (c.status === 'releasing') c.status = 'idle';
        return;
      case 'Revoked':
        if (c.status === 'releasing') return;
        if (c.status === 'holding') {
          if (token === c.token) c.status = 'idle';
        } else if (token > c.revoked) {
          c.revoked = token;
        }
        return;
      case 'WriteDone':
      case 'WriteRefused':
        c.writing = false;
        return;
    }
  };

  const deliver = (id: string) => {
    const i = s.net.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [m] = s.net.splice(i, 1);
    if (m.to === SERVICE) onService(m);
    else if (isClient(m.to)) onClient(m.to, m);
  };

  return { state: s, acquire, release, write, expire, deliver };
}

const copyMessage = (m: Message): Message => ({ ...m, data: { ...m.data } });

const createHost: CreateHost = async () => {
  const sys = createSystem();
  const s = sys.state;
  const host: Host = {
    acquire: async (client) => sys.acquire(client),
    release: async (client) => sys.release(client),
    write: async (client) => sys.write(client),
    expire: async () => sys.expire(),
    lease: async () => ({ holder: s.service.holder, token: s.service.token, writes: s.service.writes }),
    client: async (client): Promise<ClientView | null> => {
      if (!isClient(client)) return null;
      const c = s.clients[client];
      return { status: c.status, token: c.token, writing: c.writing };
    },
    inFlight: async () => s.net.map(copyMessage),
    deliver: async (id) => sys.deliver(id),
    deliverAll: async () => {
      while (s.net.length > 0) sys.deliver(s.net[0].id);
    },
  };
  return host;
};

export default createHost;
