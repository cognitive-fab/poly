// AC1, the OMS order (plan step 7, S24, S27): the two corpora, the hand-written controls, and the poly OMS
// compared with them: replay on both corpora, check-effects, the mappers step by step, and check-product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadWindows, replaySpecResults } from '@cognitive-fab/polygraph/scripts/replay.mjs';
import { loadSpec } from '@cognitive-fab/polygraph/scripts/load-spec.mjs';
import { checkEffects } from '@cognitive-fab/polygraph/polyrun/src/check-effects.mjs';
import { checkProduct } from '@cognitive-fab/polygraph/polyrun/src/check-product.mjs';
import { checkFile, render } from '@poly/check';
import { ROOT, build } from './helpers.mjs';
import { record } from '../scripts/record-oms-corpus.mjs';

const HAND = join(ROOT, 'conformance', 'field-studies', 'order');
const KERNEL = join(ROOT, 'conformance', 'field-studies', 'order-kernel');

const statuses = (spec, windows) => {
  const r = replaySpecResults(spec, windows);
  assert.ok(r.ok, r.error);
  return r.results.map((x) => x.status);
};
const pass = (xs) => xs.filter((x) => x === 'pass').length;

test('S24 (a): the copied corpus has 81 windows that never leave pending, and the hand-written order passes 53', () => {
  const windows = loadWindows(join(HAND, 'machines', 'order', 'traces'));
  assert.equal(windows.length, 81);
  assert.ok(windows.every((w) => JSON.stringify(w.pre) === JSON.stringify(w.post)));
  assert.equal(pass(statuses(join(HAND, 'machines', 'order', 'next.cjs'), windows)), 53);
});

test('S24 (b): the kernel-recorded corpus matches its PROVENANCE.md and the hand-written order passes all of it', () => {
  const text = readFileSync(join(KERNEL, 'PROVENANCE.md'), 'utf8');
  const rows = [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)];
  assert.equal(rows.length, 16);
  for (const [, f, h] of rows) assert.equal(createHash('sha256').update(readFileSync(join(KERNEL, f))).digest('hex'), h, f);
  const windows = loadWindows(join(KERNEL, 'traces'));
  assert.equal(windows.length, 58);
  assert.equal(pass(statuses(join(HAND, 'machines', 'order', 'next.cjs'), windows)), 58);
});

