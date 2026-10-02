// S137 (with S120): every manifest entry declares its retry bound. An effect with no retry clause lowers with
// polyrun's own default written out, so the runtime behaves as before and the OutboxIntent machine is checked at
// a declared bound; poly-ref's read-back expects the same default, from PT6.1, not from the lowering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, ROOT } from './helpers.mjs';

test('every effect of the effects conformance source has its maxAttempts, the default where none is written', () => {
  const [{ dir }] = build(join(ROOT, 'conformance', 'm1', 'effects.poly'), 'retry-default');
  const manifest = JSON.parse(readFileSync(join(dir, 'effects.manifest.json'), 'utf8'));
  for (const [kind, entry] of Object.entries(manifest.effects)) {
    assert.ok(Number.isInteger(entry.retry?.maxAttempts), kind);
    assert.deepEqual(entry.retry, { maxAttempts: 5, baseMs: 500, timeoutMs: 30000 }, kind);
  }
});
