// T9 v0: electing a leader among three nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

const NODES = ['n0', 'n1', 'n2'];
const UNKNOWN = ['n3', '', 'N0', 'node0', 'n-1'];

// ---------- helpers ----------

function sortObj(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = sortObj(o[k]);
  return out;
}
function msgKey(m) {
  return JSON.stringify([m.from, m.to, m.action, sortObj(m.data)]);
}
async function views(h) {
  const o = {};
  for (const n of NODES) o[n] = await h.node(n);
  return o;
}
async function snapshot(h) {
  const v = await views(h);
  const msgs = (await h.inFlight()).map(msgKey).sort();
  return { views: JSON.parse(JSON.stringify(v)), msgs };
}
async function assertUnchanged(h, before) {
  assert.deepEqual(await snapshot(h), before);
}
async function msgs(h, { from, to, action } = {}) {
  const list = await h.inFlight();
  return list.filter(
    (m) =>
      (from === undefined || m.from === from) &&
      (to === undefined || m.to === to) &&
      (action === undefined || m.action === action),
  );
}
async function findMsg(h, from, to, action) {
  const l = await msgs(h, { from, to, action });
  assert.equal(l.length, 1, `expected one ${action} from ${from} to ${to} in flight`);
  return l[0];
}
async function deliverMsg(h, from, to, action) {
  const m = await findMsg(h, from, to, action);
  await h.deliver(m.id);
  return m;
}
async function expectView(h, n, exp) {
  const v = await h.node(n);
  assert.ok(v, `node ${n} exists`);
  for (const k of Object.keys(exp)) assert.equal(v[k], exp[k], `${n}.${k}`);
}
async function timeoutOk(h, n) {
  const r = await h.timeout(n);
  assert.equal(r.ok, true);
}
async function leaders(h) {
  const v = await views(h);
  return NODES.filter((n) => v[n].role === 'leader');
}
// n votes in a fresh election started by c: c times out, RequestVote to v delivered, reply delivered.
async function elect(h, c, voter) {
  await timeoutOk(h, c);
  await deliverMsg(h, c, voter, 'RequestVote');
  await deliverMsg(h, voter, c, 'VoteReply');
}

// ---------- invariants and exploration ----------

function checkInvariants(snap, prev, ever) {
  const vs = snap.views;
  for (const n of NODES) {
    const v = vs[n];
    assert.ok(v, `${n} view exists`);
    assert.ok(['follower', 'candidate', 'leader'].includes(v.role), `${n} role valid`);
    assert.ok(v.term === 0 || v.term === 1, `${n} term is 0 or 1`);
    assert.ok(v.votedFor === null || NODES.includes(v.votedFor), `${n} votedFor valid`);
    if (v.term === 0) {
      assert.equal(v.role, 'follower', `${n} in term 0 is a follower`);
      assert.equal(v.votedFor, null, `${n} in term 0 has not voted`);
    } else {
      assert.notEqual(v.votedFor, null, `${n} in term 1 has voted`);
    }
    if (v.role === 'candidate' || v.role === 'leader') {
      assert.equal(v.term, 1, `${n} ${v.role} in term 1`);
      assert.equal(v.votedFor, n, `${n} ${v.role} voted for itself`);
    }
    if (prev) {
      const p = prev.views[n];
      assert.ok(v.term >= p.term, `${n} term never decreases`);
      if (p.votedFor !== null) assert.equal(v.votedFor, p.votedFor, `${n} never votes twice`);
      if (p.role === 'leader') assert.equal(v.role, 'leader', `${n} leader stays leader`);
      if (p.role === 'candidate') assert.ok(v.role === 'candidate' || v.role === 'leader', `${n} candidate stays candidate or leads`);
    }
  }
  const ls = NODES.filter((n) => vs[n].role === 'leader');
  assert.ok(ls.length <= 1, 'at most one leader');
  for (const L of ls) {
    const votes = NODES.filter((n) => vs[n].votedFor === L).length;
    assert.ok(votes >= 2, `leader ${L} holds a majority of votes`);
  }
  assert.ok(ever.length <= 1, 'at most one node ever becomes leader in the term');
}

