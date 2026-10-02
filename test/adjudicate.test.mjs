// `adjudicate d as Correct | Wrong` (PD2.4, S129) in the language: both surfaces, the checker, the lowering to
// an outcome intent of class none, poly-ref's semantics and read-back, and PL6203 for an adjudication that can
// come before its decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule, digest } from '@poly/core';
import { printModule, readEmbedded } from '@poly/embed';
import { checkFile } from '@poly/check';
import { ROOT, build } from './helpers.mjs';

const ROUTER = join(ROOT, 'conformance', 'm4', 'router.poly');
const OUT = join(ROOT, '.poly', 'test-adjudicate');

test('it parses, prints canonically and reads back on both surfaces with one digest', () => {
  const p = parse(readFileSync(ROUTER, 'utf8'));
  assert.deepEqual(p.diagnostics, []);
  assert.match(format(p.module), /adjudicate route as Wrong/);
  assert.equal(digest(parse(format(p.module)).module), digest(p.module));
  const ts = printModule(p.module);
  assert.match(ts, /adjudicate\("route", "Correct"\)/);
  assert.equal(digest(readEmbedded(ts).module), digest(p.module));
});

test('an unknown decision is PL1001, and an outcome other than Correct or Wrong does not parse', () => {
  const src = readFileSync(ROUTER, 'utf8');
  assert.deepEqual(checkModule(parse(src.replace('adjudicate route as Wrong', 'adjudicate rout as Wrong')).module).diagnostics.map((d) => d.code), ['PL1001']);
  assert.deepEqual(parse(src.replace('adjudicate route as Wrong', 'adjudicate route as Maybe')).diagnostics.map((d) => d.code), ['PL0001']);
});

test('it lowers to an outcome intent of class none, with its manifest entry, and translation validation agrees', async () => {
  const [{ dir }] = build(ROUTER, 'adjudicate');
  const manifest = JSON.parse(readFileSync(join(dir, 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['outcome.route'], { payloadSchema: { outcome: { type: 'string', required: true } }, retry: { maxAttempts: 1, baseMs: 500, timeoutMs: 30000 }, class: 'none', outcome: { decision: 'route' } });
  assert.match(readFileSync(join(dir, 'effects.cjs'), 'utf8'), /kind: "outcome\.route", payload: \{ outcome: "Wrong" \}/);
  const r = await checkFile(ROUTER, { root: OUT });
  assert.equal(r.verdict, 'CLEAN');
});

test('PL6203: an adjudication reachable before its decision is a finding with its path; the fix removes it', async () => {
  const unfixed = await checkFile(join(ROOT, 'conformance', 'm4', 'seeded', 'adjudication', 'unfixed.poly'), { root: OUT });
  const d = unfixed.machines[0].diagnostics.find((x) => x.code === 'PL6203');
  assert.ok(d, JSON.stringify(unfixed.machines[0].diagnostics.map((x) => x.code)));
  assert.equal(d.severity, 'finding');
  assert.deepEqual(d.witness.trace.map((s) => s.action), ['Escalate']);
  assert.equal(unfixed.verdict, 'FINDINGS');
  const fixed = await checkFile(join(ROOT, 'conformance', 'm4', 'seeded', 'adjudication', 'fixed.poly'), { root: OUT });
  assert.equal(fixed.verdict, 'CLEAN');
});
