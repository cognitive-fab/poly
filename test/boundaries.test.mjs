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

// Review finding P8: the boundary cannot be passed by a require made at run time, a template literal,
// a subprocess, or a computed name for fetch.
test('P8: indirect routes across the boundary are violations too', () => {
  for (const src of [
    "import { createRequire } from 'node:module'\nconst lang = createRequire(import.meta.url)('@poly/lang')\n",
    'const lower = await import(`@poly/lower`)\n',
    "const core = await import('@poly/' + 'core')\n",
  ]) assert.ok(violationsOf('poly-ref', 'a.ts', src).length >= 1, src);
  for (const pkg of ['poly-ref', 'poly-check']) {
    assert.ok(violationsOf(pkg, 'a.ts', "import { spawn } from 'node:child_process'\n").length >= 1);
    assert.ok(violationsOf(pkg, 'a.ts', "const f = globalThis['fe' + 'tch']\n").length >= 1);
  }
  assert.deepEqual(violationsOf('poly-ref', 'a.ts', "import type { Machine } from '@poly/core'\nimport { createRequire } from 'node:module'\n"), []);
});

// S182: network code lives in poly-io alone, and poly-io and the check packages never import each other.
test('S182: poly-io alone may open a socket; it imports only node builtins and the runtime adapter interface, as types', () => {
  assert.deepEqual(violationsOf('poly-io', 'a.ts', "import { request } from 'node:https'\nimport { connect } from 'node:tls'\nimport { createServer } from 'node:http'\n"), []);
  assert.deepEqual(violationsOf('poly-io', 'a.ts', "import type { ChannelAdapter } from '@poly/runtime/adapters'\nimport { hmac } from './util.js'\n"), []);
  for (const src of [
    "import { ChannelAdapter } from '@poly/runtime/adapters'\n",
    "import type { PolyRuntime } from '@poly/runtime'\n",
    "import { checkFile } from '@poly/check'\n",
    "import type { Module } from '@poly/core'\n",
    "const m = await import('@poly/lower')\n",
    "import { x } from '../../poly-check/src/index.js'\n",
    "import got from 'got'\n",
  ]) assert.ok(violationsOf('poly-io', 'a.ts', src).length >= 1, src);
  for (const pkg of ['poly-core', 'poly-lang', 'poly-lower', 'poly-ref', 'poly-embed', 'poly-check', 'poly-agent']) {
    assert.ok(violationsOf(pkg, 'a.ts', "import { ingress } from '@poly/io'\n").length >= 1, pkg);
    assert.ok(violationsOf(pkg, 'a.ts', "import type { X } from '@poly/io'\n").length >= 1, pkg);
  }
  assert.ok(violationsOf('poly-runtime', 'a.ts', "import https from 'node:https'\n").length >= 1);
});

test('S182, polywatch on step 8: HTTP/2 is a network module too', () => {
  for (const spec of ['node:http2', 'http2']) assert.ok(violationsOf('poly-check', 'a.ts', `import x from '${spec}'\n`).length >= 1, spec);
  assert.deepEqual(violationsOf('poly-io', 'a.ts', "import { connect } from 'node:http2'\n"), []);
});
