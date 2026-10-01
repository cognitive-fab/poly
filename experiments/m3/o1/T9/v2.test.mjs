// T9 v2: electing and announcing a leader among three nodes, with candidates that give up.
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
    assert.ok(v.leader === null || NODES.includes(v.leader), `${n} leader valid`);
    if (v.term === 0) {
      assert.equal(v.role, 'follower', `${n} in term 0 is a follower`);
      assert.equal(v.votedFor, null, `${n} in term 0 has not voted`);
      assert.equal(v.leader, null, `${n} in term 0 knows no leader`);
    } else if (v.votedFor === null) {
      assert.notEqual(v.leader, null, `${n} in term 1 without a vote got there by Leader`);
    }
    if (v.role === 'candidate' || v.role === 'leader') {
      assert.equal(v.term, 1, `${n} ${v.role} in term 1`);
      assert.equal(v.votedFor, n, `${n} ${v.role} voted for itself`);
    }
    if (v.role === 'leader') assert.equal(v.leader, n, `${n} leader knows itself`);
    if (v.role === 'candidate') assert.equal(v.leader, null, `${n} candidate knows no leader`);
    if (v.leader !== null) assert.ok(ever.includes(v.leader), `${n} knows only the elected leader`);
    if (prev) {
      const p = prev.views[n];
      assert.ok(v.term >= p.term, `${n} term never decreases`);
      if (p.votedFor !== null) assert.equal(v.votedFor, p.votedFor, `${n} never votes twice`);
      if (p.leader !== null) assert.equal(v.leader, p.leader, `${n} known leader never changes`);
      if (p.role === 'leader') assert.equal(v.role, 'leader', `${n} leader stays leader`);
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
  for (const n of opts.giveUps || []) {
    if (snap.views[n].role === 'candidate') acts.push({ t: 'giveUp', node: n });
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

test('every node starts knowing no leader', async () => {
  const h = await createHost();
  for (const n of NODES) await expectView(h, n, { leader: null });
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
    await expectView(h, n, { role: 'candidate', term: 1, votedFor: n, leader: null });
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
    await expectView(h, c, { role: 'leader', term: 1, votedFor: c, leader: c });
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
    for (const o of NODES.filter((x) => x !== c)) await expectView(h, o, { role: 'follower', term: 1, votedFor: c, leader: c });
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

  test(`two candidates ${a} and ${b}: the loser steps down to follower keeping its own vote`, async () => {
    const h = await createHost();
    await timeoutOk(h, a);
    await timeoutOk(h, b);
    await h.deliverAll();
    const [L] = await leaders(h);
    const loser = L === a ? b : a;
    await expectView(h, loser, { role: 'follower', term: 1, votedFor: loser });
  });

  test(`two candidates ${a} and ${b}: after deliverAll every node knows the leader`, async () => {
    const h = await createHost();
    await timeoutOk(h, a);
    await timeoutOk(h, b);
    await h.deliverAll();
    const [L] = await leaders(h);
    for (const n of NODES) await expectView(h, n, { leader: L });
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
  await expectView(h, 'n2', { role: 'follower', term: 1, votedFor: 'n2', leader: 'n0' });
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
  await expectView(h, 'n0', { role: 'follower', votedFor: 'n0', leader: 'n2' });
});

// ---------- change 1: announcing the leader ----------

test('no Leader message is sent before a candidate wins', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  assert.equal((await msgs(h, { action: 'Leader' })).length, 0);
});

test('a new leader sends Leader to each of the other two nodes', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  const ls = await msgs(h, { action: 'Leader' });
  assert.equal(ls.length, 2);
  for (const o of ['n1', 'n2']) {
    const m = await findMsg(h, 'n0', o, 'Leader');
    assert.equal(m.data.from, 'n0');
    assert.equal(m.data.term, 1);
  }
});

for (const [c, v] of [['n1', 'n0'], ['n2', 'n1']]) {
  test(`leader ${c} announces itself to both other nodes`, async () => {
    const h = await createHost();
    await elect(h, c, v);
    for (const o of NODES.filter((x) => x !== c)) {
      const m = await findMsg(h, c, o, 'Leader');
      assert.equal(m.data.from, c);
      assert.equal(m.data.term, 1);
    }
  });
}

test('a leader announces itself only once even after a second granted reply', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  assert.equal((await msgs(h, { action: 'Leader' })).length, 2);
});

test('a leader knows itself as leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await expectView(h, 'n0', { role: 'leader', leader: 'n0' });
});

