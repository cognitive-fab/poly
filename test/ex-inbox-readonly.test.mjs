// plan-ex.md E2, "Run it yourself": the read-only first run, held to a fake runtime. A read-only host dispatches no
// WriteDraft, Edit or Propose, requests no compose grant, connects no compose vault and registers no createDraft handler,
// so the effect gmail.createDraft is out of its reach; with drafts allowed, each of those goes through. Also the digest
// (read from the machines' state, printed, never written), and the check that the program's limits are sized for n asks.
// Light: no project is checked or admitted here; the dry run (test/after/ex-inbox-dry-run.test.mjs) holds the real runtime
// to the same property by counting the outbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const host = (f) => import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', f)).href);
const { guarded, DRAFT_ACTIONS, ReadOnlyRefusal } = await host('guard.mjs');
const { headersOf, formatDigest, readDigest } = await host('digest.mjs');
const { checkSizing, decisionResults } = await host('run.mjs');

/** A runtime that only records what it was asked. */
function fakeRt() {
  const calls = [];
  return {
    calls,
    async dispatch(id, action) { calls.push(['dispatch', id, action]); return { stepKind: 'accepted' }; },
    async requestGrant(credential, holder) { calls.push(['requestGrant', credential, holder]); return 'https://accounts.example/auth'; },
    connectVault(credential) { calls.push(['connectVault', credential]); },
    handle(kind) { calls.push(['handle', kind]); },
  };
}

test('read-only: no WriteDraft, Edit or Propose is dispatched, no compose grant is requested, no compose vault is connected, no createDraft handler is registered', async () => {
  assert.deepEqual([...DRAFT_ACTIONS].sort(), ['Edit', 'Propose', 'WriteDraft']);
  const rt = fakeRt();
  const h = guarded(rt, { drafts: false });
  for (const action of DRAFT_ACTIONS) await assert.rejects(h.dispatch('todo:work:t1', action, {}), (e) => e instanceof ReadOnlyRefusal && /read-only/.test(e.message) && /--drafts/.test(e.message), action);
  await assert.rejects(h.requestGrant('gmail_draft', 'me-work'), ReadOnlyRefusal);
  assert.equal(h.connectVault('gmail_draft', {}), false);
  assert.equal(h.registerDraftHandler('gmail.createDraft', () => {}), false);
  assert.deepEqual(rt.calls, [], 'the runtime was asked for none of it');
  // What a read-only host does do goes through: the other actions of a Todo, the read grant, the read vault.
  await h.dispatch('msg:work:a1', 'Retry', {});
  await h.dispatch('todo:work:t1', 'Finish', {});
  await h.requestGrant('gmail_read', 'me-work');
  assert.equal(h.connectVault('gmail_read', {}), true);
  assert.deepEqual(rt.calls, [['dispatch', 'msg:work:a1', 'Retry'], ['dispatch', 'todo:work:t1', 'Finish'], ['requestGrant', 'gmail_read', 'me-work'], ['connectVault', 'gmail_read']]);
});

test('with drafts allowed, each of them goes through to the runtime', async () => {
  const rt = fakeRt();
  const h = guarded(rt, { drafts: true });
  for (const action of DRAFT_ACTIONS) await h.dispatch('todo:work:t1', action, {});
  await h.requestGrant('gmail_draft', 'me-work');
  assert.equal(h.connectVault('gmail_draft', {}), true);
  assert.equal(h.registerDraftHandler('gmail.createDraft', () => {}), true);
  assert.deepEqual(rt.calls.map((c) => c.slice(0, 2).join(' ')), ['dispatch todo:work:t1', 'dispatch todo:work:t1', 'dispatch todo:work:t1', 'requestGrant gmail_draft', 'connectVault gmail_draft', 'handle gmail.createDraft']);
});

