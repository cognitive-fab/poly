// M7.5 (PS18.7, PT10, PT24.6): workflow budgets. A workflow names a budget with `budget b prices "f" order cap usd 0.05`,
// written once, after its tools. The descriptor polyflow.workflow.json gains `budget: { budget, prices: { path, digest, currency, perMillionTokens }, orderCap }`,
// the module's budgets/<b>.json is written for it, and poly-ref reads the descriptor back against the source.
// The broken lowerings `workflow-budget-dropped` and `workflow-order-cap-raised` are caught by translation validation.
// The certificate's entry for the workflow gains `budget: { budget, prices, orderCap, usage: "self-reported", bound: "reservation" }`, and K16 joins kernelAssumptions.
// Written from the specification text alone (M7.5, S359 to S524, PS18.7, PT10, PT24.6, K16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, stripped } from '@poly/core';
import { parse, format } from '@poly/lang';
import { checkFile, admit } from '@poly/check';
import { printModule, readEmbedded } from '@poly/embed';
import { translationValidate } from '@poly/ref';
import { ROOT, TEST_STD, polyFiles, build } from './helpers.mjs';
import { DELIBERATELY_BROKEN_LOWERINGS, FAULT_SOURCES } from './toolchain-faults.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'm7', 'workflow-budget');
const OUT = join(ROOT, '.poly', 'test-workflow-budget');
const SRC = readFileSync(join(FIX, 'desk.poly'), 'utf8');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const workflowOf = (m) => m.decls.find((d) => d.kind === 'Workflow');
const budgetOf = (w) => w ? w.budget : null;

/** The first place two ASTs differ, for a failure message. */
function firstDifference(a, b) {
  const x = JSON.stringify(stripped(a)), y = JSON.stringify(stripped(b));
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `standalone …${x.slice(Math.max(0, i - 100), i + 60)}\nembedded   …${y.slice(Math.max(0, i - 100), i + 60)}`;
}

let n = 0;
/** Checks a source in a fresh directory holding the fixture's price tables. */
async function check(src, name = 'desk.poly', files = {}) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(d, rel, '..'), { recursive: true }); writeFileSync(join(d, rel), text); }
  writeFileSync(join(d, name), src);
  return { r: await checkFile(join(d, name), { root: d, std: TEST_STD }), dir: d, build: join(d, '.poly', 'build') };
}

