// PS23.5, PS23.8, PT33.1-33.7: retry safety of irreversible effects (S526)
// DAC1, DAC2: PL4003 with witness parts; G1/G2 eliminate it; grammar bounds; PL4004 horizons
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkFile, exportWitness, findWitness } from '@poly/check';
import { render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const OUT = join(BUILD, 's526-rule');
mkdirSync(OUT, { recursive: true });

const BASE_PATH = join(ROOT, 'test', 'fixtures', 's526', 'rule', 'base.poly');
const base = readFileSync(BASE_PATH, 'utf8');

function variant(name, modify, allowIdentity = false) {
  const code = modify(base);
  // Safety check: variant() should not silently no-op unless explicitly allowed
  if (code === base && !allowIdentity) {
    throw new Error(`variant('${name}') produced no change to base; pass true to allow identity`);
  }
  const path = join(OUT, name);
  writeFileSync(path, code);
  return path;
}

// CONTROL: base fixture is feature-invariant (CT12.2 in CLAUDE.md: made invariant to feature landing)
// Before feature: verdict not REFUSED, machine present, no diagnostic other than PL4003 (which is zero)
// After feature: verdict not REFUSED, machine present, only PL4003 is diagnostic
test('CONTROL: base.poly with no retry clause is feature-invariant', async () => {
  const path = variant('ctrl-base.poly', (b) => b, true);
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'CONTROL: base must not be REFUSED');
  assert.ok(r.machines && r.machines[0], 'CONTROL: must have machine');
  const m = r.machines[0];
  const otherDiags = m.diagnostics.filter((d) => d.code !== 'PL4003');
  assert.equal(otherDiags.length, 0, `CONTROL: only PL4003 allowed, found: ${otherDiags.map(d => d.code).join(', ')}`);
});

// CONTROL: G1 (retry { attempts 1 }) added to base is still CLEAN, no PL4003
test('CONTROL: base + retry { attempts 1 } is CLEAN, no PL4003', async () => {
  const path = variant('ctrl-g1.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 1, base 200ms, timeout 5s }'));
  const r = await checkFile(path, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', 'CONTROL: G1 must keep verdict CLEAN');
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'CONTROL: G1 must have no PL4003');
});

// PS23.5, DAC1(a): base (unguarded) must be FINDINGS PL4003 with witness
test('PS23.5, DAC1(a): base unguarded irreversible is FINDINGS PL4003 with witness', async () => {
  const path = variant('refund-unguarded.poly', (b) => b, true);
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.5: must parse and check');
  assert.equal(r.verdict, 'FINDINGS', `PS23.5: unguarded must be FINDINGS, got ${r.verdict}`);
  assert.ok(r.machines && r.machines[0], 'PS23.5: must have checked machines');

  const m = r.machines[0];
  const text = render(r);
  assert.ok(text.includes('s526.work'), 'PS23.5: effect must be in report');

  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 1, `PS23.5: must have exactly one PL4003, got ${pl4003.length}`);

  // PS23.8: witness has prefix (trace) and delivery parts
  const finding = pl4003[0];
  assert.ok(finding.witness, 'PS23.8: witness must exist');

  // PS23.8: witness structure check - look in the whole finding JSON, not just trace field
  const witnessJson = JSON.stringify(finding);

  // Check for prefix trace elements: {pre, action, data, post}
  // Either directly as fields or in the trace array
  assert.ok(witnessJson.includes('Start') || witnessJson.includes('pre'),
    'PS23.8: witness must contain trace part (Start or pre state)');

  // PS23.8: delivery part: "executions of the target: 2", Start shown twice, may include HandlerFailed
  assert.ok(witnessJson.includes('executions of the target: 2'),
    'PS23.8: witness must contain "executions of the target: 2" (delivery part annotation)');
});

