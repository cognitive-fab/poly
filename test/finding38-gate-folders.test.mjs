// Finding 38: PolicyGate.policySets (poly report risks, PT34.4 item 2) and PolicyGate.replaySessions (S118, S146) open a
// fresh gate, and each must leave nothing in the temporary directory when it ends. Each case runs in a child process
// whose TMP, TEMP and TMPDIR name a folder of the test's own, so other tests' gates do not count. Written in the session
// that fixed it, not by a separate writer (a departure from rule 7a, recorded in the finding). Light: two short children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

function leftIn(call) {
  const temp = mkdtempSync(join(tmpdir(), 'poly-f38-'));
  const script = join(mkdtempSync(join(tmpdir(), 'poly-f38-script-')), 'probe.mjs');
  const runtime = pathToFileURL(join(ROOT, 'packages', 'poly-runtime', 'dist', 'src', 'index.js')).href;
  writeFileSync(script, [
    `const { PolicyGate, loadPolyaxion } = await import(${JSON.stringify(runtime)});`,
    'const px = await loadPolyaxion();',
    `const out = await ${call};`,
    'console.log(JSON.stringify(out));',
  ].join('\n'));
  try {
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp } });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout.trim().split('\n').at(-1)), left: readdirSync(temp) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
}

test('finding 38: PolicyGate.policySets leaves no folder in the temporary directory', () => {
  const { out, left } = leftIn("PolicyGate.policySets(px, [], ['m'])");
  assert.equal(typeof out.m, 'string', 'the open module has a policy set');
  assert.deepEqual(left, []);
});

test('finding 38: PolicyGate.replaySessions leaves no folder in the temporary directory', () => {
  const { out, left } = leftIn("PolicyGate.replaySessions(px, [], ['m'], [])");
  assert.deepEqual(out, []);
  assert.deepEqual(left, []);
});
