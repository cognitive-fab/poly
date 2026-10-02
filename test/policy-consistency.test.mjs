// PT8.5, PS8.6, S148: obligation consistency. A mandate the obligations trap together is PL6501, with a minimal
// conflicting subset found by deletion in declaration order (not the smallest), the cost reported, and a path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

function projectOf(name, files) {
  const dir = join(ROOT, '.poly', 'test-policy', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('PT8.5: two obligations that trap a mandate together are PL6501 naming exactly them, with a path', { skip }, async () => {
  const p = await checkProject(projectOf('consistency', { 'orders.poly': read('conformance/m5/orders.poly'), 'c.policy.poly': read('conformance/m5/consistency.policy.poly') }));
  const s = p.files.flatMap((f) => f.policies).find((x) => x.scope === 'orders');
  const d = s.diagnostics.find((x) => x.code === 'PL6501');
  assert.ok(d, JSON.stringify(s.diagnostics.map((x) => x.message)));
  assert.match(d.message, /under the obligations orders-mandate\.reserved-by-end, orders-mandate\.no-reserve:/);
  assert.doesNotMatch(d.message, /fee-free/, 'the unrelated rule is not in the subset');
  assert.match(d.message, /\d+ discharge check\(s\)/);
  assert.ok(!s.diagnostics.some((x) => x.code === 'PL6001'), 'the engine\'s m2 refusal is this finding, not a refusal');
  assert.equal(s.verdict, 'FINDINGS');
  assert.ok(s.stages.some((x) => x.stage === 'consistency' && x.verdict === 'FINDINGS'));
});

test('PT8.5: each obligation alone leaves the mandate dischargeable', { skip }, async () => {
  const src = read('conformance/m5/consistency.policy.poly');
  const withoutRule = src.replace(/  obligation no-reserve[\s\S]*?\n  }\n/, '');
  const s = (await checkProject(projectOf('consistency-ok', { 'orders.poly': read('conformance/m5/orders.poly'), 'c.policy.poly': withoutRule }))).files.flatMap((f) => f.policies)[0];
  assert.ok(!s.diagnostics.some((x) => x.code === 'PL6501'), JSON.stringify(s.diagnostics.map((x) => x.message)));
});


const ORDERS = () => read('conformance/m5/orders.poly');
const mandate = `  obligation reserved-by-end "Every session reserves stock before it ends." machine {
    states waiting, reserved
    initial waiting
    from waiting when effect.kind == "stock.reserve" -> reserved
    end reserved
  }
`;
const pol = (name, body) => `module ${name}_policy\n\npolicy ${name} {\n  scope "orders"\n${mandate}${body}}\n`;

// Review B3: PS8.6 explores the scope's policy machines together. A guard of another machine obligation that denies
// the only discharging proposal traps the mandate, as a rule does.
test('PS8.6: a mandate trapped by another machine obligation\'s guard is PL6501', async () => {
  const guard = `  obligation no-reserve-guard "No stock is reserved, as a guard." machine {\n    states idle\n    initial idle\n    deny in idle when effect.kind == "stock.reserve" reason "no-reserve"\n    end idle\n  }\n`;
  const s = (await checkProject(projectOf('consistency-guard', { 'orders.poly': ORDERS(), 'p.policy.poly': pol('guardtrap', guard) }))).files.flatMap((f) => f.policies)[0];
  const d = s.diagnostics.find((x) => x.code === 'PL6501');
  assert.ok(d, JSON.stringify(s.diagnostics.map((x) => x.message)));
  assert.match(d.message, /guardtrap\.reserved-by-end, guardtrap\.no-reserve-guard/);
});

// Review B9: PS8.6, "with no deny outcome on the way". An escalation a person approves is not a deny.
test('PS8.6: a mandate whose discharging proposal is escalated is dischargeable', async () => {
  const esc = `  obligation reserve-asks "A person approves every reserve." rule {\n    when effect.kind == "stock.reserve"\n    require false else escalate\n  }\n`;
  const s = (await checkProject(projectOf('consistency-esc', { 'orders.poly': ORDERS(), 'p.policy.poly': pol('esctrap', esc) }))).files.flatMap((f) => f.policies)[0];
  assert.deepEqual(s.diagnostics.filter((x) => x.code === 'PL6501').map((x) => x.message), []);
  // The engine's m2 check refuses it all the same, and the refusal says why (engine change E8).
  if (peer.ok) assert.match(s.diagnostics.find((x) => x.code === 'PL6001')?.message ?? '', /escalation as a deny.*E8/);
});

// Review B4: the check covers the whole decision table, not its first rows.
test('PS8.6: a trap past the first 400 rows of the decision table is found', async () => {
  const prog = `module meter\n\nmachine Meter {\n  state { n : 0..255 = 0 }\n  action Set(v: 0..255)\n  action A()\n  action B()\n  on Set(v) { n' = v }\n  on A { emit a(1) }\n  on B { emit b(1) }\n  effect a(k: 0..1) {\n    kind "meter.a"\n    labels { write:store }\n  }\n  effect b(k: 0..1) {\n    kind "meter.b"\n    labels { write:store }\n  }\n}\n`;
  const p = `module meter_policy\n\npolicy meter-mandate {\n  scope "meter"\n  obligation back-to-start "A session ends where it started." machine {\n    states start, stuck\n    initial start\n    from start when effect.kind == "meter.b" && machine("meter.Meter").n == 200 -> stuck\n    end start\n  }\n}\n`;
  const s = (await checkProject(projectOf('consistency-rows', { 'meter.poly': prog, 'p.policy.poly': p }))).files.flatMap((f) => f.policies)[0];
  assert.ok(s.diagnostics.some((x) => x.code === 'PL6501'), JSON.stringify(s.stages));
});

// Review B11: a discharge check that hit its bound is not a clean one.
test('PT8.5: a discharge check that hits its bound is listed, not reported clean', async () => {
  const { mandates } = await import('../packages/poly-check/dist/src/policies.js');
  const r = mandates([{ name: 'p', items: [{ kind: 'MachineObligation', name: 'm', id: 'n1' }] }], () => ({ trap: null, capHit: true }));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.bounded, ['p.m']);
});
