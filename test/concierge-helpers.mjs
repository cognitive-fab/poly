// M8 plan step 10: the concierge of AC14 to AC17 (conformance/m8/concierge), admitted, loaded and driven through
// ingress with recorded provider traffic. Until E13 is vendored a conversation cannot be spawned at run time, so
// `thread` creates it beside its application, as the spawn of starts would (PS15.2); each AC's real path through
// rt.inbound on an unknown thread is its own test, todo for E13.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { polyaxionPeer } from '@poly/runtime';
import { whatsapp, sms, slack, ingress, twilioSignature } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

export const SOURCES = ['conformance/m8/concierge/concierge.poly', 'conformance/m8/concierge/concierge.policy.poly'];
const peer = polyaxionPeer();
/** The concierge has a policy, so it runs only with the pinned gate engine; without it each test is listed as not run. */
export const SKIP = peer.ok ? false : `not run: ${peer.reason}`;
export const E13 = 'waiting on E13 (polyrun createInstance): rt.inbound on an unknown thread cannot spawn the conversation';

const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic');
export const recorded = (p) => readFileSync(join(TRAFFIC, p), 'utf8').trim();
const secret = () => randomBytes(32).toString('hex');

/** Admits and loads the concierge, with its three channels connected to recorded transports. */
// One admission per test file: checking the concierge explores its three configurations, which takes a while; each
// test loads the same build with a store of its own.
let once = null;
export async function concierge(name) {
  once ??= admitted(`concierge-${process.pid}`, SOURCES);
  const a = await once;
  const { rt, clock } = await loaded(a);
  const cfg = {
    wa: { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' },
    tw: { accountSid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', authToken: secret(), from: '+15557122661' },
    sl: { signingSecret: secret(), botToken: `xoxb-${secret()}`, teamId: 'T123ABC456' },
  };
  const sent = { support: [], text: [], staff: [] };
  const answering = (list, response) => ({ http: { async request(r) { list.push(r); return response(); } } });
  rt.connectChannel('support', whatsapp(cfg.wa), answering(sent.support, () => ({ status: 200, headers: {}, body: recorded('whatsapp/send-response.json') })));
  rt.connectChannel('text', sms(cfg.tw), answering(sent.text, () => ({ status: 201, headers: {}, body: recorded('twilio/send-response.json') })));
  rt.connectChannel('staff', slack(cfg.sl), answering(sent.staff, () => ({ status: 200, headers: {}, body: recorded('slack/post-ok.json') })));
  const handle = ingress(rt, { support: whatsapp(cfg.wa), text: sms(cfg.tw), staff: slack(cfg.sl) }, () => clock.now());
  return { a, rt, clock, cfg, sent, handle };
}

/** As the spawn of starts would: the application at `<channel>:<key>`, its conversation at `<channel>:<key>/<channel>`. */
export async function thread(rt, channel, machine, key) {
  const app = `${channel}:${key}`;
  await rt.create(`concierge.${machine}`, { id: app });
  await rt.create(`concierge.${channel}.Conversation`, { id: `${app}/${channel}`, creation: { action: 'Open', data: { app } } });
  return { app, conv: `${app}/${channel}` };
}

const URL_OF = (c) => `https://hooks.example.com/channels/${c}`;
export const whatsappWebhook = (cfg, body) => ({ method: 'POST', url: URL_OF('support'), headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', cfg.appSecret).update(body).digest('hex')}` }, body });
export const smsWebhook = (cfg, text, sid = 'SM1f0e8ae6ade43cb3c0ce4525424e404f') => {
  const body = recorded('twilio/inbound.form').replace(/SM1f0e8ae6ade43cb3c0ce4525424e404f/g, sid).replace('Body=Where+is+my+order%3F', `Body=${encodeURIComponent(text)}`);
  return { method: 'POST', url: URL_OF('text'), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(cfg.authToken, URL_OF('text'), body) }, body };
};
export const slackWebhook = (cfg, body, now) => {
  const ts = String(Math.floor(now / 1000));
  return { method: 'POST', url: URL_OF('staff'), headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', cfg.signingSecret).update(`v0:${ts}:${body}`).digest('hex')}` }, body };
};
export const WA_FROM = '16505551234';
export const SMS_FROM = '+15558675310';
export const accepted = async (rt, id, action) => (await rt.getJournal(id)).filter((j) => j.action === action && j.step_kind === 'accepted');
