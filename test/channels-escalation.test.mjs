// AC17 (plan section 6, M8 plan step 10) on the concierge: its policy escalates a free-form WhatsApp reply to an
// external recipient; the reply is sent only after an approval signed with a person key, and a recorded Slack reply
// to the escalation notice approves nothing. The concierge itself is checked: CLEAN, every never proved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { approveAs } from './runtime-helpers.mjs';
import { SKIP, E13, concierge, thread, recorded, whatsappWebhook, slackWebhook, WA_FROM } from './concierge-helpers.mjs';

const escalated = async (rt, conv) => (await rt.chain(conv)).filter((e) => e.kind === 'verdict' && e.body.outcome === 'escalated').map((e) => e.body);
const intentOf = (rt, conv) => rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'channel.support.send'").get(conv)?.intent_id;

test('AC17: a free-form reply to an external recipient is escalated by the policy and sent only after an approval signed with a person key', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, sent, handle } = await concierge('ac17-approve');
  try {
    const { conv } = await thread(rt, 'support', 'Desk', WA_FROM);
    await handle('support', whatsappWebhook(cfg.wa, recorded('whatsapp/message.json')));
    await rt.advance();
    assert.equal((await escalated(rt, conv)).length, 1, 'the reply is escalated');
    assert.equal(sent.support.length, 0, 'and not sent');
    await approveAs(rt, intentOf(rt, conv));
    await rt.advance();
    assert.equal(sent.support.length, 1, 'the approved reply is sent once');
    assert.equal(JSON.parse(sent.support[0].body).type, 'text');
  } finally { await rt.close(); }
});

test('AC17: a recorded Slack reply to the escalation notice does not approve it', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, clock, cfg, sent, handle } = await concierge('ac17-slack');
  try {
    const { conv } = await thread(rt, 'support', 'Desk', WA_FROM);
    await thread(rt, 'staff', 'Staff', 'C123ABC456');
    await handle('support', whatsappWebhook(cfg.wa, recorded('whatsapp/message.json')));
    await rt.advance();
    const body = recorded('slack/message.json').replace('Can someone look at ticket 42?', 'approve');
    assert.equal((await handle('staff', slackWebhook(cfg.sl, body, clock.now()))).status, 200);
    await rt.advance();
    assert.equal(sent.support.length, 0, 'the WhatsApp reply is still held');
    assert.equal((await escalated(rt, conv)).length, 1);
    assert.equal((await rt.chain(conv)).filter((e) => e.kind === 'verdict' && e.body.outcome === 'approved').length, 0);
  } finally { await rt.close(); }
});

test('AC17, the real path: a first WhatsApp message creates the thread, and its reply waits for a person', { skip: SKIP, todo: E13, timeout: 300_000 }, async () => {
  const { rt, cfg, sent, handle } = await concierge('ac17-real');
  try {
    await handle('support', whatsappWebhook(cfg.wa, recorded('whatsapp/message.json')));
    await rt.advance();
    assert.equal((await escalated(rt, `support:${WA_FROM}/support`)).length, 1);
    assert.equal(sent.support.length, 0);
  } finally { await rt.close(); }
});

test('the concierge: poly check is CLEAN with the channel surface only, every never of its conversations proved in its configurations', { timeout: 600_000 }, async () => {
  const src = readFileSync(join(ROOT, 'conformance', 'm8', 'concierge', 'concierge.poly'), 'utf8');
  assert.doesNotMatch(src, /^use |std\.channels/m, 'the channel surface only');
  const dir = join(ROOT, '.poly', 'test-concierge');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'concierge.poly'), src);
  const r = await checkFile(join(dir, 'concierge.poly'), { root: dir });
  assert.equal(r.verdict, 'CLEAN');
  assert.deepEqual(r.configurations.map((c) => c.configuration).sort(), ['staff', 'support', 'text']);
  for (const c of r.configurations) {
    assert.equal(c.verdict, 'CLEAN', c.configuration);
    assert.ok(c.nevers.length > 0 && c.nevers.every((x) => !x.violated), c.configuration);
  }
  for (const m of r.machines) assert.ok(m.stages.every((s) => s.status === 'ran' && s.verdict === 'CLEAN'), m.machine);
});
