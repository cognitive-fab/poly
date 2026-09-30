// S35: an action with no handler is not lowered. It is not an intent of the
// module and not in the contract's actions; the runtime answers it before any
// acceptor runs (PS9.1a): rejected("terminal") in a terminal state and
// unhandled elsewhere. Translation validation still covers it, and a reject
// property that names it is decided by poly-ref alone, which the verdict
// record says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { translationValidate } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD, build, requireModule } from './helpers.mjs';

const GUARD_TERMINAL = join(ROOT, 'conformance', 'm0', 'guard-terminal.poly');

test('S35: an action with no handler is neither an intent of the module nor in the contract', () => {
  const [b] = build(GUARD_TERMINAL, 'unhandled');
  const contract = JSON.parse(readFileSync(join(b.dir, 'contract.json'), 'utf8'));
  assert.deepEqual(Object.keys(contract.actions).sort(), ['Lock', 'OpenDoor', 'Smash', 'Trip']);
  const mod = requireModule(b.dir);
  assert.equal(mod.actions.Knock, undefined);
  assert.deepEqual(mod.instance({}).validate(), []);
  assert.deepEqual(Object.keys(mod.instance({}).manifest().intents).sort(), ['Lock', 'OpenDoor', 'Smash', 'Trip']);
});

test('S35 (1): translation validation compares the unhandled action with the runtime rows, terminal and unhandled', async () => {
  const [b] = build(GUARD_TERMINAL, 'unhandled');
  const r = await translationValidate(b.module, b.machine, b.dir);
  assert.deepEqual(r.mismatches.map((d) => d.message), []);
  const knock = r.report.graph.edges.filter((e) => e.label.action === 'Knock');
  const kinds = new Set(knock.map((e) => (e.label.verdict.kind === 'rejected' ? `rejected(${e.label.verdict.reason})` : e.label.verdict.kind)));
  assert.deepEqual([...kinds].sort(), ['rejected(terminal)', 'unhandled']);
  assert.equal(r.transitions, r.report.graph.edges.length);
});

test('S35 (1): a runtime that got the terminal row wrong for the unhandled action is caught', async () => {
  const [b] = build(GUARD_TERMINAL, 'unhandled-bad-terminal');
  // The contract is what the runtime reads; with no terminal states, Knock in Broken would be unhandled.
  const path = join(b.dir, 'contract.json');
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...contract, terminalStates: [] }));
  const r = await translationValidate(b.module, b.machine, b.dir);
  assert.ok(r.mismatches.some((d) => /Knock/.test(d.message) && /unhandled/.test(d.message) && /rejected\(terminal\)/.test(d.message)), JSON.stringify(r.mismatches.map((d) => d.message)));
});

test('S35 (2): a reject property that names an action with no handler is decided by poly-ref alone, and says so', async () => {
  const dir = join(BUILD, 'unhandled-ref-only');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'knock.poly');
  writeFileSync(file, readFileSync(GUARD_TERMINAL, 'utf8').replace(
    '  reject property alarm-blocks:',
    '  reject property knock-refused: (action == Knock && !pre.alarm && pre.door != Broken) implies rejected("alarm-on")\n  reject property alarm-blocks:',
  ));
  const r = await checkFile(file, { root: dir });
  const m = r.machines[0];
  assert.deepEqual(m.instance.refOnly, [{ property: 'knock-refused', actions: ['Knock'] }]);
  const finding = m.diagnostics.find((d) => d.code === 'PL3003' && d.property === 'knock-refused');
  assert.ok(finding, JSON.stringify(m.diagnostics.map((d) => [d.code, d.property])));
  assert.match(finding.message, /poly-ref alone/);
  const text = render(r);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('verdict:'));
  assert.ok(at >= 0 && lines.slice(at + 1).some((l) => /Room: knock-refused decided by poly-ref alone \(it names Knock, which has no handler/.test(l)), text);
  assert.equal(r.verdict, 'FINDINGS');
});
