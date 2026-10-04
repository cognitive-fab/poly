// PD5.2.2c, PD5.2.3, S156: policies read lineage.origin.f and lineage.intent, and a scope may require attribution.
//   - a payment made by a completion step inherits the origin of the step that started the chain: allowed when that
//     was a person's step, denied when an agent's (PD5.2.2c);
//   - in a scope that requires attribution, a compensable or irreversible effect reachable from an origin with no claims
//     is PL6701, a finding whose witness is the path from the unattributed action to the effect (PD5.2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function projectOf(name, files) {
  const dir = join(ROOT, '.poly', 'test-policy', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}

test('PD5.2.2c: a completion step\'s effect is decided on the origin it inherits', { skip }, async () => {
  const a = await admitted('policy-lineage', ['conformance/m5/lineage-pay.poly', 'conformance/m5/lineage-pay.policy.poly']);
  let caller = null;
  const { rt } = await loaded(a, { verifier: () => caller });
  try {
    handleWith(rt, 'lp.check', () => 'ok');
    handleWith(rt, 'lp.pay', () => 'paid');
    for (const kind of ['Agent', 'Person']) {
      caller = { kind, attest: 'Verified', assurance: 3, principal: kind.toLowerCase() };
      await rt.create('lp.Order', { id: kind });
      await rt.dispatch(kind, 'Check', {}, { actionId: `c-${kind}`, credentials: 'x' });
      for (let k = 0; k < 3; k++) await rt.worker.tick();
    }
    const pay = async (id) => (await rt.chain(id)).find((e) => e.kind === 'verdict' && e.body.effectKind === 'lp.pay')?.body;
    assert.equal((await pay('Agent')).outcome, 'denied');
    assert.equal((await pay('Person')).outcome, 'allowed');
  } finally { await rt.close(); }
});

test('PD5.2.3, S156: in a scope that requires attribution, an irreversible effect from an origin with no claims is PL6701', { skip }, async () => {
  const unclaimed = read('conformance/m5/lineage-pay.poly').replace('on Check() by c: Caller {', 'on Check() {');
  const p = await checkProject(projectOf('attribution', { 'lp.poly': unclaimed, 'p.policy.poly': read('conformance/m5/lineage-pay.policy.poly') }));
  const s = p.files.flatMap((f) => f.policies).find((x) => x.scope === 'lp');
  const f = s.diagnostics.find((d) => d.code === 'PL6701');
  assert.ok(f, JSON.stringify(s.diagnostics.map((d) => d.code + ' ' + d.message)));
  assert.deepEqual(f.witness.trace.map((t) => t.action), ['Check', 'Checked']);
  assert.match(f.message, /lp\.pay/);
  const claimed = await checkProject(projectOf('attribution-ok', { 'lp.poly': read('conformance/m5/lineage-pay.poly'), 'p.policy.poly': read('conformance/m5/lineage-pay.policy.poly') }));
  const ok = claimed.files.flatMap((x) => x.policies).find((x) => x.scope === 'lp');
  assert.deepEqual(ok.diagnostics.filter((d) => d.code === 'PL6701'), []);
  assert.equal(ok.verdict, 'CLEAN', JSON.stringify(ok.stages));
});

// S162: in a scope that requires attribution, an outside dispatch of an effect's completion or of a timer's target is
// refused before any step, with an audit row, as K9 and K10 refuse theirs; the gate's deny stays as the second line.
// Outside such a scope, the same dispatch is a step as before.
test('S162: an outside dispatch of a completion or a timer target is refused in a scope that requires attribution', { skip }, async () => {
  const { RefusedDispatch } = await import('@poly/runtime');
  const person = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' };
  for (const [name, sources, machine, start, target] of [
    ['s162-completion', ['conformance/m5/lineage-pay.poly', 'conformance/m5/lineage-pay.policy.poly'], 'lp.Order', 'Check', 'Checked'],
    ['s162-timer', ['conformance/m5/lineage-timer.poly', 'conformance/m5/lineage-timer.policy.poly'], 'lt.Hold', 'Start', 'Due'],
  ]) {
    const a = await admitted(name, sources);
    const { rt } = await loaded(a, { verifier: () => person });
    try {
      await rt.create(machine, { id: 'x' });
      await rt.dispatch('x', start, {}, { actionId: 's', credentials: 'c' });
      const before = (await rt.chain('x')).length;
      await assert.rejects(rt.dispatch('x', target, {}, { actionId: 'outside' }), (e) => e instanceof RefusedDispatch && e.rule === 'S162' && e.message.includes(target), name);
      assert.ok((await rt.audit('x')).some((r) => r.rule === 'S162' && r.action === target), name);
      assert.equal((await rt.chain('x')).length, before, name);
    } finally { await rt.close(); }
  }
  // Without the policy the scope does not require attribution, and the completion is dispatched as before.
  const open = await admitted('s162-open', ['conformance/m5/lineage-pay.poly']);
  const { rt } = await loaded(open, { verifier: () => person });
  try {
    await rt.create('lp.Order', { id: 'y' });
    await rt.dispatch('y', 'Check', {}, { actionId: 's', credentials: 'c' });
    assert.equal((await rt.dispatch('y', 'Checked', {}, { actionId: 'outside' })).stepKind, 'accepted');
  } finally { await rt.close(); }
});