test('a voter knows no leader until Leader arrives', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await expectView(h, 'n1', { role: 'follower', term: 1, votedFor: 'n0', leader: null });
});

test('a voter receiving Leader records the leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await expectView(h, 'n1', { leader: 'n0' });
});

test('a voter receiving Leader stays a follower in term 1 with its vote', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await expectView(h, 'n1', { role: 'follower', term: 1, votedFor: 'n0' });
});

test('a term-0 node receiving Leader moves to term 1 as a follower', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  await expectView(h, 'n2', { role: 'follower', term: 1 });
});

test('a term-0 node receiving Leader does not vote', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  await expectView(h, 'n2', { votedFor: null });
});

test('a term-0 node receiving Leader records the leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  await expectView(h, 'n2', { leader: 'n0' });
});

test('a term-0 node receiving Leader sends no reply', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  assert.equal((await msgs(h, { from: 'n2' })).length, 0);
});

test('a node that learned the leader cannot time out', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  const before = await snapshot(h);
  const r = await h.timeout('n2');
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('a follower that learned the leader without voting grants a late RequestVote', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await expectView(h, 'n2', { role: 'follower', term: 1, votedFor: 'n0', leader: 'n0' });
  assert.equal((await findMsg(h, 'n2', 'n0', 'VoteReply')).data.granted, true);
});

test('a leader stays leader after a late granted reply and sends no more Leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'leader', leader: 'n0' });
  assert.equal((await msgs(h, { action: 'Leader', to: 'n2' })).length, 0);
  assert.equal((await msgs(h, { action: 'Leader', to: 'n1' })).length, 1);
});

test('a candidate receiving Leader steps down to follower', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await expectView(h, 'n1', { role: 'follower', term: 1 });
});

test('a candidate that steps down keeps its vote for itself and records the leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await expectView(h, 'n1', { votedFor: 'n1', leader: 'n0' });
});

test('a candidate that stepped down refuses a later RequestVote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  assert.equal((await findMsg(h, 'n1', 'n0', 'VoteReply')).data.granted, false);
  await expectView(h, 'n1', { role: 'follower', votedFor: 'n1' });
});

test('a candidate that stepped down cannot time out again', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  const before = await snapshot(h);
  const r = await h.timeout('n1');
  assert.equal(r.ok, false);
  await assertUnchanged(h, before);
});

test('a candidate that stepped down ignores a later refused reply', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  await expectView(h, 'n1', { role: 'follower', term: 1, votedFor: 'n1', leader: 'n0' });
  assert.deepEqual(await leaders(h), ['n0']);
});

test('a lone candidate after deliverAll: every node knows the leader and nothing is in flight', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n2');
  await h.deliverAll();
  for (const n of NODES) await expectView(h, n, { leader: 'n2' });
  assert.equal((await h.inFlight()).length, 0);
});

test('three candidates: no node knows a leader after deliverAll', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  await h.deliverAll();
  for (const n of NODES) await expectView(h, n, { leader: null });
});

test('Leader arriving before the leader RequestVote: the third node still ends voting for the leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n0', 'RequestVote');
  await deliverMsg(h, 'n0', 'n1', 'VoteReply');
  await deliverMsg(h, 'n1', 'n2', 'Leader');
  await h.deliverAll();
  for (const n of NODES) await expectView(h, n, { term: 1, votedFor: 'n1', leader: 'n1' });
  assert.deepEqual(await leaders(h), ['n1']);
});

