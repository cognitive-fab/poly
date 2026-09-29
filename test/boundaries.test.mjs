// The boundary check must catch what it claims to catch: a checker that
// passes everything is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { violationsOf, checkRepository } from '../scripts/check-boundaries.mjs';

test('the repository passes the boundary check', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  assert.deepEqual(checkRepository(root), []);
});

test('poly-ref may import AST types from @poly/core, and nothing else of it', () => {
  assert.deepEqual(violationsOf('poly-ref', 'a.ts', "import type { Machine } from '@poly/core'\n"), []);
  assert.deepEqual(violationsOf('poly-ref', 'a.ts', "import { type Machine, type Expr } from '@poly/core'\n"), []);
  assert.equal(violationsOf('poly-ref', 'a.ts', "import { parse } from '@poly/core'\n").length, 1);
  assert.equal(violationsOf('poly-ref', 'a.ts', "import { type Machine, digest } from '@poly/core'\n").length, 1);
});

test('poly-ref may not import the compiler packages in any form', () => {
  for (const src of [
    "import { lowerMachine } from '@poly/lower'\n",
    "import type { X } from '@poly/lang'\n",
    "export { y } from '@poly/check'\n",
    "const m = await import('@poly/lower')\n",
    "const m = require('@poly/lang')\n",
    "import { z } from '../../poly-lower/src/index.js'\n",
    "import 'acorn'\n",
  ]) assert.ok(violationsOf('poly-ref', 'a.ts', src).length >= 1, src);
  assert.deepEqual(violationsOf('poly-ref', 'a.ts', "import { createRequire } from 'node:module'\nimport { x } from './values.js'\n"), []);
});

test('no package may reach a model or the network', () => {
  assert.ok(violationsOf('poly-core', 'a.ts', "import Anthropic from '@anthropic-ai/sdk'\n").length >= 1);
  assert.ok(violationsOf('poly-lower', 'a.ts', "import OpenAI from 'openai'\n").length >= 1);
  assert.ok(violationsOf('poly-check', 'a.ts', "import https from 'node:https'\n").length >= 1);
  assert.ok(violationsOf('poly-lang', 'a.ts', "const r = await fetch('http://x')\n").length >= 1);
});