function enabledActions(snap, opts) {
  const acts = [];
  for (const k of new Set(snap.msgs)) acts.push({ t: 'deliver', key: k });
  for (const n of opts.timeouts || []) {
    const v = snap.views[n];
    if (v.role === 'follower' && v.term === 0) acts.push({ t: 'timeout', node: n });
  }
  return acts;
}

async function applyAction(h, a) {
  if (a.t === 'deliver') {
    const list = await h.inFlight();
    const m = list.find((x) => msgKey(x) === a.key);
    assert.ok(m, 'message to deliver is in flight on replay');
    await h.deliver(m.id);
  } else {
    const r = await h[a.t](a.node);
    assert.equal(r.ok, true, `${a.t}(${a.node}) accepted`);
  }
}

async function replay(path) {
  const h = await createHost();
  for (const a of path) await applyAction(h, a);
  return h;
}

function updateEver(ever, snap) {
  const s = new Set(ever);
  for (const n of NODES) if (snap.views[n].role === 'leader') s.add(n);
  return [...s].sort();
}

// Exhaustive exploration of every order of the enabled actions, from the given prefix.
async function explore(prefix, opts, onQuiet) {
  const seen = new Set();
  const stack = [{ path: prefix, prev: null, ever: [] }];
  let states = 0;
  let replays = 0;
  // A budget of replays keeps the run short; every explored path is a real run, so stopping early is sound.
  while (stack.length && replays < (opts.budget || 4000)) {
    replays++;
    const item = stack.pop();
    const h = await replay(item.path);
    const snap = await snapshot(h);
    const ever = updateEver(item.ever, snap);
    checkInvariants(snap, item.prev, ever);
    const key = JSON.stringify([snap, ever]);
    if (seen.has(key)) continue;
    seen.add(key);
    states++;
    if (snap.msgs.length === 0 && onQuiet) onQuiet(snap);
    for (const a of enabledActions(snap, opts)) stack.push({ path: [...item.path, a], prev: snap, ever });
  }
  return states;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------- initial state and query ----------

test('every node starts as a follower in term 0', async () => {
  const h = await createHost();
  for (const n of NODES) await expectView(h, n, { role: 'follower', term: 0 });
});

test('every node starts with no vote', async () => {
  const h = await createHost();
  for (const n of NODES) await expectView(h, n, { votedFor: null });
});

test('node query returns null for ids that are not nodes', async () => {
  const h = await createHost();
  for (const id of UNKNOWN) assert.equal(await h.node(id), null, `node(${JSON.stringify(id)})`);
});

test('nothing is in flight in a fresh system', async () => {
  const h = await createHost();
  assert.equal((await h.inFlight()).length, 0);
});

test('deliverAll with nothing in flight changes nothing', async () => {
  const h = await createHost();
  const before = await snapshot(h);
  await h.deliverAll();
  await assertUnchanged(h, before);
});

test('two fresh systems are independent', async () => {
  const a = await createHost();
  await timeoutOk(a, 'n0');
  const b = await createHost();
  await expectView(b, 'n0', { role: 'follower', term: 0, votedFor: null });
  assert.equal((await b.inFlight()).length, 0);
});

// ---------- timeout ----------

for (const n of NODES) {
  test(`timeout of ${n} in term 0 is accepted`, async () => {
    const h = await createHost();
    const r = await h.timeout(n);
    assert.equal(r.ok, true);
  });

  test(`timeout makes ${n} a candidate in term 1 voting for itself`, async () => {
    const h = await createHost();
    await timeoutOk(h, n);
    await expectView(h, n, { role: 'candidate', term: 1, votedFor: n });
  });

  test(`timeout of ${n} sends RequestVote to each of the other two nodes`, async () => {
    const h = await createHost();
    await timeoutOk(h, n);
    const others = NODES.filter((x) => x !== n);
    const rv = await msgs(h, { action: 'RequestVote' });
    assert.equal(rv.length, 2);
    for (const o of others) {
      const m = await findMsg(h, n, o, 'RequestVote');
      assert.equal(m.data.from, n);
      assert.equal(m.data.term, 1);
    }
  });
}

test('timeout sends nothing but the two RequestVote messages', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  const all = await h.inFlight();
  assert.equal(all.length, 2);
  for (const m of all) assert.equal(m.action, 'RequestVote');
});

