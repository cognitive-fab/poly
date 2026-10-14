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

  // PT33.12: diagnostic fields - exact structure
  const d = pl4003[0];
  assert.ok(d.code === 'PL4003', 'PT33.12: code must be PL4003');
  assert.ok(d.name, 'PT33.12: name must exist');
  assert.ok(d.at, 'PT33.12: at must exist');
  assert.ok(typeof d.at.line === 'number', 'PT33.12: at.line must be a number (the line of effect work declaration)');
  assert.ok(typeof d.at.module === 'string', 'PT33.12: at.module must exist');
  assert.ok(typeof d.at.machine === 'string', 'PT33.12: at.machine must exist');
  assert.ok(typeof d.at.col === 'number', 'PT33.12: at.col must be a number');

  // PT33.12: reach must be "reached" or "not-reached-in-instance"
  assert.equal(d.reach, 'reached', 'PT33.12: reach must be "reached" for reachable effect');

  // PT33.12: witness structure
  assert.ok(d.witness, 'PT33.12: witness must exist');
  assert.ok(typeof d.witness.id === 'string', 'PT33.12: witness.id must be a string');

  // PT33.12: trace is non-empty array of { pre, action, data, post }
  assert.ok(Array.isArray(d.witness.trace), 'PT33.12: witness.trace must be an array');
  assert.ok(d.witness.trace.length > 0, 'PT33.12: witness.trace must be non-empty for reached effect');
  d.witness.trace.forEach((win) => {
    assert.ok(typeof win.pre === 'object', 'PT33.12: trace window pre must exist');
    assert.ok(typeof win.action === 'string', 'PT33.12: trace window action must be a string');
    assert.ok(typeof win.data === 'object', 'PT33.12: trace window data must exist');
    assert.ok(typeof win.post === 'object', 'PT33.12: trace window post must exist');
  });

  // PT33.12: delivery structure
  assert.ok(d.witness.delivery, 'PT33.12: witness.delivery must exist');
  assert.ok(d.witness.delivery.model && d.witness.delivery.model.match(/^runtime\d+\.OutboxIntent$/),
    `PT33.12: delivery.model must be runtime<m>.OutboxIntent, got ${d.witness.delivery.model}`);

  // PT33.12: steps array with exact action sequence
  assert.ok(Array.isArray(d.witness.delivery.steps), 'PT33.12: delivery.steps must be an array');
  const actions = d.witness.delivery.steps.map((s) => s.action);
  assert.deepEqual(actions, ['Propose', 'GateAllow', 'Start', 'HandlerFailed', 'Start', 'HandlerOk', 'SettleOk'],
    `PT33.12: steps actions must be exact sequence, got ${JSON.stringify(actions)}`);

  // PT33.12: each Start carries target: "may-execute"
  const starts = d.witness.delivery.steps.filter((s) => s.action === 'Start');
  assert.ok(starts.length === 2, `PT33.12: must have exactly 2 Start steps, got ${starts.length}`);
  starts.forEach((start) => {
    assert.equal(start.target, 'may-execute', 'PT33.12: each Start must have target: "may-execute"');
  });

  // PT33.12: exact field values
  assert.equal(d.witness.delivery.targetExecutions, 2, 'PT33.12: targetExecutions must be 2');
  assert.equal(d.witness.delivery.key, 'unchanged', 'PT33.12: key must be "unchanged"');
  assert.equal(d.witness.delivery.deduplication, 'none', 'PT33.12: deduplication must be "none"');
  assert.ok(Array.isArray(d.witness.delivery.alsoBy), 'PT33.12: alsoBy must be an array');
  const unsettled = d.witness.delivery.alsoBy.find((x) => x.cause === 'unsettled');
  assert.ok(unsettled, 'PT33.12: alsoBy lists the unsettled variant');
  assert.deepEqual(unsettled.steps.map((s) => s.action), ['Propose', 'GateAllow', 'Start', 'HandlerOk', 'SettleFailed', 'Start', 'HandlerOk', 'SettleOk']);
  assert.deepEqual(unsettled.steps.filter((s) => s.action === 'Start').map((s) => s.target), ['may-execute', 'may-execute']);
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

  // PT33.12: unreached case has reach: "not-reached-in-instance" and empty trace
  const d = pl4003[0];
  assert.equal(d.reach, 'not-reached-in-instance', 'PT33.12: reach must be "not-reached-in-instance" for unreached effect');
  assert.ok(Array.isArray(d.witness.trace), 'PT33.12: trace must be an array');
  assert.equal(d.witness.trace.length, 0, 'PT33.12: trace must be empty when reach is "not-reached-in-instance"');
  assert.ok(d.witness.delivery, 'PT33.12: delivery must still be present even when unreached');
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
  assert.match(run.stdout + run.stderr, /executions/i, 'PT33.9: it fails on the executions-per-intent assertion (PT33.9: executions per intent <= 1)');
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

