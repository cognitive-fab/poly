// M7.4 (PS22, PT32): a person's signed verdict on a recorded answer, and the refit of a calibration map from those verdicts
// alone. Written by the implementer from PS22 and PT32 before the code and seen failing; the separate audit reads it
// against the spec. The journal is a stub reader built in the test (as test/evaluate.test.mjs does), and one case runs the
// command line over a real store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { canonicalize, mapProblem, signRecord, verifyRecord, keyringsOf, loadProject } from '@poly/core';
import { AdmitError, admit, calibrationWarning, refitMap, signVerdict, verdictFilesIn } from '@poly/check';
import { mapDigest } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { ANCHORS, AGENT, PERSON, makeKey, project } from './runtime-helpers.mjs';

const NL = String.fromCharCode(10);
let tmp; let n = 0; let dir; let personKey; let agentKey;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-refit-'));
  dir = project('refit', ['test/fixtures/m7/forms/forms.poly'], makeKey('refit'));
  personKey = join(tmp, 'person.pem');
  writeFileSync(personKey, PERSON.privateKeyPem);
  agentKey = join(tmp, 'agent.pem');
  writeFileSync(agentKey, AGENT.privateKeyPem);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const anchorId = () => JSON.parse(readFileSync(JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8')).anchors.refit.replace(/^file:/, ''), 'utf8')).id;
const subjectOf = (event, verdict, correct) => `sha256:${createHash('sha256').update(canonicalize({ anchor: anchorId(), event, verdict, correct: correct ?? null }), 'utf8').digest('hex')}`;

/** A reader over decision events: `rows` is [{ hash, raw, model, decision }], each in a run of its own. */
function reader(rows, extra = {}) {
  const runs = rows.map((_, i) => ({ ns: 'support', wf: 'support.Ticket', run: `r${i}` }));
  const chains = Object.fromEntries(rows.map((r, i) => [`r${i}`, [
    { kind: 'decision', hash: r.hash, body: { decision: r.decision ?? 'route', request: 'q', answer: 'Refund', raw: r.raw, model: { id: 'm', reported: r.model ?? 'model-a' } } },
    ...(r.outcome ? [{ kind: 'outcome', hash: `o${i}`, body: { decision: r.decision ?? 'route', outcome: r.outcome, decisionEvent: r.hash } }] : []),
  ]]));
  return { runs: async () => runs, chain: async (r) => chains[r], body: async () => ({}), heads: async () => [], journal: async () => null, anchors: async () => [], close: async () => {}, ...extra };
}
/** The synthetic history: for each raw on a grid, `per` answers, of which round(acc(raw) * per) were right. */
const GRID = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
const acc = (raw) => 0.2 + 0.5 * (raw / 1000);
function history(per, grid = GRID, model = 'model-a') {
  const rows = []; const right = [];
  for (const raw of grid) {
    const k = Math.round(acc(raw) * per);
    for (let i = 0; i < per; i++) { const hash = `e${rows.length}`; rows.push({ hash, raw: raw / 1000, model }); right.push(i < k); }
  }
  return { rows, right };
}
/** Signs a verdict for every row, through the library, into a folder of its own. */
async function verdicts(rd, h, { by = personKey, keyId = PERSON.keyId } = {}) {
  const folder = join(tmp, `verdicts-${++n}`);
  mkdirSync(folder);
  for (let i = 0; i < h.rows.length; i++) await signVerdict({ reader: rd, event: h.rows[i].hash, verdict: h.right[i] ? 'right' : 'wrong', by: keyId, key: by, project: dir, out: join(folder, `${String(i).padStart(4, '0')}.json`) });
  return folder;
}
const previous = (model = 'model-a', version = 1) => {
  const body = { decision: 'route', version, fittedFor: model, points: [[0, 0], [1000, 1000]] };
  const file = join(tmp, `previous-${++n}.json`);
  writeFileSync(file, JSON.stringify({ ...body, digest: mapDigest(body) }, null, 2) + NL);
  return file;
};
const refit = (rd, folder, extra = {}) => refitMap({ reader: rd, decision: 'route', model: 'model-a', verdictsDir: folder, previous: extra.previous ?? previous(), project: dir, by: PERSON.keyId, key: personKey, out: join(tmp, `map-${++n}.json`), ...extra });

test('PS22.1, PT32.1: a verdict is a signed record of a person, bound to the project, the event, the verdict and the correct answer; the chain is not written', async () => {
  const h = history(2, [500]);
  const rd = reader(h.rows);
  const out = join(tmp, `v-${++n}.json`);
  const r = await signVerdict({ reader: rd, event: 'e0', verdict: 'wrong', correct: JSON.stringify('Complaint'), by: PERSON.keyId, key: personKey, project: dir, out });
  const file = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['correct', 'decision', 'event', 'kind', 'model', 'record', 'run', 'v', 'verdict']);
  assert.deepEqual([file.v, file.kind, file.decision, file.event, file.run, file.model, file.verdict, file.correct], [1, 'poly.verdict', 'route', 'e0', 'r0', 'model-a', 'wrong', 'Complaint']);
  assert.equal(file.record.kind, 'verdict');
  assert.equal(file.record.by, PERSON.keyId);
  assert.equal(r.file.record.subject, subjectOf('e0', 'wrong', 'Complaint'));
  const rings = keyringsOf(dir, loadProject(dir).manifest);
  assert.equal(verifyRecord(file.record, rings, { kind: 'verdict', subject: subjectOf('e0', 'wrong', 'Complaint') }).ok, true);
  assert.equal(verifyRecord(file.record, rings, { kind: 'verdict', subject: subjectOf('e0', 'right', 'Complaint') }).ok, false, 'bound to the verdict');
  assert.equal(verifyRecord(file.record, rings, { kind: 'verdict', subject: subjectOf('e1', 'wrong', 'Complaint') }).ok, false, 'bound to the event');
  assert.equal(verifyRecord(file.record, rings, { kind: 'verdict', subject: subjectOf('e0', 'wrong') }).ok, false, 'bound to the correct answer');
});

test('PT32.1: a verdict is refused for an agent key, a key outside the people ring, an event that is not a decision event, a verdict that is no verdict, a correct that is not JSON and an existing file', async () => {
  const rd = reader(history(2, [500]).rows);
  const base = { reader: rd, event: 'e0', verdict: 'right', by: PERSON.keyId, key: personKey, project: dir };
  await signVerdict({ ...base, out: join(tmp, `ok-${++n}.json`) });
  const refuses = async (change, re) => assert.rejects(signVerdict({ ...base, out: join(tmp, `no-${++n}.json`), ...change }), (e) => e instanceof AdmitError && re.test(e.message));
  await refuses({ by: AGENT.keyId, key: agentKey }, /agent key/);
  await refuses({ by: 'key-nobody' }, /not a key in the project's people keyring/);
  await refuses({ event: 'e99' }, /no decision event e99/);
  await refuses({ verdict: 'maybe' }, /right or wrong/);
  await refuses({ correct: '{not json' }, /--correct/);
  const there = join(tmp, `there-${++n}.json`);
  writeFileSync(there, '{}');
  await assert.rejects(signVerdict({ ...base, out: there }), /exists/);
});

test('PS22.6, PT32.2: a refit is the isotonic map of the verdicts, one version above the map it replaces, written to a new file; the old map and the sources are untouched', async () => {
  const h = history(12);
  const rd = reader(h.rows);
  const folder = await verdicts(rd, h);
  const prev = previous('model-a', 3);
  const prevBytes = readFileSync(prev, 'utf8');
  const out = join(tmp, `new-${++n}.json`);
  const r = await refit(rd, folder, { previous: prev, out });
  const map = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(mapProblem(map), null, 'a map the checker reads');
  assert.equal(map.version, 4);
  assert.equal(map.fittedFor, 'model-a');
  assert.equal(map.decision, 'route');
  assert.deepEqual(map.points.map((p) => p[0]), GRID);
  assert.deepEqual(map.points.map((p) => p[1]), GRID.map((raw) => Math.round((Math.round(acc(raw) * 12) / 12) * 1000)), 'the observed accuracy at each raw value');
  assert.equal(calibrationWarning(map), null, 'no calibration warning');
  assert.equal(readFileSync(prev, 'utf8'), prevBytes, 'the old map is not edited in place');
  assert.equal(r.map.digest, map.digest);
  // It moves the confidence toward the observed accuracy: nearer than the raw probability at every point.
  const err = (f) => map.points.reduce((t, [x, y]) => t + Math.abs(f(x, y) - acc(x)), 0);
  assert.ok(err((x, y) => y / 1000) < err((x) => x / 1000) / 3, 'overall far nearer the observed accuracy than the raw probability');
  for (const [x, y] of map.points.filter(([x]) => x === 50 || x === 950)) assert.ok(Math.abs(y / 1000 - acc(x)) < Math.abs(x / 1000 - acc(x)), `raw ${x}`);
  // The overconfident end is pulled down.
  assert.ok(map.points.at(-1)[1] < 950);
});

test('PS22.5, PT32.2: the refit record is signed by a person, binds the anchor, the map and the verdicts, and sits beside the map', async () => {
  const h = history(12);
  const rd = reader(h.rows);
  const folder = await verdicts(rd, h);
  const out = join(tmp, `signed-${++n}.json`);
  await refit(rd, folder, { out });
  const side = out.replace(/\.json$/, '.refit.json');
  assert.ok(existsSync(side), 'beside the map');
  const rec = JSON.parse(readFileSync(side, 'utf8'));
  const map = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual([rec.v, rec.kind, rec.map], [1, 'poly.refit', map.digest]);
  assert.equal(rec.verdicts.length, 120);
  assert.deepEqual(rec.verdicts, [...rec.verdicts].sort());
  const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor: anchorId(), map: map.digest, verdicts: rec.verdicts }), 'utf8').digest('hex')}`;
  const rings = keyringsOf(dir, loadProject(dir).manifest);
  assert.equal(verifyRecord(rec.record, rings, { kind: 'refit', subject }).ok, true);
  assert.equal(rec.record.by, PERSON.keyId);
  await assert.rejects(refit(rd, folder, { out }), /exists/, 'an existing map is not overwritten');
  await assert.rejects(refit(rd, folder, { by: AGENT.keyId, key: agentKey }), /agent key/);
});

test('PS22.2: only verified verdicts of the decision and the model count: an unsigned outcome, a wrong signature, an agent, another decision, another model and an unknown event are listed and left out', async () => {
  const h = history(12);
  const rows = [...h.rows.map((r, i) => ({ ...r, outcome: i % 2 ? 'Correct' : 'Wrong' })), { hash: 'xd', raw: 0.5, decision: 'other' }, { hash: 'xm', raw: 0.5, model: 'model-b' }];
  const rd = reader(rows);
  const folder = await verdicts(rd, h);
  const clean = await refit(rd, folder);
  assert.equal(JSON.parse(readFileSync(clean.path.replace(/\.json$/, '.refit.json'), 'utf8')).verdicts.length, 120, "the program own outcomes are not read");
  const files = readdirSync(folder).sort();
  const first = JSON.parse(readFileSync(join(folder, files[0]), 'utf8'));
  const put = (name, v) => writeFileSync(join(folder, name), JSON.stringify(v));
  put('x-flipped.json', { ...first, verdict: first.verdict === 'right' ? 'wrong' : 'right' });
  put('x-agent.json', { ...first, record: signRecord({ kind: 'verdict', subject: subjectOf(first.event, first.verdict, undefined), by: AGENT.keyId, at: '2026-10-12T00:00:00.000Z' }, AGENT.privateKeyPem) });
  put('x-unknown-event.json', { ...first, event: 'nope', record: signRecord({ kind: 'verdict', subject: subjectOf('nope', first.verdict, undefined), by: PERSON.keyId, at: '2026-10-12T00:00:00.000Z' }, PERSON.privateKeyPem) });
  await signVerdict({ reader: rd, event: 'xd', verdict: 'right', by: PERSON.keyId, key: personKey, project: dir, out: join(folder, 'x-decision.json') });
  await signVerdict({ reader: rd, event: 'xm', verdict: 'right', by: PERSON.keyId, key: personKey, project: dir, out: join(folder, 'x-model.json') });
  writeFileSync(join(folder, 'x-garbage.json'), '{not json');
  writeFileSync(join(folder, 'notes.txt'), 'not a verdict');
  const r = await refit(rd, folder);
  const rec = JSON.parse(readFileSync(r.path.replace(/\.json$/, '.refit.json'), 'utf8'));
  assert.equal(rec.verdicts.length, 120, 'none of them counted');
  const why = Object.fromEntries(rec.skipped.map((x) => [x.file, x.why]));
  assert.deepEqual(Object.keys(why).sort(), ['x-agent.json', 'x-decision.json', 'x-flipped.json', 'x-garbage.json', 'x-model.json', 'x-unknown-event.json']);
  assert.match(why['x-flipped.json'], /does not verify/);
  assert.match(why['x-agent.json'], /does not verify/);
  assert.match(why['x-decision.json'], /another decision/);
  assert.match(why['x-model.json'], /another model/);
  assert.match(why['x-unknown-event.json'], /no decision event/);
  assert.match(why['x-garbage.json'], /not JSON/);
  assert.equal(verdictFilesIn(folder).map((x) => basename(x)).includes('notes.txt'), false, 'a file that is not a .json is not read');
});

test('PS22.3, PT32.2: below the floor the refit refuses and says by how much; the control at the floor fits', async () => {
  const at = (k) => { const h = history(5); h.rows = h.rows.slice(0, k); h.right = h.right.slice(0, k); return h; };
  const h49 = at(49); // 49 verdicts: raw grid up to 950, ten per five; the last group short.
  const rd49 = reader(h49.rows);
  await assert.rejects(refit(rd49, await verdicts(rd49, h49)), (e) => e instanceof AdmitError && /refit of route for model-a is refused: 49 verdicts, the floor is 50: 1 short/.test(e.message));
  const h50 = at(50);
  const rd50 = reader(h50.rows);
  const ok = await refit(rd50, await verdicts(rd50, h50));
  assert.equal(mapProblem(ok.map), null, 'at the floor it fits');
  const none = reader(history(1, [500]).rows);
  const emptyFolder = join(tmp, `empty-${++n}`);
  mkdirSync(emptyFolder);
  await assert.rejects(refit(none, emptyFolder), /0 verdicts, the floor is 50: 50 short/);
});

test('PS22.3: a refit whose map would earn the calibration warning is refused with the check\'s reason and by how much; the control with the low range covered fits', async () => {
  const high = GRID.filter((x) => x >= 550);
  const h = history(30, high);
  const rd = reader(h.rows);
  await assert.rejects(refit(rd, await verdicts(rd, h)), (e) => e instanceof AdmitError && /would earn the calibration warning/.test(e.message) && /sends the 549 raw values 1 to 549 \(thousandths\) to 0, a band wider than 100/.test(e.message) && /449 over the 100/.test(e.message));
  const all = history(12);
  const rd2 = reader(all.rows);
  assert.equal(calibrationWarning((await refit(rd2, await verdicts(rd2, all))).map), null);
});

test('PS22.4: a refit for a synthetic history is marked synthetic, and only a test anchor accepts that', async () => {
  const h = history(12);
  const rd = reader(h.rows);
  const folder = await verdicts(rd, h);
  const r = await refit(rd, folder, { synthetic: true });
  assert.equal(JSON.parse(readFileSync(r.path.replace(/\.json$/, '.refit.json'), 'utf8')).synthetic, true);
  await assert.rejects(refit(rd, folder, { synthetic: true, anchorSource: 'user' }), (e) => e instanceof AdmitError && /synthetic/.test(e.message) && /test anchor/.test(e.message));
  const plain = await refit(rd, folder);
  assert.equal('synthetic' in JSON.parse(readFileSync(plain.path.replace(/\.json$/, '.refit.json'), 'utf8')), false);
});

// ── admission (PT32.3) ──────────────────────────────────────────────────────────────────────────────────────────
async function projectWithRefit(name, tweak = () => {}) {
  const key = makeKey(name);
  const d = project(name, ['test/fixtures/m7/forms/forms.poly'], key);
  const h = history(12);
  const rd = reader(h.rows);
  const folder = join(tmp, `v-${++n}`);
  mkdirSync(folder);
  const personFile = personKey;
  for (let i = 0; i < h.rows.length; i++) {
    const out = join(folder, `${i}.json`);
    // Bound to this project's anchor, not the refit project's.
    const anchor = JSON.parse(readFileSync(JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8')).anchors[name].replace(/^file:/, ''), 'utf8')).id;
    const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor, event: h.rows[i].hash, verdict: h.right[i] ? 'right' : 'wrong', correct: null }), 'utf8').digest('hex')}`;
    const record = signRecord({ kind: 'verdict', subject, by: PERSON.keyId, at: '2026-10-12T00:00:00.000Z' }, PERSON.privateKeyPem);
    writeFileSync(out, JSON.stringify({ v: 1, kind: 'poly.verdict', decision: 'route', event: h.rows[i].hash, run: `r${i}`, model: 'model-a', verdict: h.right[i] ? 'right' : 'wrong', record }));
  }
  const maps = join(d, 'src', 'maps');
  mkdirSync(maps, { recursive: true });
  const prev = previous();
  cpSync(prev, join(maps, 'route.json'));
  const out = join(maps, 'route.v2.json');
  await refitMap({ reader: rd, decision: 'route', model: 'model-a', verdictsDir: folder, previous: prev, project: d, by: PERSON.keyId, key: personFile, out });
  tweak(d, out);
  return d;
}

