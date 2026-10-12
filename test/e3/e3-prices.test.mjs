// Q-E3-5 and the owner's ruling of 2026-10-11: a price table whose source is a placeholder (example.com) is refused, and
// the live run (E3.9) cannot start until the committed tables pass the gate. The committed tables are placeholders today,
// so this file tests the gate on tables it writes itself; `node examples/harness/host/price-gate.mjs` is the live-run
// launcher's first step and exits 1 for the committed ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { checkPrices, refusalsOf } from '../../examples/harness/host/price-gate.mjs';

const TODAY = new Date('2026-10-11T12:00:00Z');
const GOOD = {
  v: 1,
  provider: 'main',
  model: 'a-vendor-model',
  currency: 'usd',
  perMillionTokens: { input: 3000000, output: 15000000, cache_write: 3750000, cache_read: 300000 },
  source: 'https://vendor.test-pricing.com/pricing',
  readOn: '2026-10-09',
};

test('Q-E3-5: a table read from a vendor page passes', () => {
  assert.deepEqual(refusalsOf(GOOD, TODAY), []);
});

test('Q-E3-5: a table whose source is example.com is refused, whatever else it says', () => {
  for (const source of ['https://example.com/pricing', 'https://www.example.com/pricing', 'https://example.org/x', 'https://example.net/x', 'https://x.invalid/p', 'https://localhost/p']) {
    assert.ok(refusalsOf({ ...GOOD, source }, TODAY).some((w) => /placeholder host/.test(w)), source);
  }
});

test('Q-E3-5: a table with a source that is not an https page, no date, a stale date or a placeholder model is refused', () => {
  assert.ok(refusalsOf({ ...GOOD, source: 'http://vendor.test-pricing.com/p' }, TODAY).some((w) => /https/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, source: 'pricing page' }, TODAY).some((w) => /not a URL/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, readOn: undefined }, TODAY).some((w) => /not a date/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, readOn: '2026-10-12' }, TODAY).some((w) => /future/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, readOn: '2026-05-01' }, TODAY).some((w) => /days old/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, model: 'main-tier-placeholder' }, TODAY).some((w) => /placeholder/.test(w)));
  assert.ok(refusalsOf({ ...GOOD, perMillionTokens: { input: 0, output: 1 } }, TODAY).some((w) => /positive integers/.test(w)));
  const { cache_write, cache_read, ...noCache } = GOOD.perMillionTokens;
  assert.ok(refusalsOf({ ...GOOD, perMillionTokens: noCache }, TODAY).some((w) => /cache_write and cache_read/.test(w)), 'the pay-gate needs the cache prices');
  assert.ok(refusalsOf({ ...GOOD, perMillionTokens: { ...noCache, cache_write: 100, cache_read: 300000 } }, TODAY).some((w) => /write at least the read/.test(w)));
});

test('Q-E3-5: a directory passes only when every table passes, and an empty one is refused', () => {
  const dir = join(ROOT, '.poly', 'test-build', 'e3-prices');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  assert.equal(checkPrices(dir, TODAY).ok, false, 'no table');
  writeFileSync(join(dir, 'main.json'), JSON.stringify(GOOD));
  assert.equal(checkPrices(dir, TODAY).ok, true);
  writeFileSync(join(dir, 'cheap.json'), JSON.stringify({ ...GOOD, provider: 'cheap', source: 'https://example.com/pricing' }));
  const r = checkPrices(dir, TODAY);
  assert.equal(r.ok, false);
  assert.deepEqual(r.tables.map((t) => [t.file, t.refusals.length > 0]), [['cheap.json', true], ['main.json', false]]);
  writeFileSync(join(dir, 'cheap.json'), 'not json');
  assert.equal(checkPrices(dir, TODAY).ok, false);
});

test('E3.9: the tables proposed for the live run (prices-live) pass the gate, and name the figures read from the vendor page on 2026-10-12', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = join(ROOT, 'examples', 'harness', 'prices-live');
  const day = new Date('2026-10-13T12:00:00Z'); // the date is pinned so that the 90-day age limit does not make this test age
  const r = checkPrices(dir, day);
  assert.deepEqual(r.tables.map((t) => [t.file, t.refusals]), [['cheap.json', []], ['main.json', []]]);
  assert.equal(r.ok, true);
  const t = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  // https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-12, in micro-units per million tokens
  assert.deepEqual([t('main.json').model, t('main.json').perMillionTokens], ['claude-sonnet-5-5', { input: 2000000, output: 10000000, cache_write: 2500000, cache_read: 100000 }]);
  assert.deepEqual([t('cheap.json').model, t('cheap.json').perMillionTokens], ['claude-haiku-4-5-20251001', { input: 1000000, output: 5000000, cache_write: 1250000, cache_read: 100000 }]);
  for (const f of ['main.json', 'cheap.json']) {
    assert.equal(t(f).source, 'https://platform.claude.com/docs/en/about-claude/pricing');
    assert.equal(t(f).readOn, '2026-10-12');
  }
  // and the committed placeholder tables are still refused, so the module's own paths are not live until they are replaced
  const placeholders = checkPrices(join(ROOT, 'examples', 'harness', 'prices'), day);
  assert.equal(placeholders.ok, false);
});