test('S24 (b): the recording script gives the same bytes on every run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-oms-'));
  try {
    const files = await record(dir);
    for (const f of files) assert.ok(readFileSync(join(dir, f)).equals(readFileSync(join(KERNEL, f))), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC1: the poly OMS against the hand-written artefacts ────────────────────

const OMS = join(ROOT, 'examples', 'oms', 'oms.poly');
const lowered = () => {
  const [ship, order] = build(OMS, 'oms');
  return { ship, order };
};

test('AC1 (a): the poly order replays the copied corpus window for window like the hand-written one, 53 of 81', () => {
  const windows = loadWindows(join(HAND, 'machines', 'order', 'traces'));
  const hand = statuses(join(HAND, 'machines', 'order', 'next.cjs'), windows);
  const poly = statuses(join(lowered().order.dir, 'next.cjs'), windows);
  const differ = windows.map((w, i) => (hand[i] !== poly[i] ? `${w.scenario}#${w.index} ${w.action}: hand ${hand[i]}, poly ${poly[i]}` : null)).filter(Boolean);
  assert.deepEqual(differ, []);
  assert.equal(pass(poly), 53);
});

test('AC1 (b): the poly order replays the kernel-recorded corpus at 100%, 58 of 58', () => {
  const windows = loadWindows(join(KERNEL, 'traces'));
  assert.equal(pass(statuses(join(lowered().order.dir, 'next.cjs'), windows)), 58);
});

test('AC1: check-effects gives the same result on both orders, over the same effect invariants', async () => {
  const { order } = lowered();
  const invariants = join(HAND, 'effect-invariants.mjs');
  const hand = await checkEffects({ module: join(HAND, 'machines', 'order', 'next.cjs'), mapper: join(HAND, 'effects.cjs'), manifest: join(HAND, 'effects.manifest.json'), invariants, contract: join(HAND, 'machines', 'order-contract.json') });
  const poly = await checkEffects({ module: join(order.dir, 'next.cjs'), mapper: join(order.dir, 'effects.cjs'), manifest: join(order.dir, 'effects.manifest.json'), invariants, contract: join(order.dir, 'contract.json') });
  const summary = (r) => ({ paths: r.pathsExplored, states: r.statesSeen, cycles: r.cyclesPruned, bounded: r.bounded, violations: r.violations.map((v) => [v.invariant, v.counterexample.join(' ')]) });
  assert.deepEqual(summary(poly), summary(hand));
  assert.deepEqual(summary(hand), { paths: 45, states: 33, cycles: 0, bounded: false, violations: [] });
});

/**
 * The intents of the two mappers, step by step along every simple path of the hand-written order, as
 * check-effects walks them. Normalised only as the rulings allow: machine ids mapped (S28), a timer's
 * delay read as milliseconds, and a cancelTimer ignored only for a key not armed on the path (S26). A
 * fired timer disarms its key: a step whose action is an armed timer's action is that timer firing.
 */
function compareMappers(handDir, polyDir) {
  const req = createRequire(import.meta.url);
  const { makeSamAdapter, domainFromManifest } = req('@cognitive-fab/polygraph/scripts/sam-adapter.cjs');
  const hand = loadSpec(join(handDir, 'machines', 'order', 'next.cjs'));
  const adapter = makeSamAdapter(hand);
  const steps = domainFromManifest(hand).steps;
  const handMap = loadSpec(join(handDir, 'effects.cjs')).effects;
  const polyMap = loadSpec(join(polyDir, 'effects.cjs')).effects;
  const ids = { 'oms.Shipment': 'shipment' };
  const ms = (t) => (typeof t.fireInMs === 'number' ? t.fireInMs : Number(/^PT(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(t.fireIn).slice(1).reduce((a, x, i) => a + (x ? Number(x) * (i === 0 ? 60_000 : 1000) : 0), 0)));
  const norm = (x) => {
    if (x.kind === 'timer') return { kind: 'timer', key: x.key, ms: ms(x), action: x.action, data: x.data ?? {} };
    if (x.kind === 'spawnChild') return { ...x, machineId: ids[x.machineId] ?? x.machineId };
    return x;
  };
  const differences = [];
  let compared = 0;
  const walk = (state, seen, armed, trail) => {
    if (trail.length >= 12) return;
    for (const st of steps) {
      const r = adapter.step(state, st.action, st.data);
      if (r.verdict !== 'accepted' || JSON.stringify(r.state) === JSON.stringify(state)) continue;
      const fired = new Map([...armed].filter(([, a]) => a !== st.action));
      const h = (handMap(state, st.action, st.data, r.state, 'accepted') ?? []).map(norm);
      const p = (polyMap(state, st.action, st.data, r.state, 'accepted') ?? []).map(norm)
        .filter((x) => !(x.kind === 'cancelTimer' && !fired.has(x.key)));
      compared++;
      if (JSON.stringify(h) !== JSON.stringify(p)) differences.push(`${[...trail, st.action].join(' ')}: hand ${JSON.stringify(h)}, poly ${JSON.stringify(p)}`);
      const key = JSON.stringify(r.state);
      if (seen.has(key)) continue;
      const next = new Map(fired);
      for (const x of h) if (x.kind === 'timer') next.set(x.key, x.action);
      walk(r.state, new Set([...seen, key]), next, [...trail, `${st.action}(${JSON.stringify(st.data)})`]);
    }
  };
  const init = adapter.init();
  walk(init, new Set([JSON.stringify(init)]), new Map(), []);
  return { differences, compared };
}

test('AC1: the two mappers emit the same intents on every step, cancelTimer read as S26 rules', () => {
  const { differences, compared } = compareMappers(HAND, lowered().order.dir);
  assert.deepEqual(differences, []);
  assert.ok(compared > 40, `${compared} steps compared`);
});

test('AC1: check-product gives the same result on both, each over its own statement of the S27 invariants', async () => {
  const { ship, order } = lowered();
  const hand = await checkProduct({
    parent: { machineId: 'order', module: join(HAND, 'machines', 'order', 'next.cjs'), contract: join(HAND, 'machines', 'order-contract.json'), mapper: join(HAND, 'effects.cjs'), manifest: join(HAND, 'effects.manifest.json') },
    children: [{ machineId: 'shipment', module: join(HAND, 'machines', 'shipment', 'next.cjs'), contract: join(HAND, 'machines', 'shipment', 'authoring-contract.json') }],
    invariants: join(ROOT, 'conformance', 'oms', 'invariants.compose.mjs'),
  });
  const poly = await checkProduct({
    parent: { machineId: 'oms.Order', module: join(order.dir, 'next.cjs'), contract: join(order.dir, 'contract.json'), mapper: join(order.dir, 'effects.cjs'), manifest: join(order.dir, 'effects.manifest.json') },
    children: [{ machineId: 'oms.Shipment', module: join(ship.dir, 'next.cjs'), contract: join(ship.dir, 'contract.json') }],
    invariants: join(order.dir, 'invariants.compose.mjs'),
  });
  const summary = (r) => ({ ok: r.ok, states: r.statesExplored, capHit: r.capHit, violations: r.violations.map((v) => v.invariant) });
  assert.deepEqual(summary(poly), summary(hand));
  assert.deepEqual(summary(hand), { ok: true, states: 45, capHit: false, violations: [] });
});

test('AC1: poly check on the OMS is clean, and its joint state count agrees with check-product', async () => {
  const r = await checkFile(OMS, { root: join(ROOT, '.poly', 'test-build', 'oms-check') });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.equal(order.instance.jointStates, 45);
});
