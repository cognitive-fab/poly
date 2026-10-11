// M7.1 (PT29.1): the export writes no chain, and no MCP tool serves it. These two checks were in
// test/trace-export-privacy.test.mjs, whose other tests could not fail (its fixture had no Content field, so its
// canary never entered the journal); that file is removed and test/trace-export-substance.test.mjs covers the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted, handleWith, loaded } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

const headsOf = async (rt) => Object.fromEntries(await Promise.all((await rt.runs()).map(async (r) => [r.run, (await rt.chain(r.run)).at(-1)?.hash ?? null])));

test('PT29.1: the export writes no chain: every run\'s head is what it was, after the export', async () => {
  const a = await admitted('trace-chain', ['conformance/m1/effects.poly']);
  writeFileSync(join(a.dir, 'admission.pub'), a.key.publicKey);
  const tmp = mkdtempSync(join(tmpdir(), 'poly-trace-chain-'));
  const db = join(tmp, 'store.db');
  try {
    const first = await loaded(a, { store: { sqlite: db } });
    let before;
    try {
      for (const k of ['billing.invoice', 'billing.perk', 'mail.receipt', 'mail.notice']) handleWith(first.rt, k, () => ({ ok: true }));
      await first.rt.create('effects.Account', { id: 'acc-1' });
      await first.rt.dispatch('acc-1', 'Bill', { tier: 'Gold' });
      await first.rt.dispatch('acc-1', 'Notify', {});
      await first.rt.signHeads();
      before = await headsOf(first.rt);
    } finally { await first.rt.close(); }
    assert.ok(Object.values(before).filter(Boolean).length >= 1, 'the store has a chain to compare');

    const out = join(tmp, 'export.ndjson');
    const r = poly('export', 'traces', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`, '--out', out);
    assert.equal(r.code, 0, r.out);
    assert.ok(readFileSync(out, 'utf8').split('\n').length > 2, 'the export holds an episode');

    const again = await loaded(a, { store: { sqlite: db } });
    try { assert.deepEqual(await headsOf(again.rt), before); } finally { await again.rt.close(); }
  } finally { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store may stay locked a moment on Windows */ } }
});

test('PT29.1: the registry has export, and no MCP tool serves the corpus', async () => {
  const { commandNamed } = await import('@poly/check');
  const { mcpTools } = await import('@poly/agent');
  const c = commandNamed('export');
  assert.ok(c, 'the registry has the export command');
  assert.equal(c.mcp, null, 'a corpus is private, so no MCP tool serves it');
  assert.ok(!mcpTools().some((t) => /export/.test(t.name) || /trace corpus/.test(t.description)), 'no MCP tool serves the corpus');
});
