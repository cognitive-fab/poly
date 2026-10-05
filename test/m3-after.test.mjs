// The subscription pilots' ruling (4c630d2). The arms' folder is checked after every run as well as before, and a
// run during which anything was synced into it is unscored and rerun. The caps (15,000,000 tokens, $15 at list price,
// one hour) are set not to bind; a run a cap stops is recorded as stopped, never rerun, and the analysis states, per
// arm, how many runs a cap stopped and which cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOne } from '../experiments/m3/runner/run.mjs';
import { DRY, stubScript } from '../experiments/m3/runner/dry-run.mjs';
import { SETTINGS } from '../experiments/m3/runner/isolation.mjs';
import { capStops } from '../experiments/m3/analysis/analyse.mjs';

/** A clean arms' folder: the login, the settings and nothing else. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-after-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(SETTINGS));
  writeFileSync(join(dir, '.credentials.json'), '{}');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
  return dir;
}

test('a run that leaves the folder clean is scored; one during which anything was synced into it is unscored', async () => {
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-after-runs-'));
  const clean = folder();
  const synced = folder();
  try {
    const agent = () => ({ kind: 'stub', turns: stubScript(1).turns });
    // Run numbers of this file's own, apart from every other file's workspace under the frozen runner (decisions-m8.md).
    const a = await runOne({ arm: 1, task: 'T1', run: 920, model: 'stub', tokens: DRY.tokens, wallMs: DRY.wallMs, out, agent: agent(), isolation: { configDir: clean } });
    assert.equal(a.record.unscored, undefined);
    assert.deepEqual(a.record.isolation.after, []);
    // The account's skills arrive during the run, as they did on the first call after the owner's login.
    const b = await runOne({ arm: 1, task: 'T1', run: 921, model: 'stub', tokens: DRY.tokens, wallMs: DRY.wallMs, out, agent: { kind: 'stub', turns: stubScript(1).turns.map((t, i) => (i === 0 ? { ...t, before: () => mkdirSync(join(synced, 'skills', 'synced'), { recursive: true }) } : t)) }, isolation: { configDir: synced } });
    assert.equal(b.record.unscored, 'synced');
    assert.ok(b.record.isolation.after.some((p) => /skills/.test(p)), JSON.stringify(b.record.isolation.after));
    assert.equal(JSON.parse(readFileSync(join(b.dir, 'run.json'), 'utf8')).unscored, 'synced');
  } finally {
    for (const d of [out, clean, synced]) rmSync(d, { recursive: true, force: true });
  }
});

test('the analysis states, per arm, how many runs a cap stopped and which cap', () => {
  const run = (arm, stops) => ({ arm, task: 'T1', scores: [], versions: stops.map((stopped, n) => ({ n, attempted: true, stopped })) });
  const records = [run(1, [null, null, null, null]), run(2, [null, 'budget']), run(2, [null, null, 'wall']), run(2, ['usd']), run(3, [null, null, null, null])];
  assert.deepEqual(capStops(records), {
    1: { runs: 1, stopped: 0, tokens: 0, wall: 0, usd: 0 },
    2: { runs: 3, stopped: 3, tokens: 1, wall: 1, usd: 1 },
    3: { runs: 1, stopped: 0, tokens: 0, wall: 0, usd: 0 },
    4: { runs: 0, stopped: 0, tokens: 0, wall: 0, usd: 0 },
  });
});
