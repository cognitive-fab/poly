// The fault scripts of the stand-in (DB6 item 5). A fault is data: a list of rules, each naming the request it applies to by host,
// method, path and its position among the requests that match (`nth`), and what happens to the connection once the stand-in has
// handled the request. The same script is run against every build.
//
//   lost-answer  the first POST /v1/refunds is applied (the refund object exists) and the connection is reset before the answer
//                reaches the client; every later request is normal. It is the first attempt's lost answer of the witness of PS23.8.
//   hold         the same request is applied, and the connection is held open with no answer for `ms` before it is dropped, for a build
//                that only fails on a timeout.
//   none         nothing is faulted (the control).
export const FAULTS = {
  none: { name: 'none', rules: [] },
  'lost-answer': { name: 'lost-answer', rules: [{ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds', nth: 1, then: 'reset' }] },
  hold: { name: 'hold', rules: [{ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds', nth: 1, then: 'hold', ms: 15_000 }] },
};

/** A script by name, or a script object of the same shape. */
export function faultScript(x) {
  if (x === undefined || x === null) return FAULTS.none;
  if (typeof x === 'string') {
    if (!FAULTS[x]) throw new Error(`no fault script named ${x}; there are ${Object.keys(FAULTS).join(', ')}`);
    return FAULTS[x];
  }
  return { name: x.name ?? 'custom', rules: x.rules ?? [] };
}

/** The rule a request meets, given how many requests have matched each rule so far; counts is a Map of rule to matches. */
export function ruleFor(script, request, counts) {
  for (const rule of script.rules) {
    if (rule.host !== request.host || rule.method !== request.method || rule.path !== request.path) continue;
    const n = (counts.get(rule) ?? 0) + 1;
    counts.set(rule, n);
    if (n === rule.nth) return rule;
  }
  return null;
}
