// Plan-m2 step 5: detached children (PS7.5, PS13.3, S60, S78). The checker binds `as k` to the child's
// address; the lowering stores the marker { $ref: "child", key } and emits createInstance; translation
// validation compares after the commit resolves the marker. Alone, the address is one more symbolic
// address of Ref<M> (PS1.6). In a configuration the child is a new instance at <parent>/<k>, in the group
// named after its machine, whose creation action is its first message; the instance bound is PL5302.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { buildMachine, checkConfiguration, transition, initialState, refCount } from '@poly/ref';
import { checkFile, exportWitness, findWitness, render } from '@poly/check';
import { spawnSync } from 'node:child_process';
import { ROOT, BUILD } from './helpers.mjs';

const FILE = join(ROOT, 'conformance', 'm2', 'detached.poly');
const SRC = readFileSync(FILE, 'utf8');
const OUT = join(BUILD, 'detached');

const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const moduleOf = (src) => parse(src).module;
const write = (name, src) => {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'm.poly');
  writeFileSync(f, src);
  return { dir, f };
};
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];

test('S60: the conformance source checks clean at every stage, and the configuration creates the worker', async () => {
  const { dir, f } = write('clean', SRC);
  const r = await checkFile(f, { root: dir });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const d = r.machines.find((m) => m.machine === 'Dispatcher');
  assert.deepEqual(d.stages.map((s) => `${s.stage}:${s.status}`), ['parse-type:ran', 'lower:ran', 'validate:ran', 'translation-validation:ran', 'model-check:ran', 'deadlock:ran', 'effects:ran']);
  const cfg = r.configurations[0];
  assert.equal(cfg.instance.states, 5);
  assert.match(cfg.stages[0].notes.join(' '), /polyrun has no sendTo or createInstance intent yet \(S58, S60\)/);
  assert.deepEqual(cfg.instance.instances, ['d: Dispatcher', 'Worker[0..0]: Worker']);
});

test('S78: alone, the child is one more symbolic address of Ref<Worker>, bound by `as w` and stored', () => {
  const M = buildMachine(moduleOf(SRC), 'Dispatcher');
  // One Ref<Worker> field, and the key w (S57, S78).
  assert.equal(refCount(M, 'Worker'), 2);
  const st = transition(M, initialState(M), 'Go', {});
  assert.equal(st.verdict.kind, 'accepted');
  assert.equal(st.next.worker, 'Worker#2');
  assert.deepEqual(st.effects.map((x) => `${x.kind}:${x.type === 'create' ? x.address : x.target}`), ['createInstance:Worker#2', 'sendTo:Worker#2']);
});

test('S78: the lowered acceptor writes the marker, and the mapper emits createInstance with the creation action', async () => {
  const { dir, f } = write('lowered', SRC);
  await checkFile(f, { root: dir });
  const b = join(dir, '.poly', 'build', 'detached.Dispatcher');
  const acceptor = readFileSync(join(b, 'next.cjs'), 'utf8');
  assert.match(acceptor, /\{ \$ref: "child", key: "w" \}/);
  const mapper = readFileSync(join(b, 'effects.cjs'), 'utf8');
  assert.match(mapper, /kind: "createInstance", machineId: "detached\.Worker", childKey: "w", creation: \{ action: "Start", data: \{ "n": 1 \} \}/);
  // The sealed shape admits the marker in the field between the write and the commit (sam-pattern #35).
  assert.match(acceptor, /"worker":\{"type":\["string","object"\],"nullable":true\}/);
});

test('PS13.3, S60: the creation action is the child\'s first message; a Hello never reaches a worker before its Start', () => {
  const r = checkConfiguration(moduleOf(SRC), 'pool');
  assert.deepEqual(r.findings.map((x) => x.code), []);
  const w = r.instances.findIndex((x) => x.name === 'd/w');
  assert.equal(r.instances[w].member, 'Worker[0]');
  for (const e of r.graph.edges) {
    const pre = r.graph.states[e.from];
    if (e.label.via === 'deliver' && e.label.instance === w && e.label.action === 'Hello') assert.ok(!pre.mu.some((m) => m.creation && m.target === w));
  }
  // Without that rule, Hello could arrive first and be rejected, and the dispatcher would wait for ever.
  assert.ok(r.graph.edges.some((e) => e.label.via === 'deliver' && e.label.action === 'Start' && e.label.creation));
});

