// plan-ex.md E1: the concierge's host code that does not wait for S450, S456 or S457. The recorded providers answer each
// decision from test/fixtures/concierge/answers.json by the message the decision's materials hold, and place each
// answer on the side of a threshold the program, its route or its policy names. The escalation forwarder tells staff of
// each escalated refund once, by intent, and nothing of the customer. The end-to-end tests (AC15, AC18, AC22, AC27,
// AC30) come with the module, once it checks CLEAN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { calibrate } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const HOST = join(ROOT, 'examples', 'concierge', 'host');
const { loadAnswers, recordedConcierge, provideRecorded } = await import(pathToFileURL(join(HOST, 'recorded.mjs')).href);
const { forwardEscalations, noticeText } = await import(pathToFileURL(join(HOST, 'notice.mjs')).href);
const FIXTURE = loadAnswers(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
const MAPS = Object.fromEntries(['small', 'large'].map((t) => [t, JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'm11', 'maps', `${t === 'small' ? 'flash' : 'opus'}.json`), 'utf8'))]));
const msg = (id) => FIXTURE.messages.find((m) => m.id === id);
const materials = (id) => ({ bodies: { body: msg(id).text }, items: {} });

test('E1: each tier answers a message from its recording, on the side of the route\'s threshold the fixture names', () => {
  const r = recordedConcierge(FIXTURE);
  const conf = (tier, id) => calibrate(MAPS[tier], r.tiers[tier]({ decision: 'classify', tier, payload: {} }, materials(id)).distribution[0][1]);
  // escalate when conf < 0.8: 800 thousandths on the calibrated scale.
  assert.ok(conf('small', 'status') >= 800);
  assert.ok(conf('small', 'refund-small') < 800 && conf('large', 'refund-small') >= 800);
  assert.ok(conf('small', 'unsure') < 800 && conf('large', 'unsure') < 800, 'the route is exhausted');
  assert.equal(r.tiers.small({ decision: 'classify', tier: 'small' }, materials('injection')).answer, 'Refund');
  assert.throws(() => r.tiers.large({ decision: 'classify', tier: 'large' }, materials('status')), /no recorded large answer/);
  assert.throws(() => r.tiers.small({ decision: 'classify', tier: 'small' }, { bodies: { body: 'a message nobody recorded' }, items: {} }), /no recorded answer/);
  assert.ok(r.asked.every((a) => !('text' in a)), 'what was asked is kept by message id, never by its text');
});

test('E1, AC30: the amount decision\'s recordings hold one answer outside { value: 0..500 } and one below the program\'s 0.8', () => {
  const r = recordedConcierge(FIXTURE);
  const a = (id) => r.decisions.amount.provider({ decision: 'amount', payload: {} }, materials(id));
  assert.deepEqual(a('refund-small').answer, { value: 40 });
  assert.ok(a('refund-large').answer.value > 100, 'above the policy\'s limit');
  assert.ok(a('refund-outside').answer.value > 500, 'outside the strict domain, refused at dispatch');
  assert.ok(a('vague-amount').distribution[0][1] < 0.8, 'unsure, so no refund is proposed');
  const values = FIXTURE.messages.filter((m) => m.amount).map((m) => m.amount.answer.value);
  assert.ok(values.filter((v) => v < 0 || v > 500).length === 1, 'exactly one recorded amount is outside the domain');
});

test('E1: the reply decision answers each message and outcome the program can ask, and the providers register by name', () => {
  const r = recordedConcierge(FIXTURE);
  assert.match(r.decisions.reply.provider({ decision: 'reply', payload: { outcome: 'Refunded' } }, materials('refund-small')).answer, /40 euros/);
  assert.throws(() => r.decisions.reply.provider({ decision: 'reply', payload: { outcome: 'Refunded' } }, materials('status')), /no recorded Refunded reply/);
  for (const m of FIXTURE.messages) assert.ok(Object.keys(m.replies).length >= 1, m.id);
  const seen = { tiers: [], decisions: [] };
  provideRecorded({ provideTier: (n) => seen.tiers.push(n), provide: (d, c) => seen.decisions.push([d, c.model]) }, r);
  assert.deepEqual(seen.tiers, ['small', 'large']);
  assert.deepEqual(seen.decisions, [['amount', 'flash-2026-09'], ['reply', 'flash-2026-09']]);
});

/** A runtime that holds two Desk journals and one Notice, and refuses a Notify while the previous one is in flight. */
function fakeRuntime() {
  const chains = {
    d1: [{ kind: 'verdict', body: { outcome: 'allowed', effectKind: 'payments.refund', intent: 'i-1' } }, { kind: 'verdict', body: { outcome: 'escalated', effectKind: 'payments.refund', intent: 'i-2' } }],
    d2: [{ kind: 'verdict', body: { outcome: 'escalated', effectKind: 'decision.reply', intent: 'i-3' } }, { kind: 'verdict', body: { outcome: 'escalated', effectKind: 'payments.refund', intent: 'i-4' } }],
  };
  const bodies = [];
  const notified = [];
  let inflight = false;
  return {
    bodies, notified,
    settle() { inflight = false; },
    async chain(id) { return chains[id] ?? []; },
    async putContent(b) { bodies.push(b); return `sha256:${bodies.length}`; },
    async dispatch(id, action, data) {
      if (inflight) return { stepKind: 'rejected', rejectReason: 'busy' };
      inflight = true;
      notified.push([id, action, data.text]);
      return { stepKind: 'accepted' };
    },
  };
}

test('E1: the host tells staff of each escalated refund once, by intent and with nothing of the customer, and retries a busy one', async () => {
  const rt = fakeRuntime();
  const noticed = new Set();
  assert.deepEqual(await forwardEscalations(rt, { desks: ['d1', 'd2'], notice: 'staff:n', noticed }), ['i-2']);
  // The Notice still has i-2 in flight, so i-4 waits.
  rt.settle();
  assert.deepEqual(await forwardEscalations(rt, { desks: ['d1', 'd2'], notice: 'staff:n', noticed }), ['i-4']);
  rt.settle();
  assert.deepEqual(await forwardEscalations(rt, { desks: ['d1', 'd2'], notice: 'staff:n', noticed }), []);
  assert.deepEqual(rt.notified.map(([id, a]) => [id, a]), [['staff:n', 'Notify'], ['staff:n', 'Notify']]);
  // A body stored for a refused Notify is stored again on the retry: the same bytes, so the same Content (PS1.4a).
  assert.deepEqual([...new Set(rt.bodies)], [noticeText('i-2'), noticeText('i-4')]);
  // An escalated reply is not a refund, and an allowed refund needs no person.
  assert.ok(!rt.bodies.some((b) => b.includes('i-1') || b.includes('i-3')));
  for (const b of rt.bodies) for (const m of FIXTURE.messages) assert.ok(!b.includes(m.text) && !b.includes(m.from));
  assert.match(noticeText('i-9'), /approves nothing/);
});
