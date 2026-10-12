// S507 (ruled 2026-10-11): poly-mine is the only package besides poly-new that may start a process, on conditions the
// boundary script checks. Each condition has a broken variant here that the script must catch by the rule it breaks (not
// by another), the base of every variant is clean, and the real package passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { violationsOf } from '../scripts/check-boundaries.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = 'packages/poly-mine/src/index.ts';
const GOOD = [
  "import { execFileSync } from 'node:child_process';",
  "import { createHash } from 'node:crypto';",
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const env = { PATH: process.env.PATH };",
  "execFileSync(process.execPath, ['x', 'mine'], { env });",
].join('\n') + '\n';

/** How many violations of a poly-mine source (the clean base plus some code) match a message. */
const caught = (code, re) => violationsOf('poly-mine', F, GOOD + code + '\n').filter((v) => re.test(v)).length;

test('S507: the real poly-mine passes the boundary check, and so does the clean base of every variant below', () => {
  assert.deepEqual(violationsOf('poly-mine', F, readFileSync(join(ROOT, F), 'utf8')), []);
  assert.deepEqual(violationsOf('poly-mine', F, GOOD), []);
});

test('S507: poly-mine may not import anything that reaches a network, another process module, or another package of poly', () => {
  for (const imp of ["import https from 'node:https';", "import net from 'node:net';", "import { Worker } from 'node:worker_threads';", "import { x } from '@poly/check';", "import { y } from './other.js';", "import v8 from 'node:v8';", "import z from 'undici';"]) {
    assert.ok(caught(imp, /poly-mine imports '[^']+'; it imports node:child_process, node:crypto, node:fs, node:os, node:path only/) >= 1, imp);
  }
});

test('S507: poly-mine starts a process only with execFileSync: no spawn, exec, fork or shell option', () => {
  for (const code of ["spawn('x', []);", "spawnSync('x');", "exec('x');", "execSync('x');", "execFile('x');", "fork('x');", "execFileSync('x', [], { shell: true });", "execFileSync('x', [], { shell: '/bin/sh' });"]) {
    assert.ok(caught(code, /starts a process other than with execFileSync|sets a shell option/) >= 1, code);
  }
  assert.ok(violationsOf('poly-mine', F, GOOD.replace('execFileSync(process.execPath', 'noop(process.execPath')).some((v) => /does not start its process with execFileSync/.test(v)), 'a package with no execFileSync is not the seam');
});

test('S507: poly-mine never reads the whole environment: only names, so the child\'s environment is built fresh', () => {
  for (const code of ["const e = { ...process.env };", "execFileSync('x', [], { env: process.env });", "for (const k of Object.keys(process.env)) {}", "const all = Object.entries(process.env);"]) {
    assert.ok(caught(code, /reads the whole environment/) >= 1, code);
  }
  assert.deepEqual(violationsOf('poly-mine', F, GOOD + "const home = process.env['HOME'];\nconst tmp = process.env.TEMP;\n"), []);
});

test('S507: the name of polyx\'s model-calling command appears nowhere in poly-mine', () => {
  for (const code of ["const c = 'annotate';", "// annotate", "const args = ['Annotate'];"]) assert.ok(caught(code, /names annotate, the polyx command that calls a model/) >= 1, code);
});

test('S507: no other package starts a process, and only poly-check\'s mine command names @poly/mine', () => {
  assert.ok(violationsOf('poly-check', 'packages/poly-check/src/other.ts', "import { execFileSync } from 'node:child_process';\n").some((v) => /imports 'node:child_process'/.test(v)));
  assert.ok(violationsOf('poly-ref', 'packages/poly-ref/src/x.ts', "import { execFileSync } from 'node:child_process';\n").some((v) => /imports 'node:child_process'/.test(v)));
  assert.deepEqual(violationsOf('poly-check', 'packages/poly-check/src/mine.ts', "const pkg = '@poly/mine';\nconst m = await import(pkg);\n"), []);
  for (const [pkg, file] of [['poly-check', 'packages/poly-check/src/other.ts'], ['poly-check', 'packages/poly-check/src/cli.ts'], ['poly-agent', 'packages/poly-agent/src/x.ts'], ['poly-runtime', 'packages/poly-runtime/src/x.ts']]) {
    assert.ok(violationsOf(pkg, file, "const pkg = '@poly/mine';\n").some((v) => /names @poly\/mine, the package that starts polyx/.test(v)), file);
    assert.ok(violationsOf(pkg, file, "import { x } from '../../poly-mine/src/index.js';\n").some((v) => /names @poly\/mine, the package that starts polyx/.test(v)), file);
  }
});
