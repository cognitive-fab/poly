// S402 (PS18.2, PT10r, PT10k, PT10l, S323, S310): a routed decision reads Content and Items. The desk of
// test/fixtures/routed-content classifies the message body itself through its route. Each tier's provider is given the
// decision's materials, `{ bodies, items }`, as an unrouted decision's provider is; each tier's call is proposed with
// the decision's taint, so a policy of the route's scope may deny a tier by effect.taint.class; and the question that is
// recorded holds digests only, so the canary scan of S310 finds the body nowhere but the content store. The body is
// given its taint, class customer owned by cust-a, as the memory check records one (test/memory-enforce.test.mjs).
// No test calls a model (S356).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk, answer, FIX as M11 } from './routing-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'routed-content');
const SRC = readFileSync(join(FIX, 'desk.poly'), 'utf8');
const policy = (f) => ({ [f]: readFileSync(join(FIX, f), 'utf8') });
const routeOf = (rt, id) => rt.store.db.prepare('SELECT instance FROM poly_route WHERE run = ?').get(id)?.instance;
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };

/** A tier provider that records the question and the materials it is given, and answers as recorded. */
function recording(branch, p) {
  const seen = [];
  const fn = (q, m) => { seen.push({ q, m }); return answer(branch, p); };
  return { fn, seen };
}

/**
 * Runs one ticket over a body holding a fresh canary, tainted class customer and owned by cust-a. The small tier answers
 * Refund at 0.96 (940 on its map, above the route's thresholds), the large one likewise.
 */
async function run(name, files = {}) {
  const canary = `canary-${randomBytes(12).toString('hex')}`;
  const a = await admittedDesk(name, SRC, files);
  assert.ok(a.certificate, `the desk reading a Content through its route is admitted: ${JSON.stringify(a.cert ?? null).slice(0, 2000)}`);
  const { rt } = await loaded(a);
  const small = recording('Refund', 0.96);
  const large = recording('Refund', 0.96);
  rt.provideTier('flash', small.fn);
  rt.provideTier('opus', large.fn);
  const body = await rt.putContent(`Where is my refund? ${canary}`);
  rt.store.db.exec('BEGIN'); rt.memory.taint(body, { c: 1, o: ['cust-a'] }); rt.store.db.exec('COMMIT');
  await rt.create('desk.Ticket', { id: 't-1' });
  await rt.dispatch('t-1', 'Received', { body });
  for (let i = 0; i < 8; i++) await rt.worker.tick();
  return { rt, a, canary, body, small, large };
}

test('S402: a routed classification over a message body gives the small tier the body as its materials and completes with its answer', { timeout: 300_000 }, async () => {
  const { rt, canary, small, large } = await run('routed-content-run');
  try {
    assert.equal(small.seen.length, 1, 'the small tier was asked once');
    assert.equal(large.seen.length, 0, 'the small tier answered above the thresholds, so the large one was not asked');
    const m = small.seen[0].m;
    assert.ok(m && typeof m === 'object', 'the tier provider receives the materials beside the question (PT10l)');
    assert.ok('bodies' in m && 'items' in m, `materials are { bodies, items }: ${JSON.stringify(m)}`);
    assert.ok(JSON.stringify(m.bodies).includes(canary), 'the bodies hold the message text');
    assert.equal((await rt.getState('t-1')).state.status, 'Routed', 'the decision completed with the answer (Classified)');
    const own = (await rt.chain('t-1')).filter((e) => e.kind === 'decision').map((e) => e.body);
    assert.deepEqual(own.map((d) => [d.tier, d.answer]), [['small', 'Refund']]);
  } finally { await rt.close(); }
});

test('S402: each tier call is proposed with the decision\'s taint, class customer', { timeout: 300_000 }, async () => {
  const { rt } = await run('routed-content-taint');
  try {
    const route = routeOf(rt, 't-1');
    assert.ok(route, 'the decision started its route');
    const verdicts = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'gate' && e.body.effectKind === 'route.triage.call' && e.body.outcome !== 'settled');
    assert.ok(verdicts.length >= 1, 'the small tier call crossed the gate');
    for (const v of verdicts) {
      const proposal = await rt.store.body(v.body.proposal);
      assert.equal(proposal?.taint?.class, 'customer', `the call's proposal carries the body's taint: ${JSON.stringify(proposal)}`);
      assert.ok(!JSON.stringify(proposal).includes('cust-a'), 'an owner is proposed by its keyed digest, never as itself');
    }
  } finally { await rt.close(); }
});

