// M7.2 (PT30.2): what poly gives polyx. A recording stand-in for polyx copies the configuration, the corpus and the
// alphabet it is handed, answers with an empty report, and the tests read the copies. Written by the implementer after the
// independent writer's mine tests proved to check only the shape of the candidates file; the mutation checks in
// docs/decisions-m7.md show that each of these fails when the port changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted } from './runtime-helpers.mjs';
import { shop } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

let tmp; let a;

/** A polyx that records what it is given (to <dir>/seen/) and finds nothing. */
function recordingPolyx() {
  const dir = mkdtempSync(join(tmpdir(), 'recording-polyx-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const seen = join(dir, 'seen').split(String.fromCharCode(92)).join('/');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0-recording' }));
  writeFileSync(join(dir, 'bin', 'polyx.mjs'), [
    "import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "const cfgFile = argv[argv.indexOf('--config') + 1];",
    'const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));',
    'const c = Object.values(cfg.corpora)[0];',
    `mkdirSync('${seen}', { recursive: true });`,
    `copyFileSync(cfgFile, '${seen}/config.json');`,
    `copyFileSync(c.source, '${seen}/corpus.json');`,
    `copyFileSync(c.alphabet, '${seen}/alphabet.yaml');`,
    `writeFileSync('${seen}/run.json', JSON.stringify({ argv, cwd: process.cwd(), jev: Boolean(process.env.POLYX_JEV_KEY), secret: Boolean(process.env.MY_SECRET_TOKEN), source: c.source, workspace: cfg.workspace }));`,
    "console.log(JSON.stringify({ manifest: { alphabetVersion: 1, thresholds: { minInstances: 5 }, seed: 1, codeCommit: 'c'.repeat(40), segmenter: 'null', corpusRevision: 'r' }, rules: [] }));",
  ].join('\n'));
  return { dir, seen: join(dir, 'seen') };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-mine-port-'));
  a = await admitted('mine-port', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly']);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Mines a corpus with the recording polyx; returns what polyx saw. */
function mined(corpusText) {
  const { dir, seen } = recordingPolyx();
  const traces = join(tmp, `corpus-${Math.random().toString(36).slice(2)}.ndjson`);
  writeFileSync(traces, corpusText);
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.json`);
  process.env.POLYX_JEV_KEY = 'not-a-real-key';
  process.env.MY_SECRET_TOKEN = 'not-a-real-secret';
  let r;
  try { r = poly('mine', '--traces', traces, '--project', a.dir, '--polyx', dir, '--out', out); } finally { delete process.env.POLYX_JEV_KEY; delete process.env.MY_SECRET_TOKEN; }
  assert.equal(r.code, 0, r.out);
  return { corpus: JSON.parse(readFileSync(join(seen, 'corpus.json'), 'utf8')), alphabet: readFileSync(join(seen, 'alphabet.yaml'), 'utf8'), config: JSON.parse(readFileSync(join(seen, 'config.json'), 'utf8')), run: JSON.parse(readFileSync(join(seen, 'run.json'), 'utf8')), header: JSON.parse(readFileSync(out, 'utf8')) };
}

test('PT30.2: one interaction per episode, operator poly, the creation row left out, and the turns in the order of the step', () => {
  const { corpus } = mined(shop());
  assert.equal(corpus.interactions.length, 18);
  assert.ok(corpus.interactions.every((i) => i.operator === 'poly'));
  // A run that reserves, charges, finishes: for each step the state before it, its action when it has no effect, the state after it, then its effects.
  const main = corpus.interactions[0].turns;
  assert.deepEqual(main.map((t) => `${t.speaker}:${t.event ?? t.button}`), [
    'system:state-orders.Order', 'system:state-orders.Order', 'action:fx-stock.reserve',
    'system:state-orders.Order', 'system:state-orders.Order', 'action:fx-payment.charge',
    'system:state-orders.Order', 'action:act-orders.Order.Finish', 'system:state-orders.Order',
  ]);
  // The first step (Reserve): pre-state, post-state, then its effect; no turn for $create.
  assert.equal(main[0].slots.status, 'Open');
  assert.equal(main[1].slots.status, 'Reserving');
  assert.equal(main[2].button, 'fx-stock.reserve');
  assert.equal(main[3].slots.status, 'Reserving');
  assert.equal(main[4].slots.status, 'Charging');
  assert.equal(main[5].button, 'fx-payment.charge');
  assert.equal(main[6].slots.status, 'Charging');
  assert.equal(main[7].button, 'act-orders.Order.Finish');
  assert.equal(main[8].slots.status, 'Done');
  assert.equal(main.length, 9);
  // Every slot is a scalar, and every turn names the run by the episode token.
  for (const i of corpus.interactions) for (const t of i.turns) {
    for (const v of Object.values(t.slots)) assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null);
    assert.match(t.slots.run, /^d:[0-9a-f]{32}$/);
  }
  assert.equal(new Set(corpus.interactions.map((i) => i.turns[0].slots.run)).size, 18, 'one run id per episode');
});

test('PT30.2: the alphabet types every action and effect, with identity run, state from the machine, and consequences from the trace', () => {
  const { alphabet } = mined(shop());
  for (const id of ['action:fx-stock.reserve', 'action:fx-payment.charge', 'action:fx-payment.fee', 'action:act-orders.Order.Finish', 'system:state-orders.Order']) assert.ok(alphabet.includes(`- id: ${id}`), id);
  const block = (id) => alphabet.split('  - id: ').find((b) => b.startsWith(id));
  assert.match(block('action:fx-stock.reserve'), /consequence: compensable/);
  assert.match(block('action:fx-payment.charge'), /consequence: irreversible/);
  assert.match(block('action:act-orders.Order.Finish'), /consequence: none/);
  for (const id of ['action:fx-payment.charge', 'action:act-orders.Order.Finish']) { assert.match(block(id), /identity: \[run\]/); assert.match(block(id), /recommendable: false/); }
  assert.match(block('system:state-orders.Order'), /identity: \[run\]/);
  assert.match(block('system:state-orders.Order'), /state: \[status\]/);
  assert.doesNotMatch(alphabet, /\$create/);
});

test('PT30.2: a rejected step and a gate-denied effect are refused turns; an unknown consequence is written none; a gapped episode is left out and counted', () => {
  const lines = shop().trim().split('\n').map((l) => JSON.parse(l));
  const [header, ...eps] = lines;
  // A rejected pure action in episode 0, a denied effect in episode 1, an unknown consequence in episode 2, a gapped episode 3.
  eps[0].steps.push({ seq: 4, action: 'Finish', stepKind: 'rejected', rejectReason: 'not-charging', pre: { status: 'Done' }, data: {}, post: { status: 'Done' }, effects: [], outsideCheckDomain: [] });
  eps[1].steps[1].effects[0].gate = { outcome: 'denied', reason: 'no' };
  eps[2].steps[1].effects[0].consequence = 'unknown';
  eps[3].gapped = true;
  const { corpus, alphabet, header: out } = mined([header, ...eps].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(corpus.interactions.length, 17);
  assert.equal(out.corpus.gappedLeftOut, 1);
  assert.equal(out.corpus.episodes, 17);
  const refusedPure = corpus.interactions.flatMap((i) => i.turns).filter((t) => t.button === 'act-orders.Order.Finish' && t.result === 'refused');
  assert.equal(refusedPure.length, 1);
  const refusedFx = corpus.interactions.flatMap((i) => i.turns).filter((t) => t.button === 'fx-stock.reserve' && t.result === 'refused');
  assert.equal(refusedFx.length, 1);
  assert.ok(!alphabet.includes('unknown'), 'unknown is written none');
});

test('PT30.1: polyx is run as mine --json --config from outside the project, with no key in its environment, and the temporary directory is gone', () => {
  const { run, config, corpus } = mined(shop());
  assert.deepEqual(run.argv.slice(0, 2), ['mine', 'poly-traces']);
  assert.ok(run.argv.includes('--json') && run.argv.includes('--config'));
  assert.ok(!run.argv.includes('annotate'));
  assert.equal(run.jev, false, 'the key of the test process did not reach polyx');
  assert.equal(run.secret, false, 'nor did anything named secret or token');
  assert.ok(!run.workspace.startsWith(a.dir) && !run.source.startsWith(a.dir), 'nothing is written into the project');
  assert.equal(config.segmenter, 'null');
  assert.ok(corpus.interactions.length);
  assert.ok(!existsSync(run.source), 'the temporary directory is removed after the command');
  assert.ok(!existsSync(run.workspace));
});
