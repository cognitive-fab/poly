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
import { admitted, loaded, handleWith, approveAs, PERSON } from './runtime-helpers.mjs';
import { lowerModels } from '../scripts/outbox-models.mjs';

const WORKER_SOURCE = join(ROOT, 'packages', 'poly-runtime', 'src', 'worker.ts');

test('the model is PT9.7, word for word', () => {
  const spec = readFileSync(join(ROOT, 'docs', '03-technical-spec.md'), 'utf8');
  const i = spec.indexOf('  ```poly\n  module runtime');
  const block = spec.slice(i + '  ```poly\n'.length, spec.indexOf('  ```\n', i + 10)).split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n');
  const model = readFileSync(MODEL_SOURCE, 'utf8').split('\n').filter((l, k, all) => k >= all.findIndex((x) => x.startsWith('module '))).join('\n');
  assert.equal(model.trimEnd(), block.trimEnd());
});

test('S137, S147: OutboxIntent at every bound from 1 to 10: CLEAN, 17m + 8 states, deadlock-free, settles under its fairness, nothing vacuous', async () => {
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
    assert.equal(mc.instance.states, 17 * m + 8, `bound ${m}`);
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

// S147: with Recheck, the bound-3 machine has 59 states, too many to script by hand. The corpus is generated from
// the model's own graph: for each accepted transition not yet covered, the shortest path from the initial state
// through it to a terminal state becomes one job, whose gate decisions, approvals, stale allows, handler outcomes
// and settles are read off the path. The worker then runs every job, and its traces must cover the whole graph.
const REF = (() => {
  const module = parse(modelSource(3)).module;
  const ref = checkMachine(module, 'OutboxIntent');
  const key = (s) => canonicalize(flatten(s, ref.model));
  return { ref, key };
})();

function corpusPaths() {
  const { ref, key } = REF;
  const g = ref.graph;
  const accepted = g.edges.filter((e) => e.label.verdict.kind === 'accepted' && e.to !== null);
  const out = new Map(g.states.map((_, i) => [i, []]));
  for (const e of accepted) out.get(e.from).push(e);
  const terminal = (i) => ['Done', 'Denied', 'Dead'].includes(g.states[i].intent.ctor);
  const bfs = (from, goal) => {
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const s = queue.shift();
      if (goal(s)) { const path = []; for (let x = s; prev.get(x); x = prev.get(x).from) path.unshift(prev.get(x)); return path; }
      for (const e of out.get(s)) if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
    return null;
  };
  const covered = new Set();
  const paths = [];
  for (const e of accepted) {
    const id = `${key(g.states[e.from])} -${e.label.action}->`;
    if (covered.has(id)) continue;
    const before = bfs(0, (s) => s === e.from);
    const after = bfs(e.to, terminal);
    if (!before || !after) continue;
    const path = [...before, e, ...after];
    for (const x of path) covered.add(`${key(g.states[x.from])} -${x.label.action}->`);
    paths.push(path.map((x) => x.label.action));
  }
  return paths;
}

/** A path of OutboxIntent actions, read as the script of one job. */
function scriptOf(actions) {
  // PS23.7, PT33.5a: a path that takes WindowLapsed runs on the keyed job, and its script moves the clock past the window at the
  // step just before it (the gate's last allow, the handler's last failure, or the last failed settle).
  const s = { propose: [], approve: [], stale: [], handler: [], settle: [], end: null, keyed: actions.includes('WindowLapsed'), lapseAfter: actions[actions.indexOf('WindowLapsed') - 1] ?? null };
  for (let k = 0; k < actions.length; k++) {
    const a = actions[k];
    if (a === 'GateAllow') s.propose.push('allow');
    if (a === 'GateDeny') s.propose.push('deny');
    if (a === 'GateEscalate') { s.propose.push('escalate'); s.approve.push(actions[k + 1] === 'Approve'); }
    if (a === 'Recheck') s.stale.push(true);
    if (a === 'Start') { if (actions[k - 1] === 'GateAllow' || actions[k - 1] === 'HandlerFailed' || actions[k - 1] === 'SettleFailed') s.stale.push(false); }
    if (a === 'HandlerOk') s.handler.push('ok');
    if (a === 'HandlerFailed') s.handler.push('fail');
    if (a === 'HandlerFailedPermanent') s.handler.push('permanent');
    if (a === 'SettleOk') s.settle.push('ok');
    if (a === 'SettleFailed') s.settle.push('failed');
  }
  s.end = actions.at(-1);
  return s;
}

const ALL = Object.fromEntries(corpusPaths().map((p, k) => [`job-${String(k).padStart(2, '0')}`, { ...scriptOf(p), path: p }]));
// A job that takes WindowLapsed moves the clock a whole window, which would end the escalation of any other job in flight, so each
// runs in a runtime of its own (LAPSE); the others share one (SCRIPT).
const LAPSE = Object.fromEntries(Object.entries(ALL).filter(([, j]) => j.keyed));
const SCRIPT = Object.fromEntries(Object.entries(ALL).filter(([, j]) => !j.keyed));
// A crash while Running, found at the next claim (S119): HandlerFailed by the lease, not by the handler.
SCRIPT['job-crash'] = { propose: ['allow'], approve: [], stale: [false, false], handler: ['hang', 'ok'], settle: ['ok'], end: 'SettleOk', path: [] };

/**
 * A gate scripted per job. A decision is a function of the proposal (K6): its place in the job's path is fixed by
 * the rechecks it has had and whether it is an approved re-proposal, which the proposal carries. Settles go in order.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
function scriptedGate(script, clockRef) {
  const settles = new Map();
  const next = (m, job) => { const k = m.get(job) ?? 0; m.set(job, k + 1); return k; };
  const index = (job, p) => {
    const keys = [];
    let r = 0;
    for (const a of script[job]?.path ?? []) {
      if (a === 'Recheck') r++;
      if (a === 'Propose') keys.push(`${r}:${keys.length && keys.at(-1).startsWith(`${r}:`) ? 'approved' : 'first'}`);
      if (a === 'Recheck') keys.push(`${r}:first`);
    }
    return keys.indexOf(`${p.rechecks ?? 0}:${p.approved ? 'approved' : 'first'}`);
  };
  return {
    propose(p) {
      const k = script[p.instance]?.path?.length ? index(p.instance, p) : 0;
      const d = script[p.instance]?.propose?.[k] ?? 'allow';
      return d === 'allow' ? { decision: 'allow' } : d === 'deny' ? { decision: 'deny', reason: 'scripted', witnessDigest: 'sha256:0' } : { decision: 'escalate', reason: 'scripted' };
    },
    settle(observed, p) {
      const sc = script[p.instance];
      const k = next(settles, p.instance);
      if (sc?.lapseAfter === 'SettleFailed' && k === sc.settle.length - 1) clockRef.clock.advance(WINDOW_MS + 1);
      return sc?.settle?.[k] ?? 'ok';
    },
  };
}

async function corpus(extra = {}, S = SCRIPT) {
  const a = await admitted('outbox', ['conformance/m4/outbox.poly', 'conformance/m4/outbox-keyed.poly']);
  const clockRef = {};
  const gate = scriptedGate(S, clockRef);
  const staleCalls = new Map();
  const isStale = (row) => { const k = staleCalls.get(row.instance_id) ?? 0; staleCalls.set(row.instance_id, k + 1); return S[row.instance_id]?.stale?.[k] ?? false; };
  const { rt, clock } = await loaded(a, { gate: { gate, escalationTimeoutMs: 10 * 60_000 }, worker: { leaseMs: 60_000, isStale }, ...extra });
  clockRef.clock = clock;
  // The window of an allow lapses just after it is recorded: the allow's own time is its start, so the clock moves once it is made.
  const allows = new Map();
  rt.intents('w.keyed').subscribe(({ instance }) => {
    const n = (allows.get(instance) ?? 0) + 1;
    allows.set(instance, n);
    const sc = S[instance];
    if (sc?.lapseAfter === 'GateAllow' && n === sc.propose.filter((x) => x === 'allow').length) clock.advance(WINDOW_MS + 1);
  });
  const calls = new Map();
  const hung = [];
  const work = (_payload, caps, ctx) => {
    const job = ctx.instanceId;
    const k = calls.get(job) ?? 0;
    calls.set(job, k + 1);
    const what = S[job]?.handler?.[k] ?? 'ok';
    assert.deepEqual(Object.keys(caps), ['exec'], 'S134: the exec label grants exec, bound to no command since none is declared');
    if (what === 'fail') {
      if (S[job]?.lapseAfter === 'HandlerFailed' && k === S[job].handler.length - 1) clock.advance(WINDOW_MS + 1);
      throw new Error('scripted failure');
    }
    if (what === 'permanent') throw Object.assign(new Error('card declined'), { permanent: true });
    if (what === 'hang') return new Promise((resolve) => hung.push(() => resolve(`${job}|late`)));
    return `${job}|${k}`;
  };
  handleWith(rt, 'w.work', work);
  handleWith(rt, 'w.keyed', work);
  for (const id of Object.keys(S)) { await rt.create(S[id].keyed ? 'outboxk.KeyedJob' : 'outbox.Job', { id }); await rt.dispatch(id, 'Go'); }
  // Each escalation is approved at once or left to time out, as its job's path says.
  const approvals = async () => {
    for (const id of Object.keys(S)) {
      const [row] = await rt.outbox(id);
      const st = await rt.worker.intentState(row);
      if (st?.intent !== 'Escalated' || st.intent_approved) continue;
      const k = (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.outcome === 'escalated').length - 1;
      if (S[id].approve[k]) await approveAs(rt, row.intent_id);
    }
  };
  const pass = async (ms) => { clock.advance(ms); await rt.worker.tick(); };
  const first = rt.worker.tick(); // the hung handler keeps this pass waiting; it is let go at the end
  await new Promise((r) => setTimeout(r, 50));
  for (let k = 1; k <= 40; k++) {
    await approvals();
    await pass(61_000);
    if (k % 10 === 0) await pass(11 * 60_000); // the unapproved escalations time out
    if (k === 20) { for (const release of hung) release(); await first; }
  }
  return { rt, clock, a };
}

test('the worker conforms: every intent\'s trace replays through OutboxIntent, and covers every state and transition', async () => {
  const main = await corpus();
  const runs = [{ rt: main.rt, S: SCRIPT }];
  const rt = main.rt;
  try {
    for (const id of Object.keys(LAPSE)) runs.push({ rt: (await corpus({}, { [id]: LAPSE[id] })).rt, S: { [id]: LAPSE[id] } });
    const c = { diagnostics: [], intents: 0, states: new Set(), edges: new Set() };
    for (const r of runs) {
      const x = await workerConformance(r.rt, WORKER_SOURCE);
      c.diagnostics.push(...x.diagnostics);
      c.intents += x.intents;
      x.states.forEach((v) => c.states.add(v));
      x.edges.forEach((v) => c.edges.add(v));
    }
    assert.deepEqual(c.diagnostics.map((d) => d.message), []);
    assert.equal(c.intents, Object.keys(SCRIPT).length + Object.keys(LAPSE).length);
    assert.ok(Object.keys(LAPSE).length >= 1, 'PT33.5a: the corpus has a keyed job that takes WindowLapsed');
    // Coverage, measured against poly-ref's graph of the bound-3 instance.
    const { ref, key } = REF;
    const states = new Set(ref.graph.states.map((s) => key(s)));
    const edges = new Set(ref.graph.edges.filter((e) => e.label.verdict.kind === 'accepted').map((e) => `${key(ref.graph.states[e.from])} -${e.label.action}->`));
    assert.equal(states.size, 59, 'S147: 17m + 8 at the bound 3');
    assert.deepEqual([...states].filter((s) => !c.states.has(s)), [], 'every state visited');
    assert.deepEqual([...edges].filter((e) => !c.edges.has(e)), [], 'every accepted transition taken');
    console.log(`# corpus: ${c.intents} intents, ${c.states.size} of ${states.size} states, ${c.edges.size} of ${edges.size} accepted transitions`);
    // The outcome each path asks for, as the program sees it: Worked on a completed intent, Gave otherwise.
    for (const r of runs) for (const [id, s] of Object.entries(r.S)) assert.equal((await r.rt.getState(id)).state.phase, s.end === 'SettleOk' ? 'Done' : 'Failed', `${id}: ${s.path.join(' ')}`);
    // PT33.5a: a lapsed window ends the intent Dead, with the exhausted completion and the observation `lapsed`.
    for (const r of runs) for (const [id, s] of Object.entries(r.S)) if (s.end === 'WindowLapsed') {
      assert.ok((await r.rt.getJournal(id)).some((x) => x.action === 'Gave' && x.action_id.endsWith(':exhausted')), `${id}: the exhausted completion`);
      assert.ok((await r.rt.chain(id)).some((e) => e.kind === 'observation' && e.body.outcome === 'lapsed'), `${id}: observed lapsed`);
    }
    // S138: a permanent error is never retried, and its intent ends with the failed completion.
    for (const [id, s] of Object.entries(SCRIPT)) if (s.end === 'HandlerFailedPermanent') assert.ok((await rt.getJournal(id)).some((r) => r.action === 'Gave' && r.action_id.endsWith(':failed')), id);
    // S147: a stale allow is rechecked, at most twice, and a third is denied with stale-allow.
    const stale = Object.entries(SCRIPT).filter(([, s]) => s.path.filter((x) => x === 'Recheck').length === 3);
    assert.ok(stale.length >= 1, 'a path denies a third stale allow');
    for (const [id] of stale) assert.ok((await rt.chain(id)).some((e) => e.kind === 'verdict' && e.body.outcome === 'denied' && e.body.reason === 'stale-allow'), id);
    // A stale worker (the hung handler's pass) took no transition after its claim was taken over.
    assert.deepEqual((await rt.audit()).filter((x) => x.rule === 'PL2401'), []);
  } finally { for (const r of runs) await r.rt.close(); }
});

test('every recorded gate decision replays from its proposal and snapshot (S118), and every run folds', async () => {
  const { rt } = await corpus();
  try {
    const runs = await replayRuntime(rt);
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
    const verdicts = (await Promise.all(Object.keys(SCRIPT).map((id) => rt.chain(id)))).flat().filter((e) => e.kind === 'verdict');
    assert.ok(verdicts.filter((e) => e.body.proposal).length >= 14, 'every proposal decided is recorded with its proposal and snapshot');
    assert.ok(verdicts.some((e) => e.body.outcome === 'approved' && e.body.by === PERSON.keyId && e.body.signed === true), 'the approval is recorded with its signer (PT12.5)');
  } finally { await rt.close(); }
});

test('polywatch: an expired Running intent whose manifest is gone is parked, not a crash', async () => {
  const a = await admitted('outbox-park', ['conformance/m4/outbox.poly']);
  const { rt, clock } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    let release;
    handleWith(rt, 'w.work', () => new Promise((r) => { release = r; }));
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    const pending = rt.worker.tick();
    await new Promise((r) => setTimeout(r, 50));
    const effects = rt.kernel.machines.get('outbox.Job').manifest.effects;
    const saved = effects['w.work'];
    delete effects['w.work'];
    clock.advance(61_000);
    await rt.worker.tick(); // must not throw
    const [row] = await rt.outbox('j');
    assert.equal(row.status, 'pending');
    assert.match(row.last_error ?? '', /parked/);
    effects['w.work'] = saved;
    release('late');
    await pending;
  } finally { await rt.close(); }
});
