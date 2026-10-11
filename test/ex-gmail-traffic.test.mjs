// plan-ex.md E2.0: the recorded Gmail tapes are exactly what scripts/ex-gmail-traffic.mjs builds from the synthetic
// corpus, so a corpus edit cannot leave a stale tape, and no tape holds anything the corpus does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const { build, text, BASE } = await import(pathToFileURL(join(ROOT, 'scripts', 'ex-gmail-traffic.mjs')).href);

test('E2.0: each account\'s tape on disk is the one the corpus builds', () => {
  const tapes = build();
  assert.deepEqual(Object.keys(tapes).sort(), ['club', 'home', 'work']);
  for (const [label, tape] of Object.entries(tapes)) assert.equal(readFileSync(join(ROOT, 'test', 'fixtures', 'traffic', 'gmail', `${label}.json`), 'utf8'), text(tape), label);
});

test('E2.0: every recorded request is a GET under the Gmail API\'s base, which gmail.readonly allows (S455, part a)', () => {
  for (const tape of Object.values(build())) for (const exchanges of Object.values(tape)) for (const { request } of exchanges) {
    assert.equal(request.method, 'GET');
    assert.ok(request.url.startsWith(`${BASE}/`), request.url);
    assert.ok(!/\/send\b|\/drafts\b/.test(request.url), request.url);
  }
});