test('PS13.5, S60: a spawn above the instance bound is not explored, and is PL5302, INCONCLUSIVE', async () => {
  const { dir, f } = write('bound', SRC.replace('bounds  { transit 2, instances 2 }', 'bounds  { transit 2, instances 1 }'));
  const r = await checkFile(f, { root: dir });
  const d = all(r).find((x) => x.code === 'PL5302');
  assert.ok(d, render(r));
  assert.equal(d.severity, 'inconclusive');
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.equal(d.witness.trace.at(-1).global.text, 'Go@d');
});

test('S60, S62: a configuration whose machine spawns detached children needs an instance bound (PL5303)', () => {
  assert.deepEqual(codes(SRC.replace('bounds  { transit 2, instances 2 }', 'bounds  { transit 2 }')), ['PL5303']);
});

test('S60: a group of dispatchers makes a group of workers, and a property reads the members that exist', async () => {
  const src = SRC.replace('  d       : Dispatcher\n  inputs  { d.Go }\n  bounds  { transit 2, instances 2 }', '  d[2]    : Dispatcher\n  inputs  { d[*].Go }\n  bounds  { transit 4, instances 4 }')
    .replace('count(Worker[*] is Finished) <= 1', 'count(Worker[*] is Finished) <= 2')
    .replace('  liveness  finishes: d.started leads to d.done == 1', '  liveness  finishes: forall i in Worker: Worker[i] is Ready leads to Worker[i] is Finished');
  assert.deepEqual(codes(src), []);
  const r = checkConfiguration(moduleOf(src), 'pool');
  assert.deepEqual(r.findings.map((x) => x.code), []);
  assert.deepEqual(r.instances.filter((x) => x.spawned).map((x) => `${x.name}=${x.member}`), ['d[0]/w=Worker[0]', 'd[1]/w=Worker[1]']);
});

test('S60: the checker: wiring, families, scope and key clashes', () => {
  const swap = (a, b) => codes(SRC.replace(a, b));
  assert.deepEqual(swap('-> Start(n: 1)', '-> Start(n: 1) on complete -> Done'), ['PL1201']);
  assert.deepEqual(swap('-> Start(n: 1)', '-> Begin(n: 1)'), ['PL1001']);
  assert.deepEqual(swap('-> Start(n: 1)', '-> Start(n: true)'), ['PL1201']);
  // `as k` binds k for the rest of its block only.
  assert.deepEqual(swap('  on Done { require worker != none', '  on Done { require w != none'), ['PL1001']);
  // A key that is already a name here; the uses of w are then unbound.
  assert.deepEqual(swap('spawn detached Worker as w', 'spawn detached Worker as started').filter((c) => c !== 'PL1001'), ['PL1002']);
  // A family of detached children is not in M2.
  assert.ok(swap('spawn detached Worker as w -> Start(n: 1)', 'spawn detached Worker as ws[0] -> Start(n: 1)').includes('PL0901'));
});

test('S83: a second spawn of a live key in a configuration is PL5101, with its witness, before the instance bound', async () => {
  const src = SRC.replace('    require !started else reject "started"\n', '');
  const { dir, f } = write('again', src);
  const r = await checkFile(f, { root: dir });
  assert.notEqual(r.verdict, 'ERROR', render(r));
  const c = r.configurations[0];
  const d = c.diagnostics.find((x) => x.code === 'PL5101');
  assert.ok(d, render(r));
  assert.match(d.message, /d spawns w again, and d\/w exists/);
  assert.equal(d.witness.trace.filter((s) => s.global.text === 'Go@d').length, 2);
  // Checked before the bound: instances 2 is full once d/w exists, and the collision is still what is reported.
  assert.ok(!c.diagnostics.some((x) => x.code === 'PL5302'), render(r));
  // Its exported test fails on the program, at the second spawn.
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /spawns w again, and d\/w exists/);
});

test('S68: the exported witness test of a configuration invariant walks the detached spawn through the lowered artefacts', async () => {
  const { dir, f } = write('witness', SRC.replace('invariant one-worker: count(Worker[*] is Finished) <= 1', 'invariant no-worker: count(Worker[*] is Finished) == 0'));
  const r = await checkFile(f, { root: dir });
  const d = all(r).find((x) => x.code === 'PL5401');
  assert.ok(d?.witness, render(r));
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /configuration invariant no-worker is violated/);
});
