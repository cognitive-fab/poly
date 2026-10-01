// T10 v2: a lease with fencing tokens, one write per grant, acknowledged releases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

const C0 = 'c0';
const C1 = 'c1';
const SVC = 'lease';
const CLIENTS = [C0, C1];

// ---------- helpers ----------

function matches(m, q) {
  if (q.from !== undefined && m.from !== q.from) return false;
  if (q.to !== undefined && m.to !== q.to) return false;
  if (q.action !== undefined && m.action !== q.action) return false;
  if (q.data) {
    for (const k of Object.keys(q.data)) {
      if (!m.data || m.data[k] !== q.data[k]) return false;
    }
  }
  return true;
}

async function findMsgs(h, q) {
  const all = await h.inFlight();
  return all.filter((m) => matches(m, q));
}

async function oneMsg(h, q) {
  const found = await findMsgs(h, q);
  assert.equal(found.length, 1, `expected exactly one message matching ${JSON.stringify(q)}`);
  return found[0];
}

async function deliverOne(h, q) {
  const m = await oneMsg(h, q);
  await h.deliver(m.id);
}

async function countMsgs(h, q) {
  return (await findMsgs(h, q)).length;
}

async function ok(p) {
  const r = await p;
  assert.equal(r.ok, true);
}

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

async function snap(h) {
  const l = await h.lease();
  const out = { holder: l.holder, token: l.token, writes: l.writes };
  for (const c of CLIENTS) {
    const v = await h.client(c);
    out[c] = { status: v.status, token: v.token, writing: v.writing };
  }
  const msgs = (await h.inFlight()).map((m) => canon([m.id, m.from, m.to, m.action, m.data])).sort();
  out.msgs = msgs;
  return out;
}

async function refusedNoChange(h, fn) {
  const before = await snap(h);
  const r = await fn();
  assert.equal(r.ok, false);
  assert.deepEqual(await snap(h), before);
}

async function drain(h) {
  await h.deliverAll();
  assert.equal((await h.inFlight()).length, 0);
}

async function expectClient(h, c, exp) {
  const v = await h.client(c);
  assert.notEqual(v, null);
  if ('status' in exp) assert.equal(v.status, exp.status);
  if ('token' in exp) assert.equal(v.token, exp.token);
  if ('writing' in exp) assert.equal(v.writing, exp.writing);
}

async function expectLease(h, exp) {
  const l = await h.lease();
  if ('holder' in exp) assert.equal(l.holder, exp.holder);
  if ('token' in exp) assert.equal(l.token, exp.token);
  if ('writes' in exp) assert.equal(l.writes, exp.writes);
}

// acquire and deliver the request and the grant
async function grant(h, c) {
  await ok(h.acquire(c));
  await deliverOne(h, { from: c, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: SVC, to: c, action: 'Granted' });
  await expectClient(h, c, { status: 'holding' });
}

// write and deliver the write and its answer
async function writeRound(h, c) {
  await ok(h.write(c));
  await deliverOne(h, { from: c, to: SVC, action: 'Write' });
  const ans = await findMsgs(h, { from: SVC, to: c });
  const a = ans.filter((m) => m.action === 'WriteDone' || m.action === 'WriteRefused');
  assert.equal(a.length, 1);
  await h.deliver(a[0].id);
  return a[0].action;
}

// release, deliver the release and its acknowledgement
async function releaseRound(h, c) {
  await ok(h.release(c));
  await deliverOne(h, { from: c, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: c, action: 'Released' });
  await expectClient(h, c, { status: 'idle' });
}

async function checkSafety(h) {
  const l = await h.lease();
  let n = 0;
  for (const c of CLIENTS) {
    const v = await h.client(c);
    if (v.status === 'holding' && v.token === l.token) n++;
  }
  assert.ok(n <= 1, 'at most one client holds the lease with the current token');
  assert.ok(l.writes <= 2, 'at most 2 writes in all');
  assert.ok(l.token <= 2, 'at most 2 grants');
}

