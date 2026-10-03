import test from 'node:test';
import assert from 'node:assert/strict';
import createHost from './host.impl.ts';

test('basic flow', async () => {
  const h = await createHost();
  assert.deepEqual(await h.acquire('c0'), { ok: true });
  assert.equal((await h.acquire('c0')).ok, false);
  assert.equal((await h.acquire('x')).ok, false);
  assert.equal(await h.client('x'), null);
  await h.deliverAll();
  assert.deepEqual(await h.lease(), { holder: 'c0', token: 1, writes: 0 });
  assert.deepEqual(await h.client('c0'), { status: 'holding', token: 1, writing: false });
  await h.write('c0');
  assert.equal((await h.write('c0')).ok, false);
  await h.deliverAll();
  assert.equal((await h.lease()).writes, 1);
  await h.acquire('c1');
  await h.deliverAll();
  assert.equal((await h.client('c1'))!.status, 'idle');
  await h.release('c0');
  await h.deliverAll();
  assert.equal((await h.lease()).holder, null);
});

test('revoked before granted', async () => {
  const h = await createHost();
  await h.acquire('c1');
  const [acq] = await h.inFlight();
  await h.deliver(acq.id);
  await h.expire();
  const rev = (await h.inFlight()).find((m) => m.action === 'Revoked')!;
  await h.deliver(rev.id);
  await h.deliverAll();
  assert.deepEqual(await h.client('c1'), { status: 'idle', token: 1, writing: false });
  assert.equal((await h.lease()).holder, null);
});

test('stale write refused', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.write('c0');
  await h.expire();
  await h.acquire('c1');
  const ms = await h.inFlight();
  await h.deliver(ms.find((m) => m.action === 'Acquire')!.id);
  await h.deliver(ms.find((m) => m.action === 'Write')!.id);
  assert.equal((await h.lease()).writes, 0);
  await h.deliverAll();
  assert.equal((await h.lease()).holder, 'c1');
  assert.deepEqual(await h.client('c0'), { status: 'idle', token: 1, writing: false });
});
