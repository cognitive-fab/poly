// The owner's rulings on the review of M11: S360 (a tier's input and output limits are both reserved, so a call within
// both records no overrun), S361 (a usage report poly cannot price is charged the full reservation, the violation
// recorded, never released), and channel names as identifiers. No test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordedProvider } from '@poly/runtime';
import { checkFile } from '@poly/check';
import { printModule } from '@poly/embed';
import { parse } from '@poly/lang';
import { ROOT } from './helpers.mjs';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk } from './routing-helpers.mjs';

const TEXT = { text: 'where is my refund' };
const a = await admittedDesk('routing-rulings');

/** One run whose small tier answers below the thresholds with `small` as its usage, then the large tier answers. */
async function run(id, small, large = { input: 10 }) {
  const { rt } = await loaded(a);
  rt.provideTier('flash', recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.6], ['Other', 0.4]], usage: small }]));
  rt.provideTier('opus', recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.96]], usage: large }]));
  await rt.create('desk.Ticket', { id });
  await rt.dispatch(id, 'Received', TEXT);
  for (let i = 0; i < 6; i++) await rt.worker.tick();
  const route = rt.store.db.prepare('SELECT instance FROM poly_route WHERE run = ?').get(id).instance;
  const calls = (await rt.chain(route)).filter((e) => e.kind === 'decision').map((e) => e.body);
  const settled = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'budget').map((e) => e.body);
  return { rt, calls, settled };
}

test('S360, ruled: a call that uses its full input and output limits records no overrun; beyond either, it does', async () => {
  // The small tier allows 2000 input and 4000 output tokens, and reserves 1,800 micro-units for them.
  for (const [usage, overrun] of [[{ input: 2000, output: 4000 }, 0], [{ input: 2001, output: 4000 }, 1], [{ input: 2000, output: 4001 }, 1]]) {
    const { rt, calls, settled } = await run(`s360-${usage.input}-${usage.output}`, usage);
    try {
      const small = calls.find((c) => c.tier === 'small');
      assert.deepEqual(small.reservation, 1800);
      assert.equal(settled[0].budgets[0].overrun, overrun, JSON.stringify(usage));
    } finally { await rt.close(); }
  }
});

test('S361, ruled: a usage report that is missing, fractional or negative is charged the full reservation, recorded, and the budget binds', async () => {
  for (const [usage, violation] of [[undefined, 'usage-missing'], [{ input: 1000, output: 200.5 }, 'usage-invalid'], [{ input: -5000 }, 'usage-invalid']]) {
    const { rt, calls, settled } = await run(`s361-${violation}-${JSON.stringify(usage ?? null).length}`, usage);
    try {
      const small = calls.find((c) => c.tier === 'small');
      assert.ok(small, `${violation}: the call is recorded`);
      assert.deepEqual([small.usageViolation, small.usage, small.cost], [violation, null, { units: 1800, unit: 'micro-usd' }]);
      assert.equal(settled[0].outcome, 'settled', `${violation}: never released for free`);
      assert.deepEqual(settled[0].budgets.map((b) => b.actual), [1800, 1800]);
      const runCap = JSON.parse(rt.store.db.prepare("SELECT state FROM pr_instance WHERE instance_id LIKE 'budget:support:run:%'").get().state);
      assert.ok(runCap.spent >= 1800, 'the budget binds');
    } finally { await rt.close(); }
  }
});

test('ruled on the review of M11: a channel\'s name is an identifier, so an embedded name cannot write outside the build', async () => {
  const src = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'text-desk.poly'), 'utf8');
  const printed = printModule(parse(src).module);
  assert.ok(printed.includes('"text"'));
  const d = join(ROOT, '.poly', 'test-routing-rulings');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'desk.ts'), printed.split('channel("text"').join('channel("../../../ESCCHANNEL"'));
  const r = await checkFile(join(d, 'desk.ts'), { root: d });
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(r.diagnostics.some((x) => x.code === 'PL1201' && /channel's name is an identifier/.test(x.message)), JSON.stringify(r.diagnostics.map((x) => x.message)));
  assert.equal(existsSync(join(d, 'ESCCHANNEL.json')), false);
});
