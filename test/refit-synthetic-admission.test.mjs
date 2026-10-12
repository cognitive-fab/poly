// PT32.3 (audit row 74): a refit record fitted from synthetic verdicts is cited only by a test certificate. Written by the
// implementer after the independent audit left the row open; it reads the record back with the source of the certificate
// named, as admission does, once for a user certificate (refused, PL6513, saying synthetic) and once for a test one (listed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyringsOf, loadProject } from '@poly/core';
import { readRefits, refitMap, signVerdict } from '@poly/check';
import { mapDigest } from '@poly/runtime';
import { ANCHORS, PERSON, makeKey, project } from './runtime-helpers.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'poly-refit-synth-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const GRID = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
const acc = (raw) => 0.2 + 0.5 * (raw / 1000);

test('PT32.3: a synthetic refit under a user certificate is PL6513 naming synthetic, and under a test certificate it is listed (the control)', async () => {
  const dir = project('refit-synth', ['test/fixtures/m7/forms/forms.poly'], makeKey('refit-synth'));
  const rows = []; const right = [];
  for (const raw of GRID) { const k = Math.round(acc(raw) * 12); for (let i = 0; i < 12; i++) { rows.push({ hash: `e${rows.length}`, raw: raw / 1000 }); right.push(i < k); } }
  const events = rows.map((r) => [{ kind: 'decision', hash: r.hash, body: { decision: 'route', request: 'q', answer: 'Refund', raw: r.raw, model: { id: 'm', reported: 'model-a' } } }]);
  const reader = { runs: async () => rows.map((_, i) => ({ ns: 's', wf: 's.T', run: `r${i}` })), chain: async (r) => events[Number(r.slice(1))], body: async () => ({}), heads: async () => [], journal: async () => null, anchors: async () => [], close: async () => {} };
  const key = join(tmp, 'person.pem');
  writeFileSync(key, PERSON.privateKeyPem);
  const verdicts = join(tmp, 'verdicts');
  mkdirSync(verdicts);
  for (let i = 0; i < rows.length; i++) await signVerdict({ reader, event: rows[i].hash, verdict: right[i] ? 'right' : 'wrong', by: PERSON.keyId, key, project: dir, out: join(verdicts, `${i}.json`) });
  const previousBody = { decision: 'route', version: 1, fittedFor: 'model-a', points: [[0, 0], [1000, 1000]] };
  const previous = join(tmp, 'previous.json');
  writeFileSync(previous, JSON.stringify({ ...previousBody, digest: mapDigest(previousBody) }));
  // The map goes under src/ so that admission's scan finds it, as the real command line leaves it.
  mkdirSync(join(dir, 'src', 'maps'), { recursive: true });
  const out = join(dir, 'src', 'maps', 'route.v2.json');
  await refitMap({ reader, decision: 'route', model: 'model-a', verdictsDir: verdicts, previous, project: dir, by: PERSON.keyId, key, out, synthetic: true });
  assert.equal(JSON.parse(readFileSync(out.replace(/\.json$/, '.refit.json'), 'utf8')).synthetic, true);

  const rings = keyringsOf(dir, loadProject(dir).manifest);
  const anchorId = JSON.parse(readFileSync(JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8')).anchors['refit-synth'].replace(/^file:/, ''), 'utf8')).id;
  const asTest = readRefits(dir, rings, anchorId, 'test');
  assert.deepEqual(asTest.problems, []);
  assert.equal(asTest.list.length, 1);
  const asUser = readRefits(dir, rings, anchorId, 'user');
  assert.equal(asUser.list.length, 0);
  assert.equal(asUser.problems.length, 1);
  assert.equal(asUser.problems[0].code, 'PL6513');
  assert.match(asUser.problems[0].message, /synthetic verdicts, which only a test certificate may cite/);
});
