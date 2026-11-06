// Finding 36 (docs/examples/language-findings.md), rule 7a: tests written by a separate writer from the specification
// alone, the paragraph "The recorded traffic stands for one day" in examples/inbox/README.md, section "The dry run".
//
// The specification: the dry run's fixtures name the instant the traffic stands for (`recordedAt`). When the host starts on
// them, the fake Google moves every `internalDate` in a body it serves by the runtime's clock at the host's start minus
// `recordedAt`, so each message is as old when the dry run reads it as it was on the recorded day. Only `internalDate`
// moves; the raw message, its Date header included, and every other field are served as recorded, and the recorded tape
// files do not change. Fixtures with no `recordedAt`, or one that is not an ISO 8601 instant with its zone, are refused when
// read, and the host does not start.
//
// The seam, where the specification leaves it open: the fake Google learns the runtime's clock from a third argument,
// `fakeGoogle(fixtures, profile, { now })`, where `now` is a function returning milliseconds since the epoch. That is the
// shape the host already hands the runtime's clock to the credential ingress (`credentialIngress(rt, vaults, () => rt.now())`
// in examples/inbox/host/run.mjs), and the host builds the fake at its start, so the clock is read when the fake is built.
// A refusal is a throw from `loadFixtures` whose message names `recordedAt`.
//
// Not held here: that the host passes the runtime's clock rather than a separate wall clock. startHost loads the run of an
// admitted project before it builds the fake, and admission takes minutes and a large heap, so that belongs to the serial
// test of the README's steps (test/after/ex-inbox-dry-run.test.mjs), not to this fast file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { loadFixtures, fakeGoogle } from '../examples/inbox/host/fixtures.mjs';
import { startHost } from '../examples/inbox/host/run.mjs';

const TAPES = join(ROOT, 'test', 'fixtures', 'traffic', 'gmail');
const TAPE = { work: join(TAPES, 'work.json'), home: join(TAPES, 'home.json') };
const ANSWERS = join(ROOT, 'examples', 'inbox', 'dry-run', 'answers.json');
const PROFILE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'google.json'), 'utf8'));
// The passes replayed here: `initial` is the dry run's own; `poll` adds the work account's other two messages. `quiet` and
// `expired` are left out because their history requests share one URL, so the replay could not tell them apart.
const PASSES = ['initial', 'poll'];

