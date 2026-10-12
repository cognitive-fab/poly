// Owner, 2026-10-11, after E3.2: the host's facts are named assumptions, each discharged or open (S463's way). The poly
// certificate takes only the assumptions poly's checks name, so examples/harness/assumptions.json lists these and the
// harness certificate (E3.10) hashes it. This test holds the list to the module: every effect whose completion is a
// handler's verdict, and every action the host dispatches or measures, is named by an assumption; an open one says what
// tests it; a discharged one says what discharges it; and the joint configuration of Turn, Context and Trial stays open
// until the E3.4 gate has checked it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';

const DIR = join(ROOT, 'examples', 'harness');
const SRC = readFileSync(join(DIR, 'harness.poly'), 'utf8');
const A = JSON.parse(readFileSync(join(DIR, 'assumptions.json'), 'utf8')).assumptions;

const named = (key) => new Set(A.flatMap((a) => a[key] ?? []));

test('every verdict effect is a named assumption', () => {
  // an effect whose ok and failed completions mean different things to the machine, rather than the same action twice
  const verdicts = [];
  let kind = null;
  let ok = null;
  for (const line of SRC.split('\n')) {
    const k = /^ {4}kind "([^"]+)"/.exec(line);
    if (k) { kind = k[1]; ok = null; continue; }
    const o = /^ {4}ok -> (\w+)\(/.exec(line);
    if (o) { ok = o[1]; continue; }
    const f = /^ {4}failed -> (\w+)\(/.exec(line);
    if (f && kind && ok && ok !== f[1] && /^tool\./.test(kind) && ['Fusable', 'Clean', 'Verified', 'StagePassed', 'Compacted'].includes(ok)) verdicts.push(kind);
  }
  assert.deepEqual([...new Set(verdicts)].sort(), ['tool.classify', 'tool.compact', 'tool.scan', 'tool.stage-check', 'tool.verify']);
  for (const v of verdicts) assert.ok(named('effects').has(v), `${v} is not named by an assumption`);
});

test('every host-dispatched or host-measured action is a named assumption', () => {
  const header = /Actions the host dispatches after it has seen the facts they need: ([^.]+)\./s.exec(SRC.replace(/\n\/\/ /g, ' '));
  assert.ok(header, 'the module header lists them');
  const listed = header[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of [...listed, 'Metered', 'Grew']) assert.ok(named('actions').has(a), `${a} is not named by an assumption`);
});

test('an open assumption says what tests it, a discharged one what discharges it, and the ids are unique', () => {
  assert.equal(new Set(A.map((a) => a.id)).size, A.length);
  for (const a of A) {
    assert.ok(['open', 'discharged'].includes(a.status), a.id);
    assert.ok(typeof a.assumption === 'string' && a.assumption.length > 20, a.id);
    if (a.status === 'open') assert.ok(typeof a.evidence === 'string' && a.evidence.length > 0, `${a.id}: no evidence named`);
    else assert.ok(typeof a.by === 'string' && a.by.length > 0, `${a.id}: discharged by nothing`);
  }
});

test('the live run needs an isolated, disposable environment with network to the model API only: an open assumption naming the E3.9 gate', () => {
  const iso = A.find((a) => a.id === 'live-run-isolation');
  assert.ok(iso, 'the entry exists');
  assert.equal(iso.status, 'open', 'discharged only by naming the environment and a check made from inside it');
  assert.match(iso.assumption, /disposable/);
  assert.match(iso.assumption, /model API/);
  assert.match(iso.evidence, /E3\.9/);
});

test('the joint configuration of Turn, Context and Trial is open until a configuration of the three has been checked', () => {
  const joint = A.find((a) => a.id === 'joint-configuration');
  assert.ok(joint, 'the entry exists');
  const hasConfig = /configuration\s+\w+\s*\{[^}]*:\s*Turn\b[^}]*:\s*Context\b[^}]*:\s*Trial\b/s.test(SRC);
  assert.equal(joint.status, hasConfig ? 'discharged' : 'open', 'discharged only if the module checks such a configuration (E3.4)');
});

test('the scan verdict is two entries: known secrets and the seven shapes are discharged by a named test, unrecognised shapes stay open', () => {
  const known = A.find((a) => a.id === 'scan-verdict-known');
  const unknown = A.find((a) => a.id === 'scan-verdict-unrecognised');
  assert.ok(known && unknown);
  assert.equal(known.status, 'discharged');
  assert.match(known.by, /test.e3.e3-loop.test.mjs/);
  assert.match(known.by, /seeded control/);
  assert.equal(unknown.status, 'open');
  assert.ok(!A.some((a) => a.id === 'scan-verdict'), 'the single entry is gone');
  // the test it cites exists, by its title
  const loop = readFileSync(join(ROOT, 'test', 'e3', 'e3-loop.test.mjs'), 'utf8');
  assert.ok(loop.includes('AC18, S554, gates 2 and 3: a token in a tool output reaches nothing'));
});

test('the statements the certificate carries: rules per machine, the pairs, the unused audience, and the two lints', () => {
  const all = JSON.parse(readFileSync(join(DIR, 'assumptions.json'), 'utf8')).statements;
  assert.deepEqual(all.map((s) => s.id), ['rules-proved-per-machine', 'pairs-were-worth-checking', 'audience-unused', 'lint-not-proof', 'recordings-evidence', 'paper-differences']);
  assert.match(all[0].text, /not proved for the machines together/);
  assert.match(all[2].text, /held by the scan, the redaction and the step property/);
});

test('the recordings evidence carries its three labels, in the certificate statements and in the committed table', () => {
  const s = JSON.parse(readFileSync(join(DIR, 'assumptions.json'), 'utf8')).statements.find((x) => x.id === 'recordings-evidence').text;
  for (const must of ['synthetic corpus of 12 trajectories', 'four characters each', 'did not \"solve the task\"', 'recordings only', 'cannot show on recordings', 'live run']) assert.ok(s.includes(must), must);
  const table = JSON.parse(readFileSync(join(ROOT, 'docs', 'e3', 'trigger-rates.json'), 'utf8'));
  assert.match(table.labels.corpus, /synthetic corpus of 12 trajectories, with tokens estimated at four characters each/);
  assert.match(table.labels.completion, /reached the end of the plan.*not.*solved the task/);
  assert.match(table.labels.scope, /recordings only.*Action Fusion cannot show on recordings|recordings only; the saving of Action Fusion cannot show on recordings/);
  assert.equal(table.findings.length, 1);
});
