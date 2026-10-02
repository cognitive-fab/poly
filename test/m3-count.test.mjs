// The pilot report's ruling (d28afc3), point 1: the recorded measure of a turn is the usage of the CLI's final
// result event, and its cost at list price is computed from those token counts (4210fa6). During a turn the
// cut-off uses a running count that takes each message's usage once, by message id; where it differs from the
// result event at the end of the turn, the record says so. The four P1 pilot journals are replayed: the recount
// equals the CLI's figures, and the computed cost equals the CLI's own list-price figure for every turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { M3 } from '../experiments/m3/lib/task.mjs';
import { turnAccount, costOfUsage, PARTS } from '../experiments/m3/runner/agent.mjs';

const PILOTS = join(M3, 'pilots');
const journal = (run) => readFileSync(join(PILOTS, run, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the recount of every pilot turn equals the CLI\'s result event, and the running count differs from it only where the record says so', () => {
  const runs = readdirSync(PILOTS).filter((d) => /^P1-arm\d-run1$/.test(d));
  assert.equal(runs.length, 4);
  for (const run of runs) {
    const events = journal(run);
    for (const turn of [0, 1]) {
      const account = turnAccount();
      for (const e of events.filter((x) => x.turn === turn && x.type === 'stream')) account.add(e.event);
      const result = events.find((x) => x.turn === turn && x.type === 'stream' && x.event.type === 'result').event;
      const f = account.final();
      assert.equal(f.source, 'result', `${run} turn ${turn}`);
      for (const k of PARTS) assert.equal(f.usage[k], result.usage[k], `${run} turn ${turn} ${k}`);
      // Streamed messages carry their output count before it is final; input and cache parts are exact once per message.
      assert.deepEqual(f.differs, PARTS.filter((k) => f.running[k] !== result.usage[k]), `${run} turn ${turn}`);
      assert.ok(f.differs.every((k) => k === 'output_tokens'), `${run} turn ${turn}: ${f.differs}`);
      assert.equal(f.running.cache_read_input_tokens, result.usage.cache_read_input_tokens);
    }
  }
});

test('the cost of a turn at list price, from its token counts, equals the CLI\'s own figure for the turn', () => {
  for (const run of readdirSync(PILOTS).filter((d) => /^P1-arm\d-run1$/.test(d))) {
    const results = journal(run).filter((x) => x.type === 'stream' && x.event.type === 'result').map((x) => x.event);
    // The CLI's total_cost_usd is cumulative over a resumed session: a turn's own cost is the difference.
    let before = 0;
    for (const r of results) {
      assert.ok(Math.abs(costOfUsage(r.usage, 'claude-opus-5-5') - (r.total_cost_usd - before)) < 1e-6, `${run}: ${costOfUsage(r.usage, 'claude-opus-5-5')} vs ${r.total_cost_usd - before}`);
      before = r.total_cost_usd;
    }
  }
});

test('a usage limit and an authentication failure are recognised, so the run is recorded as limited or failed, never scored', () => {
  const limited = turnAccount();
  limited.add({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1 }, content: [{ type: 'text', text: "You've hit your limit · resets 3pm" }] }, error: 'rate_limit' });
  assert.equal(limited.status(), 'limited');
  const viaResult = turnAccount();
  viaResult.add({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000', usage: {} });
  assert.equal(viaResult.status(), 'limited');
  const auth = turnAccount();
  auth.add({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed' });
  assert.equal(auth.status(), 'auth');
  const fine = turnAccount();
  for (const e of journal('P1-arm1-run1').filter((x) => x.type === 'stream')) fine.add(e.event);
  assert.equal(fine.status(), null);
});

test('a run recorded as limited is not scored, and the scorer says so instead of failing', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-limited-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: 'P1-arm1-run1', arm: 1, task: 'P1', unscored: 'limited', versions: [{ n: 0, attempted: true, stopped: 'limited' }] }));
    const r = spawnSync(process.execPath, ['--no-warnings', join(M3, 'runner', 'score.mjs'), dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not scored: limited/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).scores, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn the CLI stops at the dollar cap: its result event reports no usage, so the running count is recorded, and the stop is the cap', () => {
  // Measured: on the subscription, --max-budget-usd 0.0001 stopped the turn after its first call, with
  // subtype error_max_budget_usd, total_cost_usd 0.200628 and every usage part 0 in the result event.
  const a = turnAccount();
  a.add({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 3, cache_creation_input_tokens: 40000, cache_read_input_tokens: 0, output_tokens: 10 } } });
  a.add({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.200628, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } });
  const f = a.final();
  assert.equal(f.source, 'running');
  assert.equal(f.usage.cache_creation_input_tokens, 40000);
  assert.equal(a.capStop(), 'usd');
  assert.equal(a.status(), null);
});