// PT33.12: model bound matches attempts for G2 (attempt 3)
test('PT33.12: G2 with attempts 3 is CLEAN with no PL4003', async () => {
  const path = variant('g2-attempts3.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 3, base 200ms, timeout 500ms }\n    idempotent header "Idempotency-Key" window 5s'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'PT33.12: must parse');
  assert.equal(r.verdict, 'CLEAN', `PT33.12: G2 attempts 3 must be CLEAN, got ${r.verdict}`);
  assert.ok(r.machines && r.machines[0], 'PT33.12: must have checked');
  const m = r.machines[0];
  const pl4003 = m.diagnostics.filter((d) => d.code === 'PL4003');
  assert.equal(pl4003.length, 0, 'PT33.12: G2 must have no PL4003');
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

// PT33.12: the delivery model is the one of the effect's bound
test('PT33.12: an unguarded effect of 3 attempts names the model runtime3.OutboxIntent', async () => {
  const path = variant('unguarded-attempts3.poly', (b) =>
    b.replace('    class irreversible', '    class irreversible\n    retry { attempts 3, base 200ms, timeout 500ms }'));
  const r = await checkFile(path, { root: OUT });
  assert.notEqual(r.verdict, 'REFUSED', 'the source parses today');
  const d = (r.machines?.[0]?.diagnostics ?? []).find((x) => x.code === 'PL4003');
  assert.ok(d, 'PS23.5: PL4003 for 3 attempts and no guarantee');
  assert.equal(d.witness.delivery.model, 'runtime3.OutboxIntent');
});

// PT33.9, DAC1(b) (added after the second reader): the exported test fails on the unfixed program AND passes on the fixed one.
// The first half is the existing test above; this one adds the second half, with the fix of PT33.8 (`set-at-most-once`) applied in place.
// It stays red until the witness export of PT33.9 exists (it needs the PL4003 finding and the exported test that drives the build).
test('PT33.9: the exported witness test fails on the unfixed program and passes once `retry { attempts 1 }` is applied', async () => {
  const file = variant('export-fixed.poly', (b) => b, true);
  const r = await checkFile(file, { root: OUT });
  const d = (r.machines?.[0]?.diagnostics ?? []).find((x) => x.code === 'PL4003');
  assert.ok(d?.witness, `PS23.5: the unfixed program has a PL4003 with a witness (verdict ${r.verdict})`);
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: OUT, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
  const failing = run();
  assert.notEqual(failing.status, 0, 'PT33.9: the exported test fails on the unfixed program');
  writeFileSync(file, base.replace('    class irreversible', '    class irreversible\n    retry { attempts 1, base 200ms, timeout 5s }'));
  const after = await checkFile(file, { root: OUT });
  assert.equal(after.verdict, 'CLEAN', `PT33.8: the fixed program is CLEAN, got ${after.verdict}`);
  const passing = run();
  assert.equal(passing.status, 0, `PT33.9: the exported test passes on the fixed program: ${passing.stdout.slice(0, 400)}`);
});
