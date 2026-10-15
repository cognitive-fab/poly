// The demo, assembled (DF1 to DF8): the demo copy of the concierge admitted and loaded, its two network edges replaced and named
// (the customer channel by the room page, Stripe by the local stand-in), the model providers recorded or live, the development vault
// holding a synthetic token only the stand-in accepts, the room, and the presenter's staff feed. The same assembly is what the
// launcher runs and what the recorded run of the tests drives; only the clock and the providers differ.
//
// Nothing here reaches the outside: the support transport carries replies to the room, the staff transport to the presenter's
// feed, the vault's transport to the stand-in, and the model transport is the host's, given only to the live providers.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { grantRequestSubject, signRecord } from '@poly/core';
import { whatsapp, slack, postgresSource, oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { load } from '@poly/runtime';
import { createAuthority } from '../stand-in/stripe/tls.mjs';
import { startStandIn } from '../stand-in/stripe/server.mjs';
import { admitDemoConcierge } from './admission.mjs';
import { createPersonaPool } from './personas.mjs';
import { principalOf } from './verifier.mjs';
import { createLimiter } from './limits.mjs';
import { createRoom } from './room.mjs';
import { supportTransport, staffTransport } from './transport.mjs';
import { createStaffFeed } from './staff-feed.mjs';
import { ordersDb } from './orders-db.mjs';
import { developmentHttp, mintDevelopmentToken, memoryWrap } from './vault.mjs';
import { makeProviders } from './live-providers.mjs';
import { checkPrices } from './price-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostModule = (f) => import(pathToFileURL(join(ROOT, 'examples', 'concierge', 'host', f)).href);
const STRIPE_PROFILE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
export const MERCHANT = 'merchant-1';
export const ACCOUNT = 'acct_demo';
export const STAFF_CHANNEL = 'C123ABC456';

/** Why a live launch does not start. */
export class LaunchRefused extends Error {}

const secret = () => randomBytes(32).toString('hex');

/**
 * Assembles the demo. Options:
 *   mode        'recorded' (the providers answer from a fixture of recorded answers) or 'live' (the model providers, with a key)
 *   workdir     a folder for the run's keys and project (the launcher gives a temporary one)
 *   now         the clock (default: the real one); a test gives its own
 *   answers     the recorded-answers fixture (recorded mode)
 *   apiKey, models, modelTransport   the live providers' key, model ids and transport (live mode); the key is used as a header, nowhere else
 *   size, ordersOf   the persona pool and, for a test, the orders each persona holds
 *   startWorkers     run the runtime's own workers (the launcher); a test settles by hand
 *   limits      overrides of the room's limits
 */
export async function assembleDemo({
  mode = 'recorded', workdir, now = () => Date.now(), answers = null, apiKey = null, models = null, modelTransport = null,
  size = 40, ordersOf = null, startWorkers = false, limits = {}, onKill = () => {}, source = join(ROOT, 'demo', 'concierge'),
}) {
  if (!workdir) throw new Error('the demo needs a folder for its run');
  mkdirSync(workdir, { recursive: true });
  let providers;
  if (mode === 'live') {
    const gate = checkPrices(join(source, 'prices'), new Date(now()));
    if (!gate.ok) throw new LaunchRefused(`a live launch needs price tables read from the vendor's page: ${gate.tables.map((t) => `${t.file}: ${t.refusals.join('; ') || 'ok'}`).join(' | ')}`);
    if (!apiKey) throw new LaunchRefused('a live launch needs the model key (the launcher reads it from the environment, once)');
    if (!modelTransport) throw new LaunchRefused('a live launch needs the model transport');
    const small = JSON.parse(readFileSync(join(source, 'prices', 'small.json'), 'utf8')).model;
    const large = JSON.parse(readFileSync(join(source, 'prices', 'large.json'), 'utf8')).model;
    providers = makeProviders({ transport: modelTransport, apiKey, models: { small, large }, ...(models ?? {}) });
  } else {
    const { loadAnswers, recordedConcierge } = await hostModule('recorded.mjs');
    providers = recordedConcierge(loadAnswers(answers ?? join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json')));
  }

  const pool = createPersonaPool({ size, ordersOf });
  const personas = pool.all();
  const authority = createAuthority();
  const connect = { accessToken: mintDevelopmentToken(), account: ACCOUNT };
  const charges = personas.flatMap((p) => p.orders.map((o) => ({ id: o.charge, amount: o.paid, currency: 'usd' })));
  const standIn = await startStandIn({ authority, charges, connect, now });

  const admission = await admitDemoConcierge({ source, workdir });
  const verifier = (c) => (c ? { principal: c.principal } : null);
  const rt = await load(admission.build, { certificate: admission.certificate, trust: admission.trust, now, verifier });

  const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
  const sl = { signingSecret: secret(), botToken: `${['xo', 'xb'].join('')}-${secret()}`, teamId: 'T123ABC456' };
  const limiter = createLimiter({ now, ...limits });
  const staff = createStaffFeed({ now });
  const settle = async (passes = 40) => { for (let k = 0; k < passes; k++) { await rt.advance(); await rt.worker.tick(); } };
  let closed = false;
  const room = createRoom({
    rt, wa, now, pool, limiter,
    settle: async () => { if (!startWorkers) await settle(); },
    onKill: (by) => { rt.stopWorkers(); onKill(by); },
  });

  rt.connectChannel('support', whatsapp(wa), supportTransport(room));
  rt.connectChannel('staff', slack(sl), staffTransport(staff));
  rt.mapSenders('support', principalOf(pool));
  const db = ordersDb(personas);
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', keys: { charge: 'charge_id' } }));
  const { provideRecorded } = await hostModule('recorded.mjs');
  provideRecorded(rt, providers);
  const { refund } = await hostModule('refund.mjs');
  const h = rt.handlerExports('src/handlers.ts');
  h.setScript(refund);
  rt.handle('payments.refund', h.handle);

  // The merchant's Stripe Connect grant, through the development vault: the vault's secret is the synthetic token only the stand-in
  // accepts, its transport reaches the stand-in alone, and a person's signed grant request fixes its holder (S457).
  const vault = oauthVault(STRIPE_PROFILE, { clientId: 'ca_demo', redirectUri: 'https://concierge.demo/credentials/payments', clientSecret: connect.accessToken }, kmsStore(memoryWrap()), { http: developmentHttp(standIn) });
  rt.connectVault('payments', vault);
  const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
  const approvals = join(workdir, 'approvals');
  mkdirSync(approvals, { recursive: true });
  const request = signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', MERCHANT), by: admission.person.keyId, at: new Date(now()).toISOString() }, admission.person.privateKeyPem);
  writeFileSync(join(approvals, '00-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: MERCHANT, record: request }));
  const applied = (await rt.takeApprovals(approvals)).map((x) => x.outcome);
  if (applied.join() !== 'applied') throw new Error(`the merchant's grant request was not applied: ${applied.join()}`);
  const url = rt.takeAuthorizations().find((x) => x.credential === 'payments').url;
  const done = await callback('payments', { method: 'GET', url: `https://concierge.demo/credentials/payments?code=ac_${secret().slice(0, 24)}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' });
  if (done.status !== 200) throw new Error(`the merchant's grant was not completed: ${done.status}`);

  // The staff's thread: the host opens it with one signed Slack message, as a staff member saying good morning would.
  const ts = String(Math.floor(now() / 1000));
  const openBody = JSON.stringify({ token: 'demo', team_id: sl.teamId, api_app_id: 'A123ABC456', type: 'event_callback', event_id: 'Ev-demo-open', event_time: Number(ts),
    event: { type: 'message', channel: STAFF_CHANNEL, user: 'U123ABC456', text: 'The concierge is on.', ts: `${ts}.000001`, event_ts: `${ts}.000001`, channel_type: 'channel' } });
  await rt.receive('staff', { method: 'POST', url: 'https://room.invalid/channels/staff', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', sl.signingSecret).update(`v0:${ts}:${openBody}`).digest('hex')}` }, body: openBody });
  await settle();
  const notice = await rt.threadId('staff', STAFF_CHANNEL);

  const { forwardEscalations } = await hostModule('notice.mjs');
  const noticed = new Set();
  if (startWorkers) rt.startWorkers();

  return {
    mode, rt, room, pool, staff, standIn, admission, providers, db, settle, wa, limiter, connect,
    /** Tells the staff of each refund the gate escalated on the claimed personas' desks (host/notice.mjs). */
    async pumpStaff() {
      const desks = [];
      for (const p of pool.claimed()) desks.push(await rt.threadId('support', p.phone));
      return forwardEscalations(rt, { desks, notice, noticed });
    },
    /** The presenter's approval of an escalated intent: the person's signed record (PF9.6). */
    async approve(intentId) {
      const esc = await rt.escalationOf(intentId);
      return rt.approve(signRecord({ kind: 'approval', subject: esc?.hash ?? 'none', by: admission.person.keyId, at: new Date(now()).toISOString() }, admission.person.privateKeyPem));
    },
    async close() {
      if (closed) return;
      closed = true;
      await rt.close();
      await standIn.close();
      authority.remove();
    },
  };
}
