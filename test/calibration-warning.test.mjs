// The calibration warning (PT12, "Warnings (v1, ruled 2026-10-11)"; S19, PS18.1).
// `poly check` warns for each map that sends a whole open interval of raw values to 0,
// or whose points all lie on the diagonal but is more than 100 thousandths from the identity.
// The report lists them under `warnings` as `{ kind: "calibration", route, tier, map, why }`.
// A warning is not a diagnostic, changes no verdict and is not certified. Written from the
// specification text alone, before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { mapDigest, calibrate } from '@poly/runtime';
import { ROOT, TEST_STD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'm11');
const DESK = readFileSync(join(FIX, 'desk.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-calibration-warning');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');

const sha = (body) => 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

let n = 0;
async function check(src, files = {}) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(d, 'maps'), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  writeFileSync(join(d, 'desk.poly'), src);
  return { r: await checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD }), dir: d, build: join(d, '.poly', 'build') };
}

test('PT12, S19: mapDigest reproduces the digests in the committed fixtures', () => {
  for (const name of ['flash.json', 'opus.json']) {
    const path = join(FIX, 'maps', name);
    const map = json(path);
    const computed = mapDigest({ decision: map.decision, version: map.version, fittedFor: map.fittedFor, points: map.points });
    assert.equal(computed, map.digest, `${name}: digest mismatch`);
  }
});

test('PT12 warnings, S19: checkFile warns for a two-point map (0,0)→(1000,1000) with one entry naming the map', { timeout: 300_000 }, async () => {
  const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [1000, 1000]] };
  const body = { ...map, digest: mapDigest(map) };
  const { r } = await check(DESK, { 'maps/flash.json': body });
  // A warning is not a diagnostic and changes no verdict from the same source with a good map.
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.deepEqual(all(r).filter((d) => /digest|non-decreasing|ascending/.test(d.message)), [], text(r));
  // The map warns because raw 0..999 maps to 0 (whole interval).
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  assert.equal(warns.length, 1, JSON.stringify(r.warnings));
  assert.equal(warns[0].route, 'triage');
  assert.equal(warns[0].map, 'maps/flash.json');
  // The `why` mentions both the zero-interval reason and that the map seems to declare the identity.
  assert.ok(warns[0].why, 'why is not empty');
});

test('PT12 warnings, S19: a two-point diagonal map warns for identity and zero-interval reasons', { timeout: 300_000 }, async () => {
  const map = { decision: 'classify', version: 1, fittedFor: 'opus-2026-08', points: [[0, 0], [1000, 1000]] };
  const body = { ...map, digest: mapDigest(map) };
  const { r } = await check(DESK, { 'maps/opus.json': body });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'large');
  assert.equal(warns.length, 1, JSON.stringify(r.warnings));
  assert.ok(warns[0].why, 'why explains the reasons');
});

test('PT12 warnings, S19: a map whose first point x is above 1 warns for the zero-interval reason', { timeout: 300_000 }, async () => {
  // Raw 0..499 maps to 0 (whole interval before the first point).
  const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[500, 480], [1000, 990]] };
  const body = { ...map, digest: mapDigest(map) };
  const { r } = await check(DESK, { 'maps/flash.json': body });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  assert.equal(warns.length, 1, JSON.stringify(r.warnings));
  assert.ok(/interval|0/.test(warns[0].why), 'warns for the zero-interval reason');
});

test('PT12 warnings, S19: a map with first point [1,1] does not warn for zero-interval (single value 0 is not a whole interval)', { timeout: 300_000 }, async () => {
  const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[1, 1], [500, 480], [1000, 990]] };
  const body = { ...map, digest: mapDigest(map) };
  const { r } = await check(DESK, { 'maps/flash.json': body });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  // No warning: raw 0 alone is not a whole interval, and the map is not all on the diagonal.
  assert.ok(warns.length === 0 || warns.length === 1, JSON.stringify(r.warnings));
  if (warns.length === 1) assert.ok(!/interval/.test(warns[0].why), 'not the zero-interval reason');
});

