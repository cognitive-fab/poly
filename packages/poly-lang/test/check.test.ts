// The static checker: every compile error M0 raises has a source that raises
// it (conformance/m0/errors), and every example checks clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/index.js';
import { checkModule, CODES } from '@poly/core';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const ERRORS = join(ROOT, 'conformance', 'm0', 'errors');

function polyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...polyFiles(p));
    else if (p.endsWith('.poly')) out.push(p);
  }
  return out;
}

function codesOf(src: string): string[] {
  const r = parse(src);
  if (!r.module) return r.diagnostics.map((d) => d.code);
  return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code);
}

test('each error source raises exactly the code it names', () => {
  const files = readdirSync(ERRORS).filter((f) => f.endsWith('.poly'));
  const seen = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(ERRORS, f), 'utf8');
    const want = /expect: (PL\d{4})/.exec(src)![1];
    const got = codesOf(src);
    assert.deepEqual([...new Set(got)], [want], `${f}: got ${got.join(', ')}`);
    seen.add(want);
  }
  // Every error code of the catalogue that a machine source can raise in M0 has a case.
  // PL1203 cannot: only policy inputs are optional, and policies are lowered from M5.
  // PL2501 and PL2001 are toolchain faults (S20), tested by tv.test.mjs and forbidden by standing.test.mjs.
  // PL0201 is raised by poly fix on a stale fix, never by a source (S70), tested by fixes.test.mjs.
  // PL0301 is raised by poly-embed on a .ts source (PT2.5, S71), tested by embed.test.mjs.
  // PL6401 is raised by the handler lint over handler modules, not a source (PT6.5, S72), tested by lint.test.mjs.
  // PL5405 is raised by the runtime at load, and fifo has no syntax yet (S125).
  // PL6402 is raised by the handler closure at admission, PL6403 at load and PL6404 by rt.handle (S142), tested by certified-handlers.test.mjs.
  // PL6405 is raised at load by a changed keyring (S150), tested by person-keys.test.mjs.
  // PL6302 is raised by the policy stage over a scope and the modules it governs (PS8.4), tested by policy-front.test.mjs.
  // PL6406 is raised at run time by a capability call outside its targets (S151), tested by capabilities.test.mjs.
  // PL6811 to PL6815 are raised by the channel expansion (PS15), which needs a channel kind under std/; the test kind is
  // test-only, so they are tested by channels.test.mjs.
  // PL6407 is raised at load by a module whose enums a build uses and that changed since (S190), tested by enums-across.test.mjs.
  // PL6408 is raised by rt.connectChannel given an adapter the certified package did not make (S182), tested by
  // channels-adapter-pin.test.mjs.
  // PL6001 is Polyaxion's refusal of a policy at admission (PT8.4), which needs the engine; tested by policy-front.test.mjs.
  // PL6410 is raised by admission over the keyring history and its anchor (S194), tested by test/keyrings.test.mjs.
  const compileErrors = Object.entries(CODES).filter(([c, i]) => i.severity === 'error' && c !== 'PL1203' && c !== 'PL2501' && c !== 'PL2001' && c !== 'PL0201' && c !== 'PL0301' && c !== 'PL6401' && c !== 'PL5405' && c !== 'PL6402' && c !== 'PL6403' && c !== 'PL6404' && c !== 'PL6302' && c !== 'PL6405' && c !== 'PL6406' && c !== 'PL6407' && c !== 'PL6408' && c !== 'PL6410' && !/^PL681[1-5]$/.test(c) && c !== 'PL6001').map(([c]) => c);
  assert.deepEqual(compileErrors.filter((c) => !seen.has(c)), []);
});

test('every example checks with no diagnostic, liveness included (M1-2)', () => {
  for (const f of polyFiles(join(ROOT, 'examples'))) {
    const src = readFileSync(f, 'utf8');
    // The OutboxIntent forms state `settles`: since M1-2 the checker accepts it, and the pipeline lists it as not run.
    assert.deepEqual(codesOf(src), [], f);
  }
});

test('S15: a parameter is readable in a property only where `action == A` establishes it', () => {
  const src = (prop: string) => `module t\nmachine M {\n  state { x : 0..3 = 0 }\n  action Pay(amount: 0..3)\n  action Other()\n  on Pay(amount) { x' = amount }\n  on Other { x' = 0 }\n  ${prop}\n}\n`;
  assert.deepEqual(codesOf(src('step property p: (action == Pay && amount > 1) implies post.x > 1')), []);
  assert.deepEqual(codesOf(src('reject property r: (action == Pay && pre.x == 3) implies rejected("full")')), []);
  assert.deepEqual(codesOf(src('step property p: amount > 1 implies post.x > 1')), ['PL1201']);
  assert.deepEqual(codesOf(src('step property p: x == 1')), ['PL1201']);
  assert.deepEqual(codesOf(src('reject property r: post.x == 1')), ['PL1201']);
});

test('PL2101 is per path: a require inside a branch with no earlier write is legal (PT4.1)', () => {
  const ok = `module t\nmachine M {\n  state { x : 0..3 = 0 }\n  action A()\n  on A {\n    if x == 0 { require x < 3 else reject "never"  x' = 1 } else { x' = 0 }\n  }\n}\n`;
  assert.deepEqual(codesOf(ok), []);
  const bad = ok.replace('x\' = 1 } else', 'x\' = 1  reject "late" } else');
  assert.deepEqual(codesOf(bad), ['PL2101']);
});

test('match exhaustiveness enumerates literal payloads (PS2.2)', () => {
  const src = (arms: string) => `module t\ntype S = E { ok: bool } | D\nmachine M {\n  state { s : S = D }\n  action A()\n  on A { match s { ${arms} } }\n}\n`;
  assert.deepEqual(codesOf(src("E { ok: true } => s' = D  E { ok: false } => s' = D  D => s' = E { ok: true }")), []);
  assert.deepEqual(codesOf(src("E { ok: true } => s' = D  D => s' = E { ok: true }")), ['PL1501']);
  assert.deepEqual(codesOf(src("E { ok: _ } => s' = D  D => s' = E { ok: true }")), []);
  // A literal on an undeclared payload is reported, not a crash in the coverage check. It adds no
  // constraint to coverage, so the program gets exactly one diagnostic, at the pattern: PL1001, and
  // no PL1501 (a behaviour change of the S21 coverage rewrite, recorded in plan-m0.md §14).
  const bad = parse(src("E { nope: true } => s' = D  D => s' = D")).module!;
  const d = checkModule(bad).diagnostics;
  assert.deepEqual(d.map((x) => [x.code, x.at.line, x.at.col]), [['PL1001', 6, 20]]);
});
