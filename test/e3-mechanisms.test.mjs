// plan-e3.md E3.5, HAC2: the four mechanisms (Action Fusion, Online Context Compact, ObservationPack, the Evidence-Preserving
// Reducer) are switched on one at a time over a corpus of twelve recorded trajectories (test/fixtures/harness/trajectories.mjs),
// and each fires where the proposal's definition says it should (HF2.2 to HF2.5): the trigger rate is printed, with the
// trajectories named, and the table is committed (docs/e3/trigger-rates.json) so that a change in a rate is a change in a file.
//
// What "where it should" means here is the proposal's text, not the SoL-Pi paper's own thresholds, which this session cannot
// read. The expectations below are derived from each trajectory's steps (its `specs`), never from the harness's own counters,
// and every count is read from the runtime's records (the journal, the outbox, the decision events) wherever the runtime keeps
// one. The model, the tools and the stage checks are recorded, so "the trial reached the end of its plan" is a statement about
// the harness not ending a recorded run, and is not a measure of whether a model would solve the task (plan-e3.md, Q-E3-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { CONFIGS, matrix } from './e3-matrix-helpers.mjs';

const TABLE = join(ROOT, 'docs', 'e3', 'trigger-rates.json');
const FUSED = new Set(['fuse', 'build', 'leak']);
const FUSION_OPPORTUNITY = new Set(['fuse', 'build', 'leak', 'noRunner']);
const count = (specs, set) => specs.filter((s) => set.has(s)).length;
const names = (m) => Object.keys(m);
const PACK_BYTES = 10240;

test('HAC2 matrix: every trajectory runs under every configuration, 72 runs, each in a fresh runtime', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  assert.equal(names(m).length, 12);
  for (const n of names(m)) assert.deepEqual(names(m[n].runs), Object.keys(CONFIGS), n);
});

test('HAC2, Action Fusion (HF2.2): an edit then a declared runner is fused, a command that is not a declared runner is not, and off fuses nothing', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  for (const [n, { t, runs }] of Object.entries(m)) {
    assert.equal(runs.base.metrics.fusion.fired, 0, `${n}: base`);
    assert.ok(runs.base.acts.every((f) => f === false), `${n}: base fused an act`);
    const on = runs.fusion;
    // a trial that ended early on overflow (the many-reads task, which no pay-gate compacts here) saw fewer steps
    const seen = t.specs.slice(0, on.steps);
    assert.equal(on.metrics.fusion.opportunities, count(seen, FUSION_OPPORTUNITY), `${n}: opportunities`);
    assert.equal(on.metrics.fusion.fired, count(seen, FUSED), `${n}: fired`);
    // the runtime's own record: the act effects whose payload says fused
    assert.equal(on.acts.filter(Boolean).length, count(seen, FUSED), `${n}: fused acts in the outbox`);
    if (on.mode === 'Done') assert.equal(on.steps, t.specs.length, n);
  }
});

test('HAC2, Online Context Compact (HF2.3, HF3.8): a compaction is chosen only at a finished step where it pays, and one is tried at the limit before the trial may end', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  let chosen = 0;
  let declined = 0;
  for (const [n, { runs }] of Object.entries(m)) {
    for (const [cfg, r] of Object.entries(runs)) {
      for (const g of r.gate) {
        const pays = g.pre.finished && g.pre.ctx > 2 && g.pre.compactions < 2 && g.data.saving > g.data.rewrite;
        assert.equal(g.post.compactions - g.pre.compactions, pays ? 1 : 0, `${n}/${cfg}: the gate ${JSON.stringify({ pre: g.pre.ctx, ...g.data })}`);
        if (pays) chosen += 1;
        else declined += 1;
      }
      if (!CONFIGS[cfg].compaction) assert.equal(r.gate.length, 0, `${n}/${cfg}: the pay-gate is off, so it takes no measure`);
    }
  }
  assert.ok(chosen >= 4 && declined >= 4, `chosen ${chosen}, declined ${declined}: both outcomes occur over the corpus`);
  // at the limit: the many-reads task fills the window; the base harness tries one compaction, and ends the trial on overflow with the reason
  const base = m['t12-many-reads'].runs.base;
  assert.deepEqual([base.mode, base.why, base.context.attempts], ['Stopped', 'Overflow', 1]);
  assert.ok(base.metrics.compaction.forced >= 1);
  // with the pay-gate on, the same task is compacted at its finished steps and reaches the end of its plan
  assert.equal(m['t12-many-reads'].runs.compaction.mode, 'Done');
  assert.ok(m['t12-many-reads'].runs.compaction.metrics.compaction.chosen >= 1);
});

