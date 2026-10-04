// AC6's second half (S118, S146): replaying the sessions a run touched, in sseq order, on a fresh gate engine,
// reproduces every gate decision and every Σ digest. A swapped sseq or an edited digest is PL9001; a missing sseq
// stops that session's replay, listed as not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer } from '@poly/runtime';
import { replaySessions } from '@poly/check';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

async function busy() {
  const a = await admitted('session-replay', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const { rt } = await loaded(a);
  handleWith(rt, 'stock.reserve', () => 'ok');
  const h = rt.handlerExports('src/handlers.ts');
  rt.handle('payment.charge', h.handle);
  rt.handle('payment.fee', h.handle);
  // Two runs share the scope's session, interleaved: a charge denied, a reserve, a fee denied, a charge allowed.
  for (const [id, action] of [['a', 'Charge'], ['b', 'Reserve'], ['c', 'Cancel'], ['d', 'Charge']]) {
    await rt.create('orders.Order', { id });
    await rt.dispatch(id, action);
    await rt.worker.tick();
  }
  return rt;
}

test('S118, S146: the scope\'s session replays in sseq order and reproduces every decision and Σ digest', { skip }, async () => {
  const rt = await busy();
  try {
    const sessions = await replaySessions(rt);
    assert.deepEqual(sessions.map((s) => s.session), ['scope:orders']);
    const [s] = sessions;
    assert.deepEqual(s.diagnostics.map((d) => d.message), []);
    assert.deepEqual(s.notRun, []);
    assert.ok(s.proposals >= 4 && s.settles >= 2, JSON.stringify(s));
  } finally { await rt.close(); }
});

test('S118: an edited Σ digest, or two sseq swapped, is PL9001; a missing sseq stops the session, not run', { skip }, async () => {
  const rt = await busy();
  try {
    const rows = rt.store.db.prepare("SELECT run, seq, event FROM poly_ledger WHERE kind = 'verdict'").all();
    const edit = (pred, change) => {
      const r = rows.find((x) => pred(JSON.parse(x.event).body));
      const e = JSON.parse(r.event);
      change(e.body);
      rt.store.db.prepare('UPDATE poly_ledger SET event = ? WHERE run = ? AND seq = ?').run(JSON.stringify(e), r.run, r.seq);
    };
    edit((b) => b.sseq === 2, (b) => { b.stateBefore = 'sha256:' + '0'.repeat(64); });
    let [s] = await replaySessions(rt);
    assert.ok(s.diagnostics.some((d) => d.code === 'PL9001' && /sseq 2/.test(d.message)), JSON.stringify(s.diagnostics.map((d) => d.message)));
    edit((b) => b.sseq === 3, (b) => { b.sseq = 99; });
    [s] = await replaySessions(rt);
    assert.ok(s.notRun.some((n) => /sseq 3 is missing/.test(n)), JSON.stringify(s.notRun));
  } finally { await rt.close(); }
});

test('AC6: poly journal replay prints each session replayed in sseq order', { skip }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { writeFileSync, rmSync } = await import('node:fs');
  const { ROOT } = await import('./helpers.mjs');
  const { load } = await import('@poly/runtime');
  const a = await admitted('session-replay-cli', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const db = join(a.dir, 'run.db');
  rmSync(db, { force: true }); rmSync(`${db}.gate.db`, { force: true });
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db } });
  handleWith(rt, 'stock.reserve', () => 'ok');
  rt.handle('payment.charge', rt.handlerExports('src/handlers.ts').handle);
  for (const [id, action] of [['a', 'Charge'], ['b', 'Reserve'], ['d', 'Charge']]) { await rt.create('orders.Order', { id }); await rt.dispatch(id, action); await rt.worker.tick(); }
  await rt.close();
  const adm = join(a.dir, 'admission.pub');
  writeFileSync(adm, a.key.publicKey);
  const r = spawnSync(process.execPath, [join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js'), 'journal', 'replay', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${adm}`], { encoding: 'utf8' });
  assert.match(r.stdout, /session scope:orders: 3 decision\(s\) and 2 settle\(s\) replayed in sseq order, every decision and Σ digest reproduced/, r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Review C1: a proposal the engine answers after the host's timeout is held, but the engine did decide. The session
// stays closed to other proposals until the answer lands, and the late answer is recorded with its own sseq, so Σ
// stays replayable and no decision rests on an unrecorded one.
test('PT9.5: a late answer is recorded with an sseq, and the session takes no proposal while it is outstanding', { skip }, async () => {
  const a = await admitted('late-answer', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  let slow = false;
  const wrap = (raw) => new Proxy(raw, {
    get(t, p) {
      if (p === '__raw') return t;
      if (p === 'merge') return async (args) => { const v = await t.merge(args); if (slow) { slow = false; await sleep(150); } return v; };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const { rt, clock } = await loaded(a, { gate: { policy: { wrap, proposeTimeoutMs: 50 } }, worker: { leaseMs: 60_000 } });
  try {
    handleWith(rt, 'stock.reserve', () => 'ok');
    rt.handle('payment.charge', rt.handlerExports('src/handlers.ts').handle);
    await rt.create('orders.Order', { id: 'A' });
    await rt.dispatch('A', 'Reserve');
    slow = true;
    await rt.worker.tick(); // timed out: held
    await rt.create('orders.Order', { id: 'B' });
    await rt.dispatch('B', 'Charge');
    clock.advance(1);
    await rt.worker.tick(); // A's answer is still outstanding, so B is held too
    const verdicts = async (id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict').map((e) => e.body);
    assert.deepEqual((await verdicts('B')).filter((b) => b.outcome === 'allowed'), []);
    await sleep(200); // the late answer lands
    const late = (await verdicts('A')).find((b) => b.outcome === 'late');
    assert.ok(late, JSON.stringify(await verdicts('A')));
    assert.deepEqual([late.sseq, late.engineDecision], [1, 'allow']);
    clock.advance(10 * 60_000);
    await rt.worker.tick();
    const [s] = await replaySessions(rt);
    assert.deepEqual(s.diagnostics.map((d) => d.message), []);
    assert.deepEqual(s.notRun, []);
  } finally { await rt.close(); }
});

// Review C4: a decision whose event was never written at the end of a session is a gap too, found against the
// session's counter; and a settle records Σ before and after it, which replay compares.
test('S146: a missing last sseq is listed as not run; settled events carry Σ before and after', { skip }, async () => {
  const a = await admitted('trailing-gap', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const { rt } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    handleWith(rt, 'stock.reserve', () => 'ok');
    rt.handle('payment.charge', rt.handlerExports('src/handlers.ts').handle);
    await rt.create('orders.Order', { id: 'r0' });
    await rt.dispatch('r0', 'Reserve');
    await rt.worker.tick(); // allowed, settled
    const settled = (await rt.chain('r0')).find((e) => e.kind === 'verdict' && e.body.outcome === 'settled').body;
    assert.match(settled.stateBefore, /^sha256:/);
    assert.match(settled.stateAfter, /^sha256:/);
    const append = rt.store.appendEvent.bind(rt.store);
    rt.store.appendEvent = (run, kind, body, at) => { if (kind === 'verdict' && body?.outcome === 'allowed') throw new Error('injected: the ledger cannot write'); return append(run, kind, body, at); };
    await rt.create('orders.Order', { id: 'r2' });
    await rt.dispatch('r2', 'Reserve');
    await rt.worker.tick().catch(() => {});
    const [s] = await replaySessions(rt);
    assert.equal(s.notRun.length, 1, JSON.stringify(s));
    assert.match(s.notRun[0], /sseq 3 .*no event/);
  } finally { await rt.close(); }
});
