// The M8b review, part D: the runtime and admission side of channels. Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError } from '@poly/check';
import { sms } from '@poly/io';
import { SKIP, concierge, thread, recorded, smsWebhook, SMS_FROM, accepted } from './concierge-helpers.mjs';
import { hasPolicies, makeKey, project, signPolicies } from './runtime-helpers.mjs';

const settle = async (rt) => { for (let i = 0; i < 8; i++) await rt.advance(); };

test('D-F1: a certified adapter cannot be changed after it is made', () => {
  const a = sms({ accountSid: 'AC', authToken: 't', from: '+1' });
  assert.ok(Object.isFrozen(a));
  assert.throws(() => { a.send = async () => ({ ok: true, providerId: 'x' }); }, TypeError);
  assert.throws(() => { a.kind = 'whatsapp'; }, TypeError);
});

test('D-F2, D-F3: the certified adapter package is not a public field, and rt.handle refuses a channel\'s send kind', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt } = await concierge('d2');
  try {
    assert.equal(rt.ioPackage, undefined, 'no public ioPackage');
    rt.ioPackage = { madeHere: () => true };
    const lookalike = { kind: 'sms', provider: 'twilio', sender: '+15550000009', verify: () => ({ refused: 'x' }), send: async () => ({ ok: true, providerId: 'x' }) };
    assert.throws(() => rt.connectChannel('text', lookalike, {}), /PL6408/);
    // Nor can a look-alike verify a webhook for rt.receive (D-F4), whose claims a step would carry.
    const claims = { verify: () => ({ messages: [{ providerMessageId: 'x', fields: { from: SMS_FROM, keyword: 'Plain' }, body: 'hi', claims: { verified: true, sender: SMS_FROM } }], receipts: [] }) };
    await assert.rejects(rt.receive('text', { method: 'POST', url: 'https://h.example.com/c', headers: {}, body: '' }, { ...lookalike, ...claims }), /PL6408/);
    const h = rt.handlerExports('src/handlers.ts');
    assert.throws(() => rt.handle('channel.text.send', h.handle), /connectChannel/);
  } finally { await rt.close(); }
});

test('D-F4: rt.inbound takes no claims from its caller: claims come only from a certified adapter\'s verify, through rt.receive', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('d4');
  try {
    const { conv } = await thread(rt, 'text', 'Texts', SMS_FROM);
    const r = await rt.inbound('text', { from: SMS_FROM, body: await rt.putContent('hi'), keyword: 'Plain' }, { messageId: 'm-1', claims: { verified: true, sender: SMS_FROM } });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'claims-unverified']);
    assert.deepEqual(await accepted(rt, conv, 'Inbound'), []);
    // Through the adapter, the same message carries the adapter's claim: an SMS sender is Unverified.
    assert.equal((await handle('text', smsWebhook(cfg.tw, 'hi'))).status, 200);
    assert.deepEqual((await accepted(rt, conv, 'Inbound')).map((j) => j.data.$claims), [{ verified: 'Unverified' }]);
  } finally { await rt.close(); }
});

test('D-F5: the read-back catches a swapped adapter kind, a left-out adapter binding and a wrong policy engine', { skip: SKIP, timeout: 600_000 }, async () => {
  for (const [fault, sources] of [['swap-adapter-kind', ['test/fixtures/m9/text-desk.poly']], ['omit-adapters', ['test/fixtures/m9/text-desk.poly']], ['wrong-policy-engine', ['test/fixtures/m9/text-desk.poly', 'test/fixtures/m9/text-desk.policy.poly']]]) {
    const key = makeKey(`d5-${fault}`);
    const dir = project(`d5-${fault}`, sources, key, 'test-review-m8b-d');
    if (hasPolicies(sources)) await signPolicies(dir);
    await assert.rejects(admit(dir, { fault }), (e) => e instanceof AdmitError && /read-back/.test(e.message), fault);
  }
});

test('D-F6: a nonce is kept until its provider timestamp leaves the window, so a replay at any clock skew is refused', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt } = await concierge('d6');
  try {
    const t0 = 1_790_000_000_000;
    // A token whose signature is acceptable until t0 + 500 s (the provider's clock ahead of ours).
    assert.equal(await rt.claimNonce('text', 'tok', t0 + 500_000, t0), true);
    assert.equal(await rt.claimNonce('text', 'other', t0 + 900_000, t0 + 310_000), true, 'a later claim prunes only what has expired');
    assert.equal(await rt.claimNonce('text', 'tok', t0 + 500_000, t0 + 310_000), false, 'the replay is refused');
    assert.equal(await rt.claimNonce('text', 'tok', t0 + 500_000, t0 + 501_000), true, 'once its window has passed it is forgotten');
  } finally { await rt.close(); }
});

test('D-F7: an inbound message outside the Inbound type is refused on runtime:ingress, not thrown', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt } = await concierge('d7');
  try {
    await thread(rt, 'text', 'Texts', SMS_FROM);
    const r = await rt.inbound('text', { from: SMS_FROM, body: await rt.putContent('hi'), keyword: 'Shout' }, { messageId: 'm-7' });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'outside-type']);
    const records = (await rt.chain('runtime:ingress')).map((e) => e.body).filter((b) => b.stage === 'inbound');
    assert.deepEqual(records.map((b) => [b.outcome, b.reason]), [['refused', 'outside-type']]);
  } finally { await rt.close(); }
});

test('D-F8: an author\'s effect of kind channel.<c>.send is PL1208, so only a channel\'s conversation sends on it', { timeout: 300_000 }, async () => {
  const src = readFileSync(join(process.cwd(), 'conformance', 'm8', 'concierge', 'concierge.poly'), 'utf8')
    .replace('  on Got(body) {\n    emit support.reply(body: body)\n  }', '  on Got(body) {\n    emit post(body: body)\n    emit support.reply(body: body)\n  }\n  effect post(body: Content) {\n    kind "channel.support.send"\n  }');
  const key = makeKey('d8');
  const dir = project('d8', [], key, 'test-review-m8b-d');
  writeFileSync(join(dir, 'src', 'concierge.poly'), src);
  await assert.rejects(admit(dir, {}), (e) => /not admitted/.test(e.message));
  const { checkFile } = await import('@poly/check');
  const r = await checkFile(join(dir, 'src', 'concierge.poly'), { root: dir });
  assert.ok([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].some((d) => d.code === 'PL1208' && /channel\./.test(d.message)));
});

test('D-F9: a provider event that happens twice is taken twice: a second opt-out reported by Twilio after an opt-in stops the next reply', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('d9');
  try {
    const { conv } = await thread(rt, 'text', 'Texts', SMS_FROM);
    const attempts = [];
    rt.connectChannel('text', sms(cfg.tw), { http: { async request(q) { attempts.push(q); return { status: 400, headers: {}, body: recorded('twilio/error-21610.json') }; } } });
    await handle('text', smsWebhook(cfg.tw, 'Where is my order?', 'SM00000000000000000000000000000001'));
    await settle(rt);
    await handle('text', smsWebhook(cfg.tw, 'START', 'SM00000000000000000000000000000002'));
    await settle(rt);
    const reported = (await accepted(rt, conv, 'Inbound')).filter((j) => j.data.keyword === 'Reported');
    assert.equal(reported.length, 2, 'both opt-outs Twilio reported are taken');
    await handle('text', smsWebhook(cfg.tw, 'Hello again', 'SM00000000000000000000000000000003'));
    await settle(rt);
    assert.equal(attempts.length, 2, 'the reply after the second opt-out is refused, not sent');
  } finally { await rt.close(); }
});
