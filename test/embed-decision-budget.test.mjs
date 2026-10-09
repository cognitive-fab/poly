// S454 (PS18.4a, PT10r "Both surfaces"): the embedded form of a budget on an unrouted decision. The clause
// `prices "f" max input tokens I max tokens N budget b` is the decision item budget(b, { prices, maxInputTokens,
// maxTokens }), written after provider(...). A key left out reads as the part left out, so the checker gives the
// same PL1201 in either surface; an unknown key, a key written twice, a prices that is not a string literal or a limit
// that is not an integer literal is PL0301. The printer writes the item for a clause that names its budget, and says a
// clause with no budget name has no embedded form. In a declaration list, budget(name, { caps }) is still the budget.
// Written from the specification text alone; the text-form twin is test/fixtures/decision-budget/writer.poly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, stripped } from '@poly/core';
import { parse } from '@poly/lang';
import { printModule, readEmbedded } from '@poly/embed';
import { checkFile } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';

const TEXT_FIX = join(ROOT, 'test', 'fixtures', 'decision-budget');
const FIX = join(ROOT, 'test', 'fixtures', 'embed-decision-budget');
const POLY = readFileSync(join(TEXT_FIX, 'writer.poly'), 'utf8');
const TS = readFileSync(join(FIX, 'writer.ts'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-embed-decision-budget');
const CLAUSE = '    prices "prices/flash.json" max input tokens 2000 max tokens 4000 budget monthly\n';
const ITEM = 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: 4000 })';

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code).sort();
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const decisionOf = (m) => m.decls.find((d) => d.kind === 'Machine').items.find((i) => i.kind === 'Decision');
const clauseOf = (m) => decisionOf(m).items.find((i) => i.kind === 'DecBudget');

/** The first place two ASTs differ, for a failure message. */
function firstDifference(a, b) {
  const x = JSON.stringify(stripped(a)), y = JSON.stringify(stripped(b));
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `standalone …${x.slice(Math.max(0, i - 100), i + 60)}\nembedded   …${y.slice(Math.max(0, i - 100), i + 60)}`;
}

/** Reads an embedded source and asserts it read, for the tests that expect a module. */
function read(src, file = 'writer.ts') {
  const r = readEmbedded(src, file);
  assert.ok(r.module, JSON.stringify(r.diagnostics));
  return r.module;
}

let n = 0;
/** Checks a source (text or embedded) in a fresh directory holding the writer's price table, as poly-check reads it. */
async function check(src, name) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(TEXT_FIX, 'prices'), join(d, 'prices'), { recursive: true });
  writeFileSync(join(d, name), src);
  return { r: await checkFile(join(d, name), { root: d, std: TEST_STD }), build: join(d, '.poly', 'build') };
}

test('S454, PT10r: the decision item budget(b, { prices, maxInputTokens, maxTokens }) reads to the AST of the text clause', () => {
  const e = read(TS);
  const p = parse(POLY).module;
  assert.equal(digest(e), digest(p), firstDifference(p, e));
  // The item is the clause, not a declaration: the decision holds it after its provider, and one budget is declared.
  const items = decisionOf(e).items.map((i) => i.kind);
  assert.equal(items[0], 'DecProvider');
  assert.equal(items[1], 'DecBudget');
  const c = clauseOf(e);
  assert.deepEqual([c.budget, c.prices, c.maxInputTokens, c.maxTokens], ['monthly', 'prices/flash.json', 2000, 4000]);
  assert.deepEqual(e.decls.filter((d) => d.kind === 'Budget').map((d) => d.name), ['monthly']);
});

test('S454, PS18.4a: the embedded writer checks as its text twin, and its manifest entry records the same budget', { timeout: 300_000 }, async () => {
  const a = await check(POLY, 'writer.poly');
  const b = await check(TS, 'writer.ts');
  assert.equal(a.r.verdict, 'CLEAN', text(a.r));
  assert.equal(b.r.verdict, a.r.verdict, text(b.r));
  assert.deepEqual(codes(b.r), codes(a.r));
  const entry = (build) => json(join(build, 'writer.Draft', 'effects.manifest.json')).effects['decision.draft'].decision;
  assert.ok(entry(b.build).budget, JSON.stringify(entry(b.build)));
  assert.deepEqual(entry(b.build).budget, entry(a.build).budget);
  assert.deepEqual(json(join(b.build, 'budgets', 'monthly.json')), json(join(a.build, 'budgets', 'monthly.json')));
});

test('S454, PT10r: the printer writes the clause as the item after provider(...), and the print reads back to the same module', () => {
  const p = parse(POLY).module;
  const printed = printModule(p);
  // Spacing is the printer's; the call, its keys and their order are the specification's.
  const want = /provider\("flash"\),\s*budget\("monthly",\s*\{\s*prices:\s*"prices\/flash\.json",\s*maxInputTokens:\s*2000,\s*maxTokens:\s*4000\s*\}\)/;
  assert.match(printed, want);
  const back = read(printed);
  assert.equal(digest(back), digest(p), firstDifference(p, back));
  // The hand-written embedded source prints and reads back to itself too.
  const e = read(TS);
  const again = read(printModule(e));
  assert.equal(digest(again), digest(e), firstDifference(e, again));
});

