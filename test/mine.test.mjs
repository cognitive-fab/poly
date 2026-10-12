// M7.2: poly mine command tests (PT30, PS20).
// Every test MUST invoke the real CLI and assert on actual output (rule 7a).
// Tests are structured per trace-export-substance.test.mjs pattern: positive control, then refusals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@poly/core';
import { commandNamed, NOT_BUILT } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted } from './runtime-helpers.mjs';
import { shop, conflict } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYX_DIR = process.env.POLY_POLYX_DIR ?? join(ROOT, '..', 'polyx');
const SHOP_SOURCES = ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'];

const poly = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

/** The pin of a polyx directory (S507, PT30.10): recorded afresh for each call, outside the polyx directory. A directory with no entry point gets a pin file that does not exist. */
let pinCount = 0;
function pinFor(dir) {
  const pin = join(tmpdir(), `mine-test-pin-${process.pid}-${++pinCount}.json`);
  if (existsSync(join(dir, 'bin', 'polyx.mjs'))) {
    const r = poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', dir, '--polyx-pin', pin);
    assert.equal(r.code, 0, r.out);
  }
  return pin;
}

// Create fake polyx that returns a fixed report with recorded invocation.
function fakePolyxDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-polyx-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });

  const logFile = join(dir, 'invocation.log');
  const binFile = join(dir, 'bin', 'polyx.mjs');

  const script = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const configIdx = argv.indexOf('--config');
