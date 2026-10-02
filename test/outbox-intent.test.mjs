// M4b (PT9.7, S118, S119, S120): OutboxIntent is checked in the runtime's own CI, once per retry bound, and the
// worker conforms to it by trace replay. The worker hosts the machine, so its trace is the journal of each
// intent; the corpus below drives every state and every accepted transition of the bound-3 instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '@poly/core';
import { parse } from '@poly/lang';
import { checkFile, workerConformance, replayRuntime } from '@poly/check';
import { checkMachine, flatten } from '@poly/ref';
import { modelSource, BOUNDS, MODEL_BUILD, MODEL_SOURCE, verifiedModels } from '@poly/runtime/model';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';
import { lowerModels } from '../scripts/outbox-models.mjs';

const WORKER_SOURCE = join(ROOT, 'packages', 'poly-runtime', 'src', 'worker.ts');

test('the model is PT9.7, word for word', () => {
  const spec = readFileSync(join(ROOT, 'docs', '03-technical-spec.md'), 'utf8');
  const i = spec.indexOf('  ```poly\n  module runtime');
  const block = spec.slice(i + '  ```poly\n'.length, spec.indexOf('  ```\n', i + 10)).split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n');
  const model = readFileSync(MODEL_SOURCE, 'utf8').split('\n').filter((l, k, all) => k >= all.findIndex((x) => x.startsWith('module '))).join('\n');
  assert.equal(model.trimEnd(), block.trimEnd());
});

