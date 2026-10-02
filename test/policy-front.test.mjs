// M5a step 2 (PT8): the policy front end. A `.policy.poly` parses and formats to one text; its names and types are
// checked against the program; it lowers to one polyaxion.policy.json per trust scope; Polyaxion admits it; poly-ref
// validates the lowering against PS8 over the decision table; and its `never` statements are proved (S149).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkProject, checkFile } from '@poly/check';
import { lowerPolicyScope, POLICY_FAULTS } from '@poly/lower';
import { policyFacts, validatePolicy, checkNever, decide } from '@poly/ref';
import { polyaxionPeer, loadPolyaxion, policyEngine } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { POLICY_FAULT_SOURCES } from './toolchain-faults.mjs';

const BUILD = join(ROOT, '.poly', 'test-policy');
const peer = polyaxionPeer();

function projectOf(name, files) {
  const dir = join(BUILD, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORDERS = read('conformance/m5/orders.poly');
const POLICY = read('conformance/m5/orders.policy.poly');
const scopeOf = (p, scope) => p.files.flatMap((f) => f.policies).find((x) => x.scope === scope);

test('PT8.1: a policy parses, and formats back to itself', () => {
  const r = parse(POLICY);
  assert.deepEqual(r.diagnostics, []);
  const pol = r.module.decls.find((d) => d.kind === 'Policy');
  assert.equal(pol.scope, 'orders');
  assert.deepEqual(pol.items.map((i) => i.kind), ['MachineObligation', 'RuleObligation', 'Never']);
  assert.equal(format(r.module, r.trivia), POLICY);
});

test('PT8: the AC4 project checks CLEAN through every policy stage, and lowers one document for its scope', async (t) => {
  const dir = projectOf('ac4', { 'orders.poly': ORDERS, 'orders.policy.poly': POLICY });
  const p = await checkProject(dir);
  const s = scopeOf(p, 'orders');
  assert.ok(s, 'a policy report for scope orders');
  assert.deepEqual(s.policies, ['orders-governance']);
  assert.deepEqual(s.reads, ['orders.Order']);
  const doc = JSON.parse(readFileSync(join(dir, s.artefact.path), 'utf8'));
  assert.equal(doc.polyaxion, '2');
  assert.equal(doc.scope, 'orders');
  // PS8.3 needs deny rules before escalate rules; PS8.2 needs the unknown companion.
  assert.deepEqual(doc.obligations.map((o) => [o.id, o.kind, o.severity ?? null]), [
    ['orders-governance.orders-irreversible', 'rule', 'deny'],
    ['orders-governance.orders-irreversible.unknown', 'rule', 'escalate'],
    ['orders-governance.reserve-before-charge', 'machine', null],
  ]);
  if (!peer.ok) {
    t.diagnostic(`not run: ${peer.reason}`);
    assert.equal(s.verdict, 'INCONCLUSIVE');
    assert.ok(s.stages.some((x) => x.stage === 'policy-admission' && x.status === 'not-run'));
    return;
  }
  assert.equal(s.verdict, 'CLEAN', JSON.stringify(s.stages));
  assert.deepEqual(s.stages.map((x) => [x.stage, x.verdict]), [['policy-types', 'CLEAN'], ['policy-lower', 'CLEAN'], ['consistency', 'CLEAN'], ['policy-admission', 'CLEAN'], ['policy-tv', 'CLEAN'], ['regions', 'CLEAN'], ['never', 'CLEAN']]);
});

test('PT8, S147: unknown names, wrong types and a machine read that can never be known are reported', async () => {
  const bad = POLICY
    .replace('machine("orders.Order").status == Cancelled\n    require', 'machine("orders.Order").state == Cancelled\n    require')
    .replace('effect.kind == "stock.reserve"', 'effect.kinde == "stock.reserve"');
  const dir = projectOf('names', { 'orders.poly': ORDERS, 'orders.policy.poly': bad });
  const s = scopeOf(await checkProject(dir), 'orders');
  assert.deepEqual(s.diagnostics.map((d) => d.code).sort(), ['PL1001', 'PL1001']);
  assert.equal(s.verdict, 'REFUSED');
  const ledger = ORDERS.replace('machine Order {', 'machine Ledger {\n  state { open : bool = true }\n  action Close()\n  on Close { require open else reject "closed"  open\' = false }\n}\n\nmachine Order {');
  const unknowable = POLICY.replace('never no-fee-when-cancelled', 'obligation ledger-open "The ledger is open." rule {\n    when machine("orders.Ledger").open == false\n    require false else deny\n  }\n  never no-fee-when-cancelled');
  const s2 = scopeOf(await checkProject(projectOf('unknowable', { 'orders.poly': ledger, 'orders.policy.poly': unknowable })), 'orders');
  assert.ok(s2.diagnostics.some((d) => d.code === 'PL6502' && /never known/.test(d.message)), JSON.stringify(s2.diagnostics));
  assert.notEqual(s2.verdict, 'CLEAN');
});

test('S149: a policy without the rule its never statement relies on is a finding with a witness; a never statement that never applies is vacuous', async () => {
  const noRule = POLICY.replace(/  obligation orders-irreversible[\s\S]*?\n  }\n/, '');
  const s = scopeOf(await checkProject(projectOf('never-broken', { 'orders.poly': ORDERS, 'orders.policy.poly': noRule })), 'orders');
  const f = s.diagnostics.find((d) => d.code === 'PL6503');
  assert.ok(f, JSON.stringify(s.diagnostics));
  const last = f.witness.trace.at(-1);
  assert.equal(last.data.machines['orders.Order'].status, 'Cancelled');
  assert.equal(last.data.effect.class, 'irreversible');
  assert.match(f.witness.id, /^sha256:/);
  const vacuous = POLICY.replace('effect.machine == "orders.Order" && effect.class == "irreversible" && machine("orders.Order").status == Cancelled\n}', 'effect.kind == "payment.fee" && effect.class == "none"\n}'); // the fee is irreversible, so no proposal meets it
  const s2 = scopeOf(await checkProject(projectOf('never-vacuous', { 'orders.poly': ORDERS, 'orders.policy.poly': vacuous })), 'orders');
  assert.deepEqual(s2.vacuous.map((v) => v.property), ['orders-governance.no-fee-when-cancelled']);
  assert.equal(s2.verdict, 'INCONCLUSIVE');
});

test('S149: a deliberately broken decision-table evaluator is caught by translation validation', async (t) => {
  if (!peer.ok) { t.todo(`not run: ${peer.reason}`); return; }
  const mod = parse(read('conformance/m5/policy-faults.poly')).module;
  const pols = mod.decls.filter((d) => d.kind === 'Policy');
  const px = await loadPolyaxion();
  const doc = lowerPolicyScope('pf', pols, 'test');
  const engine = policyEngine(px, px.compileToTriple(doc).plan);
  const facts = policyFacts([mod]);
  assert.equal(validatePolicy({ scope: 'pf', policies: pols }, facts, engine).mismatch, null, 'the true evaluator agrees');
  const broken = (s, sigma, row) => { const d = decide(s, sigma, row); return d.decision === 'escalate' ? { ...d, decision: 'allow' } : d; };
  assert.ok(validatePolicy({ scope: 'pf', policies: pols }, facts, engine, { evaluate: broken }).mismatch, 'the broken evaluator is caught');
  // And a never statement proved with it would be wrong: the evaluator is on the check path.
  assert.ok(checkNever({ scope: 'pf', policies: pols }, facts, () => ({}), { evaluate: broken }));
});

for (const fault of POLICY_FAULTS) {
  test(`a broken policy lowering is caught with PL2501: ${fault}`, async (t) => {
    if (!peer.ok) { t.todo(`not run: ${peer.reason}`); return; }
    assert.ok(POLICY_FAULT_SOURCES[fault], `${fault} is listed in toolchain-faults.mjs`);
    const px = await loadPolyaxion();
    for (const src of POLICY_FAULT_SOURCES[fault]) {
      const mod = parse(read(src)).module;
      const pols = mod.decls.filter((d) => d.kind === 'Policy');
      const facts = policyFacts([mod]);
      const good = validatePolicy({ scope: pols[0].scope, policies: pols }, facts, policyEngine(px, px.compileToTriple(lowerPolicyScope(pols[0].scope, pols, 'test')).plan));
      assert.equal(good.mismatch, null, `the unbroken lowering agrees on ${src}: ${good.detail}`);
      const bad = validatePolicy({ scope: pols[0].scope, policies: pols }, facts, policyEngine(px, px.compileToTriple(lowerPolicyScope(pols[0].scope, pols, 'test', fault)).plan));
      assert.ok(bad.mismatch, `${fault} is caught on ${src}`);
      t.diagnostic(`caught on ${src}: ${bad.detail}`);
    }
  });
}

test('the policy faults are an explicit list, equal to poly-lower\'s', () => {
  assert.deepEqual(Object.keys(POLICY_FAULT_SOURCES).sort(), [...POLICY_FAULTS].sort());
});

test('a policy file checked alone reads only its own module, and says what it cannot resolve', async () => {
  const r = await checkFile(join(ROOT, 'conformance/m5/orders.policy.poly'), { root: join(BUILD, 'alone') });
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(r.policies[0].diagnostics.some((d) => /names no machine of the program/.test(d.message)));
  assert.ok(existsSync(join(ROOT, 'conformance/m5/orders.policy.poly')));
  void copyFileSync;
});

test('PT8.4, PT15: admission certifies each scope\'s lowered policy, and load reads it back hash-first', async (t) => {
  if (!peer.ok) { t.todo(`not run: ${peer.reason}`); return; }
  const { admitted } = await import('./runtime-helpers.mjs');
  const { load, LoadError } = await import('@poly/runtime');
  const a = await admitted('policy-cert', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const p = a.cert.poly.policies;
  assert.deepEqual(p.map((x) => [x.scope, x.policies, x.reads]), [['orders', ['orders-governance'], ['orders.Order']]]);
  assert.ok(a.cert.artefacts[p[0].path]);
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust });
  try { assert.deepEqual(rt.verified.policies.map((x) => [x.scope, x.doc.id]), [['orders', 'poly/orders']]); } finally { await rt.close(); }
  const f = join(a.dir, p[0].path);
  writeFileSync(f, readFileSync(f, 'utf8').replace('"deny"', '"warn"'));
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust }), (e) => e instanceof LoadError && /policies/.test(e.message));
});

