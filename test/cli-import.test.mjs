// PT21.4 (ruled 2026-10-11): importing packages/poly-check/dist/src/cli.js runs no command.
// The entry guard prevents it: cli.js exports main(argv), and runs it only when the file is
// the process's entry point. So a host or a test that imports the module starts no command
// and sets no exit code. Running cli.js as the entry still works: with no arguments it prints
// usage and exits 64; with arguments it runs the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');

test('PT21.4: importing cli.js starts no command', { timeout: 60_000 }, () => {
  const cliUrl = pathToFileURL(CLI).href;
  const importCmd = `import('${cliUrl}').then(m => console.log(typeof m.main))`;
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, '--input-type=module', '-e', importCmd], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), 'function', 'main is exported as a function');
  // Node's SQLite warning may be on stderr; usage text is what a command that ran would print.
  assert.doesNotMatch(r.stderr, /usage: poly/, 'no usage text on stderr (no command ran)');
});

test('PT21.4: running cli.js with no arguments prints usage and exits 64', { timeout: 60_000 }, () => {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 64, 'exit code 64 for no arguments');
  const output = r.stdout + r.stderr;
  assert.match(output, /usage|help|Usage/i, 'usage text is printed');
});
