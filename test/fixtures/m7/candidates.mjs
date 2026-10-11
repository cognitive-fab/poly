// M7.2 fixtures: candidate rules and candidate files built by hand from PT30.3 and PT30.9, so the adjudication and
// promotion tests need not run polyx. The ids are polyx-style (16 hex digits) and fixed. The digest is PS20.1's: the
// SHA-256 of the canonical JSON of the candidate without its digest field.
import { createHash } from 'node:crypto';
import { canonicalize } from '@poly/core';

export const digestOf = (c) => {
  const { digest: _d, ...rest } = c;
  return `sha256:${createHash('sha256').update(canonicalize(rest), 'utf8').digest('hex')}`;
};

const TOKEN = (n) => `d:${createHash('sha256').update(`run-${n}`).digest('hex').slice(0, 32)}`;

/** A candidate, with its digest set. */
export function candidate(c) {
  const full = { status: 'proposed', counterEvidence: [], promotable: true, ...c };
  return { ...full, digest: digestOf(full) };
}

const pathProperty = (id, body) => `path property mined-${id}: ${body}`;
const eligibility = (id, kind, machine, field, values, holds, of) => {
  const vs = [...values].sort();
  const text = `${kind} only while ${field} is ${vs.join(' or ')} (mined, ${holds} of ${of} runs)`;
  return {
    text,
    source: [
      `obligation mined-${id} "${text}" rule {`,
      `  when proposal.kind == "effect" && effect.kind == "${kind}"`,
      `  require machine("${machine}").${field} in { ${vs.join(', ')} } else deny`,
      '  on unknown escalate',
      '}',
    ].join('\n'),
  };
};

export const ID = {
  atMostCharge: 'a000000000000001',
  beforeCharge: 'a000000000000002',
  eligReserve: 'a000000000000003',
  eligConflict: 'a000000000000004',
  sameS: 'a000000000000005',
  exactlyOne: 'a000000000000006',
  mixed: 'a000000000000007',
  atMostFee: 'a000000000000008',
};

export const CANDIDATES = {
  // Holds of the shop's orders: a charge leaves the order Charging, and a second charge is rejected.
  atMostCharge: candidate({ id: ID.atMostCharge, pattern: 'at-most-one-X', status: 'suppressed', support: { holds: 12, of: 12 }, form: 'path-property', target: { machine: 'orders.Order' }, text: 'payment.charge at most once per run (mined, 12 of 12 runs)', source: pathProperty(ID.atMostCharge, 'count("payment.charge") <= 1') }),
  atMostFee: candidate({ id: ID.atMostFee, pattern: 'at-most-one-X', status: 'suppressed', support: { holds: 6, of: 6 }, form: 'path-property', target: { machine: 'orders.Order' }, text: 'payment.fee at most once per run (mined, 6 of 6 runs)', source: pathProperty(ID.atMostFee, 'count("payment.fee") <= 1') }),
  // The shop lets a charge happen before any reserve (Charge is offered from Open), so this one is violated: the finding is the news.
  beforeCharge: candidate({ id: ID.beforeCharge, pattern: 'X-implies-prior-Y', support: { holds: 12, of: 12 }, form: 'path-property', target: { machine: 'orders.Order' }, text: 'payment.charge after stock.reserve (mined, 12 of 12 runs)', source: pathProperty(ID.beforeCharge, 'before("stock.reserve", "payment.charge")') }),
  // Consistent with the shop: the reserve effect is emitted by a step that leaves the order Reserving.
  eligReserve: candidate({ id: ID.eligReserve, pattern: 'no-X-unless-state', support: { holds: 12, of: 12 }, form: 'policy-rule', target: { machine: 'orders.Order' }, ...eligibility(ID.eligReserve, 'stock.reserve', 'orders.Order', 'status', ['Reserving'], 12, 12) }),
  // Contradicts the shop: the reserve only while the order is Cancelled, which no step that reserves leaves it, so the mandate "reserve before the session ends" cannot be met.
  eligConflict: candidate({ id: ID.eligConflict, pattern: 'no-X-unless-state', support: { holds: 10, of: 10 }, form: 'policy-rule', target: { machine: 'orders.Order' }, ...eligibility(ID.eligConflict, 'stock.reserve', 'orders.Order', 'status', ['Cancelled'], 10, 10) }),
  sameS: candidate({ id: ID.sameS, pattern: 'no-X-without-prior-Y-same-S', support: { holds: 12, of: 12 }, promotable: false, reason: 'the pattern no-X-without-prior-Y-same-S is not promotable in M7', text: 'payment.charge after stock.reserve on the same run' }),
  exactlyOne: candidate({ id: ID.exactlyOne, pattern: 'exactly-one-Y-per-X', status: 'suppressed', support: { holds: 12, of: 12 }, promotable: false, reason: 'the pattern exactly-one-Y-per-X is not promotable in M7', text: 'one stock.reserve per payment.charge' }),
  mixed: candidate({ id: ID.mixed, pattern: 'X-implies-prior-Y', support: { holds: 12, of: 12 }, promotable: false, reason: 'the rule mixes an effect (payment.charge) and a pure action (Finish), which is not promotable in M7', text: 'Finish after payment.charge' }),
};

/** A candidates file (PT30.3) holding the named candidates. */
export function candidatesFile(names, { kind = 'recorded', episodes = 18 } = {}) {
  return {
    v: 1,
    kind: 'poly.candidates',
    corpus: { digest: `sha256:${createHash('sha256').update(`corpus-${kind}`).digest('hex')}`, kind, episodes, gappedLeftOut: 0 },
    tool: { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf93eeeef8ac81ea332384df227d7f70', manifest: `sha256:${createHash('sha256').update('manifest').digest('hex')}`, lens: '0.3.0' },
    thresholds: { minInstances: 5, ownSupport: 0.6, impliesSupport: 0.9 },
    candidates: names.map((n) => CANDIDATES[n]),
  };
}

export const counterEvidence = (n) => [{ episode: TOKEN(n), seq: 2 }];