test('HAC2, ObservationPack (HF2.4, HF3.3): an output over 10 KiB is archived, sent in full for exactly two requests, then shown as a handle that resolves', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  for (const [n, { t, runs }] of Object.entries(m)) {
    const on = runs.pack;
    const opps = t.recording.steps.filter((s) => Buffer.byteLength(s.tool.output) > PACK_BYTES).length;
    assert.equal(on.metrics.pack.opportunities, opps, `${n}: opportunities`);
    assert.equal(on.metrics.pack.observations, opps, `${n}: every opportunity is archived`);
    assert.equal(runs.base.metrics.pack.observations, 0, `${n}: base`);
    for (const o of on.observations) {
      if (o.state.st === 'Handled') assert.deepEqual([o.state.sent, o.fullSends], [3, 2], `${n}/${o.id}: handled on the third send, after two in full`);
      else assert.deepEqual([o.state.st, o.state.sent <= 2, o.fullSends === o.state.sent], ['Full', true, true], `${n}/${o.id}`);
      assert.ok(o.bytes > PACK_BYTES && o.refs >= 1, `${n}/${o.id}: the handle resolves while it is referred to`);
    }
  }
  const t03 = m['t03-read-big-file'].runs.pack;
  assert.deepEqual([t03.metrics.pack.observations, t03.metrics.pack.handled, t03.metrics.pack.fullSends], [1, 1, [2]], 't03: one 12 KiB read, full twice, then its handle');
  // the handle is a smaller request: the same step costs fewer tokens once the output is a handle
  const reqs = t03.requests.map((r) => r.tokens);
  assert.ok(reqs[3] < reqs[2], `the third request after the read is smaller (${reqs.join(', ')})`);
});

test('HAC2, the Evidence-Preserving Reducer (HF2.5, HF3.2): a log from 4 KiB is read by the cheaper model, and only a receipt the verifier passed replaces it', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  const verified = { 't02-fix-build': 1, 't04-big-build-log': 1, 't08-long-session': 3, 't10-mixed': 1 };
  for (const [n, { t, runs }] of Object.entries(m)) {
    const on = runs.reducer;
    // the reducer reads the logs of a predefined set of commands (the declared runners); a file read or a search bypasses it
    const logs = t.recording.steps.filter((s, k) => FUSED.has(t.specs[k]) && Buffer.byteLength(s.tool.output) >= 4096).length;
    assert.equal(on.metrics.reducer.opportunities, logs, `${n}: opportunities`);
    assert.equal(on.metrics.reducer.receipts, logs, `${n}: every log is given to the reducer`);
    assert.equal(on.metrics.reducer.verified, verified[n] ?? 0, `${n}: verified`);
    assert.equal(runs.base.metrics.reducer.receipts, 0, `${n}: base`);
    for (const r of on.receipts) {
      if (r.state.st === 'Shown') assert.equal(r.shown, 'receipt');
      else assert.deepEqual([r.state.st, r.shown], ['Original', 'original'], `${n}/${r.id}: anything the verifier did not pass shows the original`);
    }
  }
  // a receipt that quotes a line the log lacks is rejected, and the original is shown (HAC4)
  const t05 = m['t05-rejected-receipt'].runs.reducer;
  assert.deepEqual([t05.metrics.reducer.verified, t05.metrics.reducer.rejected, t05.receipts[0].shown, t05.receipts[0].reads], [0, 1, 'original', 1]);
  // a log that holds a known secret is flagged, the cheaper model is never asked, and the agent sees the redaction
  const t06 = m['t06-secret-log'].runs.reducer;
  assert.deepEqual([t06.metrics.reducer.flagged, t06.receipts[0].reads, t06.receipts[0].shown], [1, 0, 'original']);
  // a verified receipt is a smaller request than the log it stands for
  for (const n of ['t04-big-build-log', 't08-long-session']) {
    const on = m[n].runs.reducer.cost.agent.input;
    const off = m[n].runs.base.cost.agent.input;
    assert.ok(on < off, `${n}: ${on} input tokens with the reducer, ${off} without`);
  }
});

test('t12-many-reads, a reported finding: ObservationPack alone does not rescue a window filled before any output has had its third request; compaction does', { timeout: 1_800_000 }, async () => {
  const { runs } = (await matrix())['t12-many-reads'];
  assert.deepEqual([runs.pack.mode, runs.pack.why, runs.pack.metrics.pack.observations, runs.pack.metrics.pack.handled], ['Stopped', 'Overflow', 3, 0], 'pack alone: three observations, none handled yet, the window overflows');
  assert.deepEqual([runs.compaction.mode, runs.base.mode, runs.base.why], ['Done', 'Stopped', 'Overflow']);
  assert.deepEqual([runs.all.mode, runs.all.metrics.pack.observations], ['Done', 3]);
});

