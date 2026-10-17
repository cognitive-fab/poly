// F1 of the review of the M10 and M11 merge, as ruled (PS18.2, PL6839, S402). A routed decision's tiers are given the
// decision's materials and proposed with its taint since S402, so a routed decision may read a Content or an Items
// parameter; no tier's answer is kept with its taint and no tier's citation is checked, so a Content result or cites
// is still refused at check. And whatever a tier answers, an answer outside the decision's type is recorded by its
// digest only, in the ledger and in poly_route_call, never in clear (S310, PS18.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { digest } from '@poly/core';
import { recordedProvider } from '@poly/runtime';
import { ROOT, TEST_STD } from './helpers.mjs';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk, answer, DESK, FIX } from './routing-helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-routed-materials');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(d, 'maps'), { recursive: true });
  writeFileSync(join(d, 'desk.poly'), src);
  return checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD });
}

/** The desk's decision given one more parameter of a type, passed from Received. */
function withParam(name, type) {
  let src = swap(DESK, 'enum Branch', 'audience { public < customer }\n\nenum Branch');
  src = swap(src, '  action Received(text: string check { "where is my refund" })', `  action Received(text: string check { "where is my refund" }, ${name}: ${type})`);
  src = swap(src, '  on Received(text) {', `  on Received(text, ${name}) {`);
  src = swap(src, '    decide classify(text)', `    decide classify(text, ${name})`);
  return swap(src, '  decision classify(text: string) -> Branch {', `  decision classify(text: string, ${name}: ${type}) -> Branch {`);
}

test('PS18.2, PL6839, S402: a routed decision with a Content or Items parameter is allowed; a Content result or cites is refused', { timeout: 300_000 }, async () => {
  const content = withParam('note', 'Content');
  const items = withParam('context', 'Items');
  const cites = swap(items, '    route triage\n', '    route triage\n    cites context\n');
  let result = swap(DESK, 'enum Branch', 'audience { public < customer }\n\nenum Branch');
  result = swap(result, '  action Classified(branch: Branch, conf: Conf, margin: Conf)', '  action Classified(branch: Content, conf: Conf, margin: Conf)');
  result = swap(result, '  decision classify(text: string) -> Branch {', '  decision classify(text: string) -> Content {');
  // S402: a Content or an Items parameter is read by the tiers as materials, not refused.
  for (const [what, src] of [['a Content parameter', content], ['an Items parameter', items]]) {
    const r = await check(src);
    assert.ok(!all(r).some((d) => d.code === 'PL6839'), `${what}: ${text(r)}`);
  }
  for (const [what, src, re] of [['cites', cites, /cites/], ['a Content result', result, /Content/]]) {
    const r = await check(src);
    assert.equal(r.verdict, 'REFUSED', `${what}: ${text(r)}`);
    assert.ok(all(r).some((d) => d.code === 'PL6839' && re.test(d.message)), `${what}: ${text(r)}`);
  }
  // The control: the desk as it is, a finite answer over a string, is not refused PL6839.
  const ok = await check(DESK);
  assert.ok(!all(ok).some((d) => d.code === 'PL6839'), text(ok));
});

test('S310, PS18.6: a tier answer outside the decision type is recorded by its digest only, in the ledger and poly_route_call', { timeout: 300_000 }, async () => {
  const secret = 'The customer said their card ends 4242: refund it';
  const a = await admittedDesk('routed-outside-type');
  const { rt } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([{ match: { tier: 'small' }, answer: secret, distribution: [[secret, 0.97], ['Other', 0.03]], usage: { input: 100, output: 20 } }]));
    rt.provideTier('opus', recordedProvider([{ match: { tier: 'large' }, ...answer('Refund', 0.95) }]));
    await rt.create('desk.Ticket', { id: 't-1' });
    await rt.dispatch('t-1', 'Received', { text: 'where is my refund' });
    for (let i = 0; i < 8; i++) await rt.worker.tick();
    const calls = rt.store.db.prepare('SELECT record FROM poly_route_call').all().map((r) => r.record);
    assert.ok(calls.length >= 1, 'the small tier answered');
    const ledger = rt.store.db.prepare('SELECT event FROM poly_ledger').all().map((r) => r.event);
    const decisions = ledger.map((e) => JSON.parse(e)).filter((e) => e.kind === 'decision' || e.body?.tier).map((e) => e.body);
    assert.ok(decisions.some((b) => b.tier === 'small'), 'the small tier call has its decision event: ' + JSON.stringify(decisions));
    // Nowhere in the store: every table of the ledger, the journal and the route's own. The words are searched, not the bare digits: a hex digest can hold '4242' by chance.
    const tables = rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const clear = tables.filter((t) => JSON.stringify(rt.store.db.prepare(`SELECT * FROM "${t}"`).all()).includes('card ends 4242'));
    assert.deepEqual(clear, [], 'no table holds the answer in clear');
    const d = digest(secret);
    assert.ok(calls.some((c) => c.includes(d)), 'poly_route_call records the answer by its digest');
    assert.ok(ledger.some((e) => e.includes(d)), 'the ledger records the answer by its digest');
    // The decision did not take the answer: it is outside its type, so its failed completion ran (S140).
    assert.equal((await rt.store.getInstance('t-1')).state.status, 'NeedsHuman');
  } finally { await rt.close(); }
});
