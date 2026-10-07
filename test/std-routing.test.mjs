// M11 steps 3 and 4 (PS18.1, PS18.4, AC25, AC26, S351, S352): std.routing. Route is CLEAN, and every path from Trying
// reaches Answered or Exhausted under the fairness of the provider's completion; Budget is CLEAN, and spent plus
// reserved never passes the cap except by a recorded overrun. A seeded mutant of each rule gives a finding with a
// witness, the one for route-ends a route that loops on a tier; PROVENANCE.md lists every rule as poly's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { parse, format } from '@poly/lang';
import { ROOT, TEST_STD } from './helpers.mjs';

const STD = join(ROOT, 'std', 'routing');
const SRC = readFileSync(join(STD, 'routing.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-std-routing');
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(src, opts = {}, file = 'routing.poly') {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), src);
  return checkFile(join(d, file), { root: d, ...opts });
}

/** One seeded mutant per rule: [handler, text, replacement], the text unique within that handler. */
const RULES = {
  'ready-at-the-first-tier': ['Start', "    r' = Trying\n", "    tier' = 1\n"],
  'one-tier-up': ['Answer', "    } else {\n      r' = Answered\n", "    } else {\n      r' = Answered\n      tier' = 0\n"],
  'calls-only-while-trying': ['Answer', "        r' = Exhausted\n", "        r' = Exhausted\n        emit call(tier)\n"],
  'answered-meets-thresholds': ['Answer', 'if conf < 0.8 || margin < 0.1 {', 'if margin < 0.1 {'],
  'below-thresholds-escalates': ['Answer', 'if conf < 0.8 || margin < 0.1 {', 'if conf < 0.5 || margin < 0.1 {'],
  'exhausted-after-the-last': ['Fail', 'if left > 0 {', 'if left > 1 {'],
  // AC25's seeded mutant: a failed tier is called again instead of escalated, so a route can loop forever.
  'route-ends': ['Fail', "      tier' = tier + 1\n      left' = left - 1\n      emit call(tier + 1)\n", '      emit call(tier)\n'],
  'within-cap': ['Reserve', 'require spent + reserved + r <= cap', 'require spent + r <= cap'],
  'spent-is-final': ['Release', 'if reserved == r && spent >= cap {', 'if reserved == r {'],
  'reserve-fits': ['Reserve', 'require spent + reserved + r <= cap', 'require spent + reserved + r <= cap + 1'],
  'cap-fixed': ['Release', "    reserved' = reserved - r\n", "    reserved' = reserved - r\n    cap' = 0\n"],
  'settle-charges-actual': ['Settle', "spent' = spent + actual", "spent' = spent + r"],
  'overrun-recorded': ['Settle', "overrun' = overrun + actual - r", "overrun' = overrun"],
  'spent-only-by-settle': ['Release', "    reserved' = reserved - r\n", "    reserved' = reserved - r\n    spent' = spent + r\n"],
};
function mutate(src, handler, from, to) {
  const start = src.search(new RegExp(`\n  on ${handler}[ ({]`));
  assert.ok(start >= 0, `no handler ${handler}`);
  const rest = src.slice(start + 1);
  const end = start + 1 + rest.search(/\n  (on |effect |invariant |step |liveness |\/\/)|\n}/);
  const body = src.slice(start, end);
  assert.equal(body.split(from).length, 2, `${handler}: the mutant's text is not unique in the handler: ${from}`);
  return src.slice(0, start) + body.replace(from, to) + src.slice(end);
}
const ruleNames = (src) => [...src.matchAll(/^\s*(?:invariant|step property|liveness) ([a-z0-9-]+):/gm)].map((m) => m[1]);

test('AC25, AC26: std.routing is CLEAN, Route free of deadlock with its liveness under fairness, Budget within its cap', { timeout: 300_000 }, async () => {
  assert.deepEqual(ruleNames(SRC).sort(), Object.keys(RULES).sort(), 'each rule has its seeded mutant');
  const parsed = parse(SRC);
  assert.equal(format(parsed.module, parsed.trivia), SRC, 'a std module is in canonical form');
  const r = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  for (const name of ['Route', 'Budget']) {
    const m = r.machines.find((x) => x.machine === name);
    assert.deepEqual([name, m.notRun, m.vacuous], [name, [], []]);
    for (const s of ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', ...(name === 'Route' ? ['liveness'] : [])]) {
      const st = m.stages.find((x) => x.stage === s);
      assert.deepEqual([name, s, st?.status, st?.verdict], [name, s, 'ran', 'CLEAN']);
    }
  }
  // The checked instances, printed with each verdict (PT12.3a): Route over the intervals its thresholds cut, Budget
  // over check domains that put a reservation below, at and above the remainder (PS18.4).
  const route = r.machines.find((x) => x.machine === 'Route').instance;
  assert.ok(route.domains.includes('Answer.conf ∈ {0, 800}') && route.domains.includes('Answer.margin ∈ {0, 100}'), JSON.stringify(route.domains));
  const budget = r.machines.find((x) => x.machine === 'Budget').instance;
  for (const d of ['cap ∈ 0..3', 'Reserve.r ∈ 1..3', 'Settle.actual ∈ 0..6']) assert.ok(budget.domains.includes(d), JSON.stringify(budget.domains));
});

for (const [rule, [handler, from, to]] of Object.entries(RULES)) {
  test(`the seeded mutant of ${rule} gives a finding with a witness`, { timeout: 300_000 }, async () => {
    const r = await check(mutate(SRC, handler, from, to));
    const f = all(r).find((d) => d.message.includes(rule));
    assert.ok(f, text(r));
    assert.ok(f.witness?.trace?.length || f.witness?.length, JSON.stringify(f));
  });
}

test('PROVENANCE.md lists every rule as poly\'s own, and every constant', () => {
  const prov = readFileSync(join(STD, 'PROVENANCE.md'), 'utf8');
  const own = prov.slice(prov.indexOf("## poly's own rules"), prov.indexOf('## Constants'));
  for (const rule of Object.keys(RULES)) assert.ok(own.includes(`\`${rule}\``), `${rule}: not listed as poly's own`);
  for (const [, c] of SRC.matchAll(/\b(\d+(?:ms|s|m|h))\b/g)) assert.ok(prov.includes(`\`${c}\``) || prov.includes(c), `${c}: not in PROVENANCE.md`);
  assert.match(prov, /PL6843/);
});

test('the tests\' std holds std.routing byte for byte', () => {
  assert.equal(readFileSync(join(TEST_STD, 'routing', 'routing.poly'), 'utf8'), SRC);
});