test('PT8.4, PT8.5: a policy Polyaxion refuses at admission is PL6001 with the engine\'s reason; a trapped mandate is PL6501', async (t) => {
  if (!peer.ok) { t.todo(`not run: ${peer.reason}`); return; }
  const trapped = POLICY.replace('    end open, reserved\n', '    end reserved\n').replace('from open when effect.kind == "stock.reserve" -> reserved', 'from reserved when effect.kind == "stock.reserve" -> open');
  const s = scopeOf(await checkProject(projectOf('refused', { 'orders.poly': ORDERS, 'orders.policy.poly': trapped })), 'orders');
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6001' && /discharge state 'reserved' is unreachable/.test(d.message)), JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6501' && /reserve-before-charge cannot be discharged/.test(d.message)));
  assert.equal(s.verdict, 'REFUSED');
});

// Polywatch on S149: a never statement that reads a decision's answer from an open domain is runtime-only, as a
// machine field from an open domain is; it is not proved, or called vacuous, over the rows where the answer is null.
test('S149: a never statement over an open decision answer is runtime-only', () => {
  const router = parse(read('conformance/m4/router.poly')).module;
  const policy = parse(`module p\npolicy route-guard {\n  scope "support"\n  never no-refund-answer "The router never answers Refund.": allow when decision("route").answer == "Refund"\n}\n`).module;
  const facts = policyFacts([router]);
  facts.decisions.set('route', { answers: null });
  const s = { scope: 'support', policies: policy.decls.filter((d) => d.kind === 'Policy') };
  const r = checkNever(s, facts, () => ({}));
  assert.deepEqual(r.runtimeOnly, ['route-guard.no-refund-answer']);
  assert.deepEqual(r.vacuous, []);
  assert.deepEqual(r.findings, []);
});