// ---------- change 2: giving up an election ----------

test('giveUp of a candidate is accepted', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  const r = await h.giveUp('n0');
  assert.equal(r.ok, true);
});

for (const n of NODES) {
  test(`a candidate ${n} that gives up becomes a follower in term 1`, async () => {
    const h = await createHost();
    await timeoutOk(h, n);
    assert.equal((await h.giveUp(n)).ok, true);
    await expectView(h, n, { role: 'follower', term: 1 });
  });
}

test('a candidate that gives up keeps its vote for itself', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n1');
  assert.equal((await h.giveUp('n1')).ok, true);
  await expectView(h, 'n1', { votedFor: 'n1' });
});

test('a candidate that gives up knows no leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n1');
  assert.equal((await h.giveUp('n1')).ok, true);
  await expectView(h, 'n1', { leader: null });
});

test('giveUp leaves the other nodes unchanged', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n0')).ok, true);
  const after = await snapshot(h);
  assert.deepEqual(after.views.n1, before.views.n1);
  assert.deepEqual(after.views.n2, before.views.n2);
});

test('giveUp is refused for ids that are not nodes', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  const before = await snapshot(h);
  for (const id of UNKNOWN) {
    const r = await h.giveUp(id);
    assert.equal(r.ok, false, `giveUp(${JSON.stringify(id)})`);
  }
  await assertUnchanged(h, before);
});

test('giveUp is refused for a follower in term 0', async () => {
  const h = await createHost();
  const before = await snapshot(h);
  for (const n of NODES) assert.equal((await h.giveUp(n)).ok, false);
  await assertUnchanged(h, before);
});

test('giveUp is refused for a follower that voted', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n1')).ok, false);
  await assertUnchanged(h, before);
});

test('giveUp is refused for a leader', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n0')).ok, false);
  await assertUnchanged(h, before);
});

test('giveUp is refused for a node that already gave up', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  assert.equal((await h.giveUp('n0')).ok, true);
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n0')).ok, false);
  await assertUnchanged(h, before);
});

test('giveUp is refused for a candidate that already stepped down on Leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n0', 'VoteReply');
  await deliverMsg(h, 'n0', 'n1', 'Leader');
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n1')).ok, false);
  await assertUnchanged(h, before);
});

test('giveUp is refused for a follower that learned the leader without voting', async () => {
  const h = await createHost();
  await elect(h, 'n0', 'n1');
  await deliverMsg(h, 'n0', 'n2', 'Leader');
  const before = await snapshot(h);
  assert.equal((await h.giveUp('n2')).ok, false);
  await assertUnchanged(h, before);
});

test('a node that gave up cannot time out again', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  assert.equal((await h.giveUp('n0')).ok, true);
  const before = await snapshot(h);
  assert.equal((await h.timeout('n0')).ok, false);
  await assertUnchanged(h, before);
});

test('a node that gave up refuses its vote to another candidate', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  assert.equal((await h.giveUp('n0')).ok, true);
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n0', 'RequestVote');
  assert.equal((await findMsg(h, 'n0', 'n1', 'VoteReply')).data.granted, false);
});

test('a node that gave up keeps its own vote after another RequestVote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  assert.equal((await h.giveUp('n0')).ok, true);
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n0', 'RequestVote');
  await expectView(h, 'n0', { role: 'follower', term: 1, votedFor: 'n0' });
});

test('a node that gave up ignores a granted VoteReply that arrives later', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  assert.equal((await h.giveUp('n0')).ok, true);
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  await expectView(h, 'n0', { role: 'follower', term: 1, votedFor: 'n0', leader: null });
});

test('a node that gave up sends no Leader when a granted reply arrives later', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  assert.equal((await h.giveUp('n0')).ok, true);
  await deliverMsg(h, 'n1', 'n0', 'VoteReply');
  assert.equal((await msgs(h, { action: 'Leader' })).length, 0);
});