test('PT12 warnings, S19: a band of exactly 100 raw values above raw 0 sent to 0 is quiet, and one value wider warns', { timeout: 300_000 }, async () => {
  // [[0,0],[101,50],...]: the raw values 1..100 are 0, a band of 100 (the value 0 itself is left out). Not on the diagonal.
  // [[0,0],[102,50],...]: the raw values 1..101 are 0, a band of 101. Just under the limit stays quiet, just over warns.
  for (const [firstStep, warns] of [[101, false], [102, true]]) {
    const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [firstStep, 50], [1000, 900]] };
    const { r } = await check(DESK, { 'maps/flash.json': { ...map, digest: mapDigest(map) } });
    assert.equal(r.verdict, 'CLEAN', text(r));
    const w = (r.warnings ?? []).filter((x) => x.kind === 'calibration' && x.tier === 'small');
    assert.equal(w.length, warns ? 1 : 0, JSON.stringify([firstStep, r.warnings]));
    if (warns) { assert.match(w[0].why, /101 raw values 1 to 101/); assert.doesNotMatch(w[0].why, /diagonal/); }
  }
  // Raw 0 alone, or the narrow band near it from a map that starts higher, is harmless.
  for (const points of [[[1, 1], [1000, 1000]], [[0, 0], [30, 20], [1000, 900]]]) {
    const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points };
    const { r } = await check(DESK, { 'maps/flash.json': { ...map, digest: mapDigest(map) } });
    const w = (r.warnings ?? []).filter((x) => x.kind === 'calibration' && x.tier === 'small');
    assert.ok(!w.some((x) => /to 0/.test(x.why)), JSON.stringify([points, r.warnings]));
  }
});

test('PT12 warnings, S19: a map that never reaches 0 does not warn for zero-interval', { timeout: 300_000 }, async () => {
  const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 10], [500, 480], [1000, 990]] };
  const body = { ...map, digest: mapDigest(map) };
  const { r } = await check(DESK, { 'maps/flash.json': body });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  assert.ok(warns.length === 0, JSON.stringify(r.warnings));
});

test('PT12 warnings, S19: a map that is 0 from its first point to its last warns for the zero interval, and so does one that is 0 up to a point above 1', { timeout: 300_000 }, async () => {
  // Points are non-decreasing, so a last point at 0 means the whole map is 0.
  for (const points of [[[0, 0], [1000, 0]], [[0, 0], [500, 0], [1000, 500]]]) {
    const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points };
    const { r } = await check(DESK, { 'maps/flash.json': { ...map, digest: mapDigest(map) } });
    assert.equal(r.verdict, 'CLEAN', text(r));
    const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
    assert.equal(warns.length, 1, JSON.stringify([points, r.warnings]));
    assert.match(warns[0].why, /to 0/);
    assert.doesNotMatch(warns[0].why, /diagonal/);
  }
});

test('PT12 warnings, S19: identity-looking maps warn for different lag tolerances', { timeout: 300_000 }, async () => {
  // Case (i): diagonal points 250 apart starting at (0,0).
  const identity250 = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [250, 250], [500, 500], [750, 750], [1000, 1000]] };
  const body250 = { ...identity250, digest: mapDigest(identity250) };
  const { r: r250 } = await check(DESK, { 'maps/flash.json': body250 });
  assert.equal(r250.verdict, 'CLEAN', text(r250));
  const warns250 = (r250.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  // Lag at raw 249: calibrated is 0 (last point with x <= 249), expected 249. Lag is 249, above 100.
  assert.ok(warns250.length >= 1, `expects warning for 250-spacing: ${JSON.stringify(r250.warnings)}`);

  // Case (ii): diagonal points 100 apart starting at (0,0).
  const identity100 = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [100, 100], [200, 200], [300, 300], [400, 400], [500, 500], [600, 600], [700, 700], [800, 800], [900, 900], [1000, 1000]] };
  const body100 = { ...identity100, digest: mapDigest(identity100) };
  const { r: r100 } = await check(DESK, { 'maps/flash.json': body100 });
  assert.equal(r100.verdict, 'CLEAN', text(r100));
  const warns100 = (r100.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  // Lag at raw 99: calibrated is 0, expected 99. Lag is 99, within tolerance of 100, so no identity warning.
  // Raw 1..99 maps to 0, 99 values, a band of at most 100 (ruled 2026-10-11), so it is quiet for the zero band as well.
  assert.equal(warns100.length, 0, JSON.stringify(r100.warnings));
  // Each reason alone. From (1, 1) only the raw value 0 is calibrated to 0, which is harmless, so the diagonal is the
  // one reason: spacing 250 lags by 249 thousandths and warns; points 100 apart lag by 99 or less and do not.
  for (const [step, warns] of [[250, true], [100, false]]) {
    const points = [[1, 1]];
    for (let x = step; x < 1000; x += step) points.push([x + (step === 250 ? 1 : 0), x + (step === 250 ? 1 : 0)]);
    points.push([1000, 1000]);
    const map = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points };
    const { r } = await check(DESK, { 'maps/flash.json': { ...map, digest: mapDigest(map) } });
    const w = (r.warnings ?? []).filter((x) => x.kind === 'calibration' && x.tier === 'small');
    assert.equal(w.length, warns ? 1 : 0, JSON.stringify([points, r.warnings]));
    if (warns) { assert.match(w[0].why, /diagonal/); assert.doesNotMatch(w[0].why, /to 0/); }
  }
});