test('PT32.3: admission reads the refit record back and the certificate lists it; a project with no refit has no poly.refits', async () => {
  const d = await projectWithRefit('refit-adm-1');
  const r = await admit(d);
  assert.equal(r.verdict, 'CLEAN');
  const map = JSON.parse(readFileSync(join(d, 'src', 'maps', 'route.v2.json'), 'utf8'));
  assert.deepEqual(r.certificate.poly.refits.map((x) => [x.map, x.digest]), [['src/maps/route.v2.json', map.digest]]);
  assert.match(r.certificate.poly.refits[0].record, /^sha256:[0-9a-f]{64}$/);
  const none = project('refit-adm-0', ['test/fixtures/m7/forms/forms.poly'], makeKey('refit-adm-0'));
  assert.ok(!('refits' in (await admit(none)).certificate.poly));
});

test('PT32.3: PL6513 for a refit whose map was changed, whose record is an agent\'s, whose record was moved to another map, or whose map is not a map', async () => {
  const cases = {
    'refit-adm-2': (_d, out) => { const m = JSON.parse(readFileSync(out, 'utf8')); m.points[0][1] += 1; writeFileSync(out, JSON.stringify({ ...m, digest: mapDigest(m) })); },
    'refit-adm-3': (d, out) => { const f = out.replace(/\.json$/, '.refit.json'); const r = JSON.parse(readFileSync(f, 'utf8')); r.record = signRecord({ kind: 'refit', subject: r.record.subject, by: AGENT.keyId, at: r.record.at }, AGENT.privateKeyPem); writeFileSync(f, JSON.stringify(r)); },
    'refit-adm-4': (d, out) => { const f = out.replace(/\.json$/, '.refit.json'); cpSync(f, join(d, 'src', 'maps', 'other.refit.json')); cpSync(out, join(d, 'src', 'maps', 'other.json')); const m = JSON.parse(readFileSync(join(d, 'src', 'maps', 'other.json'), 'utf8')); m.version = 9; writeFileSync(join(d, 'src', 'maps', 'other.json'), JSON.stringify({ ...m, digest: mapDigest(m) })); },
    'refit-adm-5': (_d, out) => { writeFileSync(out, '{"not":"a map"}'); },
  };
  for (const [name, tweak] of Object.entries(cases)) {
    const d = await projectWithRefit(name);
    assert.equal((await admit(d)).verdict, 'CLEAN', `${name}: the control`);
    tweak(d, join(d, 'src', 'maps', 'route.v2.json'));
    await assert.rejects(admit(d), (e) => e instanceof AdmitError && /PL6513/.test(e.message) && /refit/.test(e.message), name);
  }
});

// ── the command line over a real store (PT32.1, PT32.2, PT32.5) ─────────────────────────────────────────────────
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

test('PT32.5: verdict and refit are commands with no MCP tool, and poly verdict names an event that is not there as a usage error', async () => {
  const { commandNamed } = await import('@poly/check');
  for (const name of ['verdict', 'refit']) { const c = commandNamed(name); assert.ok(c, name); assert.equal(c.mcp, null, name); }
  const { mcpTools } = await import('@poly/agent');
  assert.ok(!mcpTools().some((t) => /verdict|refit/.test(t.name)));
  const missing = poly('verdict', '--db', join(tmp, 'none.db'), '--event', 'abc', '--verdict', 'right', '--by', PERSON.keyId, '--key', personKey, '--project', dir, '--out', join(tmp, `cli-${++n}.json`));
  assert.notEqual(missing.code, 0, missing.out);
});
