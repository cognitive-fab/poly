// plan-ex.md E1, S462, S463 (decisions-ex.md, "Why a require that rejects a completion checks CLEAN"). The concierge's
// refund guard is an `if`, because a `require cites.count == 1` that rejects the amount decision's completion leaves the
// Desk in Extracting with no reply (test/ex-concierge-refund.test.mjs shows it at run time). On the cut-down refund path,
// with the property "every message the Desk takes is worked through to its end": phase != Idle leads to phase == Idle,
// under weak fairness of each completion group,
//   the machine check is CLEAN for the require version as for the if version: it offers a decision's completions as free
//     inputs (PS4.4), so the failed completion Unextracted is always still there to be taken, and fairness takes it. A
//     liveness property of a machine assumes that no completion of the program's own intents is rejected (PS6.4, S463);
//   the property is not vacuous: without the amount completions in the fair set both versions fail, PL3301, with a lasso;
//   the finding that discharges the assumption is PL5409 COMPLETION_REJECTED, in the channel's generated configuration,
//     which models the runtime's one completion of each intent (PS15.5, S463): the require copy gets it, with a witness
//     that ends in the rejected Amounted, and the if copy does not.
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
const codes = (r) => [...new Set([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)].map((d) => d.code))];

/** The cut-down path behind a WhatsApp channel, so it has a generated configuration (PS15.5): the concierge's binding. */
const behindChannel = (src) => {
  let t = swap(src, `  on Got(body) by c: Customer {
    require phase == Idle else reject "busy"
    customer' = c.principal
    phase' = Finding
    question' = body
    emit lookup(customer: c.principal)
  }`, `  on Start {
    require !started else reject "started"
    started' = true
  }

  on Got(body) by c: Customer {
    if phase == Idle {
      customer' = c.principal
      phase' = Finding
      question' = body
      emit lookup(customer: c.principal)
    } else {
      customer' = c.principal
    }
  }

  on Delivered {
    started' = started
  }

  on SendRejected(reason) {
    started' = started
  }

  on SendFailed {
    started' = started
  }`);
  t = swap(t, `  action Got(body: Content)`, `  action Start()
  action Got(body: Content)
  action Delivered()
  action SendRejected(reason: string check { "window-closed" })
  action SendFailed()`);
  t = swap(t, `    large    : bool      = false
  }`, `    large    : bool      = false
    started  : bool      = false
  }`);
  return swap(t, 'service machine Desk {', `channel support: whatsapp {
  adapter "whatsapp"
  thread "{from}"
  audience customer
  principal from principal
  starts Desk.Start on inbound
  Message -> Desk.Got
  Delivered -> Desk.Delivered
  Rejected -> Desk.SendRejected
  Failed -> Desk.SendFailed
}

service machine Desk {`);
};

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

test('S463: the require copy behind a channel gets PL5409 with a witness that ends in the rejected Amounted; the if copy does not', { timeout: 600_000 }, async () => {
  const bad = await check('channel-require', behindChannel(REQUIRE));
  const found = [...bad.diagnostics, ...bad.machines.flatMap((m) => m.diagnostics), ...(bad.configurations ?? []).flatMap((c) => c.diagnostics)].filter((d) => d.code === 'PL5409');
  assert.ok(found.length >= 1, JSON.stringify(codes(bad)));
  assert.match(found[0].message, /Amounted/);
  assert.ok(found[0].witness?.trace?.length > 0, 'the finding carries its witness');
  assert.equal(found[0].witness.trace.at(-1).action, 'Amounted');
  const good = await check('channel-if', behindChannel(SRC));
  assert.ok(!codes(good).includes('PL5409'), JSON.stringify(codes(good)));
});