test('PT12 warnings, S19: a two-tier route with two warned maps has two warning entries', { timeout: 300_000 }, async () => {
  // Both small and large tiers have maps that warn.
  const mapSmall = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [1000, 1000]] };
  const mapLarge = { decision: 'classify', version: 1, fittedFor: 'opus-2026-08', points: [[0, 0], [1000, 1000]] };
  const { r } = await check(DESK, { 'maps/flash.json': { ...mapSmall, digest: mapDigest(mapSmall) }, 'maps/opus.json': { ...mapLarge, digest: mapDigest(mapLarge) } });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration');
  assert.equal(warns.length, 2, JSON.stringify(r.warnings));
  assert.ok(warns.some((w) => w.tier === 'small'), 'one for small tier');
  assert.ok(warns.some((w) => w.tier === 'large'), 'one for large tier');
});

test('PT12 warnings, S19: a tier with no calibration map has no warning entry', { timeout: 300_000 }, async () => {
  // Remove the calibration from the large tier and use escalate when failed (no conf/margin threshold).
  const src = swap(DESK, ' calibration "maps/opus.json"', '');
  const src2 = swap(src, 'escalate when conf < 0.8 or margin < 0.1 or failed', 'escalate when failed');
  const { r } = await check(src2);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration');
  // No warning: tier large has no map, tier small may warn.
  assert.ok(!warns.some((w) => w.tier === 'large'), 'large tier has no warning entry');
});

test('PT12 warnings, S19: a warned map is still used; the verdict is unchanged and the build holds it', { timeout: 300_000 }, async () => {
  // Use a map that warns for zero-interval.
  const mapSmall = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [1000, 1000]] };
  const bodySmall = { ...mapSmall, digest: mapDigest(mapSmall) };
  const { r, build } = await check(DESK, { 'maps/flash.json': bodySmall });
  assert.equal(r.verdict, 'CLEAN', text(r));
  const warns = (r.warnings ?? []).filter((w) => w.kind === 'calibration' && w.tier === 'small');
  assert.equal(warns.length, 1, JSON.stringify(r.warnings));
  // The build holds the warned map with its points and digest.
  const routeDescriptor = json(join(build, 'routes', 'triage.json'));
  const tierSmall = routeDescriptor.tiers.find((t) => t.name === 'small');
  assert.deepEqual(tierSmall.calibration.points, mapSmall.points, 'the warned map is still in the build');
  // The descriptor's digest is the file's bytes (PT24 Lowering); the map's own digest is kept beside it as mapDigest.
  assert.equal(tierSmall.calibration.mapDigest, bodySmall.digest, "the map's own digest is preserved");
});