async function checkSettled(h) {
  assert.equal((await h.inFlight()).length, 0);
  const l = await h.lease();
  for (const c of CLIENTS) {
    const v = await h.client(c);
    assert.equal(v.status === 'holding', l.holder === c, `client ${c} holds exactly when the service says so`);
  }
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMANDS = ['acquire', 'release', 'write', 'expire'];

async function explore(h, seed, steps) {
  const r = rng(seed);
  const written = new Set();
  for (let i = 0; i < steps; i++) {
    const inf = await h.inFlight();
    if (inf.length && r() < 0.5) {
      const m = inf[Math.floor(r() * inf.length)];
      const before = await h.lease();
      await h.deliver(m.id);
      const after = await h.lease();
      if (after.writes !== before.writes) {
        assert.equal(after.writes, before.writes + 1);
        assert.equal(m.action, 'Write');
        assert.equal(m.data.from, before.holder, 'write taken only from the holder');
        assert.equal(m.data.token, before.token, 'write taken only with the current token');
        assert.ok(!written.has(before.token), 'at most one write per grant');
        written.add(before.token);
      }
      assert.ok(after.writes <= after.token, 'no more writes than grants');
    } else {
      const c = r() < 0.5 ? C0 : C1;
      const k = COMMANDS[Math.floor(r() * COMMANDS.length)];
      if (k === 'expire') await h.expire();
      else await h[k](c);
    }
    await checkSafety(h);
    if ((await h.inFlight()).length === 0) await checkSettled(h);
  }
  // deliver everything one at a time, still checking writes
  for (;;) {
    const inf = await h.inFlight();
    if (!inf.length) break;
    const m = inf[Math.floor(r() * inf.length)];
    const before = await h.lease();
    await h.deliver(m.id);
    const after = await h.lease();
    if (after.writes !== before.writes) {
      assert.equal(m.action, 'Write');
      assert.equal(m.data.from, before.holder);
      assert.equal(m.data.token, before.token);
      assert.ok(!written.has(before.token), 'at most one write per grant');
      written.add(before.token);
    }
    await checkSafety(h);
  }
  await checkSettled(h);
}

// ---------- initial state and queries ----------

test('initial lease has no holder, token 0 and no writes', async () => {
  const h = await createHost();
  await expectLease(h, { holder: null, token: 0, writes: 0 });
});

test('initial clients are idle with token 0 and not writing', async () => {
  const h = await createHost();
  for (const c of CLIENTS) await expectClient(h, c, { status: 'idle', token: 0, writing: false });
});

test('client query returns null for an unknown id', async () => {
  const h = await createHost();
  assert.equal(await h.client('c2'), null);
  assert.equal(await h.client('lease'), null);
  assert.equal(await h.client(''), null);
});

test('no message is in flight initially', async () => {
  const h = await createHost();
  assert.equal((await h.inFlight()).length, 0);
});

// ---------- unknown clients ----------

test('acquire for an unknown client is refused and changes nothing', async () => {
  const h = await createHost();
  await refusedNoChange(h, () => h.acquire('c2'));
  await refusedNoChange(h, () => h.acquire('lease'));
});

test('release for an unknown client is refused and changes nothing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await refusedNoChange(h, () => h.release('c2'));
});

test('write for an unknown client is refused and changes nothing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await refusedNoChange(h, () => h.write('c2'));
});

// ---------- acquire ----------

test('acquire by an idle client takes effect and makes it requesting', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await expectClient(h, C0, { status: 'requesting', token: 0, writing: false });
});

test('acquire sends Acquire from the client to the service with its id', async () => {
  const h = await createHost();
  await ok(h.acquire(C1));
  const m = await oneMsg(h, { from: C1, to: SVC, action: 'Acquire' });
  assert.equal(m.data.from, C1);
});

test('acquire does not change the lease before the request is delivered', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await expectLease(h, { holder: null, token: 0, writes: 0 });
});

test('acquire does not change the other client', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await expectClient(h, C1, { status: 'idle', token: 0, writing: false });
});

test('acquire while requesting is refused and changes nothing', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await refusedNoChange(h, () => h.acquire(C0));
});

test('acquire while holding is refused and changes nothing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await refusedNoChange(h, () => h.acquire(C0));
});

test('both clients can request at the same time', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await ok(h.acquire(C1));
  await expectClient(h, C0, { status: 'requesting' });
  await expectClient(h, C1, { status: 'requesting' });
  assert.equal(await countMsgs(h, { to: SVC, action: 'Acquire' }), 2);
});

