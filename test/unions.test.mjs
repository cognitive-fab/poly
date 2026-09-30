// Plan step 10: what M0 refused at lowering, now lowered (S65). A map whose values are unions with payloads,
// a payload that is itself such a union, and an action parameter of such a type each lower to one object
// { $: C, payloads } below the top of a field; translation validation (tv.test.mjs) compares every transition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD, build, requireModule } from './helpers.mjs';

const UNIONS = join(ROOT, 'conformance', 'm1', 'unions.poly');
const SRC = readFileSync(UNIONS, 'utf8');

test('the conformance case checks clean: polygraph, poly-ref and translation validation agree', async () => {
  const r = await checkFile(UNIONS, { root: join(BUILD, 'unions') });
  assert.equal(r.verdict, 'CLEAN', render(r));
  assert.equal(r.machines[0].instance.states, 36);
});

test('S65: a nested union is one object in its flat field, a map value and a parameter', () => {
  const [b] = build(UNIONS, 'unions');
  const contract = JSON.parse(readFileSync(join(b.dir, 'contract.json'), 'utf8'));
  assert.deepEqual(contract.initState, { jobs: { A: { $: 'Idle' }, B: { $: 'Busy', n: 1 } }, hold: 'Free', hold_job: null, hold_slot: null });
  assert.deepEqual(contract.dataDomain.Assign.job, [{ $: 'Idle' }, { $: 'Busy', n: 1 }, { $: 'Busy', n: 2 }]);
  const mod = requireModule(b.dir);
  mod.init();
  mod.actions.Grab({ s: 'B' });
  assert.deepEqual(mod.getState(), { jobs: { A: { $: 'Idle' }, B: { $: 'Idle' } }, hold: 'Held', hold_job: { $: 'Busy', n: 1 }, hold_slot: 'B' });
  mod.actions.Assign({ s: 'A', job: { $: 'Busy', n: 2 } });
  mod.actions.Release({});
  assert.deepEqual(mod.getState(), { jobs: { A: { $: 'Busy', n: 2 }, B: { $: 'Busy', n: 1 } }, hold: 'Free', hold_job: null, hold_slot: null });
  assert.match(readFileSync(join(b.dir, 'next.cjs'), 'utf8'), /"job":\{"type":"object","required":true\}/);
});

test('what stays refused after M1 says so: a map parameter and a union effect payload', () => {
  const lower = (src) => {
    const p = parse(src);
    assert.ok(p.module);
    const check = checkModule(p.module);
    if (check.diagnostics.length) return check.diagnostics.map((d) => [d.code, d.message]);
    return lowerMachine(p.module, check, 'Board').diagnostics.map((d) => [d.code, d.message]);
  };
  const map = lower(SRC.replace('action Bump(s: Slot)', 'action Bump(s: Slot)\n  action Load(all: map<Slot, Job>)'));
  assert.deepEqual(map.map(([c]) => c), ['PL0901']);
  assert.match(map[0][1], /after milestone M1/);
  const eff = lower(SRC.replace('action Bump(s: Slot)', 'action Bump(s: Slot)\n  effect note(job: Job) { labels { write:store } }'));
  assert.deepEqual(eff.map(([c]) => c), ['PL0901']);
  assert.match(eff[0][1], /after milestone M1.*S65/);
});