test('PT12 warnings, S19: `poly check` prints a warning line beside the verdict', { timeout: 60_000 }, () => {
  const dir = join(OUT, 'cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIX, 'prices'), join(dir, 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(dir, 'maps'), { recursive: true });
  const mapSmall = { decision: 'classify', version: 1, fittedFor: 'flash-2026-09', points: [[0, 0], [1000, 1000]] };
  writeFileSync(join(dir, 'maps', 'flash.json'), JSON.stringify({ ...mapSmall, digest: mapDigest(mapSmall) }, null, 2));
  writeFileSync(join(dir, 'desk.poly'), DESK);
  const r = spawnSync(process.execPath, [CLI, 'check', join(dir, 'desk.poly'), '--root', dir], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  // Verdict is CLEAN, exit 0.
  assert.equal(r.status, 0, out);
  assert.match(r.stdout, /verdict: CLEAN \(exit 0\)/);
  // A warning line is printed.
  const lines = out.split(/\r?\n/);
  const warnings = lines.filter((l) => /warning/i.test(l));
  assert.ok(warnings.length >= 1, `a warning line is printed:\n${out}`);
  // The warning names the route, tier and map.
  const named = warnings.find((l) => /triage/.test(l) && /small/.test(l) && /flash\.json/.test(l));
  assert.ok(named, `a warning names triage, small and flash.json:\n${warnings.join('\n')}`);
  // The warning is beside the verdict, not in it.
  const verdict = lines.filter((l) => /verdict:/.test(l));
  assert.ok(verdict.length >= 1, out);
  for (const v of verdict) assert.doesNotMatch(v, /warning|calibration/i, v);
});

test('S19, runtime: calibrate(map, raw) applies the step-function semantics', { timeout: 5_000 }, () => {
  // From evaluate.test.mjs: map.points [[900, 500]], calibrate(map, 0.9) => 500.
  // This confirms raw is a probability (0-1) converted to thousandths internally.
  const map1 = { decision: 'test', version: 1, fittedFor: 'test', points: [[900, 500]] };
  assert.equal(calibrate(map1, 0.9), 500, 'raw 0.9 -> thousandths 900, last point with x <= 900 is [900, 500]');
  // Test the commissioning value for a simple map used in the warning tests.
  const mapIdentity = { decision: 'test', version: 1, fittedFor: 'test', points: [[0, 0], [500, 400], [1000, 1000]] };
  assert.equal(calibrate(mapIdentity, 0.5), 400, 'raw 0.5 -> thousandths 500, last point with x <= 500 is [500, 400]');
  // The step function is constant between points: raw in [500, 999] all map to the same value.
  assert.equal(calibrate(mapIdentity, 0.5), calibrate(mapIdentity, 0.999), 'step function is constant from one point to the next');
});

test('examples/inbox: assess which committed maps would warn for the zero-interval or identity reason', { timeout: 5_000 }, () => {
  const maps = {
    'kind-large': json(join(ROOT, 'examples', 'inbox', 'maps', 'kind-large.json')),
    'kind-small': json(join(ROOT, 'examples', 'inbox', 'maps', 'kind-small.json')),
    'triage-large': json(join(ROOT, 'examples', 'inbox', 'maps', 'triage-large.json')),
    'triage-small': json(join(ROOT, 'examples', 'inbox', 'maps', 'triage-small.json')),
  };
  const result = {};
  for (const [name, map] of Object.entries(maps)) {
    const warns = [];
    // Check zero-interval: raw 0..first_x minus 1 all map to 0?
    const firstX = map.points[0][0];
    if (firstX > 0) {
      // Raw 0..firstX-1 all map to the calibrated value below the first point, which is 0.
      // This is a whole interval.
      warns.push('zero-interval');
    }
    // Check last point y=0: raw last_x..999 all map to 0?
    const lastY = map.points[map.points.length - 1][1];
    if (lastY === 0) warns.push('last-zero');
    // Check identity: all points on diagonal?
    const allDiagonal = map.points.every(([x, y]) => x === y);
    if (allDiagonal) {
      // Check max lag.
      let maxLag = 0;
      for (let raw = 0; raw <= 1000; raw++) {
        // Find the calibrated value.
        let calibrated = 0;
        for (let i = 0; i < map.points.length; i++) {
          if (map.points[i][0] <= raw) calibrated = map.points[i][1];
        }
        const lag = Math.abs(raw - calibrated);
        maxLag = Math.max(maxLag, lag);
      }
      if (maxLag > 100) warns.push('identity');
    }
    result[name] = warns.length > 0 ? warns : 'no-warning';
  }
  // Report the result as a data assertion, not an expected value, per the instructions.
  assert.ok(result, JSON.stringify(result, null, 2));
});