// ---------- the service on a request ----------

test('a request to a free service grants token 1 to the requester', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await expectLease(h, { holder: C0, token: 1, writes: 0 });
});

test('the service answers a granted request with Granted carrying the token', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  const m = await oneMsg(h, { from: SVC, to: C0, action: 'Granted' });
  assert.equal(m.data.token, 1);
});

test('a client stays requesting until Granted is delivered', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await expectClient(h, C0, { status: 'requesting', token: 0 });
});

test('on Granted a requesting client holds the lease with the given token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await expectClient(h, C0, { status: 'holding', token: 1, writing: false });
  await expectLease(h, { holder: C0, token: 1, writes: 0 });
});

test('a request while the lease is held is answered Denied', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await oneMsg(h, { from: SVC, to: C1, action: 'Denied' });
  assert.equal(await countMsgs(h, { to: C1, action: 'Granted' }), 0);
});

test('a denied request does not change the lease', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await expectLease(h, { holder: C0, token: 1, writes: 0 });
});

test('on Denied the requesting client becomes idle with its token unchanged', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: SVC, to: C1, action: 'Denied' });
  await expectClient(h, C1, { status: 'idle', token: 0, writing: false });
  await expectClient(h, C0, { status: 'holding', token: 1 });
});

test('a denied client may acquire again', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: SVC, to: C1, action: 'Denied' });
  await ok(h.acquire(C1));
  await expectClient(h, C1, { status: 'requesting' });
});

test('the second grant carries token 2', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  const m = await oneMsg(h, { from: SVC, to: C1, action: 'Granted' });
  assert.equal(m.data.token, 2);
  await h.deliver(m.id);
  await expectClient(h, C1, { status: 'holding', token: 2 });
  await expectLease(h, { holder: C1, token: 2 });
});

test('the same client can be granted twice, getting token 2', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C0);
  await expectClient(h, C0, { status: 'holding', token: 2 });
  await expectLease(h, { holder: C0, token: 2 });
});

test('a third request is denied even when no client holds the lease', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C1);
  await releaseRound(h, C1);
  await expectLease(h, { holder: null, token: 2 });
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await oneMsg(h, { from: SVC, to: C0, action: 'Denied' });
  assert.equal(await countMsgs(h, { action: 'Granted' }), 0);
  await expectLease(h, { holder: null, token: 2 });
});

test('after two grants a request is denied and the client ends idle', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C0);
  await releaseRound(h, C0);
  await ok(h.acquire(C1));
  await drain(h);
  await expectClient(h, C1, { status: 'idle', token: 0 });
  await expectLease(h, { holder: null, token: 2 });
});

test('a third request is denied after an expiry too', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await grant(h, C1);
  await ok(h.expire());
  await drain(h);
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await oneMsg(h, { from: SVC, to: C0, action: 'Denied' });
  await expectLease(h, { holder: null, token: 2 });
});

test('concurrent requests: the first delivered is granted and the other denied', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  const g = await oneMsg(h, { from: SVC, to: C1, action: 'Granted' });
  assert.equal(g.data.token, 1);
  await oneMsg(h, { from: SVC, to: C0, action: 'Denied' });
  await expectLease(h, { holder: C1, token: 1 });
});

test('concurrent requests settle with exactly the granted client holding', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await drain(h);
  await expectClient(h, C0, { status: 'holding', token: 1 });
  await expectClient(h, C1, { status: 'idle', token: 0 });
  await checkSettled(h);
});

// ---------- release ----------

test('release by an idle client is refused and changes nothing', async () => {
  const h = await createHost();
  await refusedNoChange(h, () => h.release(C0));
});

test('release by a requesting client is refused and changes nothing', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await refusedNoChange(h, () => h.release(C0));
});

test('release by a client whose grant is still in flight is refused', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await refusedNoChange(h, () => h.release(C0));
});

test('release by the client not holding the lease is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await refusedNoChange(h, () => h.release(C1));
});

test('release by the holder makes it releasing, not idle', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await expectClient(h, C0, { status: 'releasing', token: 1, writing: false });
});

