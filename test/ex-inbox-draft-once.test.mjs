// IT4.4, IAC10 (M7, the defect the loop found; S526): a draft Gmail may already hold is never created twice. Written from the
// witness of `count("gmail.createDraft") <= 1` (decisions-m7.md): Propose, Enveloped (createDraft), NotCreated, Propose, Enveloped.
// The path is right when the first creation definitely failed and wrong when it may have succeeded. These tests are the
// implementer's, written before the fix and seen failing. The checks that run the whole inbox are in test/after/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';

const SOURCE = join(ROOT, 'examples', 'inbox', 'inbox.poly');
const drafts = await import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', 'drafts.mjs')).href);
const caps = (post) => ({ content: { read: async (d) => (d === 'sha256:e' ? JSON.stringify({ to: 'a@example.test', subject: 's' }) : 'body') }, api: { post } });
const payload = { account: 'acct', t: 'work/19a2f0c4d1e70a01', e: 'sha256:e', body: 'sha256:b' };

test('IT4.4: the status of the answer decides the outcome: 200 ok; 400, 401, 403, 404 and 429 permanent; 408, every other status and a status that is no number are ambiguous', () => {
  assert.equal(typeof drafts.classifyDraftStatus, 'function');
  assert.equal(drafts.classifyDraftStatus(200), 'ok');
  for (const s of [400, 401, 403, 404, 429]) assert.equal(drafts.classifyDraftStatus(s), 'permanent', String(s));
  for (const s of [408, 201, 204, 301, 409, 410, 500, 502, 503, 504, 0, -1, 99999, NaN, undefined, null, '403', '200']) assert.equal(drafts.classifyDraftStatus(s), 'ambiguous', String(s));
});

test('IT4.4: a definite refusal is a permanent error (final, delivered as failed); an ambiguous status and a transport error are not permanent, and say they are ambiguous', async () => {
  assert.deepEqual(await drafts.createDraft(payload, caps(async () => ({ status: 200, headers: {}, body: '' }))), { ok: true }, 'the control: a 200 creates');
  for (const status of [400, 401, 403, 404, 429]) {
    const e = await drafts.createDraft(payload, caps(async () => ({ status, headers: {}, body: '' }))).then(() => null, (x) => x);
    assert.ok(e, String(status));
    assert.equal(e.permanent, true, `${status} is a definite refusal`);
    assert.match(e.message, new RegExp(String(status)));
  }
  for (const status of [408, 500, 503, 504, 302]) {
    const e = await drafts.createDraft(payload, caps(async () => ({ status, headers: {}, body: '' }))).then(() => null, (x) => x);
    assert.ok(e, String(status));
    assert.notEqual(e.permanent, true, `${status} may have created the draft`);
    assert.equal(e.ambiguous, true);
  }
  for (const failure of [new Error('ETIMEDOUT'), new Error('socket hang up')]) {
    const e = await drafts.createDraft(payload, caps(async () => { throw failure; })).then(() => null, (x) => x);
    assert.ok(e);
    assert.notEqual(e.permanent, true);
    assert.equal(e.ambiguous, true, 'a request that left and did not answer may have created the draft');
  }
});

test('IT4.4: the draft is attempted once and an ambiguous outcome is delivered as exhausted to DraftUncertain', () => {
  const text = readFileSync(SOURCE, 'utf8');
  const effect = /effect createDraft\([^)]*\) \{[\s\S]*?\n  \}/.exec(text)[0];
  assert.match(effect, /retry \{ attempts 1,/, 'no automatic second post: Gmail drafts have no idempotency key (S526)');
  assert.match(effect, /ok -> Created\(\)/);
  assert.match(effect, /failed -> NotCreated\(\)/);
  assert.match(effect, /exhausted -> DraftUncertain\(\)/);
});

const run = async (ops) => (await commandNamed('try').run({ file: SOURCE, machine: 'Todo', ops })).result;
const dispatch = (action, data) => ({ op: 'dispatch', action, ...(data ? { data } : {}) });
// The witness's first seven steps, up to the first createDraft.
const TO_PROPOSED = [
  dispatch('Open', { owner: 'p1', at: null, answer: true }), dispatch('ReadFailed'), dispatch('WriteDraft'), dispatch('Read', { items: { count: 0 } }),
  dispatch('Written', { text: null, cites: { count: 0 } }), dispatch('Propose'), dispatch('Enveloped', { e: null }),
];
const statusAfter = (r) => r.results.filter((x) => x.op === 'dispatch').map((x) => ({ action: x.action, kind: x.stepKind, reason: x.rejectReason, status: x.state?.status ?? null }));

test('IT4.4, the witness: after a definite refusal the to-do may propose again (the control)', async () => {
  const r = await run([...TO_PROPOSED, dispatch('NotCreated'), dispatch('Propose')]);
  const s = statusAfter(r);
  assert.ok(s.every((x) => x.kind === 'accepted'), JSON.stringify(s));
  assert.equal(r.diagnostics.length, 0);
});

test('IT4.4, the witness: after an ambiguous outcome the to-do is Uncertain and cannot propose again; only the owner leaves Uncertain', async () => {
  const r = await run([...TO_PROPOSED, dispatch('DraftUncertain'), { op: 'state' }, dispatch('Propose'), dispatch('NotCreated'), dispatch('Created'), dispatch('Enveloped', { e: null })]);
  const dispatched = r.results.filter((x) => x.op === 'dispatch');
  const after = dispatched.slice(dispatched.findIndex((x) => x.action === 'DraftUncertain'));
  const at = (name) => after.find((x) => x.action === name);
  assert.equal(at('DraftUncertain').stepKind, 'accepted');
  assert.equal(r.results.find((x) => x.op === 'state').state.status, 'Uncertain');
  for (const name of ['Propose', 'NotCreated', 'Created', 'Enveloped']) assert.notEqual(at(name).stepKind, 'accepted', `${name} must not leave Uncertain`);
});

test('IT4.4: the owner settles an Uncertain to-do: DraftFound makes it Created, DraftMissing sends it back to Drafted; neither is accepted from any other status', async () => {
  const found = await run([...TO_PROPOSED, dispatch('DraftUncertain'), dispatch('DraftFound'), { op: 'state' }]);
  assert.equal(found.results.find((x) => x.op === 'state').state.status, 'Created');
  const missing = await run([...TO_PROPOSED, dispatch('DraftUncertain'), dispatch('DraftMissing'), { op: 'state' }, dispatch('Propose')]);
  assert.equal(missing.results.find((x) => x.op === 'state').state.status, 'Drafted');
  assert.equal(missing.results.filter((x) => x.op === 'dispatch').at(-1).stepKind, 'accepted', 'it may be proposed again');
  for (const action of ['DraftFound', 'DraftMissing', 'DraftUncertain']) {
    const early = await run([dispatch('Open', { owner: 'p1', at: null, answer: true }), dispatch(action)]);
    assert.notEqual(early.results.filter((x) => x.op === 'dispatch').at(-1).stepKind, 'accepted', `${action} from Opening`);
    const proposedFound = await run([...TO_PROPOSED, dispatch(action === 'DraftUncertain' ? 'DraftFound' : action)]);
    assert.notEqual(proposedFound.results.filter((x) => x.op === 'dispatch').at(-1).stepKind, 'accepted', `${action} from Proposed`);
  }
});
