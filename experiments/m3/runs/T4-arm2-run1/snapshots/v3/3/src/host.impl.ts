// The host: the interface of host.ts over the checkout core.

import { Core } from './core.ts';
import type { StepListener } from './core.ts';
import type { CreateHost, Host, Message } from './types.ts';

const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

/** A fresh system; `listener` (optional) observes every step of the core. */
export function createSystem(listener: StepListener | null = null): Host {
  const core = new Core(listener);
  return {
    async open(cart) { return core.step('open', { cart }); },
    async add(cart) { return core.step('add', { cart }); },
    async checkout(cart) { return core.step('checkout', { cart }); },
    async cancel(cart) { return core.step('cancel', { cart }); },
    async returnCart(cart) { return core.step('returnCart', { cart }); },
    async retry(cart) { return core.step('retry', { cart }); },
    async abandon(cart) { return core.step('abandon', { cart }); },
    async declineCards() { return core.step('declineCards', {}); },
    async acceptCards() { return core.step('acceptCards', {}); },
    async cart(cart) {
      const c = core.state.carts[cart];
      return c ? { status: c.status, items: c.items } : null;
    },
    async stock() { return { available: core.state.available, reserved: core.state.reserved }; },
    async payments() { return { charged: core.state.charged, declining: core.state.declining }; },
    async inFlight() { return core.state.inFlight.map(copy); },
    async deliver(id) { core.step('deliver', { id }); },
    async deliverAll() {
      while (core.state.inFlight.length > 0) core.step('deliver', { id: core.state.inFlight[0].id });
    },
  };
}

const createHost: CreateHost = async () => createSystem();

export default createHost;
