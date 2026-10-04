// T10, a lease with fencing tokens: the service "lease", clients "c0" and "c1",
// and a network that delivers nothing until asked to.
import type { ClientView, CreateHost, Host, Message, Outcome } from '../host.ts';

const SERVICE = 'lease';
const CLIENTS = ['c0', 'c1'] as const;
const MAX_GRANTS = 2;
const MAX_WRITES = 2;

interface ServiceState {
  holder: string | null;
  token: number;
  writes: number;
  /** Whether a write was taken since the current grant. */
  grantWritten: boolean;
}

interface ClientState {
  status: 'idle' | 'requesting' | 'holding';
  token: number;
  writing: boolean;
  /** The newest token revoked while the client did not hold the lease (0 for none). */
  revoked: number;
}

/** A snapshot of the whole system, for trace capture. */
export interface Snapshot {
  service: ServiceState;
  clients: Record<string, ClientState>;
  inFlight: Message[];
}

/** One step of the system: a command, or the delivery of one message. */
export interface StepEvent {
  pre: Snapshot;
  kind: 'command' | 'deliver';
  name: string;
  args: Record<string, unknown>;
  outcome?: Outcome;
  message?: Message;
  post: Snapshot;
}

export type StepListener = (event: StepEvent) => void;

const ok = (): Outcome => ({ ok: true });
const refused = (reason: string): Outcome => ({ ok: false, reason });
const isClient = (id: string): boolean => (CLIENTS as readonly string[]).includes(id);

export function createSystem(listener?: StepListener): Host {
  const service: ServiceState = { holder: null, token: 0, writes: 0, grantWritten: false };
  const clients: Record<string, ClientState> = {};
  for (const c of CLIENTS) clients[c] = { status: 'idle', token: 0, writing: false, revoked: 0 };
  let network: Message[] = [];
  let nextId = 1;

  const snapshot = (): Snapshot => ({
    service: { ...service },
    clients: Object.fromEntries(CLIENTS.map((c) => [c, { ...clients[c] }])),
    inFlight: network.map((m) => ({ ...m, data: { ...m.data } })),
  });

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    network.push({ id: `m${nextId++}`, from, to, action, data });
  };

  const command = (name: string, args: Record<string, unknown>, run: () => Outcome): Outcome => {
    const pre = listener ? snapshot() : undefined;
    const outcome = run();
    if (listener) listener({ pre: pre!, kind: 'command', name, args, outcome, post: snapshot() });
    return outcome;
  };

  // ── the service ──────────────────────────────────────────────────────────
  const onService = (m: Message): void => {
    const from = m.data.from as string;
    switch (m.action) {
      case 'Acquire':
        if (service.holder === null && service.token < MAX_GRANTS) {
          service.token += 1;
          service.holder = from;
          service.grantWritten = false;
          send(SERVICE, from, 'Granted', { token: service.token });
        } else {
          send(SERVICE, from, 'Denied', {});
        }
        break;
      case 'Release':
        if (service.holder === from && m.data.token === service.token) service.holder = null;
        break;
      case 'Write':
        if (service.holder === from && m.data.token === service.token && !service.grantWritten && service.writes < MAX_WRITES) {
          service.writes += 1;
          service.grantWritten = true;
          send(SERVICE, from, 'WriteDone', {});
        } else {
          send(SERVICE, from, 'WriteRefused', {});
        }
        break;
    }
  };

  // ── the clients ──────────────────────────────────────────────────────────
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

  const deliverOne = (id: string): void => {
    const index = network.findIndex((m) => m.id === id);
    if (index < 0) return;
    const pre = listener ? snapshot() : undefined;
    const [m] = network.splice(index, 1);
    if (m.to === SERVICE) onService(m);
    else if (isClient(m.to)) onClient(clients[m.to], m);
    if (listener) listener({ pre: pre!, kind: 'deliver', name: m.action, args: { id }, message: m, post: snapshot() });
  };

  return {
    async inFlight() {
      return network.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      deliverOne(id);
    },
    async deliverAll() {
      while (network.length > 0) deliverOne(network[0].id);
    },

    async acquire(client) {
      return command('acquire', { client }, () => {
        if (!isClient(client)) return refused(`unknown client ${client}`);
        const c = clients[client];
        if (c.status !== 'idle') return refused(`${client} is ${c.status}, not idle`);
        c.status = 'requesting';
        send(client, SERVICE, 'Acquire', { from: client });
        return ok();
      });
    },
    async release(client) {
      return command('release', { client }, () => {
        if (!isClient(client)) return refused(`unknown client ${client}`);
        const c = clients[client];
        if (c.status !== 'holding') return refused(`${client} does not hold the lease`);
        c.status = 'idle';
        send(client, SERVICE, 'Release', { from: client, token: c.token });
        return ok();
      });
    },
    async write(client) {
      return command('write', { client }, () => {
        if (!isClient(client)) return refused(`unknown client ${client}`);
        const c = clients[client];
        if (c.status !== 'holding') return refused(`${client} does not hold the lease`);
        if (c.writing) return refused(`${client} already has a write waiting for an answer`);
        c.writing = true;
        send(client, SERVICE, 'Write', { from: client, token: c.token });
        return ok();
      });
    },
    async expire() {
      return command('expire', {}, () => {
        const holder = service.holder;
        if (holder === null) return refused('no client holds the lease');
        service.holder = null;
        send(SERVICE, holder, 'Revoked', { token: service.token });
        return ok();
      });
    },

    async lease() {
      return { holder: service.holder, token: service.token, writes: service.writes };
    },
    async client(client): Promise<ClientView | null> {
      if (!isClient(client)) return null;
      const c = clients[client];
      return { status: c.status, token: c.token, writing: c.writing };
    },
  };
}

const createHost: CreateHost = async () => createSystem();

export default createHost;
