// PT12.3: no stage reads CLEAN beside an error it records, the audit of the nineteen stages (finding 30).
// Each test shows what the spec table's last column says. The general rule: for each error diagnostic
// that the unit records, at least one stage that the table assigns to that error reads REFUSED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, checkProject, render } from '@poly/check';
import { polyaxionPeer, polycheckPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const axionPeer = polyaxionPeer();
const axionSkip = axionPeer.ok ? false : `not run: ${axionPeer.reason}`;
const checkPeer = polycheckPeer();
const checkSkip = checkPeer.ok ? false : `not run: ${checkPeer.reason}`;
const axionAndCheckSkip = (axionPeer.ok && checkPeer.ok) ? false : `not run: ${axionPeer.ok ? checkPeer.reason : axionPeer.reason}`;

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const OUT = join(ROOT, '.poly', 'test-stage-verdicts');

function projectOf(name, files) {
  const dir = join(OUT, 'projects', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}

function scopeOf(p, scope) {
  return p.files.flatMap((f) => f.policies).find((x) => x.scope === scope);
}

// Map from error codes to the stages that own them (PT12.3 table).
const errorStageMap = {
  // Machines and configurations
  'PL0901': ['parse-type', 'lower'],
  'PL2001': ['validate'],
  'PL2501': ['translation-validation', 'model-check', 'effects', 'composition'],
  'PL3001': ['model-check'],
  'PL3002': ['model-check'],
  'PL3102': ['model-check'],
  'PL3201': [],
  'PL3301': [],
  'PL6201': [],
  'PL6203': [],
  'PL5001': ['composition'],
  'PL5401': [],
  'PL5402': [],
  'PL5404': [],
  'PL5406': [],
  'PL5407': [],
  'PL5408': [],
  'PL5409': [],
  'PL5301': [],
  'PL5302': [],
  // Policies
  'PL6001': ['policy-admission'],
  'PL6302': ['policy-admission'],
  'PL1201': ['policy-types', 'policy-lower'],
  'PL6504': ['policy-types'],
  'PL6505': ['policy-types'],
  'PL1001': ['policy-types'],
  'PL1002': ['parse-type'],
  'PL6803': ['parse-type'],
};

// General rule: for each error code, check that at least one owning stage ran and is REFUSED.
// Also check that units with any error have a REFUSED verdict.
function assertGeneralRule(unit, unitType, fileName) {
  const unitName = `${fileName}/${unitType}${unit.machine || unit.configuration || unit.scope ? '.' + (unit.machine || unit.configuration || unit.scope) : ''}`;
  const errors = unit.diagnostics.filter((d) => d.severity === 'error');

  if (errors.length > 0) {
    // Unit-level check: verdict must be REFUSED if it has any error
    assert.equal(unit.verdict, 'REFUSED', `${unitName} has error(s) but verdict is ${unit.verdict}`);

    // Stage-level check: for each error, at least one owning stage ran and is REFUSED
    for (const error of errors) {
      const owners = errorStageMap[error.code];
      if (owners && owners.length > 0) {
        const ranOwners = unit.stages.filter((s) => owners.includes(s.stage) && s.status === 'ran');
        if (ranOwners.length > 0) {
          const refusedOwners = ranOwners.filter((s) => s.verdict === 'REFUSED');
          assert.ok(
            refusedOwners.length > 0,
            `${unitName}: error ${error.code} but no owning stage [${owners.join(',')}] ran as REFUSED (ran as [${ranOwners.map((s) => `${s.stage}:${s.verdict}`).join(',')}])`
          );
        }
      }
    }
  }
}

// File-level rule: an error in file.diagnostics means every machine reads parse-type REFUSED.
function assertFileGeneralRule(file) {
  const fileErrors = file.diagnostics.filter((d) => d.severity === 'error');
  if (fileErrors.length > 0) {
    for (const m of file.machines) {
      const pt = m.stages.find((s) => s.stage === 'parse-type');
      assert.ok(pt, `machine ${m.machine} has no parse-type stage`);
      assert.equal(
        pt.verdict, 'REFUSED',
        `file ${file.file} has error(s) [${fileErrors.map((d) => d.code).join(',')}] but machine ${m.machine} parse-type is ${pt.verdict}`
      );
    }
  }
}

// Test 1: parse-type
// A type error: REFUSED; a project with two modules of one name: on the file the project refuses, every machine's parse-type is REFUSED.
test('PT12.3 stage verdicts: parse-type is REFUSED with a type error or when the project check adds PL1002 to the file (finding 30)', async () => {
  // PT12.3: parse-type records every error of stage 0 and the project check's PL1002, PL6803.

  // Part 1: type error (PL1201)
  const r1 = await checkFile(join(ROOT, 'test/fixtures/review-m1/checker-rec1.poly'), { root: join(OUT, 'parse-type-error') });
  assert.ok(r1.machines.length > 0, 'source has machines');
  assert.ok(r1.diagnostics.some((d) => d.code === 'PL1201' && d.severity === 'error'), 'file has PL1201 error');
  for (const m of r1.machines) {
    const pt = m.stages.find((s) => s.stage === 'parse-type');
    assert.ok(pt, `machine ${m.machine} has parse-type`);
    assert.equal(pt.verdict, 'REFUSED', `parse-type verdict for error source`);
    assertGeneralRule(m, 'machine', r1.file);
  }
  assertFileGeneralRule(r1);

  // Part 2: project with two modules of one name (PL1002 added by project check)
  const hello = read('examples/hello/hello.poly');
  const p = await checkProject(projectOf('dup-modules', { 'a.poly': hello, 'b.poly': hello }));
  assert.equal(p.verdict, 'REFUSED', 'project verdict is REFUSED');
  const refusedFile = p.files.find((f) => f.diagnostics.some((d) => d.code === 'PL1002'));
  assert.ok(refusedFile, 'one file has PL1002');
  assert.ok(refusedFile.machines.length > 0, 'refused file has machines');
  for (const m of refusedFile.machines) {
    const pt = m.stages.find((s) => s.stage === 'parse-type');
    assert.ok(pt, `machine ${m.machine} has parse-type`);
    assert.equal(pt.verdict, 'REFUSED', `parse-type REFUSED when file has PL1002`);
    assertGeneralRule(m, 'machine', refusedFile.file);
  }
  assertFileGeneralRule(refusedFile);
});

// Test 2: lower
// An action parameter of map type: REFUSED with PL0901, and the later stages not run.
test('PT12.3 stage verdicts: lower is REFUSED with PL0901 for an action parameter of map type (finding 30)', async () => {
  // PT12.3: lower records PL0901 when an action parameter is of map type; parse-type reads CLEAN on that source.

  const src = `module test
machine M {
  state { x: 0..1 = 0 }
  action A(m: map<0..1, 0..1>)
  on A { x' = 1 }
}`;
  const file = join(OUT, 'lower-map-param.poly');
  mkdirSync(join(OUT), { recursive: true });
  writeFileSync(file, src);
  const r = await checkFile(file, { root: join(OUT, 'lower-run') });
  const m = r.machines[0];

  // Setup: parse-type is CLEAN and no file error
  assert.ok(!r.diagnostics.some((d) => d.code === 'PL0901'), 'no file-level PL0901');
  const pt = m.stages.find((s) => s.stage === 'parse-type');
  assert.equal(pt.verdict, 'CLEAN', 'parse-type is CLEAN on source with lower error');

  // Then: lower records PL0901 as error and is REFUSED
  assert.ok(m.diagnostics.some((d) => d.code === 'PL0901' && d.severity === 'error'), 'machine has PL0901 error');
  const lower = m.stages.find((s) => s.stage === 'lower');
  assert.ok(lower, 'lower stage exists');
  assert.equal(lower.verdict, 'REFUSED', `lower is REFUSED with PL0901`);

  // Then: later stages not run
  for (const stage of ['validate', 'translation-validation', 'model-check']) {
    const s = m.stages.find((x) => x.stage === stage);
    assert.ok(s, `${stage} exists`);
    assert.equal(s.status, 'not-run', `${stage} not run after lower REFUSED`);
  }
  assertGeneralRule(m, 'machine', r.file);
});

// Test 3: validate
// No source reaches PL2001; on a clean source, CLEAN with nothing recorded (PT12.3).
test('PT12.3 stage verdicts: validate is CLEAN on a clean source, as no error source reaches it (finding 30)', async () => {
  // PT12.3: validate records no diagnostics on any source the pipeline can produce.
  const r = await checkFile(join(ROOT, 'conformance/m1/effects.poly'), { root: join(OUT, 'validate-clean') });
  const m = r.machines[0];
  assert.equal(r.verdict, 'CLEAN', 'file is CLEAN');
  const validate = m.stages.find((s) => s.stage === 'validate');
  assert.ok(validate, 'validate stage exists');
  assert.equal(validate.verdict, 'CLEAN', 'validate is CLEAN');
  // No source reaches PL2001 (S20).
  const validateDiags = m.diagnostics.filter((d) => d.code === 'PL2001');
  assert.deepEqual(validateDiags, [], 'validate records no PL2001');
  assertGeneralRule(m, 'machine', r.file);
});

// Test 4: translation-validation
// No source reaches PL2501 on the pipeline; on a clean source, CLEAN with nothing recorded (PT12.3).
test('PT12.3 stage verdicts: translation-validation is CLEAN on a clean source, as no error source reaches it (finding 30)', async () => {
  // PT12.3: translation-validation records no PL2501 on the pipeline; broken lowerings and engine disagreements test it outside.
  const r = await checkFile(join(ROOT, 'conformance/m1/effects.poly'), { root: join(OUT, 'tv-clean') });
  const m = r.machines[0];
  assert.equal(r.verdict, 'CLEAN', 'file is CLEAN');
  const tv = m.stages.find((s) => s.stage === 'translation-validation');
  assert.ok(tv, 'translation-validation stage exists');
  assert.equal(tv.verdict, 'CLEAN', 'translation-validation is CLEAN');
  // No source reaches the error (the broken lowerings of test/toolchain-faults.mjs reach it in test/tv.test.mjs, outside the pipeline).
  const tvDiags = m.diagnostics.filter((d) => d.code === 'PL2501');
  assert.deepEqual(tvDiags, [], 'translation-validation records no PL2501');
  assertGeneralRule(m, 'machine', r.file);
});

// Test 5: model-check
// A reachable invariant violation: FINDINGS.
test('PT12.3 stage verdicts: model-check is FINDINGS for a reachable invariant violation (finding 30)', async () => {
  // PT12.3: model-check records an invariant violation PL3001 and is FINDINGS.
  const r = await checkFile(join(ROOT, 'test/fixtures/cli/invariant.poly'), { root: join(OUT, 'model-check') });
  const m = r.machines[0];
  assert.equal(r.verdict, 'FINDINGS', 'file is FINDINGS');
  assert.ok(m.diagnostics.some((d) => d.code === 'PL3001'), 'machine has invariant violation');
  const mc = m.stages.find((s) => s.stage === 'model-check');
  assert.ok(mc, 'model-check stage exists');
  assert.equal(mc.verdict, 'FINDINGS', `model-check is FINDINGS`);
  // No source reaches PL2501 from an engine disagreement (engine change requires both polyrun and poly-ref to disagree).
  assertGeneralRule(m, 'machine', r.file);
});

// Test 6: deadlock
// examples/hello/hello.poly: FINDINGS beside its PL3201.
test('PT12.3 stage verdicts: deadlock is FINDINGS for a reachable deadlock (finding 30)', async () => {
  // PT12.3: deadlock records PL3201 (finding, not error) and is FINDINGS.
  const r = await checkFile(join(ROOT, 'examples/hello/hello.poly'), { root: join(OUT, 'deadlock') });
  const m = r.machines[0];
  assert.ok(m.diagnostics.some((d) => d.code === 'PL3201'), 'machine has deadlock finding');
  const deadlock = m.stages.find((s) => s.stage === 'deadlock');
  assert.ok(deadlock, 'deadlock stage exists');
  assert.equal(deadlock.verdict, 'FINDINGS', `deadlock is FINDINGS`);
  assert.equal(m.verdict, 'FINDINGS', 'machine verdict is FINDINGS');
  // deadlock records only findings, no errors
  for (const d of m.diagnostics) {
    assert.notEqual(d.severity, 'error', `deadlock diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(m, 'machine', r.file);
});

// Test 7: flow
// test/fixtures/flow-boundary/leak.poly: FINDINGS beside its flow finding.
test('PT12.3 stage verdicts: flow is FINDINGS for a flow boundary violation (finding 30)', async () => {
  // PT12.3: flow records PL6831, PL6832 (findings, not errors) and is FINDINGS.
  const r = await checkFile(join(ROOT, 'test/fixtures/flow-boundary/leak.poly'), { root: join(OUT, 'flow') });
  const m = r.machines[0];
  const flowDiags = m.diagnostics.filter((d) => d.code === 'PL6831' || d.code === 'PL6832');
  assert.ok(flowDiags.length > 0, 'machine has flow finding');
  const flow = m.stages.find((s) => s.stage === 'flow');
  assert.ok(flow, 'flow stage exists');
  assert.equal(flow.verdict, 'FINDINGS', `flow is FINDINGS`);
  // flow records only findings, no errors
  for (const d of m.diagnostics) {
    assert.notEqual(d.severity, 'error', `flow diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(m, 'machine', r.file);
});

// Test 8: liveness
// A lasso: FINDINGS.
test('PT12.3 stage verdicts: liveness is FINDINGS for a lasso (fair cycle) (finding 30)', async () => {
  // PT12.3: liveness records PL3301 (finding, not error) and is FINDINGS.
  const r = await checkFile(join(ROOT, 'examples/evidence/outbox-v02.poly'), { root: join(OUT, 'liveness') });
  const m = r.machines[0];
  assert.ok(m.diagnostics.some((d) => d.code === 'PL3301'), 'machine has liveness finding');
  const liveness = m.stages.find((s) => s.stage === 'liveness');
  assert.ok(liveness, 'liveness stage exists');
  assert.equal(liveness.verdict, 'FINDINGS', `liveness is FINDINGS`);
  // liveness records only findings, no errors
  for (const d of m.diagnostics) {
    assert.notEqual(d.severity, 'error', `liveness diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(m, 'machine', r.file);
});

// Test 9: effects
// A violated path property: FINDINGS.
test('PT12.3 stage verdicts: effects is FINDINGS for a violated path property (finding 30)', async () => {
  // PT12.3: effects records PL4001 (path property violation, finding) and is FINDINGS.
  const r = await checkFile(join(ROOT, 'examples/orders/orders.poly'), { root: join(OUT, 'effects') });
  const m = r.machines[0];
  assert.ok(m.diagnostics.some((d) => d.code === 'PL4001'), 'machine has path property violation');
  const effects = m.stages.find((s) => s.stage === 'effects');
  assert.ok(effects, 'effects stage exists');
  assert.equal(effects.verdict, 'FINDINGS', `effects is FINDINGS`);
  assertGeneralRule(m, 'machine', r.file);
});

// Test 10: decisions
// An ungated irreversible effect: FINDINGS with PL6201.
test('PT12.3 stage verdicts: decisions is FINDINGS for an ungated irreversible effect (finding 30)', async () => {
  // PT12.3: decisions records PL6201 (finding: irreversible effect not gated) and is FINDINGS.
  const src = read('conformance/m2/decisions/router.poly');
  const ungated = src.replace('if conf >= 0.8 && margin >= 0.3 { status\' = Refunding   emit refund(order) }\n        else { status\' = NeedsHuman }', 'status\' = Refunding   emit refund(order)')
    .replace('  step property refund-needs-margin: (action == Routed && post.status == Refunding) implies (conf >= 0.8 && margin >= 0.3)\n', '');
  assert.notEqual(ungated, src, 'source was modified');
  const file = join(OUT, 'decisions-ungated.poly');
  mkdirSync(join(OUT), { recursive: true });
  writeFileSync(file, ungated);
  const r = await checkFile(file, { root: join(OUT, 'decisions-run') });
  const machines = r.machines.filter((m) => m.machine === 'Ticket');
  assert.ok(machines.length > 0, 'Ticket machine found');
  const m = machines[0];
  assert.ok(m.diagnostics.some((d) => d.code === 'PL6201'), `machine has PL6201`);
  const decisions = m.stages.find((s) => s.stage === 'decisions');
  assert.ok(decisions, 'decisions stage exists');
  assert.equal(decisions.verdict, 'FINDINGS', `decisions is FINDINGS`);
  // decisions records only findings, no errors
  for (const d of m.diagnostics) {
    assert.notEqual(d.severity, 'error', `decisions diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(m, 'machine', r.file);
});

// Test 11: composition
// A violated compose invariant: FINDINGS.
test('PT12.3 stage verdicts: composition is FINDINGS for a violated compose invariant (finding 30)', async () => {
  // PT12.3: composition records PL5001 (finding: violated invariant) and is FINDINGS.
  const src = read('conformance/m1/children.poly');
  const broken = src.replace('children.box.ship in { Delivered, Voided })', 'children.box.ship == Delivered)');
  assert.notEqual(broken, src, 'source was modified');
  const file = join(OUT, 'composition-violated.poly');
  mkdirSync(join(OUT), { recursive: true });
  writeFileSync(file, broken);
  const r = await checkFile(file, { root: join(OUT, 'composition-run') });
  const m = r.machines.find((x) => x.machine === 'Order');
  assert.ok(m, 'Order machine found');
  assert.ok(m.diagnostics.some((d) => d.code === 'PL5001'), 'machine has violated composition invariant');
  const composition = m.stages.find((s) => s.stage === 'composition');
  assert.ok(composition, 'composition stage exists');
  assert.equal(composition.verdict, 'FINDINGS', `composition is FINDINGS`);
  assertGeneralRule(m, 'machine', r.file);
});

// Test 12: configuration
// A violated configuration invariant: FINDINGS.
test('PT12.3 stage verdicts: configuration is FINDINGS for a violated configuration invariant (finding 30)', async () => {
  // PT12.3: configuration records PL5401 (finding: violated invariant) and is FINDINGS.
  const r = await checkFile(join(ROOT, 'examples/checkout/checkout-optimistic.poly'), { root: join(OUT, 'configuration') });
  const c = r.configurations[0];
  assert.ok(c, 'configuration found');
  assert.ok(c.diagnostics.some((d) => d.code === 'PL5401'), 'configuration has invariant violation');
  const configuration = c.stages.find((s) => s.stage === 'configuration');
  assert.ok(configuration, 'configuration stage exists');
  assert.equal(configuration.verdict, 'FINDINGS', `configuration is FINDINGS`);
  // configuration records only findings, no errors
  for (const d of c.diagnostics) {
    assert.notEqual(d.severity, 'error', `configuration diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(c, 'configuration', r.file);
});

// Test 13: policy-types
// An effect kind the program does not declare, compared in a rule: REFUSED.
test('PT12.3 stage verdicts: policy-types is REFUSED when a rule compares an effect kind not declared (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: policy-types records PL1001 (error) and is REFUSED.
  const prog = read('conformance/m5/orders.poly');
  const pol = `module test_policy
policy test {
  scope "orders"
  obligation check-unknown "Check unknown effect." rule {
    when effect.kind == "unknown.kind"
    require false else deny
  }
}`;
  const s = scopeOf(await checkProject(projectOf('policy-types-unknown', { 'orders.poly': prog, 'p.policy.poly': pol })), 'orders');
  assert.ok(s.diagnostics.some((d) => d.code === 'PL1001' && d.severity === 'error'), 'scope has PL1001 error');
  const pt = s.stages.find((x) => x.stage === 'policy-types');
  assert.ok(pt, 'policy-types stage exists');
  assert.equal(pt.verdict, 'REFUSED', `policy-types is REFUSED`);
  assertGeneralRule(s, 'scope', '');
});

// Test 14: policy-lower
// A scope whose policies hold only never statements: REFUSED with PL1201; policy-admission and policy-tv not run.
test('PT12.3 stage verdicts: policy-lower is REFUSED with PL1201 for a scope with only never statements (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: policy-lower records PL1201 (error: no obligation for the gate) and is REFUSED.
  const prog = read('conformance/m5/orders.poly');
  const pol = `module test_policy
policy test {
  scope "orders"
  never n "Never fee.": allow when effect.kind == "payment.fee"
}`;
  const p = await checkProject(projectOf('policy-lower-never', { 'orders.poly': prog, 'p.policy.poly': pol }));
  const s = scopeOf(p, 'orders');

  // Setup: PL1201 error
  assert.ok(s.diagnostics.some((d) => d.code === 'PL1201' && d.severity === 'error'), 'scope has PL1201 error');

  // Then: policy-lower is REFUSED
  const pl = s.stages.find((x) => x.stage === 'policy-lower');
  assert.ok(pl, 'policy-lower stage exists');
  assert.equal(pl.verdict, 'REFUSED', `policy-lower is REFUSED with PL1201`);

  // Then: policy-admission and policy-tv not run
  for (const stage of ['policy-admission', 'policy-tv']) {
    const st = s.stages.find((x) => x.stage === stage);
    assert.ok(st, `${stage} exists`);
    assert.equal(st.status, 'not-run', `${stage} not run`);
    assert.match(st.reason || '', /the scope has no obligation/, `${stage} reason`);
  }
  assertGeneralRule(s, 'scope', '');
});

// Test 15: consistency
// conformance/m5/consistency.policy.poly over conformance/m5/orders.poly: FINDINGS beside PL6501.
test('PT12.3 stage verdicts: consistency is FINDINGS for trapped obligations (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: consistency records PL6501 (finding: trapped mandate) and is FINDINGS.
  const s = scopeOf(
    await checkProject(projectOf('consistency', { 'orders.poly': read('conformance/m5/orders.poly'), 'c.policy.poly': read('conformance/m5/consistency.policy.poly') })),
    'orders'
  );
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6501'), 'scope has PL6501 finding');
  const consistency = s.stages.find((x) => x.stage === 'consistency');
  assert.ok(consistency, 'consistency stage exists');
  assert.equal(consistency.verdict, 'FINDINGS', `consistency is FINDINGS`);
  // consistency records only findings, no errors
  for (const d of s.diagnostics) {
    assert.notEqual(d.severity, 'error', `consistency diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(s, 'scope', '');
});

// Test 16: policy-admission
// Obligations that read labels, and one effect with no labels: REFUSED with PL6302.
test('PT12.3 stage verdicts: policy-admission is REFUSED with PL6302 for an unlabelled effect in a labelled scope (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: policy-admission records PL6302 (error: unlabelled effect refused at admission) and is REFUSED.
  const prog = read('conformance/m5/orders.poly').replace('    labels { write:store }\n', '');
  const pol = `module test_policy
policy test {
  scope "orders"
  obligation no-egress "No egress." rule {
    when effect.labels has "egress:external" && effect.class == "irreversible"
    require false else deny
  }
}`;
  const p = await checkProject(projectOf('policy-admission-labels', { 'orders.poly': prog, 'p.policy.poly': pol }));
  const s = scopeOf(p, 'orders');

  // Setup: PL6302 error, no PL6001
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6302' && d.severity === 'error'), 'scope has PL6302 error');
  assert.ok(!s.diagnostics.some((d) => d.code === 'PL6001'), 'scope has no PL6001');

  // Then: policy-admission is REFUSED
  const pa = s.stages.find((x) => x.stage === 'policy-admission');
  assert.ok(pa, 'policy-admission stage exists');
  assert.equal(pa.verdict, 'REFUSED', `policy-admission is REFUSED with PL6302`);
  assertGeneralRule(s, 'scope', '');
});

// Test 17: policy-tv
// On a clean scope, CLEAN with nothing recorded (PT12.3).
test('PT12.3 stage verdicts: policy-tv is CLEAN on a clean scope, as no error source reaches it (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: policy-tv records no diagnostics on any scope the pipeline can produce.
  const prog = read('conformance/m5/orders.poly');
  const pol = read('conformance/m5/consistency.policy.poly').replace(/  obligation no-reserve[\s\S]*?\n  }\n/, '');
  const s = scopeOf(await checkProject(projectOf('policy-tv-clean', { 'orders.poly': prog, 'c.policy.poly': pol })), 'orders');
  assert.equal(s.verdict, 'CLEAN', 'scope verdict is CLEAN');
  const ptv = s.stages.find((x) => x.stage === 'policy-tv');
  assert.ok(ptv, 'policy-tv stage exists');
  assert.equal(ptv.verdict, 'CLEAN', `policy-tv is CLEAN`);
  // No source reaches the error (broken policy lowerings are tested by direct call, not on the pipeline).
  const tvDiags = s.diagnostics.filter((d) => d.code === 'PL2501');
  assert.deepEqual(tvDiags, [], 'policy-tv records no PL2501');
  assertGeneralRule(s, 'scope', '');
});

// Test 18: regions
// A decision that reads private and egresses with no rule that names it: FINDINGS beside PL7001.
test('PT12.3 stage verdicts: regions is FINDINGS for a region without a gate (finding 30)', { skip: axionAndCheckSkip }, async () => {
  // PT12.3: regions records PL7001 (finding: unguarded region) and is FINDINGS.
  const s = scopeOf(
    await checkProject(projectOf('regions', { 'tri.poly': read('conformance/m5/trifecta.poly'), 'tri.policy.poly': read('conformance/m5/trifecta.policy.poly') })),
    'tri'
  );
  assert.ok(s.diagnostics.some((d) => d.code === 'PL7001'), 'scope has PL7001 (region witness)');
  const regions = s.stages.find((x) => x.stage === 'regions');
  assert.ok(regions, 'regions stage exists');
  assert.equal(regions.verdict, 'FINDINGS', `regions is FINDINGS`);
  // regions records only findings, no errors
  for (const d of s.diagnostics) {
    assert.notEqual(d.severity, 'error', `regions diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(s, 'scope', '');
});

// Test 19: never
// A never an obligation does not enforce is violated: FINDINGS beside PL6503.
test('PT12.3 stage verdicts: never is FINDINGS for a violated never statement (finding 30)', { skip: axionSkip }, async () => {
  // PT12.3: never records PL6503 (finding: never statement violated) and is FINDINGS.
  const prog = read('conformance/m5/orders.poly');
  const pol = `module test_policy
policy test {
  scope "orders"
  obligation reserve-first "Charge only after reserve." machine {
    states open, reserved
    initial open
    from open when effect.kind == "stock.reserve" -> reserved
    deny in open when effect.kind == "payment.charge" reason "charge-before-reserve"
    end open, reserved
  }
  never no-charge "No charge.": allow when effect.kind == "payment.charge"
}`;
  const s = scopeOf(await checkProject(projectOf('never-violated', { 'orders.poly': prog, 'p.policy.poly': pol })), 'orders');
  assert.ok(s.diagnostics.some((d) => d.code === 'PL6503'), 'scope has PL6503 (violated never)');
  const never = s.stages.find((x) => x.stage === 'never');
  assert.ok(never, 'never stage exists');
  assert.equal(never.verdict, 'FINDINGS', `never is FINDINGS`);
  // never records only findings, no errors
  for (const d of s.diagnostics) {
    assert.notEqual(d.severity, 'error', `never diagnostic ${d.code} is not error`);
  }
  assertGeneralRule(s, 'scope', '');
});
