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
