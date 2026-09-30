// Typed decisions (PD1, S75, S76, S79; plan-m2 step 8), and the acceptance of PD1.8 with a recorded provider:
// no test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkMachine } from '@poly/ref';
import { checkFile, exportWitness, findWitness, render } from '@poly/check';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { recordedProvider } from './providers/recorded.mjs';
import { ROOT, BUILD } from './helpers.mjs';

const ROUTER = join(ROOT, 'conformance', 'm2', 'decisions', 'router.poly');
const SRC = readFileSync(ROUTER, 'utf8');
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)];
const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const place = (name, src) => {
  const dir = join(BUILD, 'decisions', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'router.poly');
  writeFileSync(f, src);
  return { dir, f };
};

async function runtime(dir, replies) {
  const b = join(dir, '.poly', 'build', 'support.Ticket');
  const provider = recordedProvider(replies);
  const refunds = [];
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [{ machineId: 'support.Ticket', module: join(b, 'next.cjs'), contract: join(b, 'contract.json'), effects: { mapper: join(b, 'effects.cjs'), manifest: join(b, 'effects.manifest.json') } }],
    handlers: {
      'decision.route': provider.handler,
      'payments.refund': async (p) => { refunds.push(p); return {}; },
      'support.reply': async () => ({}),
    },
  });
  return { rt, provider, refunds };
}

test('PD1-A1: the router lowers, passes strict validate(), checks clean, and runs under polyrun with a recorded provider', async () => {
  const { dir, f } = place('a1', SRC);
  const r = await checkFile(f, { root: dir });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const m = r.machines[0];
  assert.ok(m.stages.some((s) => s.stage === 'validate' && s.verdict === 'CLEAN'));
  const manifest = JSON.parse(readFileSync(join(dir, '.poly', 'build', 'support.Ticket', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['decision.route'].onSuccess, { action: 'Routed', map: { branch: '$.result.answer', conf: '$.result.conf', margin: '$.result.margin' } });
  assert.deepEqual(manifest.effects['decision.route'].decision, { provider: 'jev', result: ['Refund', 'Reschedule', 'Status', 'Complaint', 'Other'] });
  assert.deepEqual(manifest.effects['decision.route'].retry, { maxAttempts: 1, timeoutMs: 800 });
  const { rt, provider, refunds } = await runtime(dir, [{ answer: 'Refund', conf: 910, margin: 420 }]);
  try {
    await rt.create('support.Ticket', 't1');
    const received = await rt.dispatch('t1', 'Received', { text: 'where is my refund' }, 'a1');
    assert.equal(received.stepKind, 'accepted');
    await rt.workers.tickEffects();
    assert.deepEqual(provider.asked, [{ text: 'where is my refund' }]);
    assert.equal((await rt.getState('t1')).state.status, 'Refunding');
    // The journal shows the typed answer, confidence and margin as the completion's data.
    const routed = (await rt.store.getJournal('t1')).find((j) => j.action === 'Routed');
    const data = typeof routed.data === 'string' ? JSON.parse(routed.data) : routed.data;
    assert.deepEqual(data, { branch: 'Refund', conf: 910, margin: 420 });
    await rt.workers.tickEffects();
    assert.deepEqual(refunds, [{ order: 1 }]);
  } finally {
    await rt.close();
  }
});

test('PD1-A2: poly-ref explores 5 × 2 × 2 completions in Routing', () => {
  const r = checkMachine(parse(SRC).module, 'Ticket');
  const g = r.graph;
  const routing = g.states.findIndex((s) => s.status.ctor === 'Routing');
  assert.ok(routing >= 0);
  const routed = g.edges.filter((e) => e.from === routing && e.label.action === 'Routed');
  assert.equal(routed.length, 20);
  assert.deepEqual([...new Set(routed.map((e) => e.label.data.conf))].sort((a, b) => a - b), [0, 800]);
  assert.deepEqual([...new Set(routed.map((e) => e.label.data.margin))].sort((a, b) => a - b), [0, 300]);
});

test('PD1-A2: a seeded refund when margin < 0.3 is found with a witness, whose exported test fails before the fix and passes after', async () => {
  const unfixed = SRC.replace('if conf >= 0.8 && margin >= 0.3 {', 'if conf >= 0.8 && margin < 0.3 {');
  assert.notEqual(unfixed, SRC);
  const { dir, f } = place('a2', unfixed);
  const before = await checkFile(f, { root: dir });
  const d = all(before).find((x) => x.code === 'PL3002' && x.property === 'refund-needs-margin');
  assert.ok(d?.witness, render(before));
  const last = d.witness.trace.at(-1);
  assert.equal(last.action, 'Routed');
  assert.ok(last.data.margin < 300);
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(before)), d.witness.id), { root: dir, kind: 'test' });
  const run = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env }); };
  const failing = run();
  assert.notEqual(failing.status, 0);
  assert.match(failing.stdout, /step property refund-needs-margin is violated/);
  writeFileSync(f, SRC);
  const after = await checkFile(f, { root: dir });
  assert.equal(after.verdict, 'CLEAN', render(after));
  assert.equal(run().status, 0);
});