test('HAC2: the trigger rates, printed, and held in docs/e3/trigger-rates.json', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  const sum = (f) => Object.values(m).reduce((a, { runs }) => [a[0] + f(runs)[0], a[1] + f(runs)[1]], [0, 0]);
  const per = (cfg, f) => Object.fromEntries(Object.entries(m).map(([n, { runs }]) => [n, f(runs[cfg])]));
  const rates = {
    fusion: { total: sum((r) => [r.fusion.metrics.fusion.fired, r.fusion.metrics.fusion.opportunities]), perTrajectory: per('fusion', (r) => [r.metrics.fusion.fired, r.metrics.fusion.opportunities]) },
    compaction: { total: sum((r) => [r.compaction.metrics.compaction.chosen, r.compaction.metrics.compaction.opportunities]), forcedAtTheLimit: sum((r) => [r.base.metrics.compaction.forced, 0])[0], perTrajectory: per('compaction', (r) => [r.metrics.compaction.chosen, r.metrics.compaction.opportunities]) },
    pack: { total: sum((r) => [r.pack.metrics.pack.observations, r.pack.metrics.pack.opportunities]), handled: sum((r) => [r.pack.metrics.pack.handled, 0])[0], perTrajectory: per('pack', (r) => [r.metrics.pack.observations, r.metrics.pack.opportunities]) },
    reducer: { total: sum((r) => [r.reducer.metrics.reducer.receipts, r.reducer.metrics.reducer.opportunities]), verified: sum((r) => [r.reducer.metrics.reducer.verified, 0])[0], perTrajectory: per('reducer', (r) => [r.metrics.reducer.receipts, r.metrics.reducer.opportunities]) },
    byConfig: Object.fromEntries(Object.keys(CONFIGS).map((c) => {
      const rs = Object.values(m).map(({ runs }) => runs[c]);
      const tot = (k) => rs.reduce((a, r) => a + Object.values(r.cost).reduce((b, d) => b + d[k], 0), 0);
      return [c, { reachedEndOfPlan: rs.filter((r) => r.mode === 'Done').length, endedOnOverflow: rs.filter((r) => r.why === 'Overflow').length, inputTokens: tot('input'), outputTokens: tot('output'), microUsd: tot('units') }];
    })),
  };
  // SoL-Pi (3.4): the trigger rate is the fraction of tasks on which a mechanism activates, the intensity the mean number of
  // activations per triggered task. The per-opportunity rates above are this harness's own; these are the paper's definitions.
  const paper = (mech) => {
    const fired = Object.values(rates[mech].perTrajectory).map(([f]) => f);
    const triggered = fired.filter((f) => f > 0);
    return { triggerRate: [triggered.length, fired.length], triggerIntensity: triggered.length ? Math.round((100 * triggered.reduce((a, b) => a + b, 0)) / triggered.length) / 100 : 0 };
  };
  for (const mech of ['fusion', 'compaction', 'pack', 'reducer']) rates[mech].paperDefinition = paper(mech);
  // the same two measures in the full stack, as the paper's figure 7 compares them with the standalone ones
  const FIELD = { fusion: (r) => r.metrics.fusion.fired, compaction: (r) => r.metrics.compaction.chosen, pack: (r) => r.metrics.pack.observations, reducer: (r) => r.metrics.reducer.receipts };
  for (const mech of ['fusion', 'compaction', 'pack', 'reducer']) {
    const fired = Object.values(m).map(({ runs }) => FIELD[mech](runs.all));
    const triggered = fired.filter((f) => f > 0);
    rates[mech].fullStack = { triggerRate: [triggered.length, fired.length], triggerIntensity: triggered.length ? Math.round((100 * triggered.reduce((x, y) => x + y, 0)) / triggered.length) / 100 : 0 };
  }
  rates.labels = {
    corpus: 'a synthetic corpus of 12 trajectories, with tokens estimated at four characters each',
    completion: '"reached the end of the plan", not "solved the task"',
    scope: 'the token and cost figures hold for recordings only; the saving of Action Fusion cannot show on recordings and is measured at the live run',
    expectations: 'the HF2.2 to HF2.5 definitions of the proposal; the trigger rate and intensity are those of SoL-Pi (section 3.4); the thresholds of the paper itself were re-checked on 2026-10-11 (decisions-e3.md)',
  };
  rates.findings = ['t12-many-reads: ObservationPack alone does not rescue a window filled before the third request; compaction does'];
  const line = (label, [f, o]) => `${label}: ${f} of ${o} (${o ? Math.round((100 * f) / o) : 0}%)`;
  console.log(['', 'HAC2 trigger rates over 12 recorded trajectories:', line('  Action Fusion        ', rates.fusion.total), line('  Online Context Compact', rates.compaction.total), line('  ObservationPack      ', rates.pack.total), line('  Evidence-Preserving Reducer', rates.reducer.total), JSON.stringify(rates.byConfig, null, 1)].join('\n'));
  for (const [, v] of Object.entries(rates.byConfig)) assert.ok(v.inputTokens > 0);
  // the direction of HAC3 on recordings: the harness with every mechanism reaches the end of the plan at least as often as the base, on fewer input tokens
  assert.ok(rates.byConfig.all.reachedEndOfPlan >= rates.byConfig.base.reachedEndOfPlan);
  assert.ok(rates.byConfig.all.inputTokens < rates.byConfig.base.inputTokens, `${rates.byConfig.all.inputTokens} against ${rates.byConfig.base.inputTokens}`);
  if (process.env.UPDATE_E3 || !existsSync(TABLE)) {
    mkdirSync(join(ROOT, 'docs', 'e3'), { recursive: true });
    writeFileSync(TABLE, `${JSON.stringify(rates, null, 2)}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(TABLE, 'utf8')), JSON.parse(JSON.stringify(rates)), 'the committed table is the one this corpus gives (UPDATE_E3=1 rewrites it)');
});
