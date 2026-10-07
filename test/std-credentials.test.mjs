// M9 step 6 (AC20, S204, S209; PS16): std.credentials. The Grant machine is CLEAN, free of deadlock, its refresh
// bounded, and its liveness ("a refresh ends in Granted, Expired or Revoked") holds under its stated fairness; a seeded
// mutant of each rule gives a finding with a witness; PROVENANCE.md names a source for every rule. Each credential is
// its own instance of the module, with its own scope set (PS16.1), checked like a channel's conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { parse, format } from '@poly/lang';
import { ROOT, TEST_STD } from './helpers.mjs';

const STD = join(ROOT, 'std', 'credentials');
const SRC = readFileSync(join(STD, 'grant.poly'), 'utf8');
const DESK = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'credentials.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-std-credentials');
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
let n = 0;
async function check(src, opts = {}, file = 'm.poly') {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), src);
  return checkFile(join(d, file), { root: d, ...opts });
}

/** One seeded mutant per rule: [handler, text, replacement], the text unique within that handler. */
const RULES = {
  'attempt-only-while-refreshing': ['Refreshed', "    attempt' = 0\n", "    attempt' = 1\n"],
  'refresh-keeps-scopes': ['Refreshed', "      g' = Granted\n", "      g' = Granted\n      scopes' = { first: true, second: true }\n"],
  'scopes-only-by-consent': ['TokenExpiring', "    attempt' = 1\n", "    attempt' = 1\n    scopes' = { first: true, second: false }\n"],
  'invalid-grant-expires': ['Refreshed', "    } else {\n      g' = Expired\n", "    } else {\n      g' = Granted\n"],
  'refresh-bounded': ['RefreshFailed', 'if attempt < 3 {', 'if attempt < 2 {'],
  // Review C1 (M9): the mutant is the code the review found, which skipped the revocation from Requested.
  'revoke-revokes-tokens': ['Revoke', '    emit revoke()\n', '    if g != Requested {\n      emit revoke()\n    }\n'],
  'refresh-ends': ['RefreshFailed', "attempt' = attempt + 1", "attempt' = attempt"],
};
function mutate(src, handler, from, to) {
  const start = src.search(new RegExp(`\n  on ${handler}[ ({]`));
  assert.ok(start >= 0, `no handler ${handler}`);
  const rest = src.slice(start + 1);
  const end = start + 1 + rest.search(/\n  (on |effect )/);
  const body = src.slice(start, end);
  assert.equal(body.split(from).length, 2, `${handler}: the mutant's text is not unique in the handler: ${from}`);
  return src.slice(0, start) + body.replace(from, to) + src.slice(end);
}
const ruleNames = (src) => [...src.matchAll(/^\s*(?:invariant|step property|liveness) ([a-z0-9-]+):/gm)].map((m) => m[1]);

test('AC20: std.credentials is CLEAN, free of deadlock, its refresh bounded, and its liveness holds under its fairness', { timeout: 300_000 }, async () => {
  assert.deepEqual(ruleNames(SRC).sort(), Object.keys(RULES).sort(), 'each rule has its seeded mutant');
  const parsed = parse(SRC);
  assert.equal(format(parsed.module, parsed.trivia), SRC, 'a std module is in canonical form');
  const r = await check(SRC, {}, 'grant.poly');
  assert.equal(r.verdict, 'CLEAN', text(r));
  const grant = r.machines.find((m) => m.machine === 'Grant');
  assert.deepEqual([grant.notRun, grant.vacuous], [[], []]);
  for (const s of ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', 'liveness']) {
    const st = grant.stages.find((x) => x.stage === s);
    assert.deepEqual([s, st?.status, st?.verdict], [s, 'ran', 'CLEAN']);
  }
  // The refresh is bounded by the type of attempt, and each bound is reached: three attempts, then Expired.
  assert.match(SRC, /attempt : 0\.\.3 = 0/);
});

for (const [rule, [handler, from, to]] of Object.entries(RULES)) {
  test(`AC20: the seeded mutant of ${rule} gives a finding with a witness`, { timeout: 300_000 }, async () => {
    const r = await check(mutate(SRC, handler, from, to), {}, 'grant.poly');
    const f = all(r).find((d) => d.message.includes(rule));
    assert.ok(f, text(r));
    assert.ok(f.witness?.trace?.length || f.witness?.length, JSON.stringify(f));
  });
}

test('AC20: PROVENANCE.md names a source and the date for every rule and constant', () => {
  const prov = readFileSync(join(STD, 'PROVENANCE.md'), 'utf8');
  assert.match(prov, /read on 2026-10-06/);
  const own = prov.slice(prov.indexOf("## poly's own rules"), prov.indexOf('## Not checked'));
  for (const rule of Object.keys(RULES)) {
    const row = prov.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${rule}\``));
    assert.ok(row && (/https:\/\//.test(row) || own.includes(row)), `${rule}: no row with a source, and not listed as poly's own`);
  }
  for (const [, c] of SRC.matchAll(/\b(\d+(?:ms|s|m|h))\b/g)) assert.ok(prov.includes(`\`${c}\``), `${c}: not in PROVENANCE.md`);
});

test('the tests\' std holds std.credentials byte for byte', () => {
  assert.equal(readFileSync(join(TEST_STD, 'credentials', 'grant.poly'), 'utf8'), SRC);
});

test('PS16.1: each credential is its own Grant, over its own scope set, checked and read back like a channel\'s conversation', { timeout: 300_000 }, async () => {
  const r = await check(DESK, { std: TEST_STD });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const names = r.machines.map((m) => m.machine).sort();
  assert.deepEqual(names, ['Desk', 'payments.Grant', 'reports.Grant']);
  for (const m of r.machines.filter((x) => x.machine.endsWith('.Grant'))) {
    assert.equal(m.stages.find((s) => s.stage === 'translation-validation').verdict, 'CLEAN', m.machine);
    assert.equal(m.stages.find((s) => s.stage === 'liveness').verdict, 'CLEAN', m.machine);
  }
  const contract = (c) => JSON.parse(readFileSync(join(r.machines.find((m) => m.machine === `${c}.Grant`).buildDir, 'contract.json'), 'utf8'));
  // Two declared scopes give four scope sets, one gives two (PS16.1, PT22.2b).
  assert.deepEqual(contract('payments').dataDomain.Callback.granted.length, 4);
  assert.deepEqual(contract('reports').dataDomain.Callback.granted.length, 2);
  assert.deepEqual(Object.keys(contract('payments').dataDomain.Callback.granted[0]).sort(), ['charges_read', 'refunds_write']);
});

test('PS16.1: two scopes of one credential that give one field name are PL1002', { timeout: 120_000 }, async () => {
  const r = await check(swap(DESK, 'scopes { reports.read }', 'scopes { reports.read, reports_read }'), { std: TEST_STD });
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL1002' && /reports_read/.test(d.message)), text(r));
});
