// M11 step 8 (PT24.5, PD3.2, S355): swapping a tier's model. The tier's model is its price table's; a model changed
// with its calibration map unchanged is refused PL6842, at check and so at admission, since `poly deploy` is not built;
// a map refitted for the new model is admitted, and the certificate binds the new model and map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapDigest } from '@poly/runtime';
import { CODES } from '@poly/core';
import { admittedDesk, FIX } from './routing-helpers.mjs';

const json = (f) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const NEW = 'opus-2026-11';

test('PL6842: a tier whose model changed with its map unchanged is refused at admission', { timeout: 300_000 }, async () => {
  assert.equal(CODES.PL6842.name, 'MODEL_WITHOUT_REFITTED_MAP');
  const prices = { ...json('prices/opus.json'), model: NEW, readOn: '2026-11-01' };
  await assert.rejects(admittedDesk('routing-swap-stale', undefined, { 'prices/opus.json': prices }), (e) => /PL6842/.test(e.message) || /not admitted/.test(e.message));
  // The check names the tier, the new model and the model the map was fitted for.
  const { checkFile } = await import('@poly/check');
  const { mkdirSync, cpSync, writeFileSync, rmSync } = await import('node:fs');
  const { ROOT, TEST_STD } = await import('./helpers.mjs');
  const d = join(ROOT, '.poly', 'test-routing-swap');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'maps'), join(d, 'maps'), { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  writeFileSync(join(d, 'prices', 'opus.json'), JSON.stringify(prices));
  writeFileSync(join(d, 'desk.poly'), readFileSync(join(FIX, 'desk.poly'), 'utf8'));
  const r = await checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD });
  assert.equal(r.verdict, 'REFUSED');
  const f = r.diagnostics.find((x) => x.code === 'PL6842');
  assert.ok(f, JSON.stringify(r.diagnostics.map((x) => x.message)));
  assert.match(f.message, /tier large calls model opus-2026-11/);
  assert.match(f.message, /fitted for opus-2026-08/);
});

test('PT24.5, S355: a map refitted for the new model is admitted, and the certificate binds the new model and map', { timeout: 300_000 }, async () => {
  const prices = { ...json('prices/opus.json'), model: NEW, readOn: '2026-11-01' };
  const body = { decision: 'classify', version: 2, fittedFor: NEW, points: [[0, 0], [500, 470], [800, 780], [950, 930]] };
  const map = { ...body, digest: mapDigest(body) };
  const a = await admittedDesk('routing-swap-refit', undefined, { 'prices/opus.json': prices, 'maps/opus.json': map });
  const d = a.cert.poly.decisions.find((x) => x.kind === 'decision.classify');
  assert.deepEqual(d.tiers.find((t) => t.name === 'large'), { name: 'large', provider: 'opus', model: NEW, calibration: map.digest });
  // The small tier is unchanged.
  assert.deepEqual(d.tiers.find((t) => t.name === 'small').model, 'flash-2026-09');
});
