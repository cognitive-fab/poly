// S145: the gate engine is an optional peer. poly-runtime resolves it from the sibling checkout, checks every pinned
// file before it imports one, and says why when it cannot: an absent or changed peer is not run, never assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { polyaxionPeer, loadPolyaxion } from '@poly/runtime';

test('S145: the sibling checkout resolves, every pinned file matches, and the engine imports', async (t) => {
  const peer = polyaxionPeer();
  if (!peer.ok) { t.todo(`not run: ${peer.reason}`); return; }
  const px = await loadPolyaxion();
  assert.equal(typeof px.Polyaxion, 'function');
  assert.equal(typeof px.admitPolicy, 'function');
});

test('S145: an absent peer, or one whose file differs from its pin, is not run, with the reason', () => {
  const absent = polyaxionPeer({ dir: join(tmpdir(), 'no-such-polyaxion'), fresh: true });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /absent/);
  const real = polyaxionPeer();
  if (!real.ok) return;
  const copy = mkdtempSync(join(tmpdir(), 'polyaxion-copy-'));
  try {
    cpSync(join(real.dir, 'packages', 'polyaxion', 'src'), join(copy, 'packages', 'polyaxion', 'src'), { recursive: true });
    writeFileSync(join(copy, 'packages', 'polyaxion', 'src', 'engine.mjs'), '// changed\n');
    const changed = polyaxionPeer({ dir: copy, fresh: true });
    assert.equal(changed.ok, false);
    assert.match(changed.reason, /differs from its pin/);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