test('a releasing client stays releasing after its Release is delivered until Released arrives', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await expectClient(h, C0, { status: 'releasing', token: 1 });
});

test('the service answers a taken release with Released', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  assert.equal(await countMsgs(h, { action: 'Released' }), 0);
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await oneMsg(h, { from: SVC, to: C0, action: 'Released' });
  await expectLease(h, { holder: null, token: 1 });
});

test('the service answers an ignored release with Released too', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await oneMsg(h, { from: SVC, to: C0, action: 'Released' });
  await expectLease(h, { holder: null, token: 1 });
});

test('a stale release ignored while the other client holds is still answered Released', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await grant(h, C1);
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await oneMsg(h, { from: SVC, to: C0, action: 'Released' });
  await expectLease(h, { holder: C1, token: 2 });
});

test('on Released a releasing client becomes idle', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Released' });
  await expectClient(h, C0, { status: 'idle', token: 1, writing: false });
  await checkSettled(h);
});

test('acquire while releasing is refused and changes nothing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await refusedNoChange(h, () => h.acquire(C0));
});

test('acquire while releasing is refused even after the Release is delivered', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await refusedNoChange(h, () => h.acquire(C0));
});

test('acquire after Released takes effect', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await ok(h.acquire(C0));
  await expectClient(h, C0, { status: 'requesting' });
});

test('write while releasing is refused and changes nothing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await refusedNoChange(h, () => h.write(C0));
});

test('a releasing client ignores Revoked', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'releasing', token: 1 });
});

test('a releasing client that ignored Revoked becomes idle on Released', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Released' });
  await expectClient(h, C0, { status: 'idle' });
  await checkSettled(h);
});

test('a write answer arriving while releasing clears writing and keeps releasing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.release(C0));
  await expectClient(h, C0, { status: 'releasing', writing: true });
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await deliverOne(h, { from: SVC, to: C0, action: 'WriteDone' });
  await expectClient(h, C0, { status: 'releasing', writing: false });
});

test('a release that is ignored still ends with nobody holding once settled', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await drain(h);
  await expectClient(h, C0, { status: 'idle' });
  await checkSettled(h);
});

test('release sends Release with the client id and its token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  const m = await oneMsg(h, { from: C0, to: SVC, action: 'Release' });
  assert.equal(m.data.from, C0);
  assert.equal(m.data.token, 1);
});

test('the service keeps its holder until the Release is delivered', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await expectLease(h, { holder: C0, token: 1 });
});

test('a Release from the holder with the current token frees the lease', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await expectLease(h, { holder: null, token: 1, writes: 0 });
});

test('release twice: the second release is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await refusedNoChange(h, () => h.release(C0));
});

test('a stale Release from a former holder is ignored while the other client holds', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0)); // c0 still holds in its own view
  await grant(h, C1);
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await expectLease(h, { holder: C1, token: 2 });
  await drain(h);
  await expectLease(h, { holder: C1, token: 2 });
  await expectClient(h, C1, { status: 'holding', token: 2 });
});

test('a Release after an expiry is ignored and leaves no holder', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await expectLease(h, { holder: null, token: 1 });
  await drain(h);
  await checkSettled(h);
});

test('after a release is acknowledged, the other client can be granted', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C1);
  await expectLease(h, { holder: C1, token: 2 });
  await expectClient(h, C0, { status: 'idle', token: 1 });
});

test('a request delivered before the Release is denied', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await oneMsg(h, { from: SVC, to: C1, action: 'Denied' });
  await drain(h);
  await expectLease(h, { holder: null, token: 1 });
  await expectClient(h, C1, { status: 'idle' });
  await checkSettled(h);
});

test('a request delivered after the Release is granted', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await ok(h.acquire(C1));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
  await oneMsg(h, { from: SVC, to: C1, action: 'Granted', data: { token: 2 } });
  await drain(h);
  await expectClient(h, C1, { status: 'holding', token: 2 });
  await checkSettled(h);
});

// ---------- write ----------

test('write by an idle client is refused and changes nothing', async () => {
  const h = await createHost();
  await refusedNoChange(h, () => h.write(C0));
});

test('write by a requesting client is refused and changes nothing', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await refusedNoChange(h, () => h.write(C0));
});

