// PS15.0a as amended (b6318b4c, "One value for a principal nothing reads"), PS4.1c, PS15.4, PS15.5, S450: a Principal
// field of an action's claims is explored by one value only when nothing reads it. A handler that reads it, a
// `principal from` that reads it (the Inbound of a conversation whose channel declares it) or an application action
// bound with claims (in the channel's configuration) makes **check** offer every representative. Written from the
// specification text alone.
//
// The observations are the instance counts every verdict prints (PT12.3a): `states` and `transitions`. A machine
// checked alone is offered every label in every state (measured on the thread-principal ticket: 5 states and 7 labels
// give 35 transitions), so the labels per state are transitions / states, and a field explored with p representatives
// multiplies the labels of its action by p. The Sender's Inbound carries `from` (2 values) and `body` (none and 2
// bodies), so it has 6 labels per principal value; the ticket's Got carries `body`, 3 labels per principal value.
// The fixtures are the small ticket of test/fixtures/thread-principal and its test kind: each check takes about a
// second. Larger fixtures for this area ran out of memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const TP = join(ROOT, 'test', 'fixtures', 'thread-principal');
const STD = join(TP, 'std');
const STD_BEFORE = join(ROOT, 'test', 'fixtures', 'one-value-principal', 'std-before');
const TICKET = readFileSync(join(TP, 'ticket.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-one-value-principal');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;

// The variants differ from the ticket only in the clause under test.
const noFrom = (src) => swap(src, '  principal from principal\n', '');
const noClaims = (src) => swap(swap(src, 'on Got(body) by c: Customer {', 'on Got(body) {'), "    who' = c.principal\n", '');
// Got takes the claims and never reads them.
const unread = (src) => swap(src, "    who' = c.principal\n", '');
// Got takes the claims and compares the principal with a field it never writes: it reads the field and the states do
// not change, so only the labels can differ.
const compared = (src) => swap(unread(src), '    require replies == 0 else reject "replied"\n', '    require replies == 0 else reject "replied"\n    require c.principal != who else reject "same"\n');

let n = 0;
async function check(src, std = STD) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  const r = await checkFile(join(d, 'm.poly'), { root: d, std });
  assert.ok(!r.error, text(r));
  return r;
}
const machine = (r, name) => { const m = (r.machines ?? []).find((x) => x.machine === name); assert.ok(m?.instance, `${name}: ${text(r)}`); return m; };
const conversation = (r) => machine(r, 'support.Conversation');
const configuration = (r) => { const c = (r.configurations ?? []).find((x) => x.configuration === 'support'); assert.ok(c?.instance, text(r)); return c; };
/** PS4.1c: the number of principal representatives the verdict prints in its instance. */
function representatives(m) {
  const line = (m.instance.domains ?? []).find((x) => /principal representatives/.test(x));
  assert.ok(line, JSON.stringify(m.instance));
  return Number(/(\d+) principal representatives/.exec(line)[1]);
}
const perState = (m) => {
  assert.equal(m.instance.transitions % m.instance.states, 0, `every label in every state: ${JSON.stringify(m.instance)}`);
  return m.instance.transitions / m.instance.states;
};
const sameVerdicts = (a, b) => {
  assert.equal(a.verdict, b.verdict, `${text(a)} | ${text(b)}`);
  assert.deepEqual((a.machines ?? []).map((m) => [m.machine, m.verdict]), (b.machines ?? []).map((m) => [m.machine, m.verdict]));
  assert.deepEqual((a.configurations ?? []).map((c) => [c.configuration, c.verdict]), (b.configurations ?? []).map((c) => [c.configuration, c.verdict]));
};
const INBOUND_PER_PRINCIPAL = 6;
const GOT_PER_PRINCIPAL = 3;

// ── 1. principal from, in the channel's configuration ──

test('PS15.0a, PS15.5: a channel that declares principal from explores the Sender\'s principal with every representative in its configuration, and fixes distinct thread principals in its reached states', { timeout: 120_000 }, async () => {
  // Got takes no claims, so only principal from reads the Sender's principal.
  const from = await check(noClaims(TICKET));
  const without = await check(noClaims(noFrom(TICKET)));
  sameVerdicts(from, without);
  assert.equal(from.verdict, 'CLEAN', text(from));
  const f = configuration(from).instance;
  const w = configuration(without).instance;
  // Without either, nothing reads the principal: one value, and no thread principal in the global state. With
  // principal from, every state after the first Inbound is reached once for each representative it fixed, so the
  // configuration has more states. One value would fix one thread principal and add none.
  assert.ok(f.states > w.states, `principal from: ${JSON.stringify(f)}; neither: ${JSON.stringify(w)}`);
  assert.ok(f.transitions > w.transitions, `principal from: ${JSON.stringify(f)}; neither: ${JSON.stringify(w)}`);
});

// ── 2. principal from, on the conversation alone ──

test('PS15.0a: the conversation of a channel that declares principal from, checked alone, is offered Inbound with every representative of the Sender\'s principal; without the clause, by one value', { timeout: 120_000 }, async () => {
  for (const [label, src] of [['Got reads its claims', TICKET], ['Got takes no claims', noClaims(TICKET)]]) {
    const from = await check(src);
    const without = await check(noFrom(src));
    sameVerdicts(from, without);
    const f = conversation(from);
    const w = conversation(without);
    const p = representatives(f);
    assert.ok(p >= 2, JSON.stringify(f.instance));
    // The std conversation stores no principal, so its states are the same in both forms; only Inbound's labels grow,
    // from 6 per state (one value) to 6 x p (every representative).
    assert.equal(f.instance.states, w.instance.states, label);
    assert.equal(perState(f), perState(w) + INBOUND_PER_PRINCIPAL * (p - 1),
      `${label}: principal from ${JSON.stringify(f.instance)}; without ${JSON.stringify(w.instance)}`);
  }
});

