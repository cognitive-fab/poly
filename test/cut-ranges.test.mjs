// S458, PS4.1h, PT3.3a: a range parameter read only against integer constants, or passed unchanged into the payload
// of an effect, is cut. **check** offers it at the least value of each class its cut points make, the verdict prints
// its domain, cut points and representatives (PT12.3a), the contract's dataDomain lists the representatives, and the
// runtime still accepts every value of the range and refuses one outside it (PS3.2, S400). Written from the
// specification text alone, before the change.
//
// The observations are the instance every verdict prints (PT12.3a): its `domains` lines and its `states` and
// `transitions`. A machine checked alone is offered every label in every state, its terminal state included (measured
// on test/fixtures/cut-ranges/refunds.poly before S458: 5 states and the 501 values of Ask.amount give 2,505
// transitions). So the labels per state are transitions / states, and with Ask the only action they are the number
// of values Ask.amount is explored at. The full-domain variants use 0..20 so each check stays within seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { translationValidate } from '@poly/ref';
import { ROOT, build, requireModule } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'cut-ranges');
const REFUNDS = readFileSync(join(FIX, 'refunds.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-cut-ranges');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;

let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  const r = await checkFile(join(d, 'm.poly'), { root: d });
  assert.ok(!r.error, text(r));
  return r;
}
/** Writes a source to a file of its own and lowers it with the test helpers (PT3.3a: contract.json). */
function lower(src, name) {
  const d = join(OUT, `build-${name}`);
  mkdirSync(d, { recursive: true });
  const file = join(d, `${name}.poly`);
  writeFileSync(file, src);
  return build(file, `cut-ranges-${name}`);
}
const machine = (r, name = 'Refunds') => { const m = (r.machines ?? []).find((x) => x.machine === name); assert.ok(m?.instance, `${name}: ${text(r)}`); return m; };
const domains = (m) => m.instance.domains ?? [];
const hasLine = (m, line) => assert.ok(domains(m).includes(line), `expected ${JSON.stringify(line)} in ${JSON.stringify(domains(m))}`);
const perState = (m) => {
  assert.equal(m.instance.transitions % m.instance.states, 0, `every label in every state: ${JSON.stringify(m.instance)}`);
  return m.instance.transitions / m.instance.states;
};
const sameVerdicts = (a, b) => {
  assert.equal(a.verdict, b.verdict, `${text(a)} | ${text(b)}`);
  assert.deepEqual((a.machines ?? []).map((m) => [m.machine, m.verdict]), (b.machines ?? []).map((m) => [m.machine, m.verdict]));
  assert.deepEqual((a.configurations ?? []).map((c) => [c.configuration, c.verdict]), (b.configurations ?? []).map((c) => [c.configuration, c.verdict]));
  const codes = (r) => all(r).map((d) => d.code).sort();
  assert.deepEqual(codes(a), codes(b), `${text(a)} | ${text(b)}`);
};

// The small form: Ask.amount ∈ 0..20, compared with 10. Cut, it is explored at {0, 11}; with the reduction off, at
// its 21 values.
const SMALL = swap(swap(REFUNDS, '0..500', '0..20'), 'amount > 100', 'amount > 10');
const SMALL_LINE = 'Ask.amount ∈ 0..20 at {0, 11} cut by {10} (S458)';

// ── 1. the reduction, its instance line and its counts ──

test('S458, PS4.1h, PT3.3a: a range compared only with a constant and emitted unchanged is explored at its representatives {0, 101}, and the instance prints its domain, representatives and cut points', { timeout: 120_000 }, async () => {
  const r = await check(REFUNDS);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const m = machine(r);
  hasLine(m, 'Ask.amount ∈ 0..500 at {0, 101} cut by {100} (S458)');
  // Ask is the only action: two labels per state, one per class, where 501 were offered before.
  assert.equal(perState(m), 2, JSON.stringify(m.instance));
  // The parameter is never stored, so the reduction changes no state: n ∈ 0..2 and big, five reachable states.
  assert.equal(m.instance.states, 5, JSON.stringify(m.instance));
});

