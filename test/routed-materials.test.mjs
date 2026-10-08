// F1 of the review of the M10 and M11 merge, as ruled (PS18.2, PL6839, S402). A routed decision's tiers are asked
// through the route, not through M10's decision handler, so they get no materials, store no Content answer with its
// taint and check no citation: a routed decision with a Content or Items parameter, a Content result or cites is
// refused at check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';
import { DESK, FIX } from './routing-helpers.mjs';

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

test('PS18.2, PL6839: a routed decision with a Content or Items parameter, a Content result or cites is refused', { timeout: 300_000 }, async () => {
  const content = withParam('note', 'Content');
  const items = withParam('context', 'Items');
  const cites = swap(items, '    route triage\n', '    route triage\n    cites context\n');
  let result = swap(DESK, 'enum Branch', 'audience { public < customer }\n\nenum Branch');
  result = swap(result, '  action Classified(branch: Branch, conf: Conf, margin: Conf)', '  action Classified(branch: Content, conf: Conf, margin: Conf)');
  result = swap(result, '  decision classify(text: string) -> Branch {', '  decision classify(text: string) -> Content {');
  for (const [what, src, re] of [['a Content parameter', content, /parameter note/], ['an Items parameter', items, /parameter context/], ['cites', cites, /cites/], ['a Content result', result, /Content/]]) {
    const r = await check(src);
    assert.equal(r.verdict, 'REFUSED', `${what}: ${text(r)}`);
    assert.ok(all(r).some((d) => d.code === 'PL6839' && re.test(d.message)), `${what}: ${text(r)}`);
  }
  // The control: the desk as it is, a finite answer over a string, is not refused PL6839.
  const ok = await check(DESK);
  assert.ok(!all(ok).some((d) => d.code === 'PL6839'), text(ok));
});

