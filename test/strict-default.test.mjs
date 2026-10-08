// S400, PT3.4a: strict by default. Every parameter of an action with a handler whose type has a
// check domain is strict unless disclosed is written, so dispatch rejects a value outside the domain
// with outside-check-domain before the handler runs (PT3.4, PS3.2 row 2, PS9.1a). These tests were
// written from the specification text alone, before the change; before S400 only a parameter that
// flowed into an irreversible or compensable payload was strict by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { checkFile } from '@poly/check';
import { ROOT, build, requireModule } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'strict-default');
const CHECK_ROOT = join(ROOT, '.poly', 'strict-default');
mkdirSync(CHECK_ROOT, { recursive: true });

/** Build a fixture, start its machine at the contract's initial state and return the module. */
function machine(file) {
  const [b] = build(join(FIX, file), 'strict-default');
  const mod = requireModule(b.dir);
  mod.init();
  mod.setState({ ...b.lowered.contract.initState });
  return mod;
}

/** Dispatch one action from a fresh initial state; return the step and the state after it. */
function dispatch(file, action, data) {
  const mod = machine(file);
  const before = mod.getState();
  mod.actions[action](data);
  return { step: mod.instance({}).lastStep(), before, after: mod.getState() };
}

function assertRejectedOutside({ step, before, after }) {
  assert.equal(step.classification, 'rejected', `expected rejected, got ${step.classification}`);
  assert.equal(step.rejections[0]?.reason, 'outside-check-domain');
  // PT3.4: rejected before the handler runs, so the state is unchanged.
  assert.deepEqual(after, before);
}

test('S400: an int check parameter that flows into no effect is strict: 9 is rejected outside-check-domain, 2 is accepted', () => {
  assertRejectedOutside(dispatch('checked.poly', 'SetK', { v: 9 }));
  const ok = dispatch('checked.poly', 'SetK', { v: 2 });
  assert.notEqual(ok.step.classification, 'rejected');
  assert.equal(ok.after.k, 2);
});

test('S400: a range parameter 1..3 is strict: 7 is rejected outside-check-domain, 2 is accepted', () => {
  assertRejectedOutside(dispatch('params.poly', 'SetN', { v: 7 }));
  const ok = dispatch('params.poly', 'SetN', { v: 2 });
  assert.notEqual(ok.step.classification, 'rejected');
  assert.equal(ok.after.n, 2);
});

test('S400: an enum parameter is strict: an undeclared constructor is rejected outside-check-domain', () => {
  assertRejectedOutside(dispatch('params.poly', 'SetC', { v: 'blue' }));
  const ok = dispatch('params.poly', 'SetC', { v: 'green' });
  assert.notEqual(ok.step.classification, 'rejected');
  assert.equal(ok.after.c, 'green');
});

// PT3.4a: a value of another JSON type is refused by the SAM strict profile's schema before row 2, which polyrun
// journals as a rejected step with the schema's message. The test writer asserted outside-check-domain; the builder
// corrected it to the layer that refuses, after PT3.4a said so (12cf1b37). It passed before S400: a confirmation.
test('S400: a bool parameter given a string is refused by the schema before the handler (confirmation)', () => {
  const mod = machine('params.poly');
  const before = mod.getState();
  assert.throws(() => mod.actions.SetB({ v: 'yes' }), (e) => e.name === 'SamSchemaError');
  assert.deepEqual(mod.getState(), before);
  const ok = dispatch('params.poly', 'SetB', { v: true });
  assert.notEqual(ok.step.classification, 'rejected');
  assert.equal(ok.after.b, true);
});

test('S400: a disclosed int check parameter that flows into no effect accepts 9 and the handler runs', () => {
  const { step, after } = dispatch('disclosed.poly', 'SetD', { v: 9 });
  assert.notEqual(step.classification, 'rejected');
  assert.deepEqual(step.rejections, []);
  assert.equal(after.k, 9);
});

test('S400: an implicit strict on a parameter of an action with no handler raises no PL1302 (confirmation)', async () => {
  const r = await checkFile(join(FIX, 'unhandled-implicit.poly'), { root: CHECK_ROOT });
  const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code);
  assert.ok(!codes.includes('PL1302'), `unexpected PL1302: ${codes.join(', ')}`);
  assert.notEqual(r.verdict, 'REFUSED', `diagnostics: ${codes.join(', ')}`);
});

test('S400: an explicit strict on a parameter of an action with no handler is PL1302 (confirmation)', async () => {
  const r = await checkFile(join(FIX, 'unhandled-explicit.poly'), { root: CHECK_ROOT });
  const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code);
  assert.ok(codes.includes('PL1302'), `expected PL1302, got: ${codes.join(', ')}`);
});

test('S400: the program of the first test checks CLEAN, translation validation agreeing (no PL2501)', async () => {
  const r = await checkFile(join(FIX, 'checked.poly'), { root: CHECK_ROOT });
  const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code);
  assert.ok(!codes.includes('PL2501'), `translation validation disagreed: ${codes.join(', ')}`);
  assert.equal(r.verdict, 'CLEAN', `diagnostics: ${codes.join(', ')}`);
});

test('S400: a Principal parameter has no dispatch row and accepts an arbitrary identity (confirmation)', () => {
  const { step, after } = dispatch('principal.poly', 'Who', { p: 'user-42' });
  assert.notEqual(step.classification, 'rejected', `rejected: ${step.rejections[0]?.reason}`);
  assert.equal(after.who, 'user-42');
});

// Probe reviewer A on V1 to V5, F1: a parameter bound from a reply (S79) whose type holds a Principal has no dispatch
// row (PT3.4a); it was strict over the check's representatives, so a real principal was refused at run time.
test('S400, probe A F1: a reply-bound parameter holding a Principal accepts a real principal', () => {
  const [b] = build(join(FIX, 'reply-principal.poly'), 'strict-default');
  const mod = requireModule(b.dir);
  mod.init();
  mod.setState({ ...b.lowered.contract.initState, s: 'Asked' });
  mod.actions.Got({ w: { p: 'user-42', n: 0 } });
  const step = mod.instance({}).lastStep();
  assert.notEqual(step.classification, 'rejected', JSON.stringify(step.rejections));
});

// F2: only a completion a spawn names supplies childKey and childState (S44); an ordinary action with those names is
// strict, so a value outside its domain cannot break a checked invariant at run time.
test('S400, probe A F2: an ordinary action named like a completion is strict', () => {
  assertRejectedOutside(dispatch('child-names.poly', 'Pick', { childKey: 9, childState: true }));
});