test('S402: a policy of the route\'s scope that denies effect.taint.class customer stops every tier, and the decision fails route-exhausted', { timeout: 300_000 }, async () => {
  const { rt, small, large } = await run('routed-content-deny', policy('taint.policy.poly'));
  try {
    assert.deepEqual([small.seen.length, large.seen.length], [0, 0], 'no provider was called');
    assert.equal((await rt.getState('t-1')).state.status, 'NeedsHuman', 'the failed completion, Unclassified, ran');
    const route = routeOf(rt, 't-1');
    assert.equal((await rt.getState(route)).state.r, 'Exhausted');
    const verdicts = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'gate' && e.body.effectKind === 'route.triage.call' && e.body.outcome !== 'settled');
    assert.deepEqual(verdicts.map((v) => v.body.outcome), ['denied', 'denied'], 'each tier was denied by the policy');
    const row = rt.store.db.prepare("SELECT last_error FROM pr_outbox WHERE instance_id = 't-1' AND kind = 'decision.classify'").get();
    assert.match(row.last_error, /route-exhausted/);
  } finally { await rt.close(); }
  // The control: a policy of the same scope that does not read the taint lets the small tier answer.
  const c = await run('routed-content-control', policy('tier.policy.poly'));
  try {
    assert.equal(c.small.seen.length, 1, 'the small tier was asked');
    assert.equal((await c.rt.getState('t-1')).state.status, 'Routed');
  } finally { await c.rt.close(); }
});

const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];
/** Every text the run left: each column of each row of each table but poly_content (or only it), and each file. */
function outputs(rt, dir, { content = false } = {}) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if ((name === 'poly_content') !== content) continue;
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push([`table ${name}`, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]);
  }
  if (content) return out;
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push([p, readFileSync(p, 'latin1')]); } };
  walk(dir);
  return out;
}
const found = (texts, token) => texts.flatMap(([where, t]) => (encodings(token).some((e) => t.includes(e)) ? [where] : []));

test('S402, S310: after a routed run over a body, no table but poly_content and no file of the build holds the canary', { timeout: 300_000 }, async () => {
  const { rt, a, canary, small } = await run('routed-content-canary');
  try {
    // The run did read the body, so the scan below is not empty for want of a run.
    assert.equal(small.seen.length, 1, 'the small tier was asked over the body');
    assert.deepEqual([...new Set(found(outputs(rt, a.dir, { content: true }), canary))], ['table poly_content']);
    assert.deepEqual(found(outputs(rt, a.dir), canary), [], 'the recorded question and every record hold digests only');
  } finally { await rt.close(); }
});

// PL6839 stays for what S402 does not allow: a routed decision that answers a Content, or cites.
const OUT = join(ROOT, '.poly', 'test-routed-content');
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(M11, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(M11, 'maps'), join(d, 'maps'), { recursive: true });
  writeFileSync(join(d, 'desk.poly'), src);
  return checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD });
}

test('S402: the desk reading a Content through its route is not refused PL6839; a Content result and cites still are', { timeout: 300_000 }, async () => {
  const ok = await check(SRC);
  assert.ok(!all(ok).some((d) => d.code === 'PL6839'), text(ok));
  let items = swap(SRC, '  action Received(body: Content)', '  action Received(body: Content, context: Items)');
  items = swap(items, '  on Received(body) {', '  on Received(body, context) {');
  items = swap(items, '    decide classify(body)', '    decide classify(body, context)');
  items = swap(items, '  decision classify(body: Content) -> Branch {', '  decision classify(body: Content, context: Items) -> Branch {');
  const cites = swap(items, '    route triage\n', '    route triage\n    cites context\n');
  let result = swap(SRC, '  action Classified(branch: Branch, conf: Conf, margin: Conf)', '  action Classified(branch: Content, conf: Conf, margin: Conf)');
  result = swap(result, '  decision classify(body: Content) -> Branch {', '  decision classify(body: Content) -> Content {');
  for (const [what, src, re] of [['cites', cites, /cites/], ['a Content result', result, /Content/]]) {
    const r = await check(src);
    assert.equal(r.verdict, 'REFUSED', `${what}: ${text(r)}`);
    assert.ok(all(r).some((d) => d.code === 'PL6839' && re.test(d.message)), `${what}: ${text(r)}`);
  }
});