test('timeout leaves the other nodes unchanged', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n1');
  for (const n of ['n0', 'n2']) await expectView(h, n, { role: 'follower', term: 0, votedFor: null });
});

test('timeout is refused for ids that are not nodes', async () => {
  const h = await createHost();
  const before = await snapshot(h);
  for (const id of UNKNOWN) {
    const r = await h.timeout(id);
    assert.equal(r.ok, false, `timeout(${JSON.stringify(id)})`);
  }
  await assertUnchanged(h, before);
});

test('second timeout of a candidate is refused', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  const before = await snapshot(h);
  const r = await h.timeout('n0');
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('timeout is refused for a follower that already voted in term 1', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  const before = await snapshot(h);
  const r = await h.timeout('n1');
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('timeout is refused for a leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await expectView(h, 'n0', { role: 'leader' });
  const before = await snapshot(h);
  const r = await h.timeout('n0');
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('timeout is refused for a candidate that lost its election', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await h.deliverAll();
  const loser = (await leaders(h))[0] === 'n0' ? 'n1' : 'n0';
  const before = await snapshot(h);
  const r = await h.timeout(loser);
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('a node that did not vote can still time out while another is a candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await expectView(h, 'n1', { role: 'candidate', term: 1, votedFor: 'n1' });
  await expectView(h, 'n0', { role: 'candidate', term: 1, votedFor: 'n0' });
});

// ---------- voting ----------

test('a term-0 follower receiving RequestVote moves to term 1 as a follower', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await expectView(h, 'n1', { role: 'follower', term: 1 });
});

test('a term-0 follower receiving RequestVote votes for the candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await expectView(h, 'n1', { votedFor: 'n0' });
});

test('a term-0 follower answers RequestVote with a granted VoteReply to the candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n2');
  await deliverMsg(h, 'n2', 'n0', 'RequestVote');
  const m = await findMsg(h, 'n0', 'n2', 'VoteReply');
  assert.equal(m.data.term, 1);
  assert.equal(m.data.granted, true);
});

test('delivering RequestVote removes it from the messages in flight', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  assert.equal((await msgs(h, { from: 'n0', to: 'n1', action: 'RequestVote' })).length, 0);
  assert.equal((await msgs(h, { from: 'n0', to: 'n2', action: 'RequestVote' })).length, 1);
});

test('delivering one RequestVote leaves the third node unchanged', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await expectView(h, 'n2', { role: 'follower', term: 0, votedFor: null });
});

test('a candidate refuses its vote to another candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  const m = await findMsg(h, 'n1', 'n0', 'VoteReply');
  assert.equal(m.data.term, 1);
  assert.equal(m.data.granted, false);
});

test('a candidate receiving RequestVote stays a candidate voting for itself', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await expectView(h, 'n1', { role: 'candidate', term: 1, votedFor: 'n1' });
});

test('a follower that voted refuses its vote to a second candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  const m = await findMsg(h, 'n2', 'n1', 'VoteReply');
  assert.equal(m.data.term, 1);
  assert.equal(m.data.granted, false);
});

test('a follower that voted keeps its first vote after a second RequestVote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await expectView(h, 'n2', { role: 'follower', term: 1, votedFor: 'n0' });
});

test('the first RequestVote to arrive wins the vote whichever candidate sent it', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await expectView(h, 'n2', { votedFor: 'n1' });
  assert.equal((await findMsg(h, 'n2', 'n1', 'VoteReply')).data.granted, true);
  assert.equal((await findMsg(h, 'n2', 'n0', 'VoteReply')).data.granted, false);
});

test('a leader receiving RequestVote refuses its vote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader' });
  await deliverMsg(h, 'n1', 'n0', 'RequestVote');
  const m = await findMsg(h, 'n0', 'n1', 'VoteReply');
  assert.equal(m.data.granted, false);
});

