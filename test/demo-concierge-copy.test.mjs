// Step 9 (DF8, Q11): the demo copy of the concierge is produced by a script, differs from examples/concierge only where DF8 says, and its
// diff is printed. The check of the copy (CLEAN with its instance) is heavy and runs in the serial group
// (test/after/demo-concierge-e2e.test.mjs); this file is the light part. The price tables are placeholders until the owner reads the
// vendor's page, and a live launch refuses them (the price gate), the way the harness's live run does (E3.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@poly/lang';
import { makeDemoConcierge, DEMO_CAPS, DEMO_TIMEOUTS } from '../demo/scripts/make-demo-concierge.mjs';
import { checkPrices, refusalsOf } from '../demo/host/price-gate.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
const files = (dir) => Object.fromEntries(walk(dir).map((f) => [relative(dir, f).split(sep).join('/'), readFileSync(f, 'utf8')]));

test('DF8: the committed demo copy is what the script produces (the standing rule for a generated copy)', () => {
  const out = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  try {
    makeDemoConcierge({ out });
    assert.deepEqual(files(out), files(join(ROOT, 'demo', 'concierge')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('DF8: the copy holds the program, the policy, the maps and the prices of the example, and nothing of its host or README', () => {
  const copy = files(join(ROOT, 'demo', 'concierge'));
  assert.deepEqual(Object.keys(copy).sort(), ['concierge.policy.poly', 'concierge.poly', 'maps/large.json', 'maps/small.json', 'prices/large.json', 'prices/small.json']);
});

test('DF8, DF12: the diff against examples/concierge is the two cap lines and the four timeouts and nothing else, and it is printed', () => {
  const out = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  try {
    const { diff, changed } = makeDemoConcierge({ out });
    assert.deepEqual(changed, ['concierge.poly']);
    const lines = diff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
    // The timeouts (DF12 item 5) come first in the file, in the order of the decisions: classify, amount, answer, reply.
    const timeouts = [['800ms', DEMO_TIMEOUTS.classify], ['800ms', DEMO_TIMEOUTS.amount], ['2s', DEMO_TIMEOUTS.answer], ['2s', DEMO_TIMEOUTS.reply]];
    assert.deepEqual(lines, [
      ...timeouts.flatMap(([from, to]) => [`-    timeout ${from}`, `+    timeout ${to}`]),
      `-  cap usd ${DEMO_CAPS.example.run} per run`, `-  cap usd ${DEMO_CAPS.example.day} per day per scope`, `+  cap usd ${DEMO_CAPS.demo.run} per run`, `+  cap usd ${DEMO_CAPS.demo.day} per day per scope`,
    ]);
    assert.match(diff, /diff --git/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('DF8: the policy, the maps and the prices of the copy are the example\'s, byte for byte', () => {
  const ex = files(join(ROOT, 'examples', 'concierge'));
  const copy = files(join(ROOT, 'demo', 'concierge'));
  for (const f of ['concierge.policy.poly', 'maps/large.json', 'maps/small.json', 'prices/large.json', 'prices/small.json']) assert.equal(copy[f], ex[f], f);
});

test('DF7: the copy\'s budget caps spend per run and per day, below the example\'s, and the copy still parses', () => {
  const copy = readFileSync(join(ROOT, 'demo', 'concierge', 'concierge.poly'), 'utf8');
  assert.match(copy, new RegExp(`cap usd ${DEMO_CAPS.demo.run} per run`));
  assert.match(copy, new RegExp(`cap usd ${DEMO_CAPS.demo.day} per day per scope`));
  assert.ok(Number(DEMO_CAPS.demo.run) < Number(DEMO_CAPS.example.run) && Number(DEMO_CAPS.demo.day) < Number(DEMO_CAPS.example.day));
  const r = parse(copy);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.module);
});

test('E3.9 pattern: a live launch is refused while the copy\'s price tables are placeholders, and passes tables read from a vendor\'s page', () => {
  const live = checkPrices(join(ROOT, 'demo', 'concierge', 'prices'), new Date('2026-10-15T00:00:00Z'));
  assert.equal(live.ok, false);
  assert.ok(live.tables.every((t) => t.refusals.some((r) => /placeholder/.test(r))), JSON.stringify(live.tables));
  const good = { v: 1, provider: 'small', model: 'a-real-model-id', currency: 'usd', perMillionTokens: { input: 1_000_000, output: 5_000_000 }, source: 'https://vendor.example.org/pricing', readOn: '2026-10-10' };
  assert.deepEqual(refusalsOf({ ...good, source: 'https://www.vendor-site.com/pricing' }, new Date('2026-10-15T00:00:00Z')), []);
  assert.ok(refusalsOf({ ...good, readOn: '2026-01-01' }, new Date('2026-10-15T00:00:00Z')).some((r) => /days old/.test(r)));
  assert.ok(refusalsOf({ ...good, model: 'placeholder-model' }, new Date('2026-10-15T00:00:00Z')).some((r) => /placeholder/.test(r)));
});