test('PD1-A3: a reply outside the domain (a sixth branch, a confidence of 1001) is rejected at dispatch and journaled', async () => {
  const { dir, f } = place('a3', SRC);
  await checkFile(f, { root: dir });
  const { rt } = await runtime(dir, [{ answer: 'Spam', conf: 500, margin: 500 }, { answer: 'Status', conf: 1001, margin: 500 }]);
  try {
    for (const t of ['t1', 't2']) {
      await rt.create('support.Ticket', t);
      await rt.dispatch(t, 'Received', { text: 'where is my refund' }, `${t}-a`);
    }
    await rt.workers.tickEffects();
    for (const t of ['t1', 't2']) {
      const routed = (await rt.store.getJournal(t)).find((j) => j.action === 'Routed');
      assert.ok(routed, `${t}: the completion is journaled`);
      assert.equal(routed.step_kind ?? routed.stepKind, 'rejected');
      assert.equal(routed.reject_reason ?? routed.rejectReason, 'outside-check-domain');
      assert.equal((await rt.getState(t)).state.status, 'Routing');
    }
  } finally {
    await rt.close();
  }
});

test('PD1-A4: PL1205, PL6201 and PL6202 each have an error source; a vacuous require does not silence PL6201', async () => {
  assert.deepEqual(codes(readFileSync(join(ROOT, 'conformance', 'm0', 'errors', 'PL1205-confidence-not-compared.poly'), 'utf8')), ['PL1205']);
  assert.deepEqual(codes(readFileSync(join(ROOT, 'conformance', 'm0', 'errors', 'PL6202-decision-without-failure.poly'), 'utf8')), ['PL6202']);
  // Removing the if makes the decision ungated (PD1.5).
  const ungated = SRC.replace('if conf >= 0.8 && margin >= 0.3 { status\' = Refunding   emit refund(order) }\n        else { status\' = NeedsHuman }', 'status\' = Refunding   emit refund(order)')
    .replace('  step property refund-needs-margin: (action == Routed && post.status == Refunding) implies (conf >= 0.8 && margin >= 0.3)\n', '');
  assert.notEqual(ungated, SRC);
  const a = place('ungated', ungated);
  const r1 = await checkFile(a.f, { root: a.dir });
  const d1 = all(r1).find((x) => x.code === 'PL6201');
  assert.ok(d1?.witness, render(r1));
  assert.match(d1.message, /branch = Refund/);
  // A require that tests nothing does not gate it.
  const vacuous = ungated.replace('    require status == Routing else reject "not-routing"\n    match branch', '    require status == Routing else reject "not-routing"\n    require conf >= 0 else reject "never"\n    match branch');
  assert.notEqual(vacuous, ungated);
  const b = place('vacuous', vacuous);
  const r2 = await checkFile(b.f, { root: b.dir });
  assert.ok(all(r2).some((x) => x.code === 'PL6201'), render(r2));
  // The router as written is gated.
  const c = place('gated', SRC);
  assert.deepEqual(all(await checkFile(c.f, { root: c.dir })).filter((x) => x.code === 'PL6201'), []);
});

