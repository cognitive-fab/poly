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
  assert.deepEqual(s.stages.map((x) => [x.stage, x.verdict]), [['policy-types', 'CLEAN'], ['policy-lower', 'CLEAN'], ['consistency', 'CLEAN'], ['policy-admission', 'CLEAN'], ['policy-tv', 'CLEAN'], ['never', 'CLEAN']]);
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
  const vacuous = POLICY.replace('effect.machine == "orders.Order" && effect.class == "irreversible" && machine("orders.Order").status == Cancelled\n}', 'effect.kind == "payment.refund"\n}');
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
