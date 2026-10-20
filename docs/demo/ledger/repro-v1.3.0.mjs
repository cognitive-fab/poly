// The room reproduction of the double refund on v1.3.0 (DF19 item 1). It assembles the demo over the demo copy of the tag v1.3.0
// (the folder in V130_SRC holds concierge.poly, concierge.policy.poly, maps/ and prices/ as `git show v1.3.0:demo/concierge/<file>`
// gives them) and the recorded answers of the current fixture, and sends two requests for 40 from guest 1 (the chairs, paid 120.00) and
// two from guest 3 (the synthetic order of the live room, paid 120.00). Run from the repository root with a heap of 8 GB:
//   V130_SRC=<folder> node --max-old-space-size=8192 docs/demo/ledger/repro-v1.3.0.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleDemo } from '../../../demo/host/assemble.mjs';
const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/concierge/answers.json'), 'utf8'));
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;
const ordersOf = ({ n, principal }) => {
  if (n === 1) return FIXTURE.orders.filter((o) => o.owner === 'cust-a').map((o) => ({ id: o.id, owner: principal, charge: o.charge, paid: o.paid, asOf: o.asOf, body: o.body }));
  if (n === 3) return [{ id: 'o-9031', owner: principal, charge: 'ch_demo9031', paid: 12000, asOf: '2026-10-08T10:00:00Z', body: 'Order 9031: a desk lamp, in warehouse.' }];
  return [];
};
let t = 1_790_000_000_000; const clock = { now: () => t, advance: (ms) => { t += ms; } };
const workdir = mkdtempSync(join(tmpdir(), 'v130-'));
const demo = await assembleDemo({ mode: 'recorded', workdir, now: clock.now, ordersOf, size: 3, source: process.env.V130_SRC });
try {
  demo.room.join('s1'); demo.room.join('s2'); demo.room.join('s3');
  const heard = { s1: [], s3: [] };
  demo.room.subscribe('s1', (e) => heard.s1.push(e.text)); demo.room.subscribe('s3', (e) => heard.s3.push(e.text));
  for (const [s, id] of [['s1', 'refund-twice'], ['s1', 'refund-twice'], ['s3', 'refund-synthetic'], ['s3', 'refund-synthetic']]) {
    clock.advance(6000); await demo.room.say(s, textOf(id));
    console.log(s, id, 'refunds at the stand-in:', demo.standIn.report().refunds, JSON.stringify(demo.standIn.report().amountRefunded));
  }
  console.log('guest 1 heard', JSON.stringify(heard.s1)); console.log('guest 3 heard', JSON.stringify(heard.s3));
} finally { await demo.close(); rmSync(workdir, { recursive: true, force: true }); }