test('PD1.3b, S76: what a Conf and a decimal may do', () => {
  const base = SRC;
  const swap = (a, b) => { const s = base.replace(a, b); assert.notEqual(s, base, a); return codes(s); };
  assert.deepEqual(swap('if conf >= 0.8 && margin >= 0.3', 'if conf >= margin'), ['PL1205']);
  assert.deepEqual(swap('if conf >= 0.8 && margin >= 0.3', 'if conf >= 1 && margin > 0'), []);
  assert.deepEqual(swap("status' = Refunding   emit refund(order)", "status' = Refunding   emit refund(conf)"), ['PL1205']);
  assert.deepEqual(swap("    order  : 1..2         = 1\n", "    order  : 1..2         = 1\n    last   : Conf         = 0.5\n"), ['PL1205']);
  assert.deepEqual(swap("status' = Refunding   emit refund(order)", "status' = Refunding   emit refund(order + 0.5)"), ['PL1201']);
  assert.deepEqual(swap('if conf >= 0.8', 'if conf >= 1.5'), ['PL1201']);
  // PD1.2f: the completion's parameter types are those of the reply.
  assert.deepEqual(swap('action Routed(branch: Branch, conf: Conf, margin: Conf)', 'action Routed(branch: Branch, conf: 0..1000, margin: Conf)').includes('PL1201'), true);
  assert.deepEqual(swap('ok(r) -> Routed(branch: r.answer, conf: r.conf, margin: r.margin)', 'ok(r) -> Routed(branch: r.answer, conf: r.certainty, margin: r.margin)'), ['PL1001']);
  // PD1.2a: an unbounded result is PL1101.
  assert.deepEqual(swap('decision route(text: string) -> Branch {', 'decision route(text: string) -> int {').includes('PL1101'), true);
});

test('S76, PD1.2d: a Tri result with its band, and Tri.Unknown in a machine', () => {
  const src = `module t
enum S { Waiting, Yes, No, Ask }
machine M {
  state { s : S = Waiting }
  terminal s != Waiting
  action Go()
  action Got(v: Tri)
  action Failed()
  on Go { decide urgent(1) }
  on Got(v) { match v { True => s' = Yes   False => s' = No   Tri.Unknown => s' = Ask } }
  on Failed { s' = Ask }
  decision urgent(n: 0..1) -> Tri {
    provider "jev"
    labels { egress:external }
    timeout 300ms
    band 0.3..0.7
    ok(r) -> Got(v: r.answer)
    failed -> Failed()
  }
}
`;
  assert.deepEqual(codes(src), []);
  assert.deepEqual(codes(src.replace('    band 0.3..0.7\n', '')), ['PL1201']);
  const r = checkMachine(parse(src).module, 'M');
  assert.deepEqual([...new Set(r.graph.edges.filter((e) => e.label.action === 'Got').map((e) => e.label.data.v.ctor))].sort(), ['False', 'True', 'Unknown']);
});

test('S79: ok(r) in an ordinary effect binds the handler result, strict by default, mapped from $.result', async () => {
  const src = `module t
enum Grade { A, B }
enum S { Idle, Asked, Done }
machine M {
  state { s : S = Idle   g : Grade = A }
  terminal s == Done
  action Go()
  action Graded(grade: Grade)
  on Go { require s == Idle else reject "busy"   s' = Asked   emit grade(1) }
  on Graded(grade) { require s == Asked else reject "idle"   s' = Done   g' = grade }
  effect grade(n: 0..1) {
    kind "grader.grade"
    labels { egress:external }
    ok(r) -> Graded(grade: r.grade)
  }
}
`;
  assert.deepEqual(codes(src), []);
  const { dir, f } = place('s79', src);
  const r = await checkFile(f, { root: dir });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const manifest = JSON.parse(readFileSync(join(dir, '.poly', 'build', 't.M', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['grader.grade'].onSuccess, { action: 'Graded', map: { grade: '$.result.grade' } });
  // Strict by default: a result outside the domain is rejected before the handler.
  const next = readFileSync(join(dir, '.poly', 'build', 't.M', 'next.cjs'), 'utf8');
  assert.match(next, /action === "Graded" && !\["A","B"\]\.includes\(proposal\["grade"\]\)\) return reject\('outside-check-domain'\)/);
  void copyFileSync;
});
