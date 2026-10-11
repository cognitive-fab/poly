// plan-ex.md E1, S462 (decisions-ex.md, "Why a require that rejects a completion checks CLEAN"). The concierge's refund
// guard is an `if`, because a `require cites.count == 1` that rejects the amount decision's completion leaves the Desk in
// Extracting with no reply (test/ex-concierge-refund.test.mjs shows it at run time). The question was whether a liveness
// property would have found it. On the cut-down refund path, with the property "every message the Desk takes is worked
// through to its end": phase != Idle leads to phase == Idle, under weak fairness of each completion group,
//   the require version is CLEAN, as the if version is: the machine check offers a decision's completions as free inputs
//     (PS4.4), so the failed completion Unextracted is always still there to be taken, and fairness takes it;
//   the property is not vacuous: without the amount completions in the fair set both versions fail, PL3301, with a lasso.
// The generated configuration does model the runtime (S456: a completion, whatever its verdict, takes its pending intent
// off), but it evaluates no liveness property of the application and has no finding for a rejected completion as it has
// for a rejected receipt (PL5406). So the checker's machine model differs from the runtime on a rejected completion, and
// its configuration model matches the runtime but reports nothing: a defect for the release session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const SRC = readFileSync(join(ROOT, 'test', 'fixtures', 'ex-concierge', 'refund-order.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-build', 'ex-concierge-liveness');
const swap = (src, from, to) => { assert.equal(src.split(from).length, 2, from); return src.split(from).join(to); };
const GUARD = `    if conf >= 0.8 {
      if cites.count == 1 {
        phase' = Refunding
        large' = value > 100
        emit refund(amount: value, customer: customer, order: cites)
      } else {
        phase' = Answering
        decide reply(question: question, outcome: Unsure)
      }
    } else {`;
const REQUIRE = swap(SRC, GUARD, `    require cites.count == 1 else reject "not-one"
    if conf >= 0.8 {
      phase' = Refunding
      large' = value > 100
      emit refund(amount: value, customer: customer, order: cites)
    } else {`);
const FAIR = 'Found | LookupFailed, Amounted | Unextracted, Refunded | RefundFailed, Answered | AnswerFailed';
const live = (src, fair = FAIR) => swap(src, '\n  effect lookup(', `
  liveness settles: phase != Idle leads to phase == Idle
    under fair { ${fair} }

  effect lookup(`);
const codes = (r) => [...new Set([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code))];

async function check(name, src) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.poly`);
  writeFileSync(file, src);
  return checkFile(file, { root: join(OUT, name) });
}

test('liveness: the require version of the refund guard checks CLEAN with the property, as the if version does', { timeout: 300_000 }, async () => {
  for (const [name, src] of [['require', REQUIRE], ['if', SRC]]) {
    const r = await check(`live-${name}`, live(src));
    assert.equal(r.verdict, 'CLEAN', `${name}: ${JSON.stringify(codes(r))}`);
  }
});

test('liveness: the property is not vacuous: without the amount completions in the fair set, both versions fail PL3301 with a lasso', { timeout: 300_000 }, async () => {
  for (const [name, src] of [['require', REQUIRE], ['if', SRC]]) {
    const r = await check(`unfair-${name}`, live(src, 'Found | LookupFailed, Refunded | RefundFailed, Answered | AnswerFailed'));
    assert.equal(r.verdict, 'FINDINGS', name);
    assert.deepEqual(codes(r), ['PL3301'], name);
    const d = r.machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL3301');
    assert.match(d.message, /lasso/);
  }
});