// PS23.8, DAC1(b): unreached effect still PL4003 with reach indicator
test('PS23.8, DAC1(b): unreached effect is PL4003 with reach: not-reached-in-instance', async () => {
  const path = variant('unreached.poly', (b) =>
    b.replace('    emit work(1)', ''));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.8: must check unreached effect');
  assert.ok(r.machines && r.machines[0], 'PS23.8: must have machines');

  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 1, `PS23.8: unreached must have PL4003, got ${pl4003.length}`);

  // Search witness JSON for reach indicator
  const finding = pl4003[0];
  const witnessJson = JSON.stringify(finding);
  assert.ok(witnessJson.includes('not-reached-in-instance'),
    'PS23.8: witness must contain reach: "not-reached-in-instance" for unreached effect');
});

// PT33.9: export witness test
test('PT33.9: poly witness <id> --test exports test for PL4003', async () => {
  const path = variant('export-witness.poly', (b) => b, true);
  const r = await checkFile(path, { root: OUT });
  // Must have PL4003 first to export
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 1, `PT33.9: must have PL4003 to export, got ${pl4003.length}`);

  const finding = pl4003[0];
  assert.ok(finding.witness, 'PT33.9: witness must exist for export');
  // PT33.9, AC3: the exported host test drives the build through the witness (first answer lost) and asserts that the
  // target executed at most once per intent; on the unfixed program it fails, and says why.
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), finding.witness.id), { root: OUT, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
  assert.notEqual(run.status, 0, 'PT33.9: the exported test fails on the unfixed program');
  assert.match(run.stdout + run.stderr, /execut/i, 'PT33.9: it fails because the target executed twice');
});