test('write by the client not holding the lease is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await refusedNoChange(h, () => h.write(C1));
});

test('write by a client that released is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.release(C0));
  await refusedNoChange(h, () => h.write(C0));
});

test('write by the holder takes effect and marks the client writing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await expectClient(h, C0, { status: 'holding', token: 1, writing: true });
});

test('write sends Write with the client id and its token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  const m = await oneMsg(h, { from: C0, to: SVC, action: 'Write' });
  assert.equal(m.data.from, C0);
  assert.equal(m.data.token, 1);
});

test('a write is not counted before it is delivered', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await expectLease(h, { writes: 0 });
});

test('write while a write waits for an answer is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await refusedNoChange(h, () => h.write(C0));
});

test('write is still refused after the Write is delivered but before the answer', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await refusedNoChange(h, () => h.write(C0));
});

test('the service takes a write from the holder with the current token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await expectLease(h, { holder: C0, token: 1, writes: 1 });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteDone' });
  assert.equal(await countMsgs(h, { action: 'WriteRefused' }), 0);
});

test('the client stays writing until the answer is delivered', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await expectClient(h, C0, { writing: true });
});

test('on WriteDone the client is no longer writing and keeps holding', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await expectClient(h, C0, { status: 'holding', token: 1, writing: false });
});

test('after WriteDone the client may write again', async () => {
  const h = await createHost();
  await grant(h, C0);
  await writeRound(h, C0);
  await ok(h.write(C0));
  await expectClient(h, C0, { writing: true });
});

test('one write per grant: a second write under the same grant is answered WriteRefused', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await ok(h.write(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  assert.equal(await countMsgs(h, { action: 'WriteDone' }), 0);
});

test('one write per grant: a second write under the same grant is not taken', async () => {
  const h = await createHost();
  await grant(h, C0);
  await writeRound(h, C0);
  await writeRound(h, C0);
  await expectLease(h, { holder: C0, token: 1, writes: 1 });
});

test('one write per grant: further writes under the same grant keep being refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  assert.equal(await writeRound(h, C0), 'WriteRefused');
  assert.equal(await writeRound(h, C0), 'WriteRefused');
  await expectLease(h, { writes: 1 });
});

test('on WriteRefused the client is no longer writing and keeps holding', async () => {
  const h = await createHost();
  await grant(h, C0);
  await writeRound(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteRefused');
  await expectClient(h, C0, { status: 'holding', token: 1, writing: false });
  await ok(h.write(C0));
});

test('one write per grant: the next grant to the other client may write once', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await releaseRound(h, C0);
  await grant(h, C1);
  assert.equal(await writeRound(h, C1), 'WriteDone');
  await expectLease(h, { writes: 2 });
  assert.equal(await writeRound(h, C1), 'WriteRefused');
  await expectLease(h, { writes: 2 });
});

test('one write per grant: the same client regranted may write again', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await releaseRound(h, C0);
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await expectLease(h, { holder: C0, token: 2, writes: 2 });
});

test('one write per grant: a new grant after an expiry may write once', async () => {
  const h = await createHost();
  await grant(h, C0);
  assert.equal(await writeRound(h, C0), 'WriteDone');
  await ok(h.expire());
  await grant(h, C1);
  assert.equal(await writeRound(h, C1), 'WriteDone');
  await expectLease(h, { holder: C1, token: 2, writes: 2 });
});

test('one write per grant: a grant without a write gives no extra write to the next grant', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C1);
  assert.equal(await writeRound(h, C1), 'WriteDone');
  assert.equal(await writeRound(h, C1), 'WriteRefused');
  await expectLease(h, { writes: 1 });
});

test('one write per grant: settling after a refused second write leaves one write taken', async () => {
  const h = await createHost();
  await grant(h, C0);
  await writeRound(h, C0);
  await ok(h.write(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await expectLease(h, { writes: 1 });
  await drain(h);
  await expectLease(h, { writes: 1 });
  await expectClient(h, C0, { status: 'holding', writing: false });
});

test('a write delivered after the lease expired is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.expire());
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectLease(h, { writes: 0 });
});

test('a client whose expiry is not yet known can write, but the write is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await ok(h.write(C0)); // c0 has not heard of the expiry
  const m = await oneMsg(h, { from: C0, to: SVC, action: 'Write' });
  assert.equal(m.data.token, 1);
  await h.deliver(m.id);
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectLease(h, { writes: 0 });
});

