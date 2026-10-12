// PT31.3 (C4, ruled 2026-10-11): poly-mine starts exactly two tools, polyx and polyness, and the boundary script holds the
// list. Each condition added for the second tool has a broken variant here that the script must catch by the rule it breaks.
// Written by the implementer; the base of every variant is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violationsOf } from '../scripts/check-boundaries.mjs';

const F = 'packages/poly-mine/src/index.ts';
const GOOD = [
  "import { execFileSync } from 'node:child_process';",
  "import { createHash } from 'node:crypto';",
  "import { existsSync, mkdtempSync, rmSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "const env = { PATH: process.env.PATH };",
  "const a = join('x', 'bin', 'polyx.mjs');",
  "const b = join('x', 'bin', 'polyness.mjs');",
  "const c = 'x/bin/polyness.mjs';",
  "execFileSync(process.execPath, [b, 'propose', 'step', 'project'], { env });",
].join('\n') + '\n';
const caught = (code, re) => violationsOf('poly-mine', F, GOOD + code + '\n').filter((v) => re.test(v)).length;

test('PT31.3: the base is clean: the two tools, the temporary directory and the propose command are allowed', () => {
  assert.deepEqual(violationsOf('poly-mine', F, GOOD), []);
});

test('PT31.3: an entry point of a third tool is refused, however it is written', () => {
  for (const code of ["const t = join(d, 'bin', 'polyz.mjs');", "const t = 'x/bin/other-tool.mjs';", 'const t = "bin/third.mjs";']) {
    assert.ok(caught(code, /names the entry point [\w-]+\.mjs; poly-mine starts polyx and polyness and no other tool/) >= 1, code);
  }
});

test('PT31.3: the other commands of polyness (audit, replay) are never named', () => {
  for (const code of ["const c = 'audit';", 'const c = "replay";', "execFileSync(process.execPath, [b, 'audit']);"]) {
    assert.ok(caught(code, /names a polyness command other than propose/) >= 1, code);
  }
});

test('PT31.3: the conditions of polyx hold for the second tool: no shell, no other spawn, no whole environment', () => {
  assert.ok(caught("execFileSync(process.execPath, [b], { shell: true });", /sets a shell option/) >= 1);
  assert.ok(caught("spawnSync(process.execPath, [b]);", /starts a process other than with execFileSync/) >= 1);
  assert.ok(caught("const env = { ...process.env, HOME: home };", /reads the whole environment/) >= 1);
});
