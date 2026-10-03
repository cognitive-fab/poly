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

test('one write per grant', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.write('c0');
  await h.deliverAll();
  assert.deepEqual(await h.write('c0'), { ok: true });
  await h.deliverAll();
  assert.equal((await h.lease()).writes, 1);
  assert.equal((await h.client('c0'))!.writing, false);
  await h.release('c0');
  await h.deliverAll();
  await h.acquire('c1');
  await h.deliverAll();
  await h.write('c1');
  await h.deliverAll();
  assert.equal((await h.lease()).writes, 2);
});

test('acknowledged release', async () => {
  const h = await createHost();
  await h.acquire('c0');
  await h.deliverAll();
  await h.release('c0');
  assert.equal((await h.client('c0'))!.status, 'releasing');
  assert.equal((await h.acquire('c0')).ok, false);
  await h.expire();
  const ms = await h.inFlight();
  await h.deliver(ms.find((m) => m.action === 'Revoked')!.id);
  assert.equal((await h.client('c0'))!.status, 'releasing');
  await h.deliver(ms.find((m) => m.action === 'Release')!.id);
  assert.equal((await h.inFlight())[0].action, 'Released');
  await h.deliverAll();
  assert.equal((await h.client('c0'))!.status, 'idle');
  assert.equal((await h.lease()).holder, null);
});

test('cancel acquire', async () => {
  const h = await createHost();
  assert.equal((await h.cancelAcquire('c0')).ok, false);
  await h.acquire('c0');
  assert.deepEqual(await h.cancelAcquire('c0'), { ok: true });
  assert.equal((await h.client('c0'))!.status, 'abandoning');
  assert.equal((await h.acquire('c0')).ok, false);
  await h.deliver((await h.inFlight())[0].id);
  await h.deliver((await h.inFlight())[0].id); // Granted
  assert.deepEqual(await h.client('c0'), { status: 'releasing', token: 1, writing: false });
  const [rel] = await h.inFlight();
  assert.deepEqual(rel.data, { from: 'c0', token: 1 });
  await h.deliverAll();
  assert.equal((await h.client('c0'))!.status, 'idle');
  assert.equal((await h.lease()).holder, null);
  // denied while abandoning
  await h.acquire('c1');
  await h.deliverAll();
  await h.acquire('c0');
  await h.cancelAcquire('c0');
  await h.deliverAll();
  assert.equal((await h.client('c0'))!.status, 'idle');
  assert.equal((await h.lease()).holder, 'c1');
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
