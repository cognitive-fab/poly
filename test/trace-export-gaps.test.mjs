// M7.1 open items 2 to 4 (PS19.5, PS19.6, PT29.2): a run that is erased whole, an archived run, and a gate that last said
// `denied` or `escalated`. Each is a synthetic fixture on a small program, written by the implementer; the auditor's
// report (docs/m7/export-audit.md) listed them as untested and could not build them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { polyaxionPeer } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted, approveAs, handleWith, loaded } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

const exportOf = (a, db, file) => {
  const pub = join(a.dir, 'admission.pub');
  writeFileSync(pub, a.key.publicKey);
  const r = poly('export', 'traces', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${pub}`, '--out', file);
  assert.equal(r.code, 0, r.out);
  const bytes = readFileSync(file, 'utf8');
  const [header, ...episodes] = bytes.trim().split('\n').map((l) => JSON.parse(l));
  return { header, episodes, bytes };
};
const effectsOf = (x) => x.episodes.flatMap((e) => e.steps.flatMap((s) => s.effects.map((f) => ({ ...f, run: e.machine }))));
const scratch = () => mkdtempSync(join(tmpdir(), 'poly-trace-gaps-'));
const clean = (tmp) => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store may stay locked a moment on Windows */ } };

test('PT29.2: a gate that last said denied is exported as denied, with its reason, beside an allowed one', { skip }, async () => {
  const a = await admitted('trace-gate-denied', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const tmp = scratch(); const db = join(tmp, 'store.db');
  try {
    const { rt } = await loaded(a, { store: { sqlite: db } });
    try {
      handleWith(rt, 'stock.reserve', () => 'ok');
      const h = rt.handlerExports('src/handlers.ts');
      rt.handle('payment.charge', h.handle);
      rt.handle('payment.fee', h.handle);
      await rt.create('orders.Order', { id: 'o1' });
      await rt.dispatch('o1', 'Charge');
      await rt.worker.tick();
      await rt.create('orders.Order', { id: 'c1' });
      await rt.dispatch('c1', 'Cancel');
      await rt.worker.tick();
      await rt.create('orders.Order', { id: 'r1' });
      await rt.dispatch('r1', 'Reserve');
      await rt.worker.tick();
      const denied = (await rt.chain('o1')).filter((e) => e.kind === 'verdict' && e.body.outcome === 'denied').length;
      assert.equal(denied, 1, 'the gate did deny the charge before any reserve');
    } finally { await rt.close(); }
    const x = exportOf(a, db, join(tmp, 'denied.ndjson'));
    const fx = effectsOf(x);
    const charge = fx.filter((f) => f.kind === 'payment.charge');
    assert.ok(charge.length >= 1, JSON.stringify(fx.map((f) => f.kind)));
    const deniedCharge = charge.filter((f) => f.gate?.outcome === 'denied');
    assert.ok(deniedCharge.length >= 1, JSON.stringify(charge));
    assert.match(deniedCharge[0].gate.reason, /charge-before-reserve/);
    const reserve = fx.filter((f) => f.kind === 'stock.reserve');
    assert.ok(reserve.length >= 1 && reserve.every((f) => f.gate?.outcome === 'allowed' && f.gate.reason !== undefined), JSON.stringify(reserve));
    const outcomes = new Set(fx.map((f) => f.gate?.outcome));
    assert.ok(outcomes.has('denied') && outcomes.has('allowed'), JSON.stringify([...outcomes]));
    assert.ok(!outcomes.has('settled'), 'a settlement is no gate decision');
  } finally { clean(tmp); }
});

test('PT29.2: a gate that last said escalated is exported as escalated, and as allowed once a person approved', { skip }, async () => {
  const a = await admitted('trace-gate-escalated', ['conformance/m5/switch.poly', 'conformance/m5/shop.poly', 'conformance/m5/shop-escalate.policy.poly']);
  const tmp = scratch(); const db = join(tmp, 'store.db');
  try {
    let intent;
    {
      const { rt } = await loaded(a, { store: { sqlite: db } });
      try {
        handleWith(rt, 'till.charge', () => 'ok');
        await rt.create('shop.Till', { id: 't' });
        await rt.dispatch('t', 'Charge');
        await rt.worker.tick();
        const rows = await rt.outbox('t');
        assert.equal(rows.length, 1);
        intent = rows[0].intent_id;
        assert.equal((await rt.worker.intentState(rows[0])).intent, 'Escalated');
      } finally { await rt.close(); }
    }
    const waiting = effectsOf(exportOf(a, db, join(tmp, 'escalated.ndjson'))).filter((f) => f.kind === 'till.charge');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].gate.outcome, 'escalated');
    assert.ok(waiting[0].gate.reason && waiting[0].gate.reason.length > 0);
    {
      const { rt } = await loaded(a, { store: { sqlite: db } });
      try {
        handleWith(rt, 'till.charge', () => 'ok');
        await approveAs(rt, intent);
        await rt.worker.tick();
      } finally { await rt.close(); }
    }
    const approved = effectsOf(exportOf(a, db, join(tmp, 'approved.ndjson'))).filter((f) => f.kind === 'till.charge');
    assert.equal(approved.length, 1);
    assert.equal(approved[0].gate.outcome, 'allowed', 'the last decision is the approval\'s');
  } finally { clean(tmp); }
});

test('PS19.6: an archived run is no episode and is counted exactly, and every run is accounted for', async () => {
  const a = await admitted('trace-archived', ['conformance/m1/effects.poly']);
  const tmp = scratch(); const db = join(tmp, 'store.db');
  try {
    const { rt } = await loaded(a, { store: { sqlite: db } });
    let runs;
    try {
      for (const k of ['billing.invoice', 'billing.perk', 'mail.receipt', 'mail.notice', 'mail.reminder']) handleWith(rt, k, () => ({ ok: true }));
      await rt.create('effects.Account', { id: 'old' });
      await rt.dispatch('old', 'Bill', { tier: 'Basic' });
      await rt.dispatch('old', 'Close', {});
      for (let k = 0; k < 12; k++) await rt.worker.tick();
      await rt.create('effects.Account', { id: 'live' });
      await rt.dispatch('live', 'Bill', { tier: 'Gold' });
      await rt.archive('old');
      assert.deepEqual((await rt.instances()).map((i) => i.id).filter((id) => !id.startsWith('intent:')).sort(), ['live'], 'the archived run is no longer an instance');
      runs = (await rt.runs()).length;
      assert.ok((await rt.runs()).some((r) => r.run === 'old'), 'its chain outlives the purge');
    } finally { await rt.close(); }
    const x = exportOf(a, db, join(tmp, 'archived.ndjson'));
    assert.equal(x.header.omitted.archivedRuns, 1);
    assert.equal(x.header.episodes, 1);
    assert.equal(x.episodes.length, 1);
    assert.ok(x.episodes[0].steps.some((s) => s.action === 'Bill' && s.data.tier === 'Gold'), 'the live run is the episode');
    assert.equal(x.header.episodes + x.header.omitted.archivedRuns + x.header.omitted.runtimeRuns + x.header.omitted.erasedRuns, runs);
  } finally { clean(tmp); }
});

test('PS19.5: a run all of whose steps after its creation row are erased is not exported and is counted in erasedRuns; the other run is whole', async () => {
  // The creation row names no body and is no step for this purpose (PS19.5, amended 2026-10-11). The body is erased through
  // the runtime, as a forget does; nothing in the store is altered.
  const a = await admitted('trace-erased-run', ['test/fixtures/trace-export/tiers.poly']);
  const tmp = scratch(); const db = join(tmp, 'store.db');
  try {
    const { rt } = await loaded(a, { store: { sqlite: db } });
    let digest; let runs;
    try {
      await rt.create('tiers.Rec', { id: 'whole' });
      await rt.dispatch('whole', 'Set', { n2: 1, w: 'a', m: 'Calm', f: false, p: 'someone', b: await rt.putContent('kept') });
      await rt.create('tiers.Rec', { id: 'doomed' });
      digest = await rt.putContent('doomed body');
      await rt.dispatch('doomed', 'Set', { n2: 2, w: 'b', m: 'Loud', f: true, p: 'someone-else', b: digest });
      await rt.dispatch('doomed', 'Set', { n2: 0, w: 'a', m: 'Calm', f: false, p: 'someone-else', b: digest });
      const rows = await rt.getJournal('doomed');
      const named = (r) => JSON.stringify([r.data, r.pre, r.post]).includes(digest);
      assert.equal(rows[0].action, '$create');
      assert.ok(!named(rows[0]), 'the creation row names no body, as the runtime writes it');
      assert.ok(rows.length >= 3 && rows.slice(1).every(named), 'every step after the creation row names the body');
      await rt.erase(digest);
      runs = (await rt.runs()).length;
    } finally { await rt.close(); }
    const x = exportOf(a, db, join(tmp, 'erased.ndjson'));
    assert.equal(x.header.omitted.erasedRuns, 1);
    assert.equal(x.header.omitted.erasedSteps, 2);
    assert.equal(x.header.omitted.gappedRuns, 0);
    assert.equal(x.header.episodes, 1);
    assert.equal(x.episodes.length, 1);
    assert.equal(x.episodes[0].gapped, false);
    assert.ok(x.episodes[0].steps.some((s) => s.data.n2 === 1), 'the other run is whole');
    assert.ok(!x.bytes.includes(digest) && !x.bytes.includes(digest.replace('sha256:', '')));
    assert.equal(x.header.episodes + x.header.omitted.erasedRuns + x.header.omitted.runtimeRuns + x.header.omitted.archivedRuns, runs);
  } finally { clean(tmp); }
});

test('PS19.5: a run with only its creation row is not erased: it is exported', async () => {
  const a = await admitted('trace-created-only', ['test/fixtures/trace-export/tiers.poly']);
  const tmp = scratch(); const db = join(tmp, 'store.db');
  try {
    const { rt } = await loaded(a, { store: { sqlite: db } });
    try { await rt.create('tiers.Rec', { id: 'fresh' }); await rt.erase(await rt.putContent('unrelated')); } finally { await rt.close(); }
    const x = exportOf(a, db, join(tmp, 'fresh.ndjson'));
    assert.equal(x.header.omitted.erasedRuns, 0);
    assert.equal(x.header.episodes, 1);
    assert.deepEqual(x.episodes[0].steps.map((s) => s.action), ['$create']);
  } finally { clean(tmp); }
});