test('PS4.1h: the classes follow each comparison as written: >= 10 gives {0, 10}, != 7 gives {0, 7}, since 8 is equivalent to 0', { timeout: 120_000 }, async () => {
  const ge = machine(await check(swap(SMALL, 'amount > 10', 'amount >= 10')));
  hasLine(ge, 'Ask.amount ∈ 0..20 at {0, 10} cut by {10} (S458)');
  assert.equal(perState(ge), 2, JSON.stringify(ge.instance));
  const ne = machine(await check(swap(SMALL, 'amount > 10', 'amount != 7')));
  hasLine(ne, 'Ask.amount ∈ 0..20 at {0, 7} cut by {7} (S458)');
  assert.equal(perState(ne), 2, JSON.stringify(ne.instance));
  // The constant on the left is the same comparison: 10 < amount is amount > 10.
  const left = machine(await check(swap(SMALL, 'amount > 10', '10 < amount')));
  hasLine(left, SMALL_LINE);
});

// ── 2. each use that turns the reduction off ──

const SINK = [
  '',
  'service machine Sink {',
  '  state { k : 0..1 = 0 }',
  '  action Got(v: 0..20)',
  '  on Got(v) { k\' = 1 }',
  '}',
  '',
].join('\n');

const OFF = [
  // Arithmetic.
  ['arithmetic', (s) => swap(s, 'amount > 10', 'amount + 1 > 11')],
  // A comparison with a field.
  ['a comparison with a field', (s) => swap(swap(s, '    big : bool = false\n', '    big : bool = false\n    limit : 0..20 = 10\n'), 'amount > 10', 'amount > limit')],
  // A write to a field: a stored value can be compared after storage.
  ['a write to a field', (s) => swap(swap(s, '    big : bool = false\n', '    big : bool = false\n    last : 0..20 = 0\n'), "    n' = n + 1\n", "    n' = n + 1\n    last' = amount\n")],
  // A let.
  ['a let', (s) => swap(s, '    if amount > 10 {', '    let a = amount\n    if a > 10 {')],
  // An argument of a send.
  ['a send argument', (s) => swap(swap(swap(s, '    big : bool = false\n', '    big : bool = false\n    peer : Ref<Sink> = none\n'), "    n' = n + 1\n", "    n' = n + 1\n    send peer <- Got(v: amount)\n"), '\nmachine Refunds', `${SINK}\nmachine Refunds`)],
];

test('S458 (1), PS4.1h: arithmetic, a comparison with a field, a write to a field, a let or a send argument each turns the reduction off, and Ask.amount is explored at its 21 values', { timeout: 300_000 }, async () => {
  for (const [label, variant] of OFF) {
    const m = machine(await check(variant(SMALL)));
    assert.equal(perState(m), 21, `${label}: ${JSON.stringify(m.instance)}`);
    assert.ok(!domains(m).some((l) => /^Ask\.amount .*\(S458\)$/.test(l)), `${label}: no cut line in ${JSON.stringify(domains(m))}`);
  }
  // The same source without the use is cut.
  const cut = machine(await check(SMALL));
  hasLine(cut, SMALL_LINE);
  assert.equal(perState(cut), 2, JSON.stringify(cut.instance));
});

test('S458 (1), PS4.1h: a comparison with another parameter turns the reduction off for both', { timeout: 120_000 }, async () => {
  const src = swap(swap(swap(SMALL, 'action Ask(amount: 0..20)', 'action Ask(amount: 0..20, cap: 0..1)'), 'on Ask(amount)', 'on Ask(amount, cap)'), 'amount > 10', 'amount > cap');
  const m = machine(await check(src));
  // 21 values of amount times 2 of cap: neither is cut.
  assert.equal(perState(m), 42, JSON.stringify(m.instance));
  assert.ok(!domains(m).some((l) => /\(S458\)$/.test(l) && /^Ask\./.test(l)), JSON.stringify(domains(m)));
});

// ── 3. cut points from properties ──

test('S458 (2), PS4.1h, PS5.2: the constant of emits(refund, amount: 7) in a step property is a cut point, read as amount == 7', { timeout: 120_000 }, async () => {
  // The property holds on every accepted step (n\' = n + 1 >= 1): it only adds its constant.
  const src = swap(REFUNDS, '  effect refund(', '  step property seven-counted: emits(refund, amount: 7) implies post.n > 0\n\n  effect refund(');
  const r = await check(src);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const m = machine(r);
  // Classes by PS4.1h's equivalence: 0..6 and 8..100 (one class, both outcomes alike), 7, and 101..500.
  hasLine(m, 'Ask.amount ∈ 0..500 at {0, 7, 101} cut by {7, 100} (S458)');
  assert.equal(perState(m), 3, JSON.stringify(m.instance));
});