const scratch = mkdtempSync(join(tmpdir(), 'poly-finding36-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fixtures file in the scratch directory over the real tapes, with `recordedAt` as given (omitted when undefined). */
function fixturesFile(recordedAt, passes = PASSES) {
  const doc = { gmail: { work: TAPE.work, home: TAPE.home }, passes, answers: ANSWERS };
  if (recordedAt !== undefined) doc.recordedAt = recordedAt;
  const file = join(scratch, `fixtures-${++n}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

const tape = (label) => JSON.parse(readFileSync(TAPE[label], 'utf8'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Every `internalDate` in a body, at any depth, as [path, value]. */
function internalDates(body, path = '$') {
  if (body === null || typeof body !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'internalDate') out.push([`${path}.${k}`, v]);
    else out.push(...internalDates(v, `${path}.${k}`));
  }
  return out;
}

/** The body with every `internalDate` removed, at any depth. */
function withoutInternalDate(body) {
  if (Array.isArray(body)) return body.map(withoutInternalDate);
  if (body === null || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'internalDate').map(([k, v]) => [k, withoutInternalDate(v)]));
}

/**
 * Replays each account's recorded exchanges of `passes` through the fake, as the Gmail source would send them: a token for
 * the account first (the fake remembers whom it issued it to), then each request in recorded order under that token.
 * Returns, per exchange, the recorded body and the body the fake served.
 */
async function replay(google, passes = PASSES) {
  const served = [];
  for (const label of ['work', 'home']) {
    google.state.consenting = label;
    const t = await google.http.request({ method: 'POST', url: PROFILE.token, headers: {}, body: '' });
    google.state.consenting = null;
    const token = JSON.parse(t.body).access_token;
    const recorded = tape(label);
    for (const pass of passes) {
      for (const e of recorded[pass] ?? []) {
        const res = await google.http.request({ method: e.request.method, url: e.request.url, headers: { Authorization: `Bearer ${token}` }, body: '' });
        served.push({ label, pass, url: e.request.url, status: res.status, recorded: e.response.body, body: JSON.parse(res.body) });
      }
    }
  }
  return served;
}

const R = Date.parse('2026-10-11T12:00:00Z');
// The day finding 36 was measured, with a few odd milliseconds so a shift that rounds to seconds or days is caught.
const N = Date.parse('2026-11-06T11:37:00Z') + 417;

test('finding 36: each internalDate the fake Google serves is the recorded one moved by the clock at the start minus recordedAt, for both accounts', async () => {
  const google = fakeGoogle(loadFixtures(fixturesFile('2026-10-11T12:00:00Z')), PROFILE, { now: () => N });
  const served = await replay(google);
  const dated = served.flatMap((s) => internalDates(s.recorded).map(([path, v]) => ({ ...s, path, recordedDate: v })));
  // The tapes hold four messages for work (two in initial, two in poll) and two for home; all six must be seen.
  assert.equal(dated.filter((d) => d.label === 'work').length, 4, 'four work messages are replayed');
  assert.equal(dated.filter((d) => d.label === 'home').length, 2, 'two home messages are replayed');
  for (const d of dated) {
    const got = internalDates(d.body).find(([p]) => p === d.path)?.[1];
    const want = String(Number(d.recordedDate) + (N - R));
    assert.equal(got, want, `${d.label} ${d.url} ${d.path}: served ${got}, want the recorded ${d.recordedDate} moved by ${N - R} ms`);
    // The point of the move: the message's age at N equals its age at R.
    assert.equal(N - Number(got), R - Number(d.recordedDate), `${d.label} ${d.url}: the message is as old at the start as on the recorded day`);
  }
});

test('finding 36: recordedAt with an offset is the same instant as in UTC, and moves the dates by the same amount', async () => {
  const utc = await replay(fakeGoogle(loadFixtures(fixturesFile('2026-10-11T12:00:00Z')), PROFILE, { now: () => N }));
  const offset = await replay(fakeGoogle(loadFixtures(fixturesFile('2026-10-11T14:00:00+02:00')), PROFILE, { now: () => N }));
  assert.deepEqual(offset.map((s) => s.body), utc.map((s) => s.body), 'an equal instant written with its offset serves the same bodies');
  const one = utc.find((s) => s.recorded?.id === '19a2f0c4d1e70a01');
  assert.equal(one.body.internalDate, String(Number(one.recorded.internalDate) + (N - R)), 'the invoice the dry run drafts from is moved');
});

test('finding 36: the move is fixed by the clock when the fake is built, the host\'s start, and does not follow the clock after', async () => {
  // "the runtime's clock at the host's start": a clock that moves on during the run does not move the dates again.
  let clock = N;
  const google = fakeGoogle(loadFixtures(fixturesFile('2026-10-11T12:00:00Z')), PROFILE, { now: () => clock });
  clock = N + 3 * 24 * 3600 * 1000;
  const served = await replay(google);
  const one = served.find((s) => s.recorded?.id === '19a2f0c4d1e70a01');
  assert.equal(one.body.internalDate, String(Number(one.recorded.internalDate) + (N - R)), 'moved by the clock at the start, not the clock at the request');
});

test('finding 36: two fakes over the same loaded fixtures serve the same moved dates (the loaded tapes are not moved in place)', async () => {
  const fixtures = loadFixtures(fixturesFile('2026-10-11T12:00:00Z'));
  const first = await replay(fakeGoogle(fixtures, PROFILE, { now: () => N }));
  const second = await replay(fakeGoogle(fixtures, PROFILE, { now: () => N }));
  assert.deepEqual(second.map((s) => s.body), first.map((s) => s.body));
  const one = second.find((s) => s.recorded?.id === '19a2f0c4d1e70a01');
  assert.equal(one.body.internalDate, String(Number(one.recorded.internalDate) + (N - R)), 'moved once, not twice');
});

test('finding 36 (guard): only internalDate moves; the raw message with its Date header, ids, threadId, labelIds, snippet and every other field are served as recorded', async () => {
  const google = fakeGoogle(loadFixtures(fixturesFile('2026-10-11T12:00:00Z')), PROFILE, { now: () => N });
  const served = await replay(google);
  assert.ok(served.length > 0);
  for (const s of served) {
    assert.equal(s.status, 200, `${s.label} ${s.url}`);
    assert.deepEqual(withoutInternalDate(s.body), withoutInternalDate(s.recorded), `${s.label} ${s.url}: every field but internalDate as recorded`);
    if (typeof s.recorded?.raw === 'string') {
      assert.equal(s.body.raw, s.recorded.raw, `${s.label} ${s.url}: the raw message is the recorded one`);
      const header = (raw) => /^Date: (.*)$/m.exec(Buffer.from(raw, 'base64url').toString('utf8'))?.[1];
      assert.ok(header(s.recorded.raw), 'the recorded raw message has a Date header');
      assert.equal(header(s.body.raw), header(s.recorded.raw), `${s.label} ${s.url}: the Date header is not moved`);
    }
  }
  // Bodies with no internalDate (the profile, the list, the history) are served exactly as recorded.
  for (const s of served.filter((x) => internalDates(x.recorded).length === 0)) assert.deepEqual(s.body, s.recorded, `${s.label} ${s.url}`);
});

test('finding 36 (guard): the recorded tape files on disk are unchanged after a run that moves the dates', async () => {
  const before = { work: sha(TAPE.work), home: sha(TAPE.home) };
  const google = fakeGoogle(loadFixtures(fixturesFile('2026-10-11T12:00:00Z')), PROFILE, { now: () => N });
  await replay(google);
  assert.deepEqual({ work: sha(TAPE.work), home: sha(TAPE.home) }, before);
});

const REFUSED = [
  ['no recordedAt', undefined],
  ['a date and time with no zone', '2026-10-11T12:00:00'],
  ['a date with no time and no zone', '2026-10-11'],
  ['a string that is not a date', 'yesterday'],
  ['milliseconds since the epoch, not an ISO 8601 string', R],
  ['an empty string', ''],
];
for (const [what, value] of REFUSED) {
  test(`finding 36: fixtures with ${what} are refused when read, naming recordedAt`, () => {
    const file = fixturesFile(value);
    let fixtures = null;
    assert.throws(() => { fixtures = loadFixtures(file); }, /recordedAt/);
    // Nothing is served: no fixtures came back from which a fake Google could be built.
    assert.equal(fixtures, null);
  });
}

test('finding 36 (guard): recordedAt written as an ISO 8601 instant with its zone is accepted (Z, an offset, fractional seconds)', () => {
  for (const v of ['2026-10-11T12:00:00Z', '2026-10-11T14:00:00+02:00', '2026-10-11T07:00:00-05:00', '2026-10-11T12:00:00.000Z']) {
    assert.doesNotThrow(() => loadFixtures(fixturesFile(v)), v);
  }
});

test('finding 36: the host does not start on fixtures with no recordedAt; the refusal names recordedAt', async () => {
  // startHost reads its config, then the fixtures, then loads the run. A project with only a host config is enough to reach
  // the fixtures; the refusal must come from them, before the run is loaded (which, unadmitted, would fail for its own reason).
  const project = mkdtempSync(join(scratch, 'project-'));
  writeFileSync(join(project, 'inbox.host.json'), JSON.stringify({ v: 1, accounts: [{ label: 'work', owner: 'me-work' }] }));
  const out = [];
  await assert.rejects(startHost({ project, fixtures: fixturesFile(undefined) }, { out: (s) => out.push(s), err: (s) => out.push(s) }), /recordedAt/);
  assert.equal(out.join(''), '', 'the host printed nothing: it did not start');
});

test('finding 36: examples/inbox/dry-run/fixtures.json names recordedAt as 2026-10-11 12:00 UTC, an ISO 8601 instant with its zone', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'examples', 'inbox', 'dry-run', 'fixtures.json'), 'utf8'));
  assert.equal(typeof doc.recordedAt, 'string', 'recordedAt is a string');
  assert.match(doc.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, 'an ISO 8601 instant with its zone');
  assert.equal(Date.parse(doc.recordedAt), R, 'the instant 2026-10-11T12:00:00Z');
});

test('finding 36: the dry run\'s own fixtures, loaded and served, move the initial pass\'s dates by the clock minus 2026-10-11 12:00 UTC', async () => {
  const google = fakeGoogle(loadFixtures(join(ROOT, 'examples', 'inbox', 'dry-run', 'fixtures.json')), PROFILE, { now: () => N });
  const served = await replay(google, ['initial']);
  const dated = served.filter((s) => typeof s.recorded?.internalDate === 'string');
  assert.equal(dated.length, 4, 'two messages per account in the initial pass');
  for (const s of dated) assert.equal(s.body.internalDate, String(Number(s.recorded.internalDate) + (N - R)), `${s.label} ${s.url}`);
});
