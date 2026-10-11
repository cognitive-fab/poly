// M7.2 fixtures: two SYNTHETIC trace corpora (PT29 format) for the orders program of conformance/m5/orders.poly.
// They are made for the purpose and labelled so (S514); no journal produced them. `node make-shop-traces.mjs <dir>` writes
//   shop.traces.ndjson      what the shop's runs look like when they follow the plan:
//       12 runs Reserve, Charge, Finish; 6 runs Cancel (with its fee). Planted truth, mined by polyx:
//       payment.charge never without a prior stock.reserve (12/12), at most one payment.charge per run (12/12), and
//       payment.charge only while status is Charging (12/12).
//   conflict.traces.ndjson  a corpus in which stock.reserve is only ever emitted while status is Cancelled (10 runs), against
//       6 runs that report other states and never reserve: a rule that contradicts the program, for the PL6501 case.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const token = (s) => `d:${createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
const FX = {
  reserve: { kind: 'stock.reserve', labels: ['write:store'], consequence: 'compensable', gate: { outcome: 'allowed', reason: 'allowed' } },
  charge: { kind: 'payment.charge', labels: ['egress:external'], consequence: 'irreversible', gate: { outcome: 'allowed', reason: 'allowed' } },
  fee: { kind: 'payment.fee', labels: ['egress:external'], consequence: 'irreversible', gate: { outcome: 'allowed', reason: 'allowed' } },
};
const step = (seq, action, pre, post, effects = []) => ({ seq, action, stepKind: 'accepted', rejectReason: null, pre: { status: pre }, data: {}, post: { status: post }, effects, outsideCheckDomain: [] });
const create = () => step(0, '$create', 'Open', 'Open');
const episode = (n, steps) => ({ episode: token(`run-${n}`), machine: 'orders.Order', gapped: false, steps, outcomes: [] });

function corpus(episodes) {
  const header = { v: 1, kind: 'poly.traces', project: 'shop', certificate: `sha256:${'0'.repeat(64)}`, episodes: episodes.length, omitted: { adviceEvents: 0, runtimeRuns: 0, archivedRuns: 0, erasedSteps: 0, gappedRuns: 0, erasedRuns: 0 }, unknown: { consequence: 0 } };
  return [header, ...episodes].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function shop() {
  const eps = [];
  let n = 0;
  for (let i = 0; i < 12; i++) eps.push(episode(n++, [create(), step(1, 'Reserve', 'Open', 'Reserving', [FX.reserve]), step(2, 'Charge', 'Reserving', 'Charging', [FX.charge]), step(3, 'Finish', 'Charging', 'Done')]));
  for (let i = 0; i < 6; i++) eps.push(episode(n++, [create(), step(1, 'Cancel', 'Open', 'Cancelled', [FX.fee])]));
  return corpus(eps);
}

export function conflict() {
  const eps = [];
  let n = 100;
  for (let i = 0; i < 10; i++) eps.push(episode(n++, [create(), step(1, 'Reserve', 'Open', 'Cancelled', [FX.reserve])]));
  for (let i = 0; i < 6; i++) eps.push(episode(n++, [create(), step(1, 'Charge', 'Open', 'Charging', [FX.charge]), step(2, 'Finish', 'Charging', 'Done')]));
  return corpus(eps);
}

if (process.argv[1] && process.argv[1].endsWith('make-shop-traces.mjs') && process.argv[2]) {
  mkdirSync(process.argv[2], { recursive: true });
  writeFileSync(join(process.argv[2], 'shop.traces.ndjson'), shop());
  writeFileSync(join(process.argv[2], 'conflict.traces.ndjson'), conflict());
}