test('S458 (2), PS4.1h, PS5.2a: a never emit refund(amount: 7) adds 7 as a cut point, and its violation, reachable only at 7, is still found', { timeout: 120_000 }, async () => {
  // Ask(101) sets big; Ask(7) then emits refund(7) while big. Without 7 among the representatives the never would hold.
  const src = swap(REFUNDS, '  effect refund(', '  never no-seven-when-big: emit refund(amount: 7) while big\n\n  effect refund(');
  const r = await check(src);
  assert.equal(r.verdict, 'FINDINGS', text(r));
  assert.equal(machine(r).verdict, 'FINDINGS', text(r));
  hasLine(machine(r), 'Ask.amount ∈ 0..500 at {0, 7, 101} cut by {7, 100} (S458)');
  // The same never on 99, a value inside the class 8..100, gives its own cut points.
  const other = machine(await check(swap(src, 'emit refund(amount: 7)', 'emit refund(amount: 99)')));
  hasLine(other, 'Ask.amount ∈ 0..500 at {0, 99, 101} cut by {99, 100} (S458)');
  assert.equal(other.verdict, 'FINDINGS');
});

// ── 4. a guard ──

test('S458 (2), PS4.1h: a guard comparing the parameter with a constant adds its cut point', { timeout: 120_000 }, async () => {
  const src = swap(REFUNDS, '  terminal n == 2\n', '  terminal n == 2\n  guard all when action == Ask && amount > 400 reject "too-big"\n');
  const r = await check(src);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const m = machine(r);
  hasLine(m, 'Ask.amount ∈ 0..500 at {0, 101, 401} cut by {100, 400} (S458)');
  assert.equal(perState(m), 3, JSON.stringify(m.instance));
});

// ── 5. no cut point ──

test('PT3.3a: a parameter never used, or only emitted unchanged, has no cut point and is explored at {lo}', { timeout: 120_000 }, async () => {
  const note = swap(swap(REFUNDS, '  action Ask(amount: 0..500)\n', '  action Ask(amount: 0..500)\n  action Note(tag: 3..9)\n'),
    '  effect refund(', '  on Note(tag) {\n    require n < 2 else reject "full"\n    n\' = n + 1\n  }\n\n  effect refund(');
  const m = machine(await check(note));
  hasLine(m, 'Note.tag ∈ 3..9 at {3} (S458)');
  hasLine(m, 'Ask.amount ∈ 0..500 at {0, 101} cut by {100} (S458)');
  // Two labels of Ask and one of Note in every state.
  assert.equal(perState(m), 3, JSON.stringify(m.instance));

  // Emitted unchanged and compared with nothing.
  const emitted = machine(await check(swap(REFUNDS, '    if amount > 100 {\n      big\' = true\n    }\n', '')));
  hasLine(emitted, 'Ask.amount ∈ 0..500 at {0} (S458)');
  assert.equal(perState(emitted), 1, JSON.stringify(emitted.instance));
});

// ── 6. the verdict is unchanged ──

test('PS4.1h lemma (cut invariance): an invariant broken only above the cut is found with and without the reduction, and a clean program stays clean', { timeout: 300_000 }, async () => {
  // `amount + 1 > 11` is the same test written with arithmetic, which turns the reduction off.
  const unreduce = (s) => swap(s, 'amount > 10', 'amount + 1 > 11');
  const broken = swap(SMALL, '  action Ask(', '  invariant small: !big\n\n  action Ask(');
  const [rb, ub] = [await check(broken), await check(unreduce(broken))];
  assert.equal(rb.verdict, 'FINDINGS', text(rb));
  sameVerdicts(rb, ub);
  assert.equal(perState(machine(ub)), 21);

  const [rc, uc] = [await check(SMALL), await check(unreduce(SMALL))];
  assert.equal(rc.verdict, 'CLEAN', text(rc));
  sameVerdicts(rc, uc);
  // Same states: the reduction narrows the labels and never the reachable states.
  assert.equal(machine(rc).instance.states, machine(uc).instance.states);
  // Last, since it needs S458: the reduced forms explored two values of Ask.amount and gave the same verdicts.
  assert.equal(perState(machine(rb)), 2, JSON.stringify(machine(rb).instance));
  assert.equal(perState(machine(rc)), 2, JSON.stringify(machine(rc).instance));
});

