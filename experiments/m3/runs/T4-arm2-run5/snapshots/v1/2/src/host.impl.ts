import type { CreateHost, Host, Message } from '../host.ts';
import * as core from './core.ts';

const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

const createHost: CreateHost = async () => {
  const sys = core.createSystem();

  const host: Host = {
    async inFlight() {
      return sys.inFlight.map(copy);
    },
    async deliver(id) {
      if (!core.deliver(sys, id)) throw new Error(`no message in transit with id ${id}`);
    },
    async deliverAll() {
      while (sys.inFlight.length > 0) core.deliver(sys, sys.inFlight[0].id);
    },
    async open(cart) {
      return core.open(sys, cart);
    },
    async add(cart) {
      return core.add(sys, cart);
    },
    async checkout(cart) {
      return core.checkout(sys, cart);
    },
    async cancel(cart) {
      return core.cancel(sys, cart);
    },
    async declineCards() {
      return core.declineCards(sys);
    },
    async acceptCards() {
      return core.acceptCards(sys);
    },
    async cart(cart) {
      const c = sys.carts.get(cart);
      return c ? { status: c.status, items: c.items } : null;
    },
    async stock() {
      return { ...sys.inventory };
    },
    async payments() {
      return { ...sys.payments };
    },
  };
  return host;
};

export default createHost;
