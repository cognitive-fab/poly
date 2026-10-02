// PL1207 RESERVED_REJECT_REASON (PS3.2, S101, S127): a handler or guard may not reject with a reason the runtime
// uses, so a rejection's reason always says who refused the step. Enforced from M4, on both surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { printModule, readEmbedded } from '@poly/embed';
import { ROOT } from './helpers.mjs';

const RESERVED = ['terminal', 'outside-check-domain', 'poisoned', 'archived', 'claims-unverified'];
const SOURCE = join(ROOT, 'conformance', 'm0', 'errors', 'PL1207-reserved-reject-reason.poly');

const diagnosticsOf = (module) => checkModule(module).diagnostics;
const src = (stmt) => `module t\nenum S { A, B }\nmachine M {\n  state { s : S = A }\n  action Go()\n  on Go {\n    ${stmt}\n    s' = B\n  }\n}\n`;

test('each reserved reason is PL1207, in require, reject and guard', () => {
  for (const r of RESERVED) {
    for (const text of [src(`require s == A else reject "${r}"`), src(`if s == B { reject "${r}" }`),
      src(`require s == A else reject "ok"`).replace('  on Go', `  guard all when s == B reject "${r}"\n  on Go`)]) {
      const d = diagnosticsOf(parse(text).module);
      assert.deepEqual(d.map((x) => x.code), ['PL1207'], `${r}: ${text}`);
      assert.match(d[0].message, new RegExp(r));
    }
  }
});

test('a reason that only contains a reserved word is the module\'s own', () => {
  for (const r of ['not-terminal', 'terminal-state', 'Terminal', 'archived-order']) {
    assert.deepEqual(diagnosticsOf(parse(src(`require s == A else reject "${r}"`)).module), [], r);
  }
});

test('the error source raises PL1207 at each of its five rejections, and its embedded twin does the same', () => {
  const p = parse(readFileSync(SOURCE, 'utf8'));
  const standalone = diagnosticsOf(p.module).filter((d) => d.code === 'PL1207');
  assert.equal(standalone.length, 5);
  const twin = readEmbedded(printModule(p.module), 'twin.ts');
  assert.deepEqual(twin.diagnostics, []);
  assert.deepEqual(diagnosticsOf(twin.module).map((d) => d.code), standalone.map((d) => d.code));
});
