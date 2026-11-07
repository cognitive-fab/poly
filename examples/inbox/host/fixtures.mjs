// plan-ex.md E2, "Run it yourself": the dry run. `--fixtures <file>` swaps the host's outside world, and nothing else: the
// fake Google (its token endpoint and Gmail, answering from recorded exchanges), the owner's consent (done for them, by
// calling the same credential callback Google's redirect would), and the recorded model answers. The startup path is the
// one the README describes: the same project, keys, admission, grant requests, vaults, source, providers and passes.
// No key is read and nothing leaves the machine. The recorded traffic is synthetic (test/fixtures/traffic/gmail).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Fixtures the host refuses to start on; the host prints the message as it prints its own refusals. */
export class FixturesError extends Error {}

// Finding 36: an ISO 8601 date and time with its zone (Z or an offset). A date alone, or a time with no zone, is read by
// Date.parse in a zone of its own choosing, so it does not name one instant and is refused.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The instant `at` names, or NaN. V8's Date.parse rolls a day past the month's end over (2026-02-30 is 2 March), so the
 * date and time are checked against the calendar first: a day that does not exist names no instant. */
function instantOf(at) {
  const m = typeof at === 'string' ? INSTANT.exec(at) : null;
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[7] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return NaN;
  return Date.parse(at);
}

/** The fixtures: where each account's recorded Gmail traffic is, the recorded model answers, and the day they stand for. */
export function loadFixtures(file) {
  const path = resolve(file);
  const dir = dirname(path);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  // Finding 36: no default stands in for the recorded day, since any default would make the dry run's ages a guess.
  const at = doc.recordedAt;
  const recordedAt = instantOf(at);
  if (!Number.isFinite(recordedAt)) {
    throw new FixturesError(`${path}: recordedAt must be the instant the recorded traffic stands for, an ISO 8601 date and time with its zone (README.md, The dry run); it is ${JSON.stringify(at)}`);
  }
  const read = (p) => JSON.parse(readFileSync(resolve(dir, p), 'utf8'));
  const tapes = Object.fromEntries(Object.entries(doc.gmail).map(([label, p]) => [label, read(p)]));
  const answers = read(doc.answers);
  return { tapes, answers, passes: doc.passes ?? ['initial'], recordedAt };
}

/** A served body with every `internalDate` in it moved by `ms`, kept a string as Gmail serves it; the recorded body is not touched. */
function moved(body, ms) {
  if (Array.isArray(body)) return body.map((v) => moved(v, ms));
  if (body === null || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, k === 'internalDate' ? String(Number(v) + ms) : moved(v, ms)]));
}

/**
 * The fake Google over the recorded exchanges. `tokens` are made here, so each differs per run. Each token is remembered
 * with the account it was issued to, and a Gmail request is answered from that account's tape, so a request sent under the
 * wrong grant finds no exchange and fails, as it would at Google.
 *
 * Finding 36: `now` is the runtime's clock. It is read once, here, at the host's start, and every `internalDate` served is
 * moved by it minus `recordedAt`, so each message is as old as it was on the recorded day. Before this the dry run served
 * October's dates against the wall clock, and from 2026-11-04 the source's freshness (720h) held every decision.
 */
export function fakeGoogle(fixtures, profile, { now } = {}) {
  if (typeof now !== 'function') throw new TypeError('fakeGoogle needs the runtime\'s clock, { now }');
  // Fixtures not read by loadFixtures could lack the recorded day; moving by NaN would serve "NaN" for every date.
  if (!Number.isFinite(fixtures.recordedAt)) throw new FixturesError('fakeGoogle needs fixtures with recordedAt, as loadFixtures reads them');
  const shift = now() - fixtures.recordedAt;
  const left = Object.entries(fixtures.tapes).flatMap(([label, t]) => fixtures.passes.flatMap((p) => (t[p] ?? []).map((e) => ({ ...e, label, used: false }))));
  const tokenOf = new Map();
  const state = { consenting: null };
  const created = [];
  const seen = [];
  const http = {
    async request(q) {
      if (q.url === profile.token) {
        const access = `fixture-at-${randomBytes(12).toString('base64url')}`;
        tokenOf.set(access, state.consenting);
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: access, refresh_token: `fixture-rt-${randomBytes(12).toString('base64url')}`, token_type: 'Bearer', expires_in: 3599 }) };
      }
      if (q.url === profile.revocation) return { status: 200, headers: {}, body: '' };
      const auth = Object.entries(q.headers ?? {}).find(([h]) => h.toLowerCase() === 'authorization')?.[1] ?? '';
      const label = tokenOf.get(String(auth).replace(/^Bearer /, '')) ?? null;
      seen.push({ method: q.method, url: q.url, label });
      if (q.method === 'POST' && q.url === 'https://gmail.googleapis.com/gmail/v1/users/me/drafts') {
        const sent = JSON.parse(q.body);
        created.push({ label, raw: Buffer.from(sent.message.raw, 'base64url').toString('utf8'), threadId: sent.message.threadId });
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `r-${created.length}`, message: { id: `m-${created.length}`, threadId: sent.message.threadId, labelIds: ['DRAFT'] } }) };
      }
      const e = left.find((x) => !x.used && x.request.method === q.method && x.request.url === q.url && x.label === label);
      if (!e) throw new Error(`no recorded exchange for ${q.method} ${q.url} (${label})`);
      e.used = true;
      return { status: e.response.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(moved(e.response.body, shift)) };
    },
  };
  return { http, state, created, seen };
}

/**
 * The recorded model: answers by the item ids a decision was given, from answers.json
 * `{ triage: { <item id>: [triage, kind] }, summary, when, write }`, with a raw probability high enough to clear the
 * confidence thresholds, and a usage within any limit the program declares.
 */
export function recordedModel(answers) {
  const usage = { input: 400, output: 10 };
  const idsOf = (m) => Object.values(m?.items ?? {}).flat().map((i) => i.id).sort();
  const pick = (q, m) => {
    const ids = idsOf(m);
    if (q.decision === 'triage' || q.decision === 'kind') {
      const row = answers.triage[ids[0]];
      if (!row) throw new Error(`no recorded ${q.decision} answer for ${ids[0]}`);
      return { answer: row[q.decision === 'triage' ? 0 : 1], distribution: [[row[q.decision === 'triage' ? 0 : 1], 0.97]], usage, reported: 'recorded', latencyMs: 0 };
    }
    if (q.decision === 'summary') return { answer: answers.summary.replace('{n}', String(ids.length)), distribution: [[answers.summary, 1]], usage, reported: 'recorded', latencyMs: 0 };
    if (q.decision === 'when') return { answer: answers.when, distribution: [[answers.when, 0.95]], usage, reported: 'recorded', latencyMs: 0 };
    if (q.decision === 'write') return { answer: answers.write, distribution: [[answers.write, 1]], cites: ids, usage, reported: 'recorded', latencyMs: 0 };
    throw new Error(`no recorded answer for the decision ${q.decision}`);
  };
  const decision = () => ({ provider: pick, model: 'recorded' });
  return { tiers: { small: pick, large: pick }, decisions: { summary: decision(), when: decision(), write: decision() } };
}
