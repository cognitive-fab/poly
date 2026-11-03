// DF11.3: recorded orders for personas from the fixture. The pool's first two guests get the
// fixture customers' orders (cust-a and cust-b); other guests get their synthetic orders.
import { personaOf } from './personas.mjs';

/**
 * Returns a function that maps a persona number to its orders from the fixture or synthetic orders.
 * For n=1, returns fixture customer cust-a orders with owner set to the persona's principal.
 * For n=2, returns fixture customer cust-b orders with owner set to the persona's principal.
 * For any other n, returns the persona's synthetic orders.
 */
export function recordedOrdersOf(fixture) {
  return function ordersOf({ n, id, principal }) {
    if (n === 1) {
      return fixture.orders.filter((o) => o.owner === 'cust-a').map((o) => ({
        id: o.id,
        owner: principal,
        charge: o.charge,
        paid: o.paid,
        asOf: o.asOf,
        body: o.body,
      }));
    }
    if (n === 2) {
      return fixture.orders.filter((o) => o.owner === 'cust-b').map((o) => ({
        id: o.id,
        owner: principal,
        charge: o.charge,
        paid: o.paid,
        asOf: o.asOf,
        body: o.body,
      }));
    }
    return personaOf(n).orders;
  };
}

/**
 * DF28 item 2: the recorded messages each guest may send, as the runbook's step 2.5 assigns them. Guest n gets the texts of the
 * fixture's messages from `wa-<n>`, in the fixture's order, and a guest with no sender of that name gets none.
 */
export function recordedMessagesOf(fixture) {
  return function messagesOf({ n }) {
    return fixture.messages.filter((m) => m.from === `wa-${n}`).map((m) => m.text);
  };
}
