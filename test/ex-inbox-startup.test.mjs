// plan-ex.md E2, "Run it yourself": regressions found by the first run of the dry run (test/after/ex-inbox-dry-run.test.mjs),
// each held here as a light test of the piece that was wrong, so it stays fixed without the dry run's minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ROOT } from './helpers.mjs';

const { keychainFor } = await import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', 'run.mjs')).href);

test('the keychain of a credential takes its key and its directory as file:PATH, keeps each credential apart, and writes no token in the clear', async () => {
  const base = mkdtempSync(join(tmpdir(), 'poly-inbox-keychain-'));
  try {
    writeFileSync(join(base, 'vault.key'), randomBytes(32).toString('hex'));
    const config = { vault: { key: `file:${join(base, 'vault.key')}`, dir: join(base, 'vault') } };
    const read = keychainFor(config, 'gmail_read');
    const compose = keychainFor(config, 'gmail_draft');
    const token = `canary-${randomBytes(12).toString('hex')}`;
    await read.put('grant-1', { access: token });
    assert.deepEqual(await read.get('grant-1'), { access: token });
    assert.equal(await compose.get('grant-1'), null, 'a credential\'s grants are its own');
    const files = readdirSync(join(base, 'vault', 'gmail_read'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.equal(files.length, 1);
    assert.ok(!readFileSync(join(files[0].parentPath, files[0].name)).toString('latin1').includes(token), 'the blob holds ciphertext');
    assert.equal(read.kind, 'dev-keychain');
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});
