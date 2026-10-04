import type { CreateHost, Host } from './types.ts';
import { LeaseSystem } from './lease.ts';

/** Wrap a LeaseSystem as the async Host of host.ts. */
export function hostOf(sys: LeaseSystem): Host {
  return {
    acquire: async (client) => sys.acquire(client),
    release: async (client) => sys.release(client),
    cancelAcquire: async (client) => sys.cancelAcquire(client),
    write: async (client) => sys.write(client),
    expire: async () => sys.expire(),
    lease: async () => sys.lease(),
    client: async (client) => sys.client(client),
    inFlight: async () => sys.inFlight(),
    deliver: async (id) => sys.deliver(id),
    deliverAll: async () => sys.deliverAll(),
  };
}

const createHost: CreateHost = async () => hostOf(new LeaseSystem());

export default createHost;