test('a write from a former holder is refused while the other client holds the current token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.expire());
  await grant(h, C1);
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectLease(h, { holder: C1, token: 2, writes: 0 });
});

test('after a stale write is refused the current holder can still write', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.expire());
  await grant(h, C1);
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  assert.equal(await writeRound(h, C1), 'WriteDone');
  await expectLease(h, { holder: C1, token: 2, writes: 1 });
});

test('a write with an old token is refused even when the same client holds a newer token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0)); // Write token 1 in flight
  await ok(h.expire());
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Released' });
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted', data: { token: 2 } });
  await expectLease(h, { holder: C0, token: 2 });
  await deliverOne(h, { from: C0, to: SVC, action: 'Write', data: { token: 1 } });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectLease(h, { writes: 0 });
});

test('a write delivered after its client released is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectLease(h, { holder: null, writes: 0 });
});

test('a write delivered before its client release is taken', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await oneMsg(h, { from: SVC, to: C0, action: 'WriteDone' });
  await expectLease(h, { writes: 1 });
});

test('a write answer delivered after the lease was revoked clears writing', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'idle' });
  await deliverOne(h, { from: C0, to: SVC, action: 'Write' });
  await deliverOne(h, { from: SVC, to: C0, action: 'WriteRefused' });
  await expectClient(h, C0, { status: 'idle', writing: false });
});

// ---------- expire ----------

test('expire with no holder is refused and changes nothing', async () => {
  const h = await createHost();
  await refusedNoChange(h, () => h.expire());
});

test('expire while a request is still undelivered is refused', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await refusedNoChange(h, () => h.expire());
});

test('expire after the lease was released is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await refusedNoChange(h, () => h.expire());
});

test('expire a second time is refused', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await refusedNoChange(h, () => h.expire());
});

test('expire with a holder frees the service and keeps the token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await expectLease(h, { holder: null, token: 1, writes: 0 });
});

test('expire keeps the count of writes', async () => {
  const h = await createHost();
  await grant(h, C0);
  await writeRound(h, C0);
  await ok(h.expire());
  await expectLease(h, { writes: 1 });
});

test('expire sends Revoked with the token to the former holder', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  const m = await oneMsg(h, { from: SVC, to: C0, action: 'Revoked' });
  assert.equal(m.data.token, 1);
  assert.equal(await countMsgs(h, { to: C1 }), 0);
});

test('expire of the second holder revokes token 2 to it', async () => {
  const h = await createHost();
  await grant(h, C0);
  await releaseRound(h, C0);
  await grant(h, C1);
  await ok(h.expire());
  await oneMsg(h, { from: SVC, to: C1, action: 'Revoked', data: { token: 2 } });
});

test('the former holder keeps holding until Revoked is delivered', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await expectClient(h, C0, { status: 'holding', token: 1 });
});

test('on Revoked with its own token a holding client becomes idle', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'idle', token: 1 });
  await checkSettled(h);
});

test('after an expiry the other client can be granted the next token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await grant(h, C1);
  await expectLease(h, { holder: C1, token: 2 });
  await expectClient(h, C1, { status: 'holding', token: 2 });
});

test('expire takes effect while the Granted is still in flight', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await expectLease(h, { holder: null, token: 1 });
  await oneMsg(h, { from: SVC, to: C0, action: 'Revoked', data: { token: 1 } });
});

test('Revoked before its Granted: the client stays requesting on the Revoked', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'requesting' });
});

test('Revoked before its Granted: the client becomes idle on the Granted', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted' });
  await expectClient(h, C0, { status: 'idle' });
  await expectLease(h, { holder: null, token: 1 });
  await checkSettled(h);
});

test('Granted before its Revoked: the client holds then becomes idle', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted' });
  await expectClient(h, C0, { status: 'holding', token: 1 });
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'idle' });
  await checkSettled(h);
});

test('a write by a client whose lease was revoked before the grant is refused', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted' });
  await refusedNoChange(h, () => h.write(C0));
});