test('the digest reads what the machines recorded and the stored headers, formats them, and holds no body', async () => {
  assert.deepEqual(headersOf('From: Alice <alice@supplier.example.com>\nTo: Owner\nSubject: Invoice 4471\nDate: x\n\nbody'), { from: 'Alice <alice@supplier.example.com>', subject: 'Invoice 4471' });
  assert.deepEqual(headersOf(null), { from: '', subject: '' });
  const instances = { 'inbox.Message': ['msg:work:a1', 'msg:work:a2', 'msg:home:b1'], 'inbox.Todo': ['todo:work:t1', 'todo:work:t2'] };
  const states = {
    'msg:work:a1': { seen: 'Actionable', account: 'me-work', id: 'work/a1' }, 'msg:work:a2': { seen: 'Held', account: 'me-work', id: 'work/a2' }, 'msg:home:b1': { seen: 'Filed', account: 'me-home', id: 'home/b1' },
    'todo:work:t1': { status: 'Open', account: 'me-work', title: 'sha256:t1', due: 'ThisWeek', reply: true }, 'todo:work:t2': { status: 'Done', account: 'me-work', title: 'sha256:t2', due: 'Unstated', reply: false },
  };
  const rt = {
    store: { db: { prepare: () => ({ all: (machine) => (machine === undefined ? [{ intent_id: 'i1', instance_id: 'todo:work:t1' }, { intent_id: 'i2', instance_id: 'todo:work:t2' }] : instances[machine].map((instance_id) => ({ instance_id }))) }) } },
    escalationOf: async (intent) => (intent === 'i1' ? { hash: 'h' } : null),
    getState: async (id) => ({ state: states[id] }),
    contentBody: async (d) => ({ 'sha256:t1': 'Pay invoice 4471' })[d] ?? null,
  };
  const source = { resolve: async (id) => (id === 'work/a2' ? 'From: Bob <bob@example.com>\nSubject: Unclear request\n\nsecret body text' : null) };
  const accounts = [{ label: 'work', owner: 'me-work' }, { label: 'home', owner: 'me-home' }];
  const model = await readDigest(rt, { accounts, source, now: new Date('2026-10-11T12:00:00Z') });
  assert.deepEqual(model.accounts, { work: { messages: 2, actionable: 1, filed: 0, held: 1, pending: 0 }, home: { messages: 1, actionable: 0, filed: 1, held: 0, pending: 0 } });
  assert.deepEqual(model.todos, [{ id: 'todo:work:t1', label: 'work', status: 'Open', title: 'Pay invoice 4471', due: 'ThisWeek', reply: true }]);
  assert.deepEqual(model.held, [{ id: 'msg:work:a2', label: 'work', from: 'Bob <bob@example.com>', subject: 'Unclear request' }]);
  const text = formatDigest(model, { drafts: false });
  assert.match(text, /read-only: no draft is proposed/);
  assert.match(text, /work: 2 message\(s\): 1 to do, 0 filed, 1 held for you/);
  assert.match(text, /\[work\] Pay invoice 4471 \(due: ThisWeek\), a reply is wanted/);
  assert.match(text, /\[work\] Unclear request from Bob/);
  assert.deepEqual(model.approvals, [{ intent: 'i1', todo: 'todo:work:t1' }], 'only the escalated draft waits');
  assert.match(text, /Waiting for your approval[^\n]*\n {2}the draft of todo:work:t1: intent i1/);
  assert.ok(!text.includes('secret body text'), 'no body is printed');
  assert.match(formatDigest(model, { drafts: true }), /drafts are allowed/);
});

/** A build directory with a decision's manifest and a route, as poly admit writes them. */
function build(limits) {
  const dir = mkdtempSync(join(tmpdir(), 'poly-inbox-build-'));
  mkdirSync(join(dir, 'inbox.Message'), { recursive: true });
  mkdirSync(join(dir, 'inbox.Todo'), { recursive: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });
  const budget = (i, o) => ({ budget: 'monthly', maxInputTokens: i, maxTokens: o });
  writeFileSync(join(dir, 'inbox.Message', 'effects.manifest.json'), JSON.stringify({ effects: { 'decision.triage': { decision: { route: 'triage', result: ['ActNow', 'Fyi'] } }, 'source.mail.retrieve': {} } }));
  writeFileSync(join(dir, 'inbox.Todo', 'effects.manifest.json'), JSON.stringify({ effects: { 'decision.when': { decision: { result: ['Today', 'Later'], budget: budget(...limits.when) } }, 'decision.summary': { decision: { result: 'content', budget: budget(4000, 200) } } } }));
  writeFileSync(join(dir, 'routes', 'triage.json'), JSON.stringify({ tiers: [{ name: 'small', maxInputTokens: limits.tier[0], maxTokens: limits.tier[1] }, { name: 'large', maxInputTokens: limits.tier[0], maxTokens: limits.tier[1] }] }));
  return dir;
}

test('the program\'s limits must be sized for the asks the config says: a program set up for fewer is refused with the fix', () => {
  const ok = build({ when: [20000, 100], tier: [20000, 100] });
  const small = build({ when: [4000, 20], tier: [4000, 20] });
  try {
    assert.deepEqual(decisionResults(ok), { triage: ['ActNow', 'Fyi'], when: ['Today', 'Later'], summary: 'content' });
    assert.doesNotThrow(() => checkSizing(ok, decisionResults(ok), 5));
    assert.throws(() => checkSizing(small, decisionResults(small), 5), (e) => /not sized for 5 asks/.test(e.message) && /when \(4000 input, 20 output\)/.test(e.message) && /triage, small tier/.test(e.message) && /--samples 5/.test(e.message) && !/summary/.test(e.message));
    // The same small program is sized for fewer asks than 5, not for none: 3 asks of 20 output tokens are 6 each, below 8.
    assert.throws(() => checkSizing(small, decisionResults(small), 3), /not sized for 3 asks/);
  } finally { rmSync(ok, { recursive: true, force: true }); rmSync(small, { recursive: true, force: true }); }
});