const configFile = configIdx !== -1 && configIdx + 1 < argv.length ? argv[configIdx + 1] : null;
const log = {
  argv: argv,
  hasJsonFlag: argv.includes('--json'),
  hasConfigFlag: configIdx !== -1,
  configPath: configFile,
  envHasPolyxJevKey: !!process.env.POLYX_JEV_KEY,
};
try {
  writeFileSync('${logFile.split(String.fromCharCode(92)).join('/')}', JSON.stringify(log, null, 2));
} catch (e) {}
const report = {
  manifest: {
    alphabetVersion: '1.0',
    thresholds: { minInstances: 5, ownSupport: 0.6, impliesSupport: 0.9 },
    seed: 12345,
    codeCommit: '963b9e2ccf93eeeef8ac81ea332384df227d7f70',
    segmenter: 'trace',
    corpusRevision: 'M7.2',
  },
  stats: { runs: 18, steps: 60, rules: 12 },
  rules: [
    { id: 'a0000000000000aa', family: 'ordering', pattern: 'X-implies-prior-Y', bindings: { X: 'payment.charge', Y: 'stock.reserve' }, window: null, support: { holds: 12, of: 12 }, counterexamples: [], status: 'proposed', provenance: { kind: 'own' } },
    { id: 'a0000000000000bb', family: 'count', pattern: 'at-most-one-X', bindings: { X: 'payment.charge' }, window: null, support: { holds: 12, of: 12 }, counterexamples: [], status: 'proposed', provenance: { kind: 'own' } },
    { id: 'a0000000000000cc', family: 'state', pattern: 'no-X-unless-state', bindings: { X: 'stock.reserve', subject: { field: 'status', allowed: ['Reserving'] } }, window: null, support: { holds: 12, of: 12 }, counterexamples: [], status: 'proposed', provenance: { kind: 'own' } },
    { id: 'a0000000000000dd', family: 'state', pattern: 'no-X-unless-state', bindings: { X: 'payment.charge', subject: { field: 'status', allowed: ['Charging'] } }, window: null, support: { holds: 12, of: 12 }, counterexamples: [], status: 'proposed', provenance: { kind: 'own' } },
    { id: 'a0000000000000ee', family: 'state', pattern: 'no-X-unless-state', bindings: { X: 'payment.fee', subject: { field: 'status', allowed: ['Cancelled'] } }, window: null, support: { holds: 6, of: 6 }, counterexamples: [], status: 'proposed', provenance: { kind: 'own' } },
    { id: 'a0000000000000ff', family: 'count', pattern: 'at-most-one-X', bindings: { X: 'stock.reserve' }, window: null, support: { holds: 12, of: 12 }, counterexamples: [], status: 'suppressed', provenance: { kind: 'own' } },
  ],
};
console.log(JSON.stringify(report));
`;

  writeFileSync(binFile, script, 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.1' }, null, 2));
  return { dir, logFile };
}

function makeTraceFile(content) {
  const f = mkdtempSync(join(tmpdir(), 'traces-'));
  const file = join(f, 'corpus.ndjson');
  writeFileSync(file, content);
  return { dir: f, file };
}

let tmp;
let n = 0;
const uniq = (p) => join(tmp, `${p}-${++n}.json`);
let a;
let shopTraces;
let traceFile;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-mine-'));
  a = await admitted('mine-main', SHOP_SOURCES);
  shopTraces = shop();
  const traceTmp = makeTraceFile(shopTraces);
  traceFile = traceTmp.file;
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (traceFile) rmSync(join(traceFile, '..'), { recursive: true, force: true });
});

// === S1: Usage errors with positive control ===
test('S1: positive control - mine succeeds with all required args', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s1-pos.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, `mine should succeed: ${r.out}`);
  assert.ok(existsSync(out), 'candidates file should exist');

  const c = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(c.kind, 'poly.candidates');

  rmSync(polyxDir, { recursive: true });
});

test('S1: missing --traces is rejected', () => {
  const { dir: polyxDir } = fakePolyxDir();

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0, 'positive control should succeed');

  const rRef = poly('mine', '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', join(tmp, 'fail1.json'));
  assert.equal(rRef.code, 64, `should exit 64, got ${rRef.code}`);
  assert.match(rRef.out, /poly:.*--traces/, 'should name --traces');

  rmSync(polyxDir, { recursive: true });
});

test('S1: missing --project is rejected', () => {
  const { dir: polyxDir } = fakePolyxDir();

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const rRef = poly('mine', '--traces', traceFile, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', join(tmp, 'fail2.json'));
  assert.equal(rRef.code, 64);
  assert.match(rRef.out, /poly:.*--project/);

  rmSync(polyxDir, { recursive: true });
});

test('S1: missing --polyx is rejected', () => {
  const { dir: polyxDir } = fakePolyxDir();

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const rRef = poly('mine', '--traces', traceFile, '--project', a.dir, '--out', join(tmp, 'fail3.json'));
  assert.equal(rRef.code, 64);
  assert.match(rRef.out, /poly:.*--polyx/);

  rmSync(polyxDir, { recursive: true });
});

test('S1: missing --out is rejected', () => {
  const { dir: polyxDir } = fakePolyxDir();

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const rRef = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir);
  assert.equal(rRef.code, 64);
  assert.match(rRef.out, /poly:.*--out/);

  rmSync(polyxDir, { recursive: true });
});

test('S1: polyx dir without bin/polyx.mjs is rejected', () => {
  const badPolyxDir = mkdtempSync(join(tmpdir(), 'bad-polyx-'));
  const { dir: goodPolyxDir } = fakePolyxDir();

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', goodPolyxDir, '--polyx-pin', pinFor(goodPolyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const rRef = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', badPolyxDir, '--polyx-pin', pinFor(badPolyxDir), '--out', join(tmp, 'fail5.json'));
  assert.equal(rRef.code, 64);
  assert.match(rRef.out, /poly:.*bin\/polyx\.mjs/);

  rmSync(badPolyxDir, { recursive: true });
  rmSync(goodPolyxDir, { recursive: true });
});

test('S1: existing --out file is refused and left unchanged', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const outFile = join(tmp, 'existing.json');
  const original = 'original';
  writeFileSync(outFile, original);

  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const rRef = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', outFile);
  assert.equal(rRef.code, 64);
  assert.match(rRef.out, /poly:.*exists/);
  assert.equal(readFileSync(outFile, 'utf8'), original);

  rmSync(polyxDir, { recursive: true });
});

// === S2: Polyx invocation ===
test('S2: polyx is run as mine with --json and --config', () => {
  const { dir: polyxDir, logFile } = fakePolyxDir();
  const out = join(tmp, 'candidates-s2.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(out));

  const log = JSON.parse(readFileSync(logFile, 'utf8'));
  assert.ok(log.argv.includes('mine'));
  assert.ok(log.hasJsonFlag);
  assert.ok(log.hasConfigFlag);

  rmSync(polyxDir, { recursive: true });
});

test('S2: polyx failure (exit 1) is reported; no --out written', () => {
  const failPolyxDir = mkdtempSync(join(tmpdir(), 'fail-polyx-'));
  mkdirSync(join(failPolyxDir, 'bin'), { recursive: true });
  writeFileSync(join(failPolyxDir, 'bin', 'polyx.mjs'), '#!/usr/bin/env node\nconsole.error("polyx failed");\nprocess.exit(1);\n');
  writeFileSync(join(failPolyxDir, 'package.json'), '{"version":"0.1.1"}');

  const { dir: goodPolyxDir } = fakePolyxDir();
  const rPos = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', goodPolyxDir, '--polyx-pin', pinFor(goodPolyxDir), '--out', uniq('pos'));
  assert.equal(rPos.code, 0);

  const outFile = join(tmp, 'should-not-exist.json');
  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', failPolyxDir, '--polyx-pin', pinFor(failPolyxDir), '--out', outFile);

  assert.notEqual(r.code, 0);
  assert.match(r.out, /polyx failed/);
  assert.ok(!existsSync(outFile));

  rmSync(failPolyxDir, { recursive: true });
  rmSync(goodPolyxDir, { recursive: true });
});

test('S2: POLYX_JEV_KEY not in polyx environment', () => {
  const { dir: polyxDir, logFile } = fakePolyxDir();
  const out = join(tmp, 'candidates-s2-env.json');

  process.env.POLYX_JEV_KEY = 'not-a-real-key';
  let r;
  try { r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out); } finally { delete process.env.POLYX_JEV_KEY; }
  assert.equal(r.code, 0, r.out);

  const log = JSON.parse(readFileSync(logFile, 'utf8'));
  assert.equal(log.envHasPolyxJevKey, false, 'the key the test process holds did not reach polyx');

  rmSync(polyxDir, { recursive: true });
});

// === S3: No vendoring/importing ===
test('S3: polyx not vendored (with positive control)', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s3.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const vendorDir = join(ROOT, 'vendor');
  if (existsSync(vendorDir)) {
    const files = readdirSync(vendorDir);
    assert.ok(!files.includes('polyx'));
  }

  rmSync(polyxDir, { recursive: true });
});

// === S4: Port from trace to polyx format ===
test('S4: candidates has correct episodic structure from port', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s4.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(c.corpus.episodes, 18);
  assert.ok(c.corpus.hasOwnProperty('gappedLeftOut'));

  rmSync(polyxDir, { recursive: true });
});

// === S5: Candidates file structure ===
test('S5: candidates file matches PT30.3 schema', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s5.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(c.v, 1);
  assert.equal(c.kind, 'poly.candidates');
  assert.ok(c.corpus && c.corpus.digest && c.corpus.kind && typeof c.corpus.episodes === 'number');
  assert.ok(c.tool && c.tool.name === 'polyx' && c.tool.version && c.tool.commit);
  assert.ok(c.thresholds && c.thresholds.minInstances === 5);
  assert.ok(Array.isArray(c.candidates));

  rmSync(polyxDir, { recursive: true });
});

test('S5: corpus digest equals SHA-256 of file', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s5-digest.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  const expected = `sha256:${createHash('sha256').update(shopTraces, 'utf8').digest('hex')}`;
  assert.equal(c.corpus.digest, expected);

  rmSync(polyxDir, { recursive: true });
});

test('S5: --synthetic marks corpus kind', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s5-synthetic.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out, '--synthetic');
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(c.corpus.kind, 'synthetic');

  rmSync(polyxDir, { recursive: true });
});

test('S5: candidate digest is SHA-256 of canonical JSON without digest', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s5-cand.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  for (const cand of c.candidates) {
    const { digest: _d, ...rest } = cand;
    const computed = `sha256:${createHash('sha256').update(canonicalize(rest), 'utf8').digest('hex')}`;
    assert.equal(cand.digest, computed);
  }

  rmSync(polyxDir, { recursive: true });
});

test('S5: two runs produce byte-identical files', () => {
  const { dir: polyxDir1 } = fakePolyxDir();
  const { dir: polyxDir2 } = fakePolyxDir();
  const out1 = join(tmp, 'candidates-s5-run1.json');
  const out2 = join(tmp, 'candidates-s5-run2.json');

  const r1 = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir1, '--polyx-pin', pinFor(polyxDir1), '--out', out1);
  const r2 = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir2, '--polyx-pin', pinFor(polyxDir2), '--out', out2);

  assert.equal(r1.code, 0, r1.out);
  assert.equal(r2.code, 0, r2.out);

  const bytes1 = readFileSync(out1);
  const bytes2 = readFileSync(out2);
  assert.deepEqual(bytes1, bytes2);

  rmSync(polyxDir1, { recursive: true });
  rmSync(polyxDir2, { recursive: true });
});

// === S6: Exact source texts (PT30.9) ===
// S6 (the exact sources of PT30.9) is asserted against real polyx in the real-polyx tests below.

// === S7: Non-promotable rules ===
test('S7: non-promotable rules have reason field', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s7.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  for (const cand of c.candidates) {
    if (cand.promotable === false) {
      assert.ok(cand.reason && typeof cand.reason === 'string');
    }
  }

  rmSync(polyxDir, { recursive: true });
});

// === S8: --all flag ===
test('S8: without --all only proposed rules are candidates', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s8-no-all.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  const hasSupressed = c.candidates.some(ca => ca.status === 'suppressed');
  assert.ok(!hasSupressed);

  rmSync(polyxDir, { recursive: true });
});

test('S8: with --all both proposed and suppressed rules included', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s8-all.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out, '--all');
  assert.equal(r.code, 0, r.out);

  const c = JSON.parse(readFileSync(out, 'utf8'));
  const hasSupressed = c.candidates.some(ca => ca.status === 'suppressed');
  assert.ok(hasSupressed);

  rmSync(polyxDir, { recursive: true });
});

// === S9: Privacy ===
test('S9: no absolute paths in candidates output', () => {
  const { dir: polyxDir } = fakePolyxDir();
  const out = join(tmp, 'candidates-s9.json');

  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', polyxDir, '--polyx-pin', pinFor(polyxDir), '--out', out);
  assert.equal(r.code, 0, r.out);

  const json = readFileSync(out, 'utf8');
  assert.ok(!json.includes(tmpdir()));
  assert.ok(!json.includes(a.dir));

  rmSync(polyxDir, { recursive: true });
});

// === S10: Not served over MCP ===
test('S10: mine in registry with mcp:null AND NOT_BUILT has no mine', () => {
  const cmd = commandNamed('mine');
  assert.ok(cmd);
  assert.equal(cmd.mcp, null);
  assert.ok(!NOT_BUILT.includes('mine'));
});

// === Real polyx tests ===
// The planted truth of the shop corpus (make-shop-traces.mjs), found by polyx run by hand, as (pattern, status, support, source).
const SHOP_TRUTH = [
  ['X-implies-prior-Y', 'proposed', 12, 12, /^path property mined-r[0-9a-f]{16}: before\("stock\.reserve", "payment\.charge"\)$/],
  ['no-X-unless-state', 'proposed', 12, 12, /effect\.kind == "stock\.reserve"[\s\S]*machine\("orders\.Order"\)\.status in \{ Reserving \} else deny\n  on unknown escalate\n\}$/],
  ['no-X-unless-state', 'proposed', 12, 12, /effect\.kind == "payment\.charge"[\s\S]*status in \{ Charging \} else deny/],
  ['no-X-unless-state', 'proposed', 6, 6, /effect\.kind == "payment\.fee"[\s\S]*status in \{ Cancelled \} else deny/],
  ['at-most-one-X', 'suppressed', 12, 12, /count\("stock\.reserve"\) <= 1$/],
  ['at-most-one-X', 'suppressed', 12, 12, /count\("payment\.charge"\) <= 1$/],
  ['at-most-one-X', 'suppressed', 6, 6, /count\("payment\.fee"\) <= 1$/],
  ['no-X-without-prior-Y', 'suppressed', 12, 12, /before\("stock\.reserve", "payment\.charge"\)$/],
];

test('real-polyx: the shop corpus gives the planted rules, with their sources, and the unpromotable ones listed', () => {
  assert.ok(existsSync(join(POLYX_DIR, 'bin', 'polyx.mjs')), `polyx is expected at ${POLYX_DIR}`);
  const out = uniq('real-shop');
  const r = poly('mine', '--traces', traceFile, '--project', a.dir, '--polyx', POLYX_DIR, '--polyx-pin', pinFor(POLYX_DIR), '--out', out, '--all');
  assert.equal(r.code, 0, r.out);
  const c = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(c.tool.name, 'polyx');
  assert.match(c.tool.commit, /^[0-9a-f]{40}$/);
  assert.equal(c.corpus.episodes, 18);
  for (const [pattern, status, holds, of, re] of SHOP_TRUTH) {
    const hit = c.candidates.filter((x) => x.pattern === pattern && x.status === status && x.support.holds === holds && x.support.of === of && x.promotable === true && re.test(x.source));
    assert.equal(hit.length, 1, `${pattern} ${status} ${holds}/${of} ${re}`);
    assert.match(hit[0].id, /^r[0-9a-f]{16}$/);
    assert.ok(hit[0].source.includes(`mined-${hit[0].id}`), 'the rule is named mined-<id>');
    assert.deepEqual(hit[0].target, { machine: 'orders.Order' });
  }
  const no = c.candidates.filter((x) => x.promotable === false);
  assert.deepEqual(no.map((x) => x.pattern).sort(), ['exactly-one-Y-per-X', 'no-X-without-prior-Y-same-S']);
  for (const x of no) assert.ok(x.reason.includes(x.pattern) && !('source' in x), x.reason);
  assert.equal(c.candidates.length, SHOP_TRUTH.length + 2, 'nothing else is proposed');
});

test('real-polyx: the conflict corpus gives the eligibility rule that contradicts the program', () => {
  const conflictFile = join(tmp, 'conflict.ndjson');
  writeFileSync(conflictFile, conflict());
  const out = uniq('real-conflict');
  const r = poly('mine', '--traces', conflictFile, '--project', a.dir, '--polyx', POLYX_DIR, '--polyx-pin', pinFor(POLYX_DIR), '--out', out, '--all');
  assert.equal(r.code, 0, r.out);
  const c = JSON.parse(readFileSync(out, 'utf8'));
  const hit = c.candidates.filter((x) => x.pattern === 'no-X-unless-state' && x.promotable && /effect\.kind == "stock\.reserve"[\s\S]*status in \{ Cancelled \} else deny/.test(x.source));
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].support, { holds: 10, of: 10 });
});
