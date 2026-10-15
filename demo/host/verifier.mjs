// DF3: the small verifier adapter a deployment writes: the sender the certified adapter verified (the number WhatsApp
// authenticated) is mapped to the principal of the persona that owns it, `cust-guest-NN`, or to nothing. Nothing in a message's
// text chooses the principal. The runtime calls the function with the verified sender (rt.mapSenders, S450).

/** A sender mapping over the pool: the principal of the persona whose number this is, else null. */
export function principalOf(pool) {
  return (sender) => {
    if (typeof sender !== 'string' || sender === '') return null;
    return pool.byPhone(sender)?.principal ?? null;
  };
}