// Review B1: an escalated proposal a person approves is allowed and moves the policy machines (PT12.5). The never
// check explores those states too, so a never statement violated only after an approval is a finding.
test('S149: a never statement violated after an approved escalation is PL6503', async () => {
  const pol = `module appr_policy\n\npolicy orders-appr {\n  scope "orders"\n  obligation reserve-first "Charge only after a reserve." machine {\n    states open, reserved\n    initial open\n    from open when effect.kind == "stock.reserve" -> reserved\n    deny in open when effect.kind == "payment.charge" reason "charge-before-reserve"\n    end open, reserved\n  }\n  obligation reserve-asks "A person approves every reserve." rule {\n    when effect.kind == "stock.reserve"\n    require false else escalate\n  }\n  never no-charge "No charge is ever allowed.": allow when effect.kind == "payment.charge"\n}\n`;
  const s = scopeOf(await checkProject(projectOf('never-approved', { 'orders.poly': ORDERS, 'orders.policy.poly': pol })), 'orders');
  const f = s.diagnostics.find((d) => d.code === 'PL6503');
  assert.ok(f, JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.ok(f.witness.trace.some((st) => st.verdict === 'allow (approved)'), JSON.stringify(f.witness.trace.map((st) => st.verdict)));
});

// Review B2: a decision's model id is compared with the ids the policies name, not one placeholder, so a never
// statement violated on another model's routing is found.
test('S149: a never statement over decision(d).model.id is checked against the ids the policies name', async () => {
  const pol = `module legacy_policy\n\npolicy no-legacy {\n  scope "support"\n  obligation refund-after-route "A refund follows a routing decision." rule {\n    when effect.kind == "payments.refund"\n    require decision("route").taken else deny\n  }\n  never no-legacy-refund "No refund on the legacy model's routing.": allow when effect.kind == "payments.refund" && decision("route").model.id == "m-legacy"\n}\n`;
  const s = scopeOf(await checkProject(projectOf('never-model-id', { 'router.poly': read('conformance/m4/router.poly'), 'p.policy.poly': pol })), 'support');
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6503'), JSON.stringify(s.stages));
});

// Review B5: a string field's check domain is its domain in the decision table; a rule over a field with no finite
// domain is listed as runtime-only, not validated clean over its unknown case alone.
test('S149: a string field with a check domain is enumerated; a rule over an open field is runtime-only', async () => {
  const prog = (dom) => `module tagger\n\nmachine Tagger {\n  state { tag : string${dom} = "none" }\n  action Tag(t: string check { "none", "hold", "vip" })\n  action Ship()\n  on Tag(t) { tag' = t }\n  on Ship { emit ship(1) }\n  effect ship(k: 0..1) {\n    kind "goods.ship"\n    labels { write:store }\n    class irreversible\n  }\n}\n`;
  const pol = `module tagger_policy\n\npolicy tag-hold {\n  scope "tagger"\n  obligation hold-vip "A shipment tagged hold is denied." rule {\n    when effect.kind == "goods.ship" && machine("tagger.Tagger").tag == "hold"\n    require false else deny\n  }\n}\n`;
  const facts = policyFacts([parse(prog(' check { "none", "hold", "vip" }')).module]);
  assert.deepEqual(facts.machines.get('tagger.Tagger').fields.get('tag').values, ['none', 'hold', 'vip']);
  const tagged = scopeOf(await checkProject(projectOf('tagged-rule', { 'tagger.poly': prog(' check { "none", "hold", "vip" }'), 'p.policy.poly': pol })), 'tagger');
  assert.match(tagged.stages.find((x) => x.stage === 'never').note, /^\d+ proposals|no never/);
  // A machine field always has a finite domain (PL1101); a decision's answer may not. A rule over one is runtime-only.
  const { openReads } = await import('../packages/poly-check/dist/src/policies.js');
  const router = parse(read('conformance/m4/router.poly')).module;
  const routed = parse('module p\npolicy route-rule {\n  scope "support"\n  obligation no-refund "No refund answer." rule {\n    when decision("route").answer == "Refund"\n    require false else deny\n  }\n}\n').module;
  const rf = policyFacts([router]);
  rf.decisions.set('route', { answers: null });
  assert.deepEqual(openReads({ scope: 'support', policies: routed.decls.filter((d) => d.kind === 'Policy') }, rf), ['decision route.answer']);
});

// Review B6: PT8.1, each name is checked against the program. A misspelt effect kind, class or label would make a
// rule apply to nothing.
test('PT8.1: an effect kind, class or label the program does not have is PL1001', async () => {
  for (const [bad, what] of [['effect.kind == "payment.fees"', 'payment.fees'], ['effect.class == "irreversable"', 'irreversable'], ['effect.labels has "egress:externel"', 'egress:externel'], ['effect.kind in { "payment.fee", "payment.chrage" }', 'payment.chrage']]) {
    const pol = `module typo_policy\n\npolicy typo {\n  scope "orders"\n  obligation r "A rule." rule {\n    when ${bad}\n    require false else deny\n  }\n}\n`;
    const s = scopeOf(await checkProject(projectOf('typo', { 'orders.poly': ORDERS, 'p.policy.poly': pol })), 'orders');
    assert.ok(s.diagnostics.some((d) => d.code === 'PL1001' && d.message.includes(what)), `${bad}: ${JSON.stringify(s.diagnostics.map((d) => d.message))}`);
  }
});

// Review B7: two transitions out of one state that both match a proposal. PS8's machine takes the first, as written;
// the lowering makes the engine agree, so the legal policy is not refused as a toolchain fault.
test('PT8.2: of two matching transitions out of a state, the first is taken, and the engine agrees', async (t) => {
  if (!peer.ok) { t.skip(peer.reason); return; }
  const pol = `module two_policy\n\npolicy orders-two {\n  scope "orders"\n  obligation track "Track reserve." machine {\n    states open, a, b\n    initial open\n    from open when effect.kind == "stock.reserve" -> a\n    from open when effect.class == "compensable" -> b\n    deny in b when effect.kind == "payment.charge" reason "charge-in-b"\n    end open, a, b\n  }\n}\n`;
  const s = scopeOf(await checkProject(projectOf('two-transitions', { 'orders.poly': ORDERS, 'p.policy.poly': pol })), 'orders');
  assert.deepEqual(s.diagnostics.filter((d) => d.code === 'PL2501').map((d) => d.message), []);
  assert.equal(s.stages.find((x) => x.stage === 'policy-tv').verdict, 'CLEAN');
});

// Review B12: a transition whose condition reads only a policy var is lowered with the proposal conjunct, so the
// engine can route it, and the stage reports rather than the check throwing.
test('PT8.2: a transition that reads only a var is lowered and validated', async (t) => {
  if (!peer.ok) { t.skip(peer.reason); return; }
  const pol = `module vr_policy\n\npolicy orders-vr {\n  scope "orders"\n  var lenient: bool = true\n  obligation reserve-first "Charge only after reserve." machine {\n    states open, done\n    initial open\n    from open when lenient -> done\n    deny in open when effect.kind == "payment.charge" reason "charge-first"\n    end open, done\n  }\n}\n`;
  const s = scopeOf(await checkProject(projectOf('var-transition', { 'orders.poly': ORDERS, 'p.policy.poly': pol })), 'orders');
  assert.equal(s.stages.find((x) => x.stage === 'policy-tv').verdict, 'CLEAN', JSON.stringify(s.diagnostics.map((d) => d.message)));
});

// Review B8: PS8.4, in a scope whose obligations read labels or class, an effect with no labels is refused.
test('PS8.4: an unlabelled effect in a labelled scope is PL6302, refused', async () => {
  const prog = ORDERS.replace('    labels { write:store }\n', '');
  const pol = `module lab_policy\n\npolicy orders-labels {\n  scope "orders"\n  obligation no-egress "No egress." rule {\n    when effect.labels has "egress:external" && effect.class == "irreversible"\n    require false else deny\n  }\n}\n`;
  const s = scopeOf(await checkProject(projectOf('unlabelled', { 'orders.poly': prog, 'p.policy.poly': pol })), 'orders');
  const d = s.diagnostics.find((x) => x.code === 'PL6302');
  assert.ok(d, JSON.stringify(s.diagnostics.map((x) => x.code)));
  assert.match(d.message, /stock\.reserve/);
  assert.equal(s.verdict, 'REFUSED');
});

// A scope whose policies hold only never statements gives the gate nothing to enforce; it is refused with a reason,
// not left to the engine, which takes no empty document.
test('PT8.2: a scope with no obligation to enforce is refused with a reason', async () => {
  const pol = `module nev_policy\n\npolicy only-never {\n  scope "orders"\n  never n "No fee.": allow when effect.kind == "payment.fee"\n}\n`;
  const p = await checkProject(projectOf('only-never', { 'orders.poly': ORDERS, 'p.policy.poly': pol }));
  const s = scopeOf(p, 'orders');
  assert.ok(s, JSON.stringify(p.files.map((f) => [f.verdict, f.error])));
  assert.ok(s.diagnostics.some((x) => x.code === 'PL1201' && /no obligation/.test(x.message)));
  assert.equal(s.verdict, 'REFUSED');
});

// Polywatch on review B1: an escalated proposal is allowed once a person approves it (PT12.5), so a never statement
// whose forbidden proposal the policy only escalates is violated too.
test('S149: a never statement whose forbidden proposal is only escalated is PL6503', async () => {
  const pol = `module esc_never_policy\n\npolicy orders-esc-never {\n  scope "orders"\n  obligation fee-asks "A person approves every fee." rule {\n    when effect.kind == "payment.fee"\n    require false else escalate\n  }\n  never no-fee "No fee is ever allowed.": allow when effect.kind == "payment.fee"\n}\n`;
  const s = scopeOf(await checkProject(projectOf('never-escalated', { 'orders.poly': ORDERS, 'orders.policy.poly': pol })), 'orders');
  const f = s.diagnostics.find((d) => d.code === 'PL6503');
  assert.ok(f, JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.equal(f.witness.trace.at(-1).verdict, 'allow (approved)');
});

// B13 (review of M5a, ruled to M5b): a comment written inside an obligation body stays where it was written. The
// formatter printed it after the obligation, since the expressions it sits beside were not comment anchors.
test('B13: comments inside an obligation body keep their place through the formatter', () => {
  const src = 'module c\n\npolicy p {\n  scope "orders"\n  // before the rule\n  obligation r "R." rule {\n    // inside the rule, before when\n    when effect.kind == "payment.fee"  // trailing on when\n    // before require\n    require false else deny\n  }  // after the rule\n  obligation m "M." machine {\n    states a, b\n    initial a\n    // before a transition\n    from a when effect.kind == "stock.reserve" -> b  // trailing on the transition\n    // before a guard\n    deny in a when effect.kind == "payment.charge" reason "r"\n    end a, b\n  }\n}\n';
  const r = parse(src);
  assert.equal(format(r.module, r.trivia), src);
});

// Review of M5b, D-F6: the lines with no expression (on unknown, states, initial, end) are comment anchors too.
test('B13: comments on and before the on unknown, states, initial and end lines keep their place', () => {
  const src = 'module c\n\npolicy p {\n  scope "orders"\n  obligation r "R." rule {\n    require effect.kind == "x" else deny\n    // why unknown denies\n    on unknown deny  // fail closed\n  }\n  obligation m "M." machine {\n    // the states\n    states a, b  // two states\n    // start\n    initial a  // here\n    from a when effect.kind == "x" -> b\n    // b is final\n    end a, b  // both\n  }\n}\n';
  const r = parse(src);
  const out = format(r.module, r.trivia);
  assert.equal(out, src);
  const again = parse(out);
  assert.equal(format(again.module, again.trivia), out);
});