// ── review of M5b, part C ──────────────────────────────────────────────────

// C2: a policy that reads step.claims or lineage.origin as a whole (unknown(step.claims)) reads every field: the
// decision table offers claims and origins for it, so a never statement it violates is found.
test('review C2: a whole-record read of step.claims or lineage.origin is explored', { skip }, async () => {
  for (const req of ['!unknown(step.claims)', '!unknown(lineage.origin)']) {
    const pol = `module rp\n\npolicy whole {\n  scope "refund"\n  obligation r "A refund has claims." rule {\n    when effect.kind == "payments.refund"\n    require ${req} else deny\n  }\n  never no-refund "No refund is allowed.": allow when effect.kind == "payments.refund"\n}\n`;
    const p = await checkProject(projectOf(`whole-${req.includes('step') ? 'step' : 'origin'}`, { 'refund.poly': read('conformance/m5/refund.poly'), 'p.policy.poly': pol }));
    const s = p.files.flatMap((f) => f.policies ?? []).find((x) => x.scope === 'refund');
    assert.ok(s.diagnostics.some((d) => d.code === 'PL6503'), `${req}: ${JSON.stringify(s.stages.find((x) => x.stage === 'never'))}`);
  }
});

// C3: a field two claims types declare with different types cannot be read from a policy, whichever comes first.
test('review C3: a claims field with two types is refused in a policy, in either order', async () => {
  const prog = (first, second) => `module two\n\nenum Kind { Person, Agent }\n\nclaims ${first}\n\nclaims ${second}\n\nenum Status { Idle, Done }\n\nmachine Pay {\n  state { status : Status = Idle }\n  terminal status == Done\n  action ByA()\n  action ByB()\n  on ByA() by a: A {\n    require status == Idle else reject "busy"\n    status' = Done\n    emit pay(1)\n  }\n  on ByB() by b: B {\n    require status == Idle else reject "busy"\n    status' = Done\n    emit pay(1)\n  }\n  effect pay(n: 0..1) {\n    kind "two.pay"\n    labels { egress:external }\n    class irreversible\n  }\n}\n`;
  const A = 'A {\n  level: Kind\n}';
  const B = 'B {\n  level: 0..3\n}';
  const pol = `module twop\n\npolicy twop {\n  scope "two"\n  obligation lv "Level." rule {\n    when effect.kind == "two.pay"\n    require step.claims.level >= 2 else deny\n  }\n}\n`;
  for (const [x, y] of [[A, B], [B, A]]) {
    const p = await checkProject(projectOf('shared-field', { 'two.poly': prog(x, y), 'p.policy.poly': pol }));
    const s = p.files.flatMap((f) => f.policies ?? []).find((z) => z.scope === 'two');
    assert.ok(s.diagnostics.some((d) => d.code === 'PL1201' && /level/.test(d.message) && /A/.test(d.message) && /B/.test(d.message)), JSON.stringify(s.diagnostics.map((d) => d.message)));
  }
});

// Polywatch on the M5b fixes: claims fields were kept in a plain object and tested with `in`, so a field named like an
// Object.prototype member (constructor) was a conflict with a type named undefined.
test('polywatch: a claims field named constructor is read from a policy like any other', async () => {
  const prog = `module ctor

enum Kind { Person, Agent }

claims A {
  constructor: Kind
}

enum Status { Idle, Done }

machine Pay {
  state { status : Status = Idle }
  terminal status == Done
  action Go()
  on Go() by a: A {
    require status == Idle else reject "busy"
    status' = Done
    emit pay(1)
  }
  effect pay(n: 0..1) {
    kind "ctor.pay"
    labels { egress:external }
    class irreversible
  }
}
`;
  const pol = `module ctorp

policy ctorp {
  scope "ctor"
  obligation who "Who." rule {
    when effect.kind == "ctor.pay"
    require step.claims.constructor == Person else deny
  }
}
`;
  const p = await checkProject(projectOf('ctor-field', { 'ctor.poly': prog, 'p.policy.poly': pol }));
  const s = p.files.flatMap((x) => x.policies ?? []).find((z) => z.scope === 'ctor');
  assert.ok(!s.diagnostics.some((d) => d.code === 'PL1201' || d.code === 'PL1001'), JSON.stringify(s.diagnostics.map((d) => d.message)));
});

// C4: an author's obligation named attribution is the author's; the scope's attribution rule has its own source.
test('review C4: an obligation named attribution does not take the attribution rule\'s place', { skip }, async () => {
  const pol = read('conformance/m5/lineage-pay.policy.poly').replace('obligation person-pays', 'obligation attribution');
  const p = await checkProject(projectOf('attribution-name', { 'lp.poly': read('conformance/m5/lineage-pay.poly'), 'p.policy.poly': pol }));
  const s = p.files.flatMap((f) => f.policies ?? []).find((x) => x.scope === 'lp');
  assert.equal(s.verdict, 'CLEAN', JSON.stringify(s.diagnostics.map((d) => d.message)));
});