test('a leader receiving RequestVote stays leader with its own vote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n1', 'n0', 'RequestVote');
  await expectView(h, 'n0', { role: 'leader', term: 1, votedFor: 'n0' });
});

test('a candidate is unchanged when its RequestVote is delivered before any reply', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await expectView(h, 'n0', { role: 'candidate', term: 1, votedFor: 'n0' });
});

// ---------- counting votes ----------

test('a candidate with only its own vote is not leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await expectView(h, 'n0', { role: 'candidate' });
});

test('a candidate becomes leader on its first granted VoteReply', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await expectView(h, 'n0', { role: 'leader', term: 1, votedFor: 'n0' });
});

for (const [c, v] of [['n1', 'n2'], ['n2', 'n0'], ['n0', 'n2'], ['n1', 'n0'], ['n2', 'n1']]) {
  test(`${c} becomes leader with the vote of ${v}`, async () => {
    const h = await createHost();
    await elect(h, c, v);
    await expectView(h, c, { role: 'leader', term: 1, votedFor: c });
    await expectView(h, v, { role: 'follower', term: 1, votedFor: c });
  });
}

test('delivering a granted VoteReply leaves the voter unchanged', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  const before = (await snapshot(h)).views.n1;
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.node('n1'))), before);
});

test('a candidate receiving a refused VoteReply stays a candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'candidate', term: 1, votedFor: 'n0' });
});

test('two refused VoteReplies leave a candidate a candidate', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'candidate' });
});

test('a leader stays leader after a second granted VoteReply', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader' });
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader', term: 1, votedFor: 'n0' });
});

test('a leader ignores a refused VoteReply', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader', term: 1, votedFor: 'n0' });
  await expectView(h, 'n1', { role: 'candidate', term: 1, votedFor: 'n1' });
});

test('either granted reply alone makes the candidate leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader' });
});

test('a losing candidate is not made leader by a refused reply after the winner leads', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  assert.deepEqual(await leaders(h), ['n0']);
});

// ---------- deliverAll ----------

for (const c of NODES) {
  test(`a lone candidate ${c} becomes leader after deliverAll`, async () => {
    const h = await createHost();
    await timeoutOk(h, c);
    await h.deliverAll();
    await expectView(h, c, { role: 'leader', term: 1, votedFor: c });
  });

  test(`after deliverAll the other nodes voted for the lone candidate ${c}`, async () => {
    const h = await createHost();
    await timeoutOk(h, c);
    await h.deliverAll();
    for (const o of NODES.filter((x) => x !== c)) await expectView(h, o, { role: 'follower', term: 1, votedFor: c });
  });
}

test('deliverAll leaves nothing in flight', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await h.deliverAll();
  assert.equal((await h.inFlight()).length, 0);
});

for (const [a, b] of [['n0', 'n1'], ['n0', 'n2'], ['n1', 'n2']]) {
  test(`two candidates ${a} and ${b}: deliverAll elects exactly one leader`, async () => {
    const h = await createHost();
    await timeoutOk(h, a);
    await timeoutOk(h, b);
    await h.deliverAll();
    const ls = await leaders(h);
    assert.equal(ls.length, 1);
    assert.ok(ls[0] === a || ls[0] === b);
  });

  test(`two candidates ${a} and ${b}: the leader holds the third node's vote`, async () => {
    const h = await createHost();
    await timeoutOk(h, a);
    await timeoutOk(h, b);
    await h.deliverAll();
    const third = NODES.find((x) => x !== a && x !== b);
    const [L] = await leaders(h);
    await expectView(h, third, { role: 'follower', term: 1, votedFor: L });
  });

  test(`two candidates ${a} and ${b}: the loser stays a candidate voting for itself`, async () => {
    const h = await createHost();
    await timeoutOk(h, a);
    await timeoutOk(h, b);
    await h.deliverAll();
    const [L] = await leaders(h);
    const loser = L === a ? b : a;
    await expectView(h, loser, { role: 'candidate', term: 1, votedFor: loser });
  });
}

test('three candidates: deliverAll elects no leader', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  await h.deliverAll();
  assert.deepEqual(await leaders(h), []);
});

