// M7-AC (M7.4): on synthetic verdicts, a refit map moves the confidence toward the observed accuracy, raises no calibration
// warning, and the inbox checks CLEAN and is admitted with it, the certificate listing the refit. The verdicts are SYNTHETIC
// (written by the test for the decision `triage` and the model its small tier's map was fitted for); no recorded run is used,
// and the refit record says so. The old map is not edited: the inbox is admitted first with it, then with the new file named in
// the route, and the old file is byte for byte as it was. Two admissions of the inbox, run alone. Written by the implementer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, calibrationWarning, refitMap, signVerdict } from '@poly/check';
import { mapProblem } from '@poly/core';
import { PERSON, makeKey, project, signPolicies } from '../runtime-helpers.mjs';
import { DRAFT, POLICY, SOURCE } from '../ex-inbox-helpers.mjs';

const GRID = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
const acc = (raw) => 0.2 + 0.5 * (raw / 1000);

test('M7.4: a refit of the inbox\'s triage map from synthetic verdicts is admitted, cites the old map until the route names the new one, and raises no warning', { timeout: 3_600_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-inbox-refit-'));
  try {
    const name = 'ex-inbox-refit';
    const dir = project(name, [], makeKey(name), 'test-ex-inbox');
    writeFileSync(join(dir, 'src', 'inbox.poly'), SOURCE);
    writeFileSync(join(dir, 'src', 'inbox.policy.poly'), POLICY);
    cpSync(join(DRAFT, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
    cpSync(join(DRAFT, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
    const cfg = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
    writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...cfg, credentials: { gmail_draft: { store: 'kms' }, gmail_read: { store: 'kms' } } }, null, 2));
    await signPolicies(dir);
    const old = join(dir, 'src', 'maps', 'triage-small.json');
    const oldBytes = readFileSync(old, 'utf8');
    const model = JSON.parse(oldBytes).fittedFor;

    // The first admission cites the old map; the certificate lists no refit.
    const first = await admit(dir);
    assert.equal(first.verdict, 'CLEAN');
    assert.ok(!('refits' in first.certificate.poly));

    // Synthetic verdicts: 12 answers at each of ten raw values, of which round(acc * 12) were right.
    const rows = []; const right = [];
    for (const raw of GRID) { const k = Math.round(acc(raw) * 12); for (let i = 0; i < 12; i++) { rows.push({ hash: `e${rows.length}`, raw: raw / 1000 }); right.push(i < k); } }
    const events = rows.map((r) => [{ kind: 'decision', hash: r.hash, body: { decision: 'triage', request: 'q', answer: 'Act', raw: r.raw, model: { id: 'small', reported: model } } }]);
    const reader = { runs: async () => rows.map((_, i) => ({ ns: 'inbox', wf: 'inbox.Message', run: `r${i}` })), chain: async (r) => events[Number(r.slice(1))], body: async () => ({}), heads: async () => [], journal: async () => null, anchors: async () => [], close: async () => {} };
    const key = join(tmp, 'person.pem');
    writeFileSync(key, PERSON.privateKeyPem);
    const verdicts = join(tmp, 'verdicts');
    mkdirSync(verdicts);
    for (let i = 0; i < rows.length; i++) await signVerdict({ reader, event: rows[i].hash, verdict: right[i] ? 'right' : 'wrong', by: PERSON.keyId, key, project: dir, out: join(verdicts, `${String(i).padStart(4, '0')}.json`) });
    const out = join(dir, 'src', 'maps', 'triage-small.v2.json');
    const r = await refitMap({ reader, decision: 'triage', model, verdictsDir: verdicts, previous: old, project: dir, by: PERSON.keyId, key, out, synthetic: true });

    assert.equal(mapProblem(r.map), null);
    assert.equal(r.map.version, 2);
    assert.equal(calibrationWarning(r.map), null, 'no calibration warning');
    const err = (f) => r.map.points.reduce((t, [x, y]) => t + Math.abs(f(x, y) - acc(x)), 0);
    assert.ok(err((x, y) => y / 1000) < err((x) => x / 1000) / 3, 'the map is nearer the observed accuracy than the raw probability');
    assert.equal(readFileSync(old, 'utf8'), oldBytes, 'the old map is not edited');
    assert.equal(JSON.parse(readFileSync(out.replace(/\.json$/, '.refit.json'), 'utf8')).synthetic, true, 'the record says the verdicts were made for the test');

    // The route still cites the old map; the project admits as before, and now lists the refit record beside the new file.
    const second = await admit(dir);
    assert.equal(second.verdict, 'CLEAN');
    assert.deepEqual(second.certificate.poly.refits.map((x) => [x.map, x.digest]), [['src/maps/triage-small.v2.json', r.map.digest]]);

    // The person changes the route's path to the new file; the project checks CLEAN with no calibration warning and is admitted.
    const src = join(dir, 'src', 'inbox.poly');
    const text = readFileSync(src, 'utf8');
    assert.equal(text.split('calibration "maps/triage-small.json"').length, 2);
    writeFileSync(src, text.replace('calibration "maps/triage-small.json"', 'calibration "maps/triage-small.v2.json"'));
    await signPolicies(dir);
    const third = await admit(dir);
    assert.equal(third.verdict, 'CLEAN');
    assert.ok(!JSON.stringify(third.report ?? {}).includes('"kind":"calibration"'), 'no calibration warning in the report');
    assert.notEqual(JSON.stringify(third.certificate.poly.decisions), JSON.stringify(first.certificate.poly.decisions), 'the certificate binds the new map');
    assert.ok(existsSync(old));
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }); }
});