test('a lone candidate that gives up is never elected, whatever is delivered', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n2');
  assert.equal((await h.giveUp('n2')).ok, true);
  await h.deliverAll();
  assert.deepEqual(await leaders(h), []);
  await expectView(h, 'n2', { role: 'follower', term: 1, votedFor: 'n2', leader: null });
  assert.equal((await h.inFlight()).length, 0);
});

test('a candidate that gives up after both replies were sent is not elected', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  await deliverMsg(h, 'n0', 'n2', 'RequestVote');
  assert.equal((await h.giveUp('n0')).ok, true);
  await h.deliverAll();
  assert.deepEqual(await leaders(h), []);
  for (const n of NODES) await expectView(h, n, { term: 1, votedFor: 'n0', leader: null });
});

test('another candidate can win after a candidate gives up', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  assert.equal((await h.giveUp('n0')).ok, true);
  await timeoutOk(h, 'n1');
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  await expectView(h, 'n1', { role: 'leader', term: 1, votedFor: 'n1', leader: 'n1' });
});

test('a node that gave up records the new leader and stays a follower with its own vote', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  assert.equal((await h.giveUp('n0')).ok, true);
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  await deliverMsg(h, 'n1', 'n0', 'Leader');
  await expectView(h, 'n0', { role: 'follower', term: 1, votedFor: 'n0', leader: 'n1' });
});

test('after a give-up and a rival win, deliverAll keeps exactly the rival as leader', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await timeoutOk(h, 'n1');
  assert.equal((await h.giveUp('n0')).ok, true);
  await deliverMsg(h, 'n1', 'n2', 'RequestVote');
  await deliverMsg(h, 'n2', 'n1', 'VoteReply');
  await h.deliverAll();
  assert.deepEqual(await leaders(h), ['n1']);
  for (const n of NODES) await expectView(h, n, { leader: 'n1' });
  assert.equal((await h.inFlight()).length, 0);
});

test('a vote given to a candidate that gave up cannot elect anyone else', async () => {
  const h = await createHost();
  await timeoutOk(h, 'n0');
  await deliverMsg(h, 'n0', 'n1', 'RequestVote');
  assert.equal((await h.giveUp('n0')).ok, true);
  await timeoutOk(h, 'n2');
  await h.deliverAll();
  assert.deepEqual(await leaders(h), []);
  await expectView(h, 'n1', { votedFor: 'n0' });
  await expectView(h, 'n2', { votedFor: 'n2' });
});

test('all candidates giving up leaves no leader', async () => {
  const h = await createHost();
  for (const n of NODES) await timeoutOk(h, n);
  for (const n of NODES) assert.equal((await h.giveUp(n)).ok, true);
  await h.deliverAll();
  assert.deepEqual(await leaders(h), []);
  for (const n of NODES) await expectView(h, n, { role: 'follower', term: 1, votedFor: n, leader: null });
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
        for (const n of NODES) assert.equal(snap.views[n].leader, ls[0], 'every node knows the leader');
        for (const n of NODES) if (n !== ls[0]) assert.equal(snap.views[n].role, 'follower');
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


test('every order of deliveries and give-ups with two candidates keeps the election safe', async () => {
  await explore([{ t: 'timeout', node: 'n0' }, { t: 'timeout', node: 'n1' }], { timeouts: ['n2'], giveUps: NODES });
});

test('every order of deliveries, timeouts and give-ups from a lone candidate keeps the election safe', async () => {
  await explore([{ t: 'timeout', node: 'n0' }], { timeouts: ['n1', 'n2'], giveUps: NODES });
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
        const cmd = rnd() < 0.7 ? 'timeout' : 'giveUp';
        const expectOk = cmd === 'timeout' ? v.role === 'follower' && v.term === 0 : v.role === 'candidate';
        const r = await h[cmd](n);
        assert.equal(r.ok, expectOk, `${cmd}(${n}) outcome`);
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
