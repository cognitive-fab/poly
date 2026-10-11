// plan-ex.md E2, "Run it yourself": the dry run. `--fixtures <file>` swaps the host's outside world, and nothing else: the
// fake Google (its token endpoint and Gmail, answering from recorded exchanges), the owner's consent (done for them, by
// calling the same credential callback Google's redirect would), and the recorded model answers. The startup path is the
// one the README describes: the same project, keys, admission, grant requests, vaults, source, providers and passes.
// No key is read and nothing leaves the machine. The recorded traffic is synthetic (test/fixtures/traffic/gmail).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The fixtures: where each account's recorded Gmail traffic is, and the recorded model answers. */
export function loadFixtures(file) {
  const path = resolve(file);
  const dir = dirname(path);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const read = (p) => JSON.parse(readFileSync(resolve(dir, p), 'utf8'));
  const tapes = Object.fromEntries(Object.entries(doc.gmail).map(([label, p]) => [label, read(p)]));
  const answers = read(doc.answers);
  return { tapes, answers, passes: doc.passes ?? ['initial'] };
}

/**
 * The fake Google over the recorded exchanges. `tokens` are made here, so each differs per run. Each token is remembered
 * with the account it was issued to, and a Gmail request is answered from that account's tape, so a request sent under the
 * wrong grant finds no exchange and fails, as it would at Google.
 */
export function fakeGoogle(fixtures, profile) {
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
      return { status: e.response.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e.response.body) };
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
