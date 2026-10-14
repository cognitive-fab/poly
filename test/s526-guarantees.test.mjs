// PS23.4 to PS23.7, PT33.6, PT33.7 (DAC2, the parts the rule file does not cover): the key window (PL4004), a nature
// declaration outside the standard library (PL4005), a person's acceptance (G3: admission only), and the retry-safe
// lines of the report. Every variant is test/fixtures/s526/rule/base.poly (CLEAN before the feature) with one clause
// of the effect `work` changed. A refused source fails an assertion (the clause is unknown today), it never passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { checkFile, checkProject, admit, AdmitError, render } from '@poly/check';
import { signRecord } from '@poly/core';
import { ROOT, BUILD } from './helpers.mjs';
import { project, makeKey, PERSON, AGENT } from './runtime-helpers.mjs';

const OUT = join(BUILD, 's526-guarantees');
const BASE = readFileSync(join(ROOT, 'test', 'fixtures', 's526', 'rule', 'base.poly'), 'utf8');
const CLASS_LINE = '    class irreversible\n';
assert.ok(BASE.includes(CLASS_LINE), 'the base fixture has the class line this file extends');

/** The base with `extra` inserted after the class line of the effect. */
const variant = (extra) => BASE.replace(CLASS_LINE, CLASS_LINE + extra.map((l) => `    ${l}\n`).join(''));
const write = (name, src) => {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, name);
  writeFileSync(file, src);
  return file;
};
const diagnosticsOf = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? [])];
const count = (r, code) => diagnosticsOf(r).filter((d) => d.code === code).length;

/** Checks a variant and asserts that it was really checked: a verdict of CLEAN or FINDINGS and one machine. */
async function checked(name, extra) {
  const r = await checkFile(write(name, variant(extra)), { root: OUT });
  const syntax = diagnosticsOf(r).map((d) => `${d.code} ${d.message ?? ''}`).slice(0, 3).join('; ');
  assert.ok(['CLEAN', 'FINDINGS'].includes(r.verdict), `${name}: the source was not checked (verdict ${r.verdict}): ${syntax}`);
  assert.equal(r.machines?.length, 1, `${name}: one machine was checked`);
  return r;
}

test('CONTROL: base.poly with retry { attempts 1 } is CLEAN today and must stay CLEAN with no PL4003', async () => {
  // Protects the at-most-once form (G1): the rule must never flag it.
  const r = await checked('control-g1.poly', ['retry { attempts 1, base 200ms, timeout 5s }']);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(count(r, 'PL4003'), 0);
});

// ---- PS23.7: the key window against the retry horizon ----------------------------------------------------------------

test('PS23.7: attempts 5, base 500ms, timeout 30s and window 1m: horizon 157,500 ms is above 60,000 ms, so one PL4004', async () => {
  // H = (500 + 1000 + 2000 + 4000) + 5 * 30000 = 7,500 + 150,000 = 157,500 ms.
  const r = await checked('window-1m.poly', ['retry { attempts 5, base 500ms, timeout 30s }', 'idempotent header "Idempotency-Key" window 1m']);
  assert.equal(r.verdict, 'FINDINGS');
  assert.equal(count(r, 'PL4004'), 1, `one PL4004: ${diagnosticsOf(r).map((d) => d.code)}`);
  assert.equal(count(r, 'PL4003'), 0, 'a keyed effect is not PL4003');
});

test('PS23.7: the same effect with window 24h has no PL4004 and no PL4003, and the report has its retry-safe line', async () => {
  const r = await checked('window-24h.poly', ['retry { attempts 5, base 500ms, timeout 30s }', 'idempotent header "Idempotency-Key" window 24h']);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(count(r, 'PL4004'), 0);
  assert.equal(count(r, 'PL4003'), 0);
  assert.match(render(r), /retry-safe/, 'PT33.6: the report lists the effect');
});

test('PS23.7: attempts 2, base 1s, timeout 1s have horizon 1,000 + 2 * 1,000 = 3,000 ms: window 3s has no PL4004', async () => {
  const r = await checked('window-3s.poly', ['retry { attempts 2, base 1s, timeout 1s }', 'idempotent header "Idempotency-Key" window 3s']);
  assert.equal(count(r, 'PL4004'), 0);
  assert.equal(r.verdict, 'CLEAN');
});

test('PS23.7: the same effect with window 2s (below 3,000 ms) has one PL4004', async () => {
  const r = await checked('window-2s.poly', ['retry { attempts 2, base 1s, timeout 1s }', 'idempotent header "Idempotency-Key" window 2s']);
  assert.equal(r.verdict, 'FINDINGS');
  assert.equal(count(r, 'PL4004'), 1);
});

