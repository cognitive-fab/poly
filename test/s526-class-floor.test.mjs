// PS23.6: the class floor (DAC3). Effects with egress:external or egress:public must declare a class.
// Decisions are class none by construction (PD1.7), so they never trigger PL6304.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const OUT = join(BUILD, 's526-class-floor');

// Write a source file and return its path.
const write = (name, src) => {
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, src);
  return file;
};

const BASE = join(ROOT, 'test', 'fixtures', 's526', 'rule', 'base.poly');
const DECISION = join(ROOT, 'test', 'fixtures', 's526', 'rule', 'decision.poly');

// Helper: count diagnostics with a code in a result
const countCode = (result, code) => {
  return (result.machines || [])
    .flatMap((m) => m.diagnostics || [])
    .filter((d) => d.code === code).length;
};

// Helper: get all diagnostics with a code
const getDiagsWithCode = (result, code) => {
  return (result.machines || [])
    .flatMap((m) => m.diagnostics || [])
    .filter((d) => d.code === code);
};

test('CONTROL: base.poly is CLEAN today', async () => {
  const r = await checkFile(BASE, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', `base.poly should be CLEAN but got ${r.verdict}`);
  assert.equal(countCode(r, 'PL6304'), 0, 'base.poly should have no PL6304');
});

test('CONTROL: decision.poly is CLEAN today', async () => {
  const r = await checkFile(DECISION, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', `decision.poly should be CLEAN but got ${r.verdict}`);
  assert.equal(countCode(r, 'PL6304'), 0, 'decision.poly should have no PL6304 (decisions are class none by construction, PD1.7)');
});

test('PS23.6: effect with egress:external but no class reports PL6304', async () => {
  // Remove class irreversible, keep egress:external label
  const src = readFileSync(BASE, 'utf8').replace('    class irreversible\n', '');
  assert.ok(!src.includes('class irreversible'), 'sanity: class irreversible should be removed');
  assert.ok(src.includes('egress:external'), 'sanity: egress:external should remain');

  const file = write('no-class-external.poly', src);
  const r = await checkFile(file, { root: OUT });

  assert.equal(r.verdict, 'FINDINGS', `PS23.6: verdict should be FINDINGS but got ${r.verdict}`);

  const pl6304s = getDiagsWithCode(r, 'PL6304');
  assert.equal(pl6304s.length, 1, `PS23.6: expect exactly one PL6304 but found ${pl6304s.length}`);

  // PL6304 must be at the effect declaration
  const diag = pl6304s[0];
  assert.ok(diag.at, 'PL6304 should have a location');
  const lines = src.split('\n');
  const line = lines[diag.at.line - 1];
  assert.ok(/effect|labels/.test(line), `PL6304 should point to effect or labels line, got: ${line}`);
});

test('PS23.6: effect with egress:public but no class reports PL6304', async () => {
  // Replace egress:external with egress:public, remove class
  let src = readFileSync(BASE, 'utf8');
  src = src.replace('egress:external', 'egress:public');
  src = src.replace('    class irreversible\n', '');
  assert.ok(src.includes('egress:public'), 'sanity: egress:public should be present');
  assert.ok(!src.includes('class irreversible'), 'sanity: class irreversible should be removed');

  const file = write('no-class-public.poly', src);
  const r = await checkFile(file, { root: OUT });

  assert.equal(r.verdict, 'FINDINGS', `PS23.6: verdict should be FINDINGS but got ${r.verdict}`);
  assert.equal(countCode(r, 'PL6304'), 1, `PS23.6: expect exactly one PL6304`);
});

test('PS23.6: class none on egress:external has no PL6304 and report prints class', async () => {
  // Replace class irreversible with class none
  const src = readFileSync(BASE, 'utf8').replace('class irreversible', 'class none');
  assert.ok(src.includes('class none'), 'sanity: class none should be present');
  assert.ok(src.includes('egress:external'), 'sanity: egress:external should remain');

  const file = write('class-none.poly', src);
  const r = await checkFile(file, { root: OUT });

  assert.equal(r.verdict, 'CLEAN', `PS23.6: verdict should be CLEAN but got ${r.verdict}`);
  assert.equal(countCode(r, 'PL6304'), 0, 'PS23.6: no PL6304 when class is declared');

  // PT33.12: effectClasses field has exact structure
  const m = r.machines[0];
  assert.ok(Array.isArray(m.effectClasses), 'PT33.12: effectClasses must be an array');
  assert.equal(m.effectClasses.length, 1, 'PT33.12: one entry for work effect (has egress label)');
  const entry = m.effectClasses[0];
  assert.equal(entry.kind, 's526.work', 'PT33.12: kind must match effect kind');
  assert.equal(entry.effect, 'work', 'PT33.12: effect name');
  assert.equal(entry.class, 'none', 'PT33.12: class must be none (the declared class)');
  assert.ok(Array.isArray(entry.labels), 'PT33.12: labels must be an array');
  assert.ok(entry.labels.includes('egress:external'), 'PT33.12: labels must contain egress:external');

  // PT33.12: report prints exact line
  const report = render(r);
  const lines = report.split('\n').map((l) => l.trim());
  const expected = 'class  s526.work  none';
  assert.ok(lines.some((l) => l === expected),
    `PT33.12: must have exact line "${expected}" in\n${report}`);
});

test('CONTROL: PS23.6: effect with non-egress label and no class has no PL6304', async () => {
  // Replace labels { egress:external } with labels { write:store }, remove class
  let src = readFileSync(BASE, 'utf8');
  src = src.replace('labels { egress:external }', 'labels { write:store }');
  src = src.replace('    class irreversible\n', '');
  assert.ok(src.includes('write:store'), 'sanity: write:store should be present');
  assert.ok(!src.includes('egress:'), 'sanity: no egress label should be present');

  const file = write('no-class-write.poly', src);
  const r = await checkFile(file, { root: OUT });

  // Verify the source is checked, not REFUSED
  assert.ok(r.verdict !== 'REFUSED', `PS23.6: source should be checked, not REFUSED. Got: ${r.verdict}`);

  // PL6304 only applies to egress labels (PS23.6)
  assert.equal(countCode(r, 'PL6304'), 0, 'PS23.6: non-egress label should not trigger PL6304');
});

test('CONTROL: PS23.6: decision with egress label never reports PL6304', async () => {
  const r = await checkFile(DECISION, { root: OUT });

  assert.equal(r.verdict, 'CLEAN', `verdict should be CLEAN but got ${r.verdict}`);

  // Decisions are class none by construction (PD1.7), so they never trigger PL6304
  assert.equal(countCode(r, 'PL6304'), 0, 'PS23.6: decision should never be PL6304');

  // Report should mention the decision or its egress label
  const report = render(r);
  assert.ok(report, 'sanity: report should exist');
  // Just verify the decision is referenced somehow in the output
  assert.ok(/decision|ask|egress/.test(report), `PS23.6: report should mention decision or egress, got: ${report}`);
});

test('PT33.12: class null for unclassified egress effect shows in effectClasses', async () => {
  // Effect with egress label but no class (PL6304)
  const src = readFileSync(BASE, 'utf8').replace('    class irreversible\n', '');
  assert.ok(src.includes('egress:external'), 'sanity: egress label present');
  assert.ok(!src.includes('class'), 'sanity: class removed');

  const file = write('class-null.poly', src);
  const r = await checkFile(file, { root: OUT });

  // PT33.12: effectClasses has entry with class: null
  const m = r.machines[0];
  assert.ok(Array.isArray(m.effectClasses), 'PT33.12: effectClasses must exist');
  const entry = m.effectClasses.find((e) => e.effect === 'work');
  assert.ok(entry, 'PT33.12: work effect in effectClasses');
  assert.equal(entry.class, null, 'PT33.12: class must be null when not declared');

  // PT33.12: render output for unclassified
  const report = render(r);
  const lines = report.split('\n').map((l) => l.trim());
  const expected = 'class  s526.work  unclassified';
  assert.ok(lines.some((l) => l === expected),
    `PT33.12: must have exact line "${expected}" in\n${report}`);
});

test('PS23.6: multi-effect with one lacking class reports exactly one PL6304', async () => {
  // Base should be valid from previous test
  let src = readFileSync(BASE, 'utf8');
  assert.ok(src.includes('effect work'), 'sanity: base should have work effect');

  // Add a second effect with no class and egress label, before the closing brace
  const secondEffect = `
  effect backup(n: 0..1) {
    kind "s526.backup"
    labels { egress:external }
    ok -> Worked()
    failed -> Gave()
  }`;
  // Find the last closing brace and insert before it
  const lastBraceIndex = src.lastIndexOf('}');
  src = src.substring(0, lastBraceIndex) + secondEffect + '\n' + src.substring(lastBraceIndex);
  assert.ok(src.includes('backup'), 'sanity: backup effect should be added');
  assert.ok(src.includes('work'), 'sanity: original work effect should remain');

  const file = write('multi-effect.poly', src);
  const r = await checkFile(file, { root: OUT });

  // Source must be checked, not REFUSED
  assert.ok(r.verdict !== 'REFUSED', `PS23.6: multi-effect source should be checked, got ${r.verdict}`);

  // Exactly one PL6304 (for backup which has no class)
  assert.equal(countCode(r, 'PL6304'), 1, 'PS23.6: expect exactly one PL6304 for the second effect');

  // PT33.12: effectClasses has both effects (both have egress label)
  const m = r.machines[0];
  assert.ok(Array.isArray(m.effectClasses), 'PT33.12: effectClasses must be array');
  assert.equal(m.effectClasses.length, 2, 'PT33.12: two entries for two effects with egress labels');
  const work = m.effectClasses.find((e) => e.effect === 'work');
  const backup = m.effectClasses.find((e) => e.effect === 'backup');
  assert.ok(work, 'PT33.12: work in effectClasses');
  assert.ok(backup, 'PT33.12: backup in effectClasses');
  assert.equal(work.class, 'irreversible', 'PT33.12: work has class');
  assert.equal(backup.class, null, 'PT33.12: backup has class null');

  // The PL6304 should point to the backup effect area (not work, which has class)
  const diags = getDiagsWithCode(r, 'PL6304');
  if (diags.length > 0) {
    const diag = diags[0];
    const lines = src.split('\n');
    const line = lines[diag.at.line - 1];
    assert.ok(/backup|labels/.test(line), `PS23.6: PL6304 should point to backup effect, got: ${line}`);
  }
});

test('CONTROL: decision with egress label is not in effectClasses (decisions are class none by construction, PD1.7)', async () => {
  const r = await checkFile(DECISION, { root: OUT });
  const m = r.machines[0];

  // effectClasses should not have the decision; it has no entry
  assert.ok(Array.isArray(m.effectClasses), 'PT33.12: effectClasses array');
  const hasDec = m.effectClasses.some((e) => e.effect === 'ask' || e.kind && e.kind.includes('ask'));
  assert.ok(!hasDec, 'PT33.12: decision must not be in effectClasses');
});
