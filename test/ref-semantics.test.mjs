// poly-ref against the definitions of 04-semantics, one rule at a time.
// Kept outside packages/poly-ref so poly-ref's own build never references the
// compiler, even for tests (PS9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@poly/lang';
import { checkMachine, buildMachine, transition, initialState } from '@poly/ref';

function machine(src) {
  const r = parse(src);
  assert.ok(r.module, JSON.stringify(r.diagnostics));
  return r.module;
}
const codes = (r) => r.findings.map((d) => d.code);

test('PS3.2: a terminal state rejects every action with "terminal", before any handler', () => {
  const m = machine(`module t\ntype S = Open | Closed\nmachine M {\n  state { s : S = Open }\n  terminal s is Closed\n  action Close()\n  on Close { s' = Closed }\n}\n`);
  const M = buildMachine(m, 'M');
  const closed = transition(M, initialState(M), 'Close', {}).next;
  assert.deepEqual(transition(M, closed, 'Close', {}), { verdict: { kind: 'rejected', reason: 'terminal' }, next: closed });
  const r = checkMachine(m, 'M');
  assert.equal(r.states, 2);
  assert.deepEqual(codes(r), []); // Closed is terminal, so not a deadlock (PS5.6)
});

test('PS3.2, PS3.3: an action with no handler is an unhandled stutter, and does not prevent a deadlock', () => {
  const m = machine(`module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action Inc()\n  action Ping()\n  on Inc { require x < 1 else reject "full"  x' = x + 1 }\n}\n`);
  const M = buildMachine(m, 'M');
  assert.deepEqual(transition(M, initialState(M), 'Ping', {}).verdict, { kind: 'unhandled' });
  const r = checkMachine(m, 'M');
  assert.equal(r.transitions, 4); // two states, two actions, stutters included
  assert.deepEqual(r.deadlocks, [{ x: 1 }]);
});

test('PS2.2: guards run first, in declaration order, and the first one that holds gives its reason', () => {
  const m = machine(`module t\nmachine M {\n  state { x : 0..3 = 0 }\n  action Inc()\n  guard all when x >= 0 reject "first"\n  guard all when x >= 0 reject "second"\n  on Inc { require x > 5 else reject "handler"  x' = x + 1 }\n}\n`);
  const M = buildMachine(m, 'M');
  assert.deepEqual(transition(M, initialState(M), 'Inc', {}).verdict, { kind: 'rejected', reason: 'first' });
});

test('PS5.2 and PS5.3: step properties see accepted steps only; reject properties see every step', () => {
  const src = (prop) => `module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action Inc()\n  action Ping()\n  on Inc { require x < 1 else reject "full"  x' = x + 1 }\n  ${prop}\n}\n`;
  // False on every stutter, true on the one accepted step.
  assert.ok(!codes(checkMachine(machine(src('step property moves: post.x != pre.x')), 'M')).includes('PL3002'));
  // The unhandled Ping is a step a reject property sees.
  const r = checkMachine(machine(src('reject property ping-rejected: action == Ping implies rejected("nope")')), 'M');
  assert.ok(codes(r).includes('PL3003'));
  const ok = checkMachine(machine(src('reject property full: (action == Inc && pre.x == 1) implies rejected("full")')), 'M');
  assert.ok(!codes(ok).includes('PL3003'));
});

test('PS4.2a: leaving a check domain is a bound hit; properties still hold or fail inside the bound', () => {
  const m = machine(`module t\nmachine M {\n  state { n : int check 0..3 = 0 }\n  action Inc()\n  on Inc { n' = n + 1 }\n  invariant small: n < 3\n}\n`);
  const r = checkMachine(m, 'M');
  assert.equal(r.states, 4); // 0..3 explored, 4 is not
  assert.deepEqual(codes(r).sort(), ['PL3001', 'PL3901']);
  const bound = r.findings.find((d) => d.code === 'PL3901');
  assert.deepEqual(bound.witness.trace.map((s) => s.action), ['Inc', 'Inc', 'Inc', 'Inc']);
});

test('PS4.2a: leaving a declared type is a domain escape, a finding (PT3.5)', () => {
  const m = machine(`module t\nmachine M {\n  state { items : 0..3 = 0 }\n  action AddItem()\n  on AddItem { items' = items + 1 }\n}\n`);
  const r = checkMachine(m, 'M');
  assert.deepEqual(codes(r), ['PL3102']);
  assert.deepEqual(r.findings[0].witness.trace.map((s) => s.action), ['AddItem', 'AddItem', 'AddItem', 'AddItem']);
});

test('PS2.5, S12: integer division truncates toward zero; % takes the sign of the dividend', () => {
  const m = machine(`module t\nmachine M {\n  state { q : -5..5 = 0  r : -5..5 = 0 }\n  action Go()\n  on Go { q' = -7 / 2  r' = -7 % 2 }\n}\n`);
  const M = buildMachine(m, 'M');
  assert.deepEqual(transition(M, initialState(M), 'Go', {}).next, { q: -3, r: -1 });
});

test('maps: literals, indexing, and update of one entry (PT2.2, S4)', () => {
  const m = machine(`module t\ntype Msg = M1 | M2\nmachine M {\n  state {\n    seen  : map<Msg, bool> = { M1: false, M2: false }\n    slots : map<0..1, 0..2> = [0, 0]\n  }\n  action See(m: Msg)\n  on See(m) {\n    require !seen[m] else reject "seen"\n    seen' = seen with [m] = true\n    slots' = slots with [0] = slots[0] + 1\n  }\n}\n`);
  const r = checkMachine(m, 'M');
  // seen: 4 values, but slots[0] counts the number of seen messages, so 4 states.
  assert.equal(r.states, 4);
  assert.deepEqual(codes(r), ['PL3201']); // both seen: nothing accepts
});

test('PS1.7: a service is exempt from the per-instance deadlock check', () => {
  const m = machine(`module t\nservice machine M {\n  state { x : 0..1 = 0 }\n  action Inc()\n  on Inc { require x < 1 else reject "full"  x' = 1 }\n}\n`);
  assert.deepEqual(codes(checkMachine(m, 'M')), []);
});

test('PS2.2: match binds payloads and literal patterns select the arm', () => {
  const m = machine(`module t\ntype S = Idle | Busy { n: 1..2 } | Done\nmachine M {\n  state { s : S = Idle }\n  terminal s is Done\n  action Go()\n  on Go {\n    match s {\n      Idle => s' = Busy { n: 1 }\n      Busy { n: 2 } => s' = Done\n      Busy { n: k } => s' = Busy { n: k + 1 }\n      Done => reject "done"\n    }\n  }\n}\n`);
  const r = checkMachine(m, 'M');
  assert.equal(r.states, 4);
  assert.deepEqual(codes(r), []);
});