// PS23.4, DAC2(a): G1 (retry { attempts 1 }) eliminates PL4003
test('PS23.4, DAC2(a): G1 retry { attempts 1 } is CLEAN, no PL4003, shows retry-safe', async () => {
  const path = variant('g1.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 1, base 200ms, timeout 5s }'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.4: must parse retry clause');
  assert.equal(r.verdict, 'CLEAN', `PS23.4: G1 must be CLEAN, got ${r.verdict}`);
  assert.ok(r.machines && r.machines[0], 'PS23.4: must have checked');

  const m = r.machines[0];
  const text = render(r);
  assert.ok(text.includes('s526.work'), 'PS23.4: effect must be in report');

  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PS23.4: G1 must eliminate PL4003');

  // PT33.6: retry-safe line with specific content
  assert.ok(text.includes('retry-safe'), 'PT33.6: must print retry-safe line');
  assert.ok(text.includes('at most once'), 'PT33.6: G1 must show "at most once"');
});

// PS23.4, DAC2(b): G2 (idempotent header) eliminates PL4003, shows K17
test('PS23.4, DAC2(b): G2 idempotent header window is CLEAN, shows retry-safe with header+K17', async () => {
  const path = variant('g2.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 500ms }\n    idempotent header "Idempotency-Key" window 5s'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.4: must parse idempotent clause');
  assert.equal(r.verdict, 'CLEAN', `PS23.4: G2 must be CLEAN, got ${r.verdict}`);
  assert.ok(r.machines && r.machines[0], 'PS23.4: must have checked');

  const m = r.machines[0];
  const text = render(r);
  assert.ok(text.includes('s526.work'), 'PS23.4: effect must be in report');

  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PS23.4: G2 must eliminate PL4003');

  // PT33.6: retry-safe line with specific content
  assert.ok(text.includes('retry-safe'), 'PT33.6: must print retry-safe line');
  assert.ok(text.includes('keyed') || text.includes('Idempotency-Key'), 'PT33.6: G2 must mention keyed or header');
  assert.ok(text.includes('Idempotency-Key'), 'PT33.6: must show header name');
  assert.ok(text.includes('K17'), 'PT33.6: must list K17 assumption');
});

// PS23.4, DAC2(c): base (no G1) must have PL4003 (CLEAN baseline without guarding)
test('PS23.4, DAC2(c): base (no G1) returns PL4003', async () => {
  const path = variant('g1-broken.poly', (b) => b, true);
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.4: must parse');
  assert.ok(r.machines && r.machines[0], 'PS23.4: must check');
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.ok(pl4003.length > 0, 'PS23.4: base must have PL4003');
});

// PS23.4, DAC2(d): base (no G2) must have PL4003
test('PS23.4, DAC2(d): base (no G2) returns PL4003', async () => {
  const path = variant('g2-broken.poly', (b) => b, true);
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.4: must parse');
  assert.ok(r.machines && r.machines[0], 'PS23.4: must check');
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.ok(pl4003.length > 0, 'PS23.4: base must have PL4003');
});

// PT33.1: grammar bounds - window 1s pair
test('PT33.1: window 1s with horizon < 1s is CLEAN (pair part 1: valid boundary)', async () => {
  // Horizon H = min(200*2^0, 3600000) + 2*200 = 200 + 400 = 600ms < 1s
  const path = variant('window-1s-valid.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "Idempotency-Key" window 1s'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.1: window 1s must be accepted with small enough horizon');
  assert.equal(r.verdict, 'CLEAN', `PT33.1: window 1s with H < 1s must be CLEAN, got ${r.verdict}`);
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PT33.1: valid window must have no PL4003');
});

test('PT33.1: window 500ms is REFUSED (pair part 2: out-of-range)', async () => {
  const path = variant('window-short.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "Idempotency-Key" window 500ms'));
  const r = await checkFile(path, { root: OUT });
  assert.equal(r.verdict, 'REFUSED', 'PT33.1: window < 1s must be REFUSED');
  // Check that the refusal is not PL0001 (syntax) but a semantic check
  const syntaxError = r.diagnostics.filter((d) => d.code === 'PL0001');
  assert.equal(syntaxError.length, 0, 'PT33.1: refusal must be semantic, not syntax error');
});

// PT33.1: grammar bounds - window 7d pair
test('PT33.1: window 7d is CLEAN (pair part 1: valid boundary)', async () => {
  // With retry { attempts 5, base 500ms, timeout 30s }, H = 157.5s < 7d
  const path = variant('window-7d-valid.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 5, base 500ms, timeout 30s }\n    idempotent header "Idempotency-Key" window 7d'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.1: window 7d must be accepted');
  assert.equal(r.verdict, 'CLEAN', `PT33.1: window 7d must be CLEAN, got ${r.verdict}`);
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PT33.1: valid window must have no PL4003');
});

test('PT33.1: window 8d is REFUSED (pair part 2: out-of-range)', async () => {
  const path = variant('window-long.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 5, base 500ms, timeout 30s }\n    idempotent header "Idempotency-Key" window 8d'));
  const r = await checkFile(path, { root: OUT });
  assert.equal(r.verdict, 'REFUSED', 'PT33.1: window > 7d must be REFUSED');
  // Check that the refusal is semantic, not syntax
  const syntaxError = r.diagnostics.filter((d) => d.code === 'PL0001');
  assert.equal(syntaxError.length, 0, 'PT33.1: refusal must be semantic, not syntax error');
});

// PT33.1: invalid header token pair
test('PT33.1: header "Idempotency-Key" is CLEAN (pair part 1: valid header)', async () => {
  const path = variant('header-valid.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "Idempotency-Key" window 5s'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.1: valid header must be accepted');
  assert.equal(r.verdict, 'CLEAN', `PT33.1: valid header must be CLEAN, got ${r.verdict}`);
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PT33.1: valid header must have no PL4003');
});

test('PT33.1: invalid header name is REFUSED (pair part 2: bad token)', async () => {
  const path = variant('header-bad.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "bad header" window 5s'));
  const r = await checkFile(path, { root: OUT });
  assert.equal(r.verdict, 'REFUSED', 'PT33.1: non-token header must be REFUSED');
  // Check that the refusal is semantic, not syntax
  const syntaxError = r.diagnostics.filter((d) => d.code === 'PL0001');
  assert.equal(syntaxError.length, 0, 'PT33.1: refusal must be semantic, not syntax error');
});

// PT33.1, PL1002: duplicate idempotent
test('PT33.1, PL1002: single idempotent is CLEAN (prerequisite)', async () => {
  const path = variant('single-idempotent.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "K1" window 24h'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.1: single idempotent syntax should parse');
  assert.equal(r.verdict, 'CLEAN', `PT33.1: single idempotent should be CLEAN, got ${r.verdict}`);
});

test('PT33.1, PL1002: second idempotent item is DUPLICATE_DECLARATION', async () => {
  const path = variant('dup-idempotent.poly', (b) =>
    b.replace('    class irreversible',
      '    class irreversible\n    retry { attempts 2, base 200ms, timeout 200ms }\n    idempotent header "K1" window 24h\n    idempotent header "K2" window 24h'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.1: syntax should parse');
  assert.ok(r.machines && r.machines[0], 'PT33.1: must have checked');
  const m = r.machines[0];
  const pl1002 = m.diagnostics.filter((d) => d.code === 'PL1002');
  assert.equal(pl1002.length, 1, `PT33.1: duplicate must be PL1002, got ${pl1002.length}`);
});

// PS23.7, PL4004: horizon validation
test('PS23.7, PL4004: window 1m < horizon 157.5s is PL4004', async () => {
  // m=5, b=500ms, t=30s → H = 500+1000+2000+4000+150000 = 157500ms
  const path = variant('horizon-short.poly', (b) =>
    b.replace('    class irreversible',
      '    class irreversible\n    retry { attempts 5, base 500ms, timeout 30s }\n    idempotent header "K" window 1m'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.7: must check window');
  assert.ok(r.machines && r.machines[0], 'PS23.7: must have checked');
  const m = r.machines[0];
  const pl4004 = m.diagnostics.filter((d) => d.code === 'PL4004');
  assert.equal(pl4004.length, 1, `PS23.7: 1m < 157.5s must be PL4004, got ${pl4004.length}`);
});

// PS23.7: window 24h >> horizon passes (no PL4004)
test('PS23.7: window 24h > horizon 157.5s is not PL4004', async () => {
  const path = variant('horizon-ok.poly', (b) =>
    b.replace('    class irreversible',
      '    class irreversible\n    retry { attempts 5, base 500ms, timeout 30s }\n    idempotent header "K" window 24h'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PS23.7: must check window');
  assert.ok(r.machines && r.machines[0], 'PS23.7: must have checked');
  const m = r.machines[0];
  const pl4004 = m.diagnostics.filter((d) => d.code === 'PL4004');
  assert.equal(pl4004.length, 0, 'PS23.7: 24h > 157.5s must not be PL4004');
});

// PS23.5: the rule holds with NO declared property
test('PS23.5: base.poly has no property declaration and has PL4003 when feature lands', async () => {
  const path = variant('no-property.poly', (b) => b, true);
  // Verify base has no declared properties
  const code = readFileSync(path, 'utf8');
  assert.ok(!code.includes('invariant'), 'PS23.5: base must not declare invariant');
  assert.ok(!code.includes('never'), 'PS23.5: base must not declare never');
  assert.ok(!code.includes('path property'), 'PS23.5: base must not declare path property');
  assert.ok(!code.includes('step property'), 'PS23.5: base must not declare step property');

  const r = await checkFile(path, { root: OUT });
  // The rule applies whether or not any property is declared
  assert.ok(r.machines && r.machines[0], 'PS23.5: must have checked');
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  // After feature lands: unguarded irreversible must have PL4003
  assert.ok(pl4003.length > 0, 'PS23.5: unguarded irreversible must have PL4003 regardless of property declarations');
});
