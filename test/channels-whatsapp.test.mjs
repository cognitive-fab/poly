// AC15 and AC16 (plan section 6, M8 plan step 10) on the concierge. AC15: a free-form WhatsApp reply after the window
// has closed is refused, and the application receives Rejected("window-closed"); poly check's witness for a variant
// waits on a ruling (the conversation's timers as inputs of the generated configuration, PS15.5). AC16: after an
// opt-out no send to that number is reachable until an opt-in: the never statement is proved in the concierge, its
// seeded mutant gives a witness, and at run time sends are refused until START.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { SKIP, E13, concierge, thread, recorded, whatsappWebhook, smsWebhook, WA_FROM, SMS_FROM, accepted } from './concierge-helpers.mjs';

const DAY = 24 * 3_600_000;
const rejections = async (rt, app) => (await accepted(rt, app, 'SendRejected')).map((j) => j.data.reason);

// AC15's variant: the concierge on a std.channels.whatsapp whose Reply sends free-form whatever the window (its window
// check taken out), under the test-only std option. The generated configuration fires the window's timer (PS15.5), so
// poly check finds the reply after the window closed, with a witness through WindowExpired.
async function variant(name, opts = {}) {
  const dir = join(ROOT, '.poly', `test-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'concierge.poly'), CONCIERGE);
  const std = join(dir, 'std');
  cpSync(join(ROOT, 'std'), std, { recursive: true });
  const wa = readFileSync(join(std, 'channels', 'whatsapp.poly'), 'utf8');
  const at = wa.indexOf('  on Reply(body) {');
  writeFileSync(join(std, 'channels', 'whatsapp.poly'), wa.slice(0, at) + wa.slice(at).replace('if window is Closed {', 'if window is Open && window is Closed {'));
  return checkFile(join(dir, 'concierge.poly'), { root: dir, std, ...opts });
}
const configWitness = (r) => r.configurations.find((c) => c.configuration === 'support')?.diagnostics.find((d) => d.code === 'PL3002' && /free-form-outside-window/.test(d.message));

test('AC15, poly check: the concierge variant that sends a free-form reply after the window has closed gets a witness in its configuration', { timeout: 600_000 }, async () => {
  const f = configWitness(await variant('ac15-variant'));
  assert.ok(f && f.witness.length > 0, 'a witness in the support configuration');
  assert.ok(f.witness.trace.some((s) => s.action === 'WindowExpired'), 'through the window\'s timer');
});

test('AC15, seeded control: a generated configuration that offers no timer firing finds no reply after the window', { timeout: 600_000 }, async () => {
  assert.equal(configWitness(await variant('ac15-no-timers', { refFault: 'no-timer-firing' })), undefined);
});

test('AC15: with the clock past the window, the free-form reply is refused, and the application receives Rejected("window-closed"); nothing is sent', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, clock, cfg, sent, handle } = await concierge('ac15-window');
  try {
    const { app } = await thread(rt, 'support', 'Desk', WA_FROM);
    assert.equal((await handle('support', whatsappWebhook(cfg.wa, recorded('whatsapp/message.json')))).status, 200);
    // The customer service window closes 24 hours after the customer's message; the reply is taken after that.
    clock.advance(DAY + 60_000);
    await rt.advance();
    assert.deepEqual(await rejections(rt, app), ['window-closed']);
    assert.equal(sent.support.length, 0);
  } finally { await rt.close(); }
});

test('AC15, the real path: the first message creates the thread, and a reply after the window is refused, window-closed', { skip: SKIP, todo: E13, timeout: 300_000 }, async () => {
  const { rt, clock, cfg, sent, handle } = await concierge('ac15-real');
  try {
    await handle('support', whatsappWebhook(cfg.wa, recorded('whatsapp/message.json')));
    clock.advance(DAY + 60_000);
    await rt.advance();
    assert.deepEqual(await rejections(rt, await rt.threadId('support', WA_FROM)), ['window-closed']);
    assert.equal(sent.support.length, 0);
  } finally { await rt.close(); }
});

const CONCIERGE = readFileSync(join(ROOT, 'conformance', 'm8', 'concierge', 'concierge.poly'), 'utf8');

test('AC16, poly check: in the concierge, no send after an opt-out is reachable until an opt-in: the never is proved, and its seeded mutant gives a witness', { timeout: 600_000 }, async () => {
  const dir = join(ROOT, '.poly', 'test-ac16');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'concierge.poly'), CONCIERGE);
  const r = await checkFile(join(dir, 'concierge.poly'), { root: dir });
  assert.equal(r.verdict, 'CLEAN');
  const text = r.configurations.find((c) => c.configuration === 'text');
  // PS5.2a: tested, not vacuous, in every configuration of the concierge, the window's rule included (PS15.5).
  for (const c of r.configurations) assert.deepEqual(c.vacuous, [], c.configuration);
  assert.deepEqual(text.nevers.filter((x) => x.property === 'no-send-after-opt-out').map((x) => x.violated), [false]);
  // The mutant: std.channels.sms with its Reply's consent check taken out, under the test-only std option.
  const std = join(dir, 'std');
  cpSync(join(ROOT, 'std'), std, { recursive: true });
  const sms = readFileSync(join(std, 'channels', 'sms.poly'), 'utf8');
  const at = sms.indexOf('  on Reply(body) {');
  const mutated = sms.slice(0, at) + sms.slice(at).replace('if !consent {', 'if consent && !consent {');
  writeFileSync(join(std, 'channels', 'sms.poly'), mutated);
  const m = await checkFile(join(dir, 'concierge.poly'), { root: dir, std });
  const f = [...m.configurations.flatMap((c) => c.diagnostics), ...m.machines.flatMap((x) => x.diagnostics)].find((d) => d.code === 'PL3002' && /no-send-after-opt-out/.test(d.message));
  assert.ok(f && f.witness.length > 0, JSON.stringify(m.verdict));
});

test('AC16: after a STOP, replies to the number are refused, opted-out, and none is sent; after START they are sent again', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, sent, handle } = await concierge('ac16-stop');
  try {
    const { app } = await thread(rt, 'text', 'Texts', SMS_FROM);
    assert.equal((await handle('text', smsWebhook(cfg.tw, 'STOP', 'SMstop'))).status, 200);
    await rt.advance();
    assert.deepEqual(await rejections(rt, app), ['opted-out']);
    assert.equal(sent.text.length, 0);
    assert.equal((await handle('text', smsWebhook(cfg.tw, 'START', 'SMstart'))).status, 200);
    await rt.advance();
    assert.equal(sent.text.length, 1, 'the answer to START is sent');
    assert.equal(new URLSearchParams(sent.text[0].body).get('To'), SMS_FROM);
  } finally { await rt.close(); }
});

test('AC16, the real path: a first STOP creates the thread, and the reply to it is refused, opted-out', { skip: SKIP, todo: E13, timeout: 300_000 }, async () => {
  const { rt, cfg, sent, handle } = await concierge('ac16-real');
  try {
    await handle('text', smsWebhook(cfg.tw, 'STOP', 'SMstop'));
    await rt.advance();
    assert.deepEqual(await rejections(rt, await rt.threadId('text', SMS_FROM)), ['opted-out']);
    assert.equal(sent.text.length, 0);
  } finally { await rt.close(); }
});
