import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHost from './host.impl.ts';

test('grant, write, release', async () => {
  const h = await createHost();
  assert.deepEqual(await h.acquire('c0'), { ok: true });
  assert.equal((await h.acquire('c2')).ok, false);
  assert.equal((await h.acquire('c0')).ok, false);
  await h.deliverAll();
  assert.deepEqual(await h.client('c0'), { status: 'holding', token: 1, writing: false });
  assert.deepEqual(await h.write('c0'), { ok: true });
  assert.equal((await h.write('c0')).ok, false);
  await h.deliverAll();
  assert.deepEqual(await h.lease(), { holder: 'c0', token: 1, writes: 1 });
  assert.deepEqual(await h.release('c0'), { ok: true });
  await h.deliverAll();
  assert.deepEqual(await h.lease(), { holder: null, token: 1, writes: 1 });
  assert.equal(await h.client('x'), null);
});

test('acknowledged release', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.expire();
  assert.deepEqual(await h.release('c0'), { ok: true });
  assert.equal((await h.client('c0'))!.status, 'releasing');
  assert.equal((await h.acquire('c0')).ok, false);
  assert.equal((await h.write('c0')).ok, false);
  const revoked = (await h.inFlight()).find((m) => m.action === 'Revoked')!;
  await h.deliver(revoked.id);
  assert.equal((await h.client('c0'))!.status, 'releasing');
  const rel = (await h.inFlight()).find((m) => m.action === 'Release')!;
  await h.deliver(rel.id);
  const ack = (await h.inFlight()).find((m) => m.action === 'Released')!;
  assert.deepEqual(ack.data, {});
  assert.equal(ack.to, 'c0');
  await h.deliver(ack.id);
  assert.equal((await h.client('c0'))!.status, 'idle');
  assert.deepEqual(await h.inFlight(), []);
});

test('cancelled request', async () => {
  const h = await createHost();
  assert.equal((await h.cancelAcquire('c0')).ok, false);
  assert.equal((await h.cancelAcquire('zz')).ok, false);
  await h.acquire('c0');
  assert.deepEqual(await h.cancelAcquire('c0'), { ok: true });
  assert.equal((await h.client('c0'))!.status, 'abandoning');
  assert.equal((await h.acquire('c0')).ok, false);
  assert.equal((await h.cancelAcquire('c0')).ok, false);
  await h.deliver((await h.inFlight())[0].id);
  await h.deliver((await h.inFlight())[0].id); // Granted
  assert.deepEqual(await h.client('c0'), { status: 'releasing', token: 1, writing: false });
  const [rel] = await h.inFlight();
  assert.equal(rel.action, 'Release');
  assert.deepEqual(rel.data, { from: 'c0', token: 1 });
  await h.deliverAll();
  assert.deepEqual(await h.client('c0'), { status: 'idle', token: 1, writing: false });
  assert.deepEqual(await h.lease(), { holder: null, token: 1, writes: 0 });

  await h.acquire('c1');
  await h.acquire('c0');
  await h.cancelAcquire('c0');
  await h.deliverAll();
  assert.equal((await h.client('c1'))!.status, 'holding');
  assert.equal((await h.client('c0'))!.status, 'idle');
});

test('one write per grant', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.write('c0');
  await h.deliverAll();
  assert.deepEqual(await h.write('c0'), { ok: true });
  const sent = (await h.inFlight()).length;
  assert.equal(sent, 1);
  await h.deliverAll();
  assert.deepEqual(await h.lease(), { holder: 'c0', token: 1, writes: 1 });
  assert.equal((await h.client('c0'))!.writing, false);
  await h.release('c0');
  await h.deliverAll();
  await h.acquire('c1');
  await h.deliverAll();
  await h.write('c1');
  await h.deliverAll();
  assert.deepEqual(await h.lease(), { holder: 'c1', token: 2, writes: 2 });
});

test('revoked before granted', async () => {
  const h = await createHost();
  await h.acquire('c0');
  const [acq] = await h.inFlight();
  await h.deliver(acq.id);
  assert.deepEqual(await h.expire(), { ok: true });
  const revoked = (await h.inFlight()).find((m) => m.action === 'Revoked')!;
  assert.deepEqual(revoked.data, { token: 1 });
  await h.deliver(revoked.id);
  await h.deliverAll();
  assert.deepEqual(await h.client('c0'), { status: 'idle', token: 1, writing: false });
  assert.equal((await h.expire()).ok, false);
});

test('stale writer is refused', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.write('c0');
  await h.expire();
  await h.acquire('c1');
  const acq = (await h.inFlight()).find((m) => m.action === 'Acquire')!;
  await h.deliver(acq.id);
  const w = (await h.inFlight()).find((m) => m.action === 'Write')!;
  await h.deliver(w.id);
  assert.deepEqual(await h.lease(), { holder: 'c1', token: 2, writes: 0 });
  await h.deliverAll();
  assert.equal((await h.client('c0'))!.status, 'idle');
  assert.equal((await h.client('c1'))!.status, 'holding');
  await h.acquire('c0');
  await h.deliverAll();
  assert.equal((await h.client('c0'))!.status, 'idle');
});

test('random schedules keep the invariants', async () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 3000; run++) {
    const h = await createHost();
    let lastWrites = 0;
    for (let step = 0; step < 40; step++) {
      const msgs = await h.inFlight();
      const k = rnd(7);
      if (k === 6) { await h.cancelAcquire(rnd(2) ? 'c0' : 'c1'); continue; }
      const c = rnd(2) ? 'c0' : 'c1';
      if (k === 0) await h.acquire(c);
      else if (k === 1) await h.release(c);
      else if (k === 2) await h.write(c);
      else if (k === 3 && rnd(3) === 0) await h.expire();
      else if (msgs.length) {
        const m = msgs[rnd(msgs.length)];
        const before = await h.lease();
        await h.deliver(m.id);
        const after = await h.lease();
        if (m.action === 'Write' && after.writes > before.writes) {
          assert.equal(m.data.from, before.holder);
          assert.equal(m.data.token, before.token);
        }
      }
      const l = await h.lease();
      assert.ok(l.writes >= lastWrites && l.writes <= 2);
      lastWrites = l.writes;
      const holdersCur = [];
      for (const id of ['c0', 'c1']) {
        const v = (await h.client(id))!;
        if (v.status === 'holding' && v.token === l.token) holdersCur.push(id);
      }
      assert.ok(holdersCur.length <= 1);
    }
    await h.deliverAll();
    const l = await h.lease();
    for (const id of ['c0', 'c1']) {
      const v = (await h.client(id))!;
      assert.equal(v.status === 'holding', l.holder === id, `run ${run}`);
      assert.notEqual(v.status, 'requesting');
      assert.notEqual(v.status, 'releasing');
      assert.notEqual(v.status, 'abandoning');
      assert.equal(v.writing, false);
    }
  }
});