// F1: Parse and check CLEAN with budget clause
test('PT10, PS18.7: a workflow with a budget clause parses, formats back to itself, and checks CLEAN', async () => {
  const { r } = await check(SRC);
  assert.ok(!codes(r).includes('PL1201') && !codes(r).includes('PL1001'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  const m = parse(SRC);
  const w = workflowOf(m.module);
  assert.equal(w.name, 'desk');
  assert.equal(w.machine, 'Desk');
  assert.equal(w.input, 'Start');
  const b = budgetOf(w);
  assert.ok(b, 'workflow has no budget clause');
  assert.equal(b.name, 'spend');
  assert.equal(b.prices, 'prices/agent.json');
  assert.deepEqual(b.orderCap, { currency: 'usd', amount: 50000 });
  assert.equal(format(m.module, m.trivia), SRC, 'formatted source does not match original');
});

// F1: Budget clause must be written once, after tools
test('PT10, PS18.7: a budget clause before the tools, or written twice, is a parse error (PL0001), and the control parses', async () => {
  assert.equal(codes(await check(SRC).then((x) => x.r)).includes('PL0001'), false, 'the control');
  const withBudgetBeforeTools = SRC.replace('  tool "desk.draft"', '  budget spend prices "prices/agent.json" order cap usd 0.05\n  tool "desk.draft"');
  const { r: r1 } = await check(withBudgetBeforeTools);
  assert.ok(codes(r1).includes('PL0001'), text(r1));

  const withBudgetTwice = SRC.replace(/budget spend prices.*\n/, (m) => m + m);
  const { r: r2 } = await check(withBudgetTwice);
  assert.ok(codes(r2).includes('PL0001'), text(r2));
});

// F2: Embedded TypeScript surface
test('PT10, PT2.5: the embedded form reads a workflow budget to the same AST, and prints it back', async () => {
  const p = parse(SRC).module;
  const ts = printModule(p);
  assert.match(ts, /budget:\s*\{\s*name:\s*"spend",\s*prices:\s*"prices\/agent.json",\s*orderCap:\s*\{\s*currency:\s*"usd",\s*amount:\s*0\.05/);
  const b = readEmbedded(ts, 'desk.ts');
  assert.ok(b.module, JSON.stringify(b.diagnostics));
  assert.equal(strip(b.module), strip(p), firstDifference(p, b.module));
  assert.deepEqual(b.module.decls.find((d) => d.kind === 'Workflow').budget.orderCap, { currency: 'usd', amount: 50000 });
  assert.equal(strip(readEmbedded(printModule(b.module), 'desk.ts').module), strip(p), 'printing the read module and reading it again changes nothing');
});

/** Stripped JSON of an AST for comparison. */
function strip(x) {
  return JSON.stringify(x, (k, v) => (k === 'span' || k === 'id' ? undefined : v));
}

// F3: Checks with positive controls
test('PT10, PS18.7: PL1001 when b is not a budget of the module', async () => {
  const pos = await check(SRC);
  assert.ok(!codes(pos.r).some((c) => c === 'PL1001'), 'positive control failed: ' + text(pos.r));

  const neg = await check(swap(SRC, 'budget spend prices', 'budget nowhere prices'));
  assert.ok(codes(neg.r).includes('PL1001'), text(neg.r));
});

test('PT10, PS18.7: PL6843 when the price table lacks a source or a date it was read', async () => {
  const pos = await check(SRC);
  assert.ok(!codes(pos.r).includes('PL6843'), 'positive control failed: ' + text(pos.r));
  for (const field of ['source', 'readOn']) {
    const table = json(join(FIX, 'prices', 'agent.json'));
    delete table[field];
    const { r } = await check(SRC, 'desk.poly', { 'prices/agent.json': JSON.stringify(table) });
    assert.ok(codes(r).includes('PL6843'), field + ': ' + text(r));
  }
});

test('PT10, PS18.7: PL1201 for a price table that is malformed, a path that is not well formed and an order cap of 0; PL1001 for a path with no file', async () => {
  const malformed = await check(swap(SRC, '"prices/agent.json"', '"prices/malformed.json"'), 'desk.poly', { 'prices/malformed.json': JSON.stringify({ v: 1, provider: 'agent' }) });
  assert.ok(codes(malformed.r).includes('PL1201'), 'malformed price table: ' + text(malformed.r));
  const dots = await check(swap(SRC, '"prices/agent.json"', '"../agent.json"'));
  assert.ok(codes(dots.r).includes('PL1201'), 'a path with .. in it: ' + text(dots.r));
  const none = await check(swap(SRC, '"prices/agent.json"', '"prices/nothing.json"'));
  assert.ok(codes(none.r).includes('PL1001'), 'a path with no file: ' + text(none.r));
  const zeroCap = await check(swap(SRC, 'order cap usd 0.05', 'order cap usd 0'));
  assert.ok(codes(zeroCap.r).includes('PL1201'), 'zero order cap: ' + text(zeroCap.r));
  assert.ok(!codes((await check(SRC)).r).includes('PL1201'), 'the control');
});

test('PT10, PS18.7: PL6844 when order cap currency differs from budget or table currency', async () => {
  const pos = await check(SRC);
  assert.ok(!codes(pos.r).includes('PL6844'), 'positive control failed: ' + text(pos.r));

  const wrongCurrency = swap(SRC, 'order cap usd 0.05', 'order cap eur 0.05');
  const { r } = await check(wrongCurrency);
  assert.ok(codes(r).includes('PL6844'), text(r));
});

test('PT10, PS18.7: PL6845 when order cap exceeds a cap of the budget that applies', async () => {
  const pos = await check(SRC);
  assert.ok(!codes(pos.r).includes('PL6845'), 'positive control failed: ' + text(pos.r));

  const tooHigh = swap(SRC, 'order cap usd 0.05', 'order cap usd 0.20');
  const { r } = await check(tooHigh);
  assert.ok(codes(r).includes('PL6845'), 'order cap exceeds per-run cap: ' + text(r));
});

// F4: Lowering
test('PT10, PS18.7: the descriptor polyflow.workflow.json gains budget with digest and the budgets json is written', async () => {
  const { r, build: buildDir } = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const d = json(join(buildDir, 'workflows', 'desk', 'polyflow.workflow.json'));
  assert.ok(d.budget, 'descriptor has no budget field');
  assert.equal(d.budget.budget, 'spend');
  assert.equal(d.budget.prices.path, 'prices/agent.json');
  assert.ok(d.budget.prices.digest, 'prices digest is missing');
  assert.equal(d.budget.prices.currency, 'usd');
  assert.ok(d.budget.prices.perMillionTokens, 'perMillionTokens missing');
  assert.deepEqual(d.budget.orderCap, 50000);

  const budgetFile = json(join(buildDir, 'budgets', 'spend.json'));
  assert.equal(budgetFile.budget, 'spend');
  assert.equal(budgetFile.module, 'desk');
  assert.ok(budgetFile.machine);
  assert.ok(budgetFile.caps.length > 0);
});

test('PT10, PS18.7: a workflow without a budget has no budget key in the descriptor', async () => {
  const noBudget = swap(SRC, '  budget spend prices "prices/agent.json" order cap usd 0.05\n', '');
  const { r, build: buildDir } = await check(noBudget);
  const d = json(join(buildDir, 'workflows', 'desk', 'polyflow.workflow.json'));
  assert.ok(!d.budget, 'descriptor should not have budget field: ' + JSON.stringify(d.budget));
});

// F5: Poly-ref read-back and toolchain faults
test('PT10, PS18.7: the broken lowering workflow-budget-dropped is caught by translation validation', { timeout: 300_000 }, async () => {
  const good = build(join(FIX, 'desk.poly'), 'tv-good');
  const bad = build(join(FIX, 'desk.poly'), 'tv-workflow-budget-dropped', { fault: 'workflow-budget-dropped' });
  const g = good[0];
  const b = bad[0];

  const goodDesc = json(join(g.dir, '..', 'workflows', 'desk', 'polyflow.workflow.json'));
  const badDesc = json(join(b.dir, '..', 'workflows', 'desk', 'polyflow.workflow.json'));

  assert.ok(goodDesc.budget, 'good lowering should have budget');
  assert.ok(!badDesc.budget, 'bad lowering should drop budget');

  const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });
  assert.ok(r.mismatches.length > 0, 'translation validation should catch the fault');
  assert.ok(r.mismatches.every((d) => d.code === 'PL2501'), 'all mismatches should be PL2501');
});

test('PT10, PS18.7: the broken lowering workflow-order-cap-raised is caught by translation validation', { timeout: 300_000 }, async () => {
  const good = build(join(FIX, 'desk.poly'), 'tv-good-2');
  const bad = build(join(FIX, 'desk.poly'), 'tv-workflow-order-cap-raised', { fault: 'workflow-order-cap-raised' });
  const g = good[0];
  const b = bad[0];

  const goodDesc = json(join(g.dir, '..', 'workflows', 'desk', 'polyflow.workflow.json'));
  const badDesc = json(join(b.dir, '..', 'workflows', 'desk', 'polyflow.workflow.json'));

  assert.equal(goodDesc.budget.orderCap, 50000);
  assert.ok(badDesc.budget.orderCap > 50000, 'bad lowering should raise order cap');

  const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });
  assert.ok(r.mismatches.length > 0, 'translation validation should catch the fault');
  assert.ok(r.mismatches.every((d) => d.code === 'PL2501'), 'all mismatches should be PL2501');
});