test('a Granted with a newer token than the remembered revoked one is held', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await ok(h.expire());
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted' });
  await grant(h, C0);
  await expectClient(h, C0, { status: 'holding', token: 2 });
  await expectLease(h, { holder: C0, token: 2 });
  await checkSettled(h);
});

test('a stale Revoked delivered while requesting a newer grant does not stop the newer grant', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire()); // Revoked token 1 in flight
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Released' });
  await ok(h.acquire(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Acquire' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked', data: { token: 1 } });
  await deliverOne(h, { from: SVC, to: C0, action: 'Granted', data: { token: 2 } });
  await expectClient(h, C0, { status: 'holding', token: 2 });
  await checkSettled(h);
});

test('a Revoked with an older token is ignored by a client holding a newer token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire()); // Revoked token 1 in flight
  await ok(h.release(C0));
  await deliverOne(h, { from: C0, to: SVC, action: 'Release' });
  await deliverOne(h, { from: SVC, to: C0, action: 'Released' });
  await grant(h, C0);
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked', data: { token: 1 } });
  await expectClient(h, C0, { status: 'holding', token: 2 });
  await expectLease(h, { holder: C0, token: 2 });
  await checkSettled(h);
});

test('a Revoked delivered to a client that finished releasing leaves it idle', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await releaseRound(h, C0);
  await deliverOne(h, { from: SVC, to: C0, action: 'Revoked' });
  await expectClient(h, C0, { status: 'idle', token: 1 });
  await drain(h);
  await checkSettled(h);
});

// ---------- the conclusion ----------

test('deliverAll leaves no message in flight', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await ok(h.acquire(C1));
  await drain(h);
});

test('deliverAll delivers the answers its deliveries send', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await h.deliverAll();
  await expectClient(h, C0, { status: 'holding', token: 1 });
  await checkSettled(h);
});

test('settled: after both clients request, exactly one holds and the service agrees', async () => {
  const h = await createHost();
  await ok(h.acquire(C0));
  await ok(h.acquire(C1));
  await drain(h);
  const l = await h.lease();
  assert.ok(l.holder === C0 || l.holder === C1);
  await checkSettled(h);
  await checkSafety(h);
});

test('settled: after an expiry and a regrant, only the new holder holds', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await grant(h, C1);
  await drain(h);
  await expectClient(h, C0, { status: 'idle' });
  await expectClient(h, C1, { status: 'holding', token: 2 });
  await checkSettled(h);
});

test('safety: while a revoke is in flight only the new holder holds the current token', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.expire());
  await grant(h, C1);
  await checkSafety(h);
  await expectClient(h, C0, { status: 'holding', token: 1 });
  await expectLease(h, { token: 2 });
});

test('settled: expire with the grant in flight leaves nobody holding in any order', async () => {
  for (const firstAction of ['Granted', 'Revoked']) {
    const h = await createHost();
    await ok(h.acquire(C1));
    await deliverOne(h, { from: C1, to: SVC, action: 'Acquire' });
    await ok(h.expire());
    await deliverOne(h, { from: SVC, to: C1, action: firstAction });
    await drain(h);
    await expectClient(h, C1, { status: 'idle' });
    await expectLease(h, { holder: null });
    await checkSettled(h);
  }
});

test('settled: a release with writes in flight ends with nobody holding', async () => {
  const h = await createHost();
  await grant(h, C0);
  await ok(h.write(C0));
  await ok(h.release(C0));
  await ok(h.acquire(C1));
  await drain(h);
  await checkSettled(h);
  for (const c of CLIENTS) await expectClient(h, c, { writing: false });
});

test('invariants hold under random command and delivery orders (seeds 1-25)', async () => {
  for (let s = 1; s <= 25; s++) {
    const h = await createHost();
    await explore(h, s, 60);
  }
});

test('invariants hold under random command and delivery orders (seeds 26-50)', async () => {
  for (let s = 26; s <= 50; s++) {
    const h = await createHost();
    await explore(h, s, 60);
  }
});

test('invariants hold under random command and delivery orders (seeds 51-75)', async () => {
  for (let s = 51; s <= 75; s++) {
    const h = await createHost();
    await explore(h, s, 120);
  }
});