test('three candidates: each still a candidate voting for itself after deliverAll', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  await h.deliverAll();
  for (const n of NODES) await expectView(h, n, { role: 'candidate', term: 1, votedFor: n });
});

test('three candidates: every VoteReply is refused', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  for (const c of NODES) for (const o of NODES) if (c !== o) await deliverMsg(h, c, o, 'RequestVote');
  const replies = await msgs(h, { action: 'VoteReply' });
  assert.equal(replies.length, 6);
  for (const m of replies) assert.equal(m.data.granted, false);
});

// ---------- orders that matter ----------

test('a later timeout cannot win once a leader holds a majority', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await timeoutOk(h, 'n2');
  await h.deliverAll();
  assert.deepEqual(await leaders(h), ['n0']);
  await expectView(h, 'n2', { role: 'candidate', votedFor: 'n2' });
});

test('a reply delivered before the rival RequestVote: first candidate leads, rival refused', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader' });
  await expectView(h, 'n1', { role: 'candidate' });
  await expectView(h, 'n2', { votedFor: 'n0' });
});

test('replies delivered out of order still elect only the candidate that won the vote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'candidate' });
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  assert.deepEqual(await leaders(h), ['n1']);
});

test('a node that times out after its RequestVote arrived elsewhere is refused by the voter', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await timeoutOk(h, 'n2');
  await deliverMsg(h, 'n2', 'n1', 'RequestVote');
  assert.equal((await findMsg(h, 'n1', 'n2', 'VoteReply')).data.granted, false);
  await expectView(h, 'n1', { votedFor: 'n0' });
});

test('a candidate cannot win when the only free node votes for its rival', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n2');
  await deliverMsg(h, 'n2', 'n1', 'RequestVote');
  await h.deliverAll();
  assert.deepEqual(await leaders(h), ['n2']);
  await expectView(h, 'n0', { role: 'candidate' });
});

// ---------- conclusion: any order ----------

test('every order of deliveries with two candidates n0 and n1 keeps the election safe', async () => {
  let quiet = 0;
  await explore(
    [{ t: 'timeout', node: 'n0' }, { t: 'timeout', node: 'n1' }],
    { timeouts: ['n2'] },
    (snap) => {
      quiet++;
      const ls = NODES.filter((n) => snap.views[n].role === 'leader');
      if (snap.views.n2.role !== 'candidate') {
        assert.equal(ls.length, 1, 'with a free voter, exactly one leader once everything is delivered');
        assert.equal(snap.views.n2.votedFor, ls[0]);
      } else {
        assert.equal(ls.length, 0, 'three candidates elect no leader');
      }
    },
  );
  assert.ok(quiet > 0);
});

test('every order of deliveries and timeouts from a lone candidate keeps the election safe', async () => {
  await explore([{ t: 'timeout', node: 'n0' }], { timeouts: ['n1', 'n2'] });
});


test('random sequences of commands and deliveries keep the election safe', async () => {
  const rnd = lcg(9001);
  for (let run = 0; run < 150; run++) {
    const h = await createHost();
    let prev = await snapshot(h);
    let ever = [];
    checkInvariants(prev, null, ever);
    for (let step = 0; step < 20; step++) {
      const list = await h.inFlight();
      const choice = rnd();
      if (list.length > 0 && choice < 0.6) {
        const m = list[Math.floor(rnd() * list.length)];
        await h.deliver(m.id);
      } else {
        const n = NODES[Math.floor(rnd() * 3)];
        const v = prev.views[n];
        const expectOk = v.role === 'follower' && v.term === 0;
        const r = await h.timeout(n);
        assert.equal(r.ok, expectOk, `timeout(${n}) outcome`);
        if (!expectOk) await assertUnchanged(h, prev);
      }
      const snap = await snapshot(h);
      ever = updateEver(ever, snap);
      checkInvariants(snap, prev, ever);
      prev = snap;
    }
    await h.deliverAll();
    const snap = await snapshot(h);
    ever = updateEver(ever, snap);
    checkInvariants(snap, prev, ever);
    assert.equal(snap.msgs.length, 0);
  }
});
