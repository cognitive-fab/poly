// `poly try` (PT28.2, PF15.2, AC29, S362, ruled at M11): a playground over one machine, built as the owner ruled on the
// review of M11. AC29: it reproduces the README turnstile's deadlock step by step, and the witness it asks for is the
// one `poly check` reports. Nothing is admitted, signed, run or written to a store or a ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, commandNamed } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const GATE = join(ROOT, 'conformance', 'm2', 'seeded', 'deadlock', 'unfixed.poly');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const OUT = join(ROOT, '.poly', 'test-try');
const run = (input) => commandNamed('try').run(input);

test('AC29: poly try reproduces the turnstile\'s deadlock step by step, and its witness is the one poly check reports', { timeout: 300_000 }, async () => {
  const coin = { op: 'dispatch', action: 'Coin' };
  const push = { op: 'dispatch', action: 'Push' };
  const o = await run({ file: GATE, machine: 'Gate', ops: [coin, coin, coin, push, coin, push, { op: 'state' }, { op: 'witness', predicate: 'deadlock' }] });
  assert.deepEqual(o.result.diagnostics, []);
  const steps = o.result.results.filter((x) => x.op === 'dispatch');
  assert.deepEqual(steps.map((x) => [x.action, x.stepKind, x.rejectReason ?? null]), [['Coin', 'accepted', null], ['Coin', 'accepted', null], ['Coin', 'accepted', null], ['Push', 'accepted', null], ['Coin', 'rejected', 'coin-box-full'], ['Push', 'rejected', 'locked']]);
  // A full coin box, locked: no action is accepted, the deadlock PL3201 names.
  assert.deepEqual(o.result.results[6].state, { mode: 'Locked', coins: 3 });
  const w = o.result.results[7];
  assert.equal(w.found, true);
  const r = await checkFile(GATE, { root: join(OUT, 'check') });
  const d = r.machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL3201');
  assert.ok(d, 'poly check reports the deadlock');
  const checked = (d.witness?.trace ?? d.witness).map((s) => s.action);
  assert.deepEqual(w.path.map((s) => s.action), checked);
  // Each step is a window of the trace, which poly check --against can replay (PT28.2d).
  assert.equal(o.result.trace.length, 6);
  assert.deepEqual(o.result.trace[0], { pre: { mode: 'Locked', coins: 0 }, action: 'Coin', data: {}, post: { mode: 'Unlocked', coins: 1 } });
});

test('PT28.2: intents, a predicate witness, reset, and PL6846 for an operation that is no step', { timeout: 300_000 }, async () => {
  const o = await run({ file: GATE, machine: 'Gate', ops: [{ op: 'dispatch', action: 'Coin' }, { op: 'intents' }, { op: 'witness', predicate: 'coins == 2' }, { op: 'reset' }, { op: 'state' }, { op: 'dispatch', action: 'Kick' }, { op: 'state' }] });
  assert.deepEqual(o.result.results[1], { op: 'intents', intents: [] });
  assert.deepEqual(o.result.results[2].path.map((s) => s.action), ['Coin', 'Coin']);
  assert.deepEqual(o.result.results[4].state, { mode: 'Locked', coins: 0 });
  assert.equal(o.result.results.length, 5, 'the session stops at the refused operation');
  assert.deepEqual(o.result.diagnostics.map((x) => x.code), ['PL6846']);
  assert.notEqual(o.exit, 0);
});

test('PT28.2b: the gate of a policy file, by PS8, over the intents of the last step', { timeout: 300_000 }, async () => {
  mkdirSync(OUT, { recursive: true });
  const src = join(OUT, 'shop.poly');
  writeFileSync(src, ['module shop', '', 'machine Order {', '  state {', '    paid : bool = false', '  }', '', '  action Pay()', '', '  on Pay {', '    require !paid else reject "paid"', "    paid' = true", '    emit charge()', '  }', '', '  effect charge() {', '    kind "payments.charge"', '    labels { egress:external }', '    class irreversible', '  }', '}', ''].join('\n'));
  const pol = join(OUT, 'shop.policy.poly');
  writeFileSync(pol, ['module shop_policy', '', 'policy charges {', '  scope "shop"', '  obligation person-charges "A charge needs a person." rule {', '    when effect.kind == "payments.charge"', '    require false else escalate', '  }', '}', ''].join('\n'));
  const o = await run({ file: src, machine: 'Order', ops: [{ op: 'dispatch', action: 'Pay' }, { op: 'intents' }, { op: 'gate', policy: pol }] });
  assert.deepEqual(o.result.diagnostics, []);
  assert.deepEqual(o.result.results[1].intents.map((x) => x.kind), ['payments.charge']);
  assert.deepEqual(o.result.results[2].decisions[0].scopes.map((x) => [x.scope, x.decision]), [['shop', 'escalate']]);
});

test('PT28.2d: nothing is admitted, signed or written beside the source; the session is saved as a trace only where asked', { timeout: 300_000 }, async () => {
  const dir = join(OUT, 'quiet');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'gate.poly');
  writeFileSync(src, readFileSync(GATE, 'utf8'));
  const ops = join(OUT, 'ops.json');
  writeFileSync(ops, JSON.stringify([{ op: 'dispatch', action: 'Coin' }, { op: 'dispatch', action: 'Push' }]));
  const trace = join(OUT, 'trace.json');
  const out = execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, 'try', src, '--machine', 'Gate', '--ops', ops, '--out', trace], { encoding: 'utf8' });
  assert.match(out, /Coin: accepted/);
  assert.equal(existsSync(join(dir, '.poly')), false, 'no build, report, store or certificate beside the source');
  assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')).map((w) => w.action), ['Coin', 'Push']);
  assert.equal(commandNamed('try').mcp, 'poly_try');
  assert.equal(commandNamed('try').lsp, true);
});