test('S137: OutboxIntent at every bound from 1 to 10: CLEAN, 3m + 8 states, deadlock-free, settles under its fairness, nothing vacuous', async () => {
  const dir = join(ROOT, '.poly', 'test-outbox-model');
  mkdirSync(dir, { recursive: true });
  assert.deepEqual([...BOUNDS], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const counts = {};
  for (const m of BOUNDS) {
    const f = join(dir, `outbox-${m}.poly`);
    writeFileSync(f, modelSource(m));
    const r = await checkFile(f, { root: dir });
    const mc = r.machines[0];
    assert.equal(r.verdict, 'CLEAN', `bound ${m}`);
    assert.equal(mc.instance.states, 3 * m + 8, `bound ${m}`);
    counts[m] = mc.instance.states;
    for (const stage of ['model-check', 'deadlock', 'liveness']) assert.equal(mc.stages.find((s) => s.stage === stage)?.verdict, 'CLEAN', `${m} ${stage}`);
    assert.deepEqual([mc.notRun, mc.vacuous], [[], []]);
  }
  console.log(`# OutboxIntent states by bound: ${JSON.stringify(counts)}`);
});

test('the checked-in builds are the lowering of the model, byte for byte, and the runtime checks them (standing rule)', () => {
  const { files, manifest } = lowerModels();
  for (const [rel, text] of Object.entries(files)) assert.equal(readFileSync(join(MODEL_BUILD, rel), 'utf8'), text, rel);
  assert.deepEqual(JSON.parse(readFileSync(join(MODEL_BUILD, 'MANIFEST.json'), 'utf8')), manifest);
  assert.equal(verifiedModels([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).length, 10);
  const f = join(MODEL_BUILD, 'runtime.OutboxIntent', 'next.cjs');
  const original = readFileSync(f);
  try {
    writeFileSync(f, Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => verifiedModels([3]), /does not match its manifest/);
  } finally { writeFileSync(f, original); }
});

// ── the conformance corpus ────────────────────────────────────────────────

/** A gate scripted per job: its proposals by whether they are approved re-proposals (K6), its settles in order. */
function scriptedGate(script) {
  const settles = new Map();
  return {
    propose(p) {
      const plan = script[p.instance]?.propose ?? ['allow'];
      const d = plan[Math.min(p.approved ? 1 : 0, plan.length - 1)];
      return d === 'allow' ? { decision: 'allow' } : d === 'deny' ? { decision: 'deny', reason: 'scripted', witnessDigest: 'sha256:0' } : { decision: 'escalate', reason: 'scripted' };
    },
    settle(observed, p) {
      const k = settles.get(p.instance) ?? 0;
      settles.set(p.instance, k + 1);
      return script[p.instance]?.settle?.[k] ?? 'ok';
    },
  };
}

const SCRIPT = {
  'job-ok': { propose: ['allow'], handler: ['ok'] },
  'job-deny': { propose: ['deny'] },
  'job-escalate-allow': { propose: ['escalate', 'allow'], approve: true, handler: ['ok'] },
  'job-escalate-deny': { propose: ['escalate', 'deny'], approve: true },
  'job-escalate-again': { propose: ['escalate', 'escalate'], approve: true },
  'job-escalate-timeout': { propose: ['escalate'] },
  'job-fail-thrice': { propose: ['allow'], handler: ['fail', 'fail', 'fail'] },
  'job-fail-then-ok': { propose: ['allow'], handler: ['fail', 'ok'] },
  'job-settle-fails': { propose: ['allow'], handler: ['ok', 'ok', 'ok'], settle: ['failed', 'failed', 'failed'] },
  'job-settle-then-ok': { propose: ['allow'], handler: ['ok', 'ok'], settle: ['failed', 'ok'] },
  'job-settle-third-ok': { propose: ['allow'], handler: ['ok', 'ok', 'ok'], settle: ['failed', 'failed', 'ok'] },
  'job-crash': { propose: ['allow'], handler: ['hang', 'ok'] },
};

async function corpus(extra = {}) {
  const a = await admitted('outbox', ['conformance/m4/outbox.poly']);
  const gate = scriptedGate(SCRIPT);
  const { rt, clock } = await loaded(a, { gate: { gate, escalationTimeoutMs: 10 * 60_000 }, worker: { leaseMs: 60_000 }, ...extra });
  const calls = new Map();
  const hung = [];
  rt.handle('w.work', (_payload, caps, ctx) => {
    const job = ctx.instanceId;
    const k = calls.get(job) ?? 0;
    calls.set(job, k + 1);
    const what = SCRIPT[job]?.handler?.[k] ?? 'ok';
    assert.deepEqual(caps, {}, 'S134: no capabilities');
    if (what === 'fail') throw new Error('scripted failure');
    if (what === 'hang') return new Promise((resolve) => hung.push(() => resolve(`${job}|late`)));
    return `${job}|${k}`;
  });
  for (const id of Object.keys(SCRIPT)) { await rt.create('outbox.Job', { id }); await rt.dispatch(id, 'Go'); }
  // Pass after pass: retries wait their backoff, escalations their approval or their timeout, the hung handler its lease.
  const pass = async (ms) => { clock.advance(ms); await rt.worker.tick(); };
  const first = rt.worker.tick(); // the hung handler keeps this pass waiting; it is let go at the end
  await new Promise((r) => setTimeout(r, 50));
  for (const id of Object.keys(SCRIPT).filter((x) => SCRIPT[x].approve)) {
    const [row] = await rt.outbox(id);
    await rt.approve(row.intent_id, { by: 'ops@example', ref: `esc-${id}` });
  }
  for (let k = 0; k < 8; k++) await pass(61_000);
  await pass(11 * 60_000); // the unapproved escalation times out
  for (const release of hung) release();
  await first;
  for (let k = 0; k < 4; k++) await pass(61_000);
  return { rt, clock, a };
}

test('the worker conforms: every intent\'s trace replays through OutboxIntent, and covers every state and transition', async () => {
  const { rt } = await corpus();
  try {
    const c = await workerConformance(rt, WORKER_SOURCE);
    assert.deepEqual(c.diagnostics.map((d) => d.message), []);
    assert.equal(c.intents, Object.keys(SCRIPT).length);
    // Coverage, measured against poly-ref's graph of the bound-3 instance.
    const module = parse(modelSource(3)).module;
    const ref = checkMachine(module, 'OutboxIntent');
    const states = new Set(ref.graph.states.map((s) => canonicalize(flatten(s, ref.model))));
    const edges = new Set(ref.graph.edges.filter((e) => e.label.verdict.kind === 'accepted').map((e) => `${canonicalize(flatten(ref.graph.states[e.from], ref.model))} -${e.label.action}->`));
    assert.equal(states.size, 17);
    assert.deepEqual([...states].filter((s) => !c.states.has(s)), [], 'every state visited');
    assert.deepEqual([...edges].filter((e) => !c.edges.has(e)), [], 'every accepted transition taken');
    console.log(`# corpus: ${c.intents} intents, ${c.states.size} of ${states.size} states, ${c.edges.size} of ${edges.size} accepted transitions`);
    // The outcomes the scripts ask for, as the program sees them.
    const phase = async (id) => (await rt.getState(id)).state.phase;
    for (const [id, want] of Object.entries({ 'job-ok': 'Done', 'job-deny': 'Failed', 'job-escalate-allow': 'Done', 'job-escalate-deny': 'Failed', 'job-escalate-again': 'Failed', 'job-escalate-timeout': 'Failed', 'job-fail-thrice': 'Failed', 'job-fail-then-ok': 'Done', 'job-settle-fails': 'Failed', 'job-settle-then-ok': 'Done', 'job-settle-third-ok': 'Done', 'job-crash': 'Done' })) {
      assert.equal(await phase(id), want, id);
    }
    // A stale worker (the hung handler's pass) took no transition after its claim was taken over.
    assert.deepEqual((await rt.audit()).filter((x) => x.rule === 'PL2401'), []);
  } finally { await rt.close(); }
});

test('every recorded gate decision replays from its proposal and snapshot (S118), and every run folds', async () => {
  const { rt } = await corpus();
  try {
    const runs = await replayRuntime(rt);
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
    const verdicts = (await Promise.all(Object.keys(SCRIPT).map((id) => rt.chain(id)))).flat().filter((e) => e.kind === 'verdict');
    assert.ok(verdicts.filter((e) => e.body.proposal).length >= 14, 'every proposal decided is recorded with its proposal and snapshot');
    assert.ok(verdicts.some((e) => e.body.outcome === 'approved' && e.body.by === 'ops@example' && e.body.signed === false), 'the approval is recorded, unsigned until M5');
  } finally { await rt.close(); }
});