test('S454, PT10r: a key left out reads as the part left out of the clause', () => {
  // The text parser's own reading of a part left out: `budget monthly` alone leaves out the prices and both limits.
  const bare = clauseOf(parse(swap(POLY, CLAUSE, '    budget monthly\n')).module);
  for (const key of ['prices', 'maxInputTokens', 'maxTokens']) {
    const kept = { prices: '"prices/flash.json"', maxInputTokens: '2000', maxTokens: '4000' };
    delete kept[key];
    const item = `budget("monthly", { ${Object.entries(kept).map(([k, v]) => `${k}: ${v}`).join(', ')} })`;
    const e = read(swap(TS, ITEM, item));
    // Expected: the full clause's AST with that one part as the text parser reads a part left out.
    const p = parse(POLY).module;
    clauseOf(p)[key] = bare[key];
    assert.equal(digest(e), digest(p), `${key}\n${firstDifference(p, e)}`);
  }
  // All three left out is the text form `budget monthly`.
  const e = read(swap(TS, ITEM, 'budget("monthly", {})'));
  const p = parse(swap(POLY, CLAUSE, '    budget monthly\n')).module;
  assert.equal(digest(e), digest(p), firstDifference(p, e));
});

test('S454, PT10r: a key left out is PL1201 at check, as the text form with that part left out is', { timeout: 300_000 }, async () => {
  // No maxTokens: the text grammar cannot leave out one limit alone, so the embedded check is read against PL1201.
  const noMax = await check(swap(TS, ITEM, 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000 })'), 'writer.ts');
  assert.equal(noMax.r.verdict, 'REFUSED', text(noMax.r));
  assert.ok(codes(noMax.r).includes('PL1201'), text(noMax.r));
  // Every key left out: the embedded form and the text form `budget monthly` give the same PL1201 and verdict.
  const a = await check(swap(POLY, CLAUSE, '    budget monthly\n'), 'writer.poly');
  const b = await check(swap(TS, ITEM, 'budget("monthly", {})'), 'writer.ts');
  assert.equal(a.r.verdict, 'REFUSED', text(a.r));
  assert.ok(codes(a.r).includes('PL1201'), text(a.r));
  assert.equal(b.r.verdict, a.r.verdict, text(b.r));
  assert.deepEqual(codes(b.r), codes(a.r));
});

test('S454, PT10r: an unknown key, a key written twice, a prices that is not a string or a limit that is not an integer is PL0301', () => {
  const cases = [
    ['unknown key', 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: 4000, cap: 1 })'],
    ['caps in a decision', 'budget("monthly", { caps: [{ currency: "usd", amount: 0.004, per: "month" }] })'],
    ['key written twice', 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: 4000, maxTokens: 4000 })'],
    ['prices written twice', 'budget("monthly", { prices: "prices/flash.json", prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: 4000 })'],
    ['prices a number', 'budget("monthly", { prices: 1, maxInputTokens: 2000, maxTokens: 4000 })'],
    ['prices a name', 'budget("monthly", { prices: $.flash, maxInputTokens: 2000, maxTokens: 4000 })'],
    ['input limit a decimal', 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000.5, maxTokens: 4000 })'],
    ['output limit a string', 'budget("monthly", { prices: "prices/flash.json", maxInputTokens: 2000, maxTokens: "4000" })'],
  ];
  for (const [why, item] of cases) {
    const r = readEmbedded(swap(TS, ITEM, item), 'writer.ts');
    assert.equal(r.module, null, why);
    assert.equal(r.diagnostics[0]?.code, 'PL0301', `${why}: ${JSON.stringify(r.diagnostics)}`);
  }
});

test('S454, PT10r: budget(name, { caps, onExhausted? }) in the declaration list is still the budget declaration', () => {
  // The writer with its decision's clause taken out, so this reads only what was built before S454. The clause and the
  // declaration together are read in the first test, which finds one Budget declaration.
  const TS0 = swap(TS, `        ${ITEM},\n`, '');
  const POLY0 = swap(POLY, CLAUSE, '');
  const e = read(TS0);
  const decl = e.decls.find((d) => d.kind === 'Budget');
  const p = parse(POLY0).module.decls.find((d) => d.kind === 'Budget');
  assert.equal(digest(decl), digest(p), firstDifference(p, decl));
  assert.equal(digest(e), digest(parse(POLY0).module));
  // With onExhausted, as the text form's `on exhausted escalate`.
  const ts = swap(TS0, '  ] }),\n]);', '  ], onExhausted: "escalate" }),\n]);');
  const poly = swap(POLY0, '  cap usd 0.004 per month\n', '  cap usd 0.004 per month\n  on exhausted escalate\n');
  const a = read(ts), b = parse(poly).module;
  assert.equal(a.decls.find((d) => d.kind === 'Budget').onExhausted, 'escalate');
  assert.equal(digest(a), digest(b), firstDifference(b, a));
});

test('S454, PT10r: a clause with no budget name has no embedded form, and printing one says so', { timeout: 300_000 }, async () => {
  const src = swap(POLY, CLAUSE, '    prices "prices/flash.json" max input tokens 2000 max tokens 4000\n');
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  assert.equal(clauseOf(p.module).budget, null);
  assert.throws(() => printModule(p.module), /no embedded form/);
  // It is PL1201 in the text surface.
  const { r } = await check(src, 'writer.poly');
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});