// ---- PS23.4, G4: idempotent by nature is for the standard library only ------------------------------------------------

test('PS23.4, PT33.7: idempotent by nature in a module outside the standard library is PL4005, and does not guard the effect', async () => {
  // The module is s526base, not a std module. PL4005 is a finding at check time (PT33.7 lists it with the others),
  // and the effect keeps the default retry with no guarantee that counts, so PL4003 is reported too.
  const r = await checked('nature-outside-std.poly', ['idempotent by nature "RFC 7009"']);
  assert.equal(r.verdict, 'FINDINGS');
  assert.equal(count(r, 'PL4005'), 1, `PL4005 once: ${diagnosticsOf(r).map((d) => d.code)}`);
  assert.equal(count(r, 'PL4003'), 1, 'the nature declaration is not a guarantee outside the library');
});

// ---- PS23.4, G3: a person's acceptance lifts admission and nothing else ------------------------------------------------

test('PS23.4, PT12.5: an unguarded PL4003 is refused at admission, an agent-signed acceptance has no effect, a person-signed one admits, and the verdict stays FINDINGS', async () => {
  const src = write('g3-unguarded.poly', BASE);
  const key = makeKey('s526-g3');
  const dir = project('s526-g3', [relative(ROOT, src).split('\\').join('/')], key);
  const report = await checkProject(dir, { root: dir });
  const f = report.files?.[0];
  assert.ok(f, 'the project was checked');
  const d = (f.machines ?? []).flatMap((m) => m.diagnostics ?? []).find((x) => x.code === 'PL4003');
  assert.ok(d, `PS23.5: the unguarded irreversible effect is PL4003 (found ${(f.machines ?? []).flatMap((m) => m.diagnostics ?? []).map((x) => x.code)})`);
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /FINDINGS/.test(e.message), 'admission refuses an unaccepted finding');
  const subject = `${f.moduleDigest}:${d.witness.id}`;
  mkdirSync(join(dir, 'accepted'), { recursive: true });
  const record = (who) => JSON.stringify(signRecord({ kind: 'acceptance', subject, by: who.keyId, at: '2026-10-14T00:00:00.000Z' }, who.privateKeyPem));
  writeFileSync(join(dir, 'accepted', 'a.json'), record(AGENT));
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /agent key/.test(e.message), 'an agent-signed acceptance has no effect');
  writeFileSync(join(dir, 'accepted', 'a.json'), record(PERSON));
  const admitted = await admit(dir);
  assert.deepEqual(admitted.certificate.boundAccepted.map((x) => [x.code, x.by]), [['PL4003', PERSON.keyId]]);
  assert.deepEqual(readdirSync(join(dir, 'accepted')), ['a.json']);
  const again = await checkProject(dir, { root: dir });
  assert.equal(again.verdict, 'FINDINGS', 'G3 lifts admission only: poly check never prints CLEAN for it');
});

// ---- PT33.6: the report lists every irreversible effect ----------------------------------------------------------------

test('PT33.6: at most once: the report has the retry-safe line of `work` saying so, on a CLEAN verdict', async () => {
  const r = await checked('report-g1.poly', ['retry { attempts 1, base 200ms, timeout 5s }']);
  assert.equal(r.verdict, 'CLEAN');
  const text = render(r);
  assert.match(text, /retry-safe[^\n]*work[^\n]*at most once/, text.slice(0, 600));
});

test('PT33.6: keyed: the report line names the header, the window and K17, on a CLEAN verdict', async () => {
  const r = await checked('report-g2.poly', ['retry { attempts 3, base 200ms, timeout 5s }', 'idempotent header "Idempotency-Key" window 24h']);
  assert.equal(r.verdict, 'CLEAN');
  const text = render(r);
  const line = text.split('\n').find((l) => /retry-safe/.test(l) && /work/.test(l));
  assert.ok(line, `a retry-safe line for work: ${text.slice(0, 600)}`);
  assert.match(line, /Idempotency-Key/);
  assert.match(line, /24h|86400000/);
  assert.match(line, /K17/);
});

test('PT33.6: unguarded (FINDINGS): the report still has a retry-safe line for `work`, and PL4003', async () => {
  const r = await checkFile(write('report-unguarded.poly', BASE), { root: OUT });
  assert.ok(['CLEAN', 'FINDINGS'].includes(r.verdict), `checked: ${r.verdict}`);
  assert.equal(count(r, 'PL4003'), 1, 'PS23.5: one PL4003');
  assert.match(render(r), /retry-safe[^\n]*work/, 'PT33.6: a line even when the rule fails');
});
