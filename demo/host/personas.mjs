// DF3: the synthetic personas of the room. Each browser session gets one, `guest-NN`, a number from the reserved fiction range
// (+1 555 555 01NN, inside the 555-0100 to 555-0199 block), and one or two synthetic orders (`o-9NN1`, `o-9NN2`) with the charge
// each was paid with (`ch_demo9NN1`). Nothing in a message chooses the persona: the session does, and the verifier maps the number
// the adapter verified to `cust-guest-NN`. Everything here is made up (demo/PROVENANCE.md).

const two = (n) => String(n).padStart(2, '0');

/** The persona numbered n (1 to 99): id, principal, WhatsApp number and the orders it owns. */
export function personaOf(n, ordersOf = null) {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('a persona is numbered 1 to 99');
  const id = `guest-${two(n)}`;
  const principal = `cust-${id}`;
  const synthetic = [{ id: `o-9${two(n)}1`, owner: principal, charge: `ch_demo9${two(n)}1`, paid: 12000, asOf: '2026-10-01T09:30:00Z', body: `Order 9${two(n)}1: a desk lamp, delivered on 2 October.` }];
  if (n % 2 === 0) synthetic.push({ id: `o-9${two(n)}2`, owner: principal, charge: `ch_demo9${two(n)}2`, paid: 30000, asOf: '2026-10-06T12:00:00Z', body: `Order 9${two(n)}2: a sofa, delayed at the warehouse.` });
  const orders = ordersOf ? ordersOf({ n, id, principal }) : synthetic;
  return { n, id, principal, phone: `1555555${'01'}${two(n)}`, display: `+1 555 555 01${two(n)}`, orders };
}

/** The pool: sessions claim personas in order; a session keeps its persona; a full pool refuses a new session. */
/** `ordersOf({ n, id, principal })` replaces the synthetic orders (the recorded run gives the persona the orders its recorded answers cite). */
export function createPersonaPool({ size = 40, ordersOf = null } = {}) {
  const all = Array.from({ length: size }, (_, k) => personaOf(k + 1, ordersOf));
  const bySession = new Map();
  const claimed = () => new Set(bySession.values());
  return {
    size,
    claim(session) {
      if (bySession.has(session)) return bySession.get(session);
      const taken = claimed();
      const next = all.find((p) => !taken.has(p));
      if (!next) return null;
      bySession.set(session, next);
      return next;
    },
    byPhone: (phone) => all.find((p) => p.phone === phone && claimed().has(p)) ?? null,
    byPrincipal: (principal) => all.find((p) => p.principal === principal) ?? null,
    all: () => all.map((p) => ({ ...p })),
    claimed: () => [...claimed()],
  };
}