// ── 3. a handler that reads the field ──

test('PS15.0a, PS4.1c: a machine whose handler reads a claims Principal field is explored with every representative; one whose handler never reads it, by one value', { timeout: 120_000 }, async () => {
  // No principal from, so only the ticket's handler can read the field.
  const reads = await check(compared(noFrom(TICKET)));
  const never = await check(unread(noFrom(TICKET)));
  sameVerdicts(reads, never);
  const r = machine(reads, 'Ticket');
  const u = machine(never, 'Ticket');
  const p = representatives(r);
  assert.ok(p >= 2, JSON.stringify(r.instance));
  // The compared field is never written, so the states are the same; Got's labels are 3 per state unread and 3 x p read.
  assert.equal(r.instance.states, u.instance.states);
  assert.equal(perState(r), perState(u) + GOT_PER_PRINCIPAL * (p - 1), `reads ${JSON.stringify(r.instance)}; never ${JSON.stringify(u.instance)}`);

  // Storing it reads it too: c.principal stored in who. Got carries every representative in every state.
  const stores = machine(await check(noFrom(TICKET)), 'Ticket');
  assert.equal(perState(stores), perState(u) + GOT_PER_PRINCIPAL * (p - 1), `stores ${JSON.stringify(stores.instance)}; never ${JSON.stringify(u.instance)}`);
  assert.ok(stores.instance.states > u.instance.states, 'each stored representative is a state of its own');

  // A handler that never reads it is explored by its first value: the same labels as a handler that takes no claims.
  const none = machine(await check(noClaims(noFrom(TICKET))), 'Ticket');
  assert.deepEqual([u.instance.states, u.instance.transitions], [none.instance.states, none.instance.transitions]);
});

test('PS15.0a, PS4.1c: outside a channel, a handler comparing a claims Principal field is offered every representative, and one that never reads it one value', { timeout: 120_000 }, async () => {
  const PLAIN = [
    '// PS15.0a: the one-value rule on a machine with no channel.',
    'module ovp_plain',
    '',
    'claims Caller {',
    '  principal: Principal',
    '}',
    '',
    'machine Desk {',
    '  state {',
    '    n     : 0..1      = 0',
    '    owner : Principal = none',
    '  }',
    '',
    '  action Hit()',
    '',
    '  on Hit by c: Caller {',
    '    require n == 0 else reject "done"',
    '    require c.principal != owner else reject "owner"',
    "    n' = 1",
    '  }',
    '}',
    '',
  ].join('\n');
  const reads = await check(PLAIN);
  const never = await check(swap(PLAIN, '    require c.principal != owner else reject "owner"\n', ''));
  sameVerdicts(reads, never);
  const r = machine(reads, 'Desk');
  const u = machine(never, 'Desk');
  const p = representatives(r);
  assert.equal(r.instance.states, u.instance.states);
  // Hit is the only action: one label per state unread, p read.
  assert.equal(perState(u), 1, JSON.stringify(u.instance));
  assert.equal(perState(r), p, JSON.stringify(r.instance));
});

// ── 4. the application's bound action takes claims ──

test('PS15.0a, PS15.4: in a channel configuration the Sender\'s principal is explored with every representative when the application\'s bound action takes claims, even with no principal from', { timeout: 120_000 }, async () => {
  const takes = await check(unread(noFrom(TICKET)));
  const neither = await check(noClaims(noFrom(TICKET)));
  sameVerdicts(takes, neither);
  const t = configuration(takes).instance;
  const w = configuration(neither).instance;
  // Got never reads the claims, so the ticket alone is the same in both; the configuration passes the claims with the
  // Message it delivers to Got, and each representative in transit is a state of its own.
  assert.deepEqual([machine(takes, 'Ticket').instance.states, machine(takes, 'Ticket').instance.transitions],
    [machine(neither, 'Ticket').instance.states, machine(neither, 'Ticket').instance.transitions]);
  assert.ok(t.states > w.states, `takes claims: ${JSON.stringify(t)}; neither: ${JSON.stringify(w)}`);
  assert.ok(t.transitions > w.transitions, `takes claims: ${JSON.stringify(t)}; neither: ${JSON.stringify(w)}`);
  // Without principal from the conversation alone does not read the principal: one value, as with neither.
  assert.deepEqual([conversation(takes).instance.states, conversation(takes).instance.transitions],
    [conversation(neither).instance.states, conversation(neither).instance.transitions]);
});

// ── neither: what it explored before S450 ──

test('PS15.0a: a channel with neither principal from nor an application action taking claims explores what it explored before S450', { timeout: 120_000 }, async () => {
  const src = noClaims(noFrom(TICKET));
  const now = await check(src);
  const before = await check(src, STD_BEFORE);
  sameVerdicts(now, before);
  const c = configuration(now).instance;
  const b = configuration(before).instance;
  assert.deepEqual([c.states, c.transitions], [b.states, b.transitions], `S450 kind ${JSON.stringify(c)}; before ${JSON.stringify(b)}`);
  assert.deepEqual([conversation(now).instance.states, conversation(now).instance.transitions],
    [conversation(before).instance.states, conversation(before).instance.transitions]);
});
