// plan-ex.md E2, PT24: the inbox's committed calibration maps are step functions, and none sends a band of raw values wider
// than 100 thousandths above raw 0 to 0 (the ruling of 2026-10-11; `poly check` warns of such a band). Each map keeps a point
// at raw 1, which also holds under the warning's earlier rule (two or more consecutive raw values sent to 0). Each digest is
// the digest of the rest of the map, as the route requires (PL1201), and no map calibrates above its raw value, so the
// maps stay conservative until they are refitted on the owner's mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mapDigest } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const DIR = join(ROOT, 'examples', 'inbox', 'maps');
const at = (points, raw) => { let y = 0; for (const [x, v] of points) { if (x <= raw) y = v; else break; } return y; };

test('the inbox\'s four maps send no band of raw values above 0 to 0, have a true digest, and never calibrate above the raw value', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['kind-large.json', 'kind-small.json', 'triage-large.json', 'triage-small.json']);
  for (const f of files) {
    const map = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    const { digest, ...body } = map;
    assert.equal(digest, mapDigest(body), `${f}: digest`);
    let run = 0;
    let longest = 0;
    for (let raw = 1; raw <= 1000; raw++) {
      run = at(map.points, raw) === 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
      assert.ok(at(map.points, raw) <= raw, `${f}: raw ${raw} is calibrated above itself`);
    }
    assert.ok(longest <= 100, `${f}: ${longest} raw values above 0 go to 0`);
    assert.ok(at(map.points, 1) > 0, `${f}: raw 1 is sent to 0`);
  }
});