// ── 7. the runtime accepts what it accepted ──

test('PS4.1h, PS3.2, S400: the lowered acceptor still takes 37 and 250, which check never offers, and refuses 501 and -1 outside-check-domain', () => {
  const [b] = lower(REFUNDS, 'runtime');
  const dispatch = (data) => {
    const mod = requireModule(b.dir);
    mod.init();
    mod.setState({ ...b.lowered.contract.initState });
    const before = mod.getState();
    mod.actions.Ask(data);
    return { step: mod.instance({}).lastStep(), before, after: mod.getState() };
  };
  for (const amount of [37, 250, 100, 101, 500]) {
    const { step, after } = dispatch({ amount });
    assert.notEqual(step.classification, 'rejected', `${amount}: ${JSON.stringify(step)}`);
    assert.equal(after.n, 1, String(amount));
    assert.equal(after.big, amount > 100, String(amount));
  }
  for (const amount of [501, -1]) {
    const { step, before, after } = dispatch({ amount });
    assert.equal(step.classification, 'rejected', String(amount));
    assert.equal(step.rejections[0]?.reason, 'outside-check-domain', String(amount));
    assert.deepEqual(after, before);
  }
});

// ── 8. the contract and its read-back ──

test('PT3.3a: the contract\'s dataDomain lists the representatives, and translation validation reads it back: another list is a finding', { timeout: 300_000 }, async () => {
  const [b] = lower(REFUNDS, 'contract');
  const contract = JSON.parse(readFileSync(join(b.dir, 'contract.json'), 'utf8'));
  assert.deepEqual(contract.dataDomain.Ask.amount, [0, 101]);
  const good = await translationValidate(b.module, 'Refunds', b.dir);
  assert.deepEqual(good.mismatches, [], JSON.stringify(good.mismatches));

  const dir = join(OUT, 'tv-bad');
  rmSync(dir, { recursive: true, force: true });
  cpSync(b.dir, dir, { recursive: true });
  const full = Array.from({ length: 501 }, (_, i) => i);
  for (const wrong of [[0, 100], [0], [0, 101, 250], full]) {
    writeFileSync(join(dir, 'contract.json'), JSON.stringify({ ...contract, dataDomain: { ...contract.dataDomain, Ask: { ...contract.dataDomain.Ask, amount: wrong } } }));
    const tv = await translationValidate(b.module, 'Refunds', dir);
    assert.ok(tv.mismatches.length > 0, `dataDomain ${wrong.length > 4 ? '0..500' : JSON.stringify(wrong)} is read back as a disagreement`);
  }
});

// ── 9. a configuration ──

test('PS4.1h, PS13: a declared configuration offers the instance\'s inputs at the same representatives', { timeout: 300_000 }, async () => {
  const CONF = '\nconfiguration desk {\n  r : Refunds\n  inputs { r.Ask }\n  bounds { transit 1 }\n}\n';
  const reduced = await check(SMALL + CONF);
  const full = await check(swap(SMALL, 'amount > 10', 'amount + 1 > 11') + CONF);
  sameVerdicts(reduced, full);
  const conf = (r) => { const c = (r.configurations ?? []).find((x) => x.configuration === 'desk'); assert.ok(c?.instance, text(r)); return c.instance; };
  const [c, f] = [conf(reduced), conf(full)];
  assert.equal(c.states, f.states, `reduced ${JSON.stringify(c)}; full ${JSON.stringify(f)}`);
  // Each global state where Ask is offered gets 2 labels reduced and 21 full.
  assert.ok(f.transitions > 0, JSON.stringify(f));
  assert.equal(c.transitions * 21, f.transitions * 2, `reduced ${JSON.stringify(c)}; full ${JSON.stringify(f)}`);
});