// F6: Certificate
test('PS18.7, K16: the certificate lists the workflow budget with self-reported usage and reservation bound', { timeout: 300_000 }, async () => {
  const key = makeKey('workflow-budget-cert');
  const dir = project('workflow-budget-cert', ['test/fixtures/m7/workflow-budget/desk.poly'], key, 'workflow-budget-cert');
  cpSync(join(FIX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  const a = await admit(dir);

  assert.ok(a.certificate.poly.workflows, 'certificate has no workflows');
  const wf = a.certificate.poly.workflows.find((w) => w.name === 'desk');
  assert.ok(wf, 'certificate does not list desk workflow');

  assert.ok(wf.budget, 'workflow certificate entry has no budget');
  assert.equal(wf.budget.budget, 'spend');
  assert.equal(wf.budget.orderCap, 50000);
  assert.equal(wf.budget.usage, 'self-reported');
  assert.equal(wf.budget.bound, 'reservation');
  assert.ok(wf.budget.prices, 'budget entry has no prices');
  assert.ok(wf.budget.prices.digest, 'prices digest missing');
  assert.equal(wf.budget.prices.currency, 'usd');
  assert.ok(wf.budget.prices.path);

  assert.ok(a.certificate.kernelAssumptions.includes('K16'), 'K16 not in kernel assumptions: ' + JSON.stringify(a.certificate.kernelAssumptions));
});

test('PS18.7, K16: a workflow without a budget does not list K16 in kernel assumptions', { timeout: 300_000 }, async () => {
  const key = makeKey('workflow-no-budget-cert');
  const noBudgetSrc = swap(SRC, '  budget spend prices "prices/agent.json" order cap usd 0.05\n', '');
  const dir = project('workflow-no-budget-cert', ['test/fixtures/m7/workflow-budget/desk.poly'], key, 'workflow-no-budget-cert');
  writeFileSync(join(dir, 'src', 'desk.poly'), noBudgetSrc);
  const a = await admit(dir);

  const wf = a.certificate.poly.workflows.find((w) => w.name === 'desk');
  assert.ok(!wf.budget, 'workflow without budget should not have budget entry');
  assert.ok(!a.certificate.kernelAssumptions.includes('K16'), 'K16 should not be listed without a budget workflow');
});

// Note on assumptions made where spec is silent:
// 1. The prices digest is computed as SHA-256 of the price table bytes, as specified for routes (PT10r).
// 2. The currency and perMillionTokens from the price table are certified as-is, matching decision-budget structure.
// 3. The budget machine instance naming follows the existing budget convention: the module name and 'budgets' directory.
// 4. K16 is listed in kernelAssumptions exactly when a workflow names a budget, matching the spec rule.
// 5. Order cap is stored as micro-units (50000 for 0.05 usd) in the descriptor, matching the semantic requirement.
