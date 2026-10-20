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
import { grantRequestSubject, invocationSubject, signRecord } from '@poly/core';
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
import { LaunchRefused } from './launch-refused.mjs';
import { createSpendMeter, formatSpend, meteredTransport, parseCap } from './spend.mjs';
import { operatorVerifier } from './resolve.mjs';
import { stubTransport } from './stub-model.mjs';
import { domainsOf, routesOf, watchFailures } from './failures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostModule = (f) => import(pathToFileURL(join(ROOT, 'examples', 'concierge', 'host', f)).href);
const STRIPE_PROFILE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
export const MERCHANT = 'merchant-1';
export const ACCOUNT = 'acct_demo';
export const STAFF_CHANNEL = 'C123ABC456';

export { LaunchRefused };

const secret = () => randomBytes(32).toString('hex');

/**
 * The model side of a live or stub launch (DF10, DF12): the price gate (live only), the cap, the key, the metered transport and the
 * live providers. The launcher's latency measurement uses it without the rest of the assembly.
 */
export function modelSide({ mode, source, now = () => Date.now(), apiKey = null, modelTransport = null, capUsd = null, meter: givenMeter = null, stubLatencyMs = 0, models = null, onCap = () => {}, onAuthFailure = () => {} }) {
  if (mode === 'live') {
    const gate = checkPrices(join(source, 'prices'), new Date(now()));
    if (!gate.ok) throw new LaunchRefused(`a live launch needs price tables read from the vendor's page: ${gate.tables.map((t) => `${t.file}: ${t.refusals.join('; ') || 'ok'}`).join(' | ')}`);
  }
  const cap = capUsd === null ? null : parseCap(capUsd);
  if (cap === null) throw new LaunchRefused('a live or stub launch needs a spend cap: --cap-usd <dollars>, at most 10');
  if (mode === 'live' && !apiKey) throw new LaunchRefused('a live launch needs the model key (the launcher reads it from the environment, once)');
  if (mode === 'live' && !modelTransport) throw new LaunchRefused('a live launch needs the model transport');
  const small = JSON.parse(readFileSync(join(source, 'prices', 'small.json'), 'utf8'));
  const large = JSON.parse(readFileSync(join(source, 'prices', 'large.json'), 'utf8'));
  const tables = { [small.model]: small, [large.model]: large };
  const meter = givenMeter ?? createSpendMeter({ capUsd: cap, tables, onCap });
  const transport = meteredTransport(mode === 'live' ? modelTransport : stubTransport({ latencyMs: stubLatencyMs }), meter);
  const names = { small: small.model, large: large.model };
  const providers = makeProviders({ transport, apiKey: mode === 'live' ? apiKey : 'stub-model', models: names, onAuthFailure, ...(models ?? {}) });
  return { providers, meter, models: names };
}

/**
 * Assembles the demo. Options:
 *   mode        'recorded' (the providers answer from a fixture of recorded answers), 'live' (the model providers, with a key) or
 *               'stub-model' (the live providers over the stub model: no key, no network, DF10)
 *   capUsd, meter   the spend cap in dollars (live and stub modes need it, DF10 item 5) and, for a test, a meter that replaces the real one
 *   onReply     called with { session } after each reply delivered to a guest (DF10 item 6)
 *   onFailure   called with a line for each failed decision and for a refused key (DF12 items 3 and 4); when given, the failures are watched
 *   stubLatencyMs   the stub model's latency (stub mode, DF12 item 2)
 *   workdir     a folder for the run's keys and project (the launcher gives a temporary one)
 *   now         the clock (default: the real one); a test gives its own
 *   answers     the recorded-answers fixture (recorded mode)
 *   apiKey, models, modelTransport   the live providers' key, model ids and transport (live mode); the key is used as a header, nowhere else
 *   size, ordersOf   the persona pool and, for a test, the orders each persona holds
 *   startWorkers     run the runtime's own workers (the launcher); a test settles by hand
 *   limits      overrides of the room's limits
 *   standInFault   the stand-in's fault script by name (DF22): 'none' (the default), 'lost-all' or 'down'; the show uses none
 */
export async function assembleDemo({
  mode = 'recorded', workdir, now = () => Date.now(), answers = null, apiKey = null, models = null, modelTransport = null,
  size = 40, ordersOf = null, standInFault = 'none', startWorkers = false, limits = {}, onKill = () => {}, onReply = () => {}, onFailure = null, stubLatencyMs = 0, capUsd = null, meter: givenMeter = null, source = join(ROOT, 'demo', 'concierge'),
}) {
  if (!workdir) throw new Error('the demo needs a folder for its run');
  mkdirSync(workdir, { recursive: true });
  let providers;
  let meter = null;
  let room = null;
  if (mode === 'live' || mode === 'stub-model') {
    // DF12 item 4: a refused key is a line, once per launch.
    let reported = false;
    const side = modelSide({
      mode, source, now, apiKey, modelTransport, capUsd, meter: givenMeter, stubLatencyMs, models,
      onCap: () => room?.kill('spend-cap'),
      onAuthFailure: (e) => { if (!reported) { reported = true; onFailure?.(`model key refused (HTTP ${e?.status ?? '?'}): set a fresh key and restart the launcher`); } },
    });
    providers = side.providers;
    meter = side.meter;
  } else {
    const { loadAnswers, recordedConcierge } = await hostModule('recorded.mjs');
    providers = recordedConcierge(loadAnswers(answers ?? join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json')));
  }

  const pool = createPersonaPool({ size, ordersOf });
  const personas = pool.all();
  const authority = createAuthority();
  const connect = { accessToken: mintDevelopmentToken(), account: ACCOUNT };
  const charges = personas.flatMap((p) => p.orders.map((o) => ({ id: o.charge, amount: o.paid, currency: 'usd' })));
  const standIn = await startStandIn({ authority, charges, connect, now, fault: standInFault });

  const admission = await admitDemoConcierge({ source, workdir });
  // DF21: the claims of Resolve come from a person's signed invocation record and from nothing else.
  const holder = (k) => ({ name: k.name, keyId: k.keyId, publicKey: k.publicKey });
  const verifier = operatorVerifier({ people: [holder(admission.person)], agents: [holder(admission.agent)] });
  const rt = await load(admission.build, { certificate: admission.certificate, trust: admission.trust, now, verifier });

  const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
  const sl = { signingSecret: secret(), botToken: `${['xo', 'xb'].join('')}-${secret()}`, teamId: 'T123ABC456' };
  const limiter = createLimiter({ now, ...limits });
  const staff = createStaffFeed({ now });
  const settle = async (passes = 40) => { for (let k = 0; k < passes; k++) { await rt.advance(); await rt.worker.tick(); } };
  let closed = false;
  room = createRoom({
    rt, wa, now, pool, limiter, onReply, capReached: () => meter?.capReached() ?? false,
    settle: async () => { if (!startWorkers) await settle(); },
    onKill: (by) => { rt.stopWorkers(); onKill(by); },
  });

  rt.connectChannel('support', whatsapp(wa), supportTransport(room));
  rt.connectChannel('staff', slack(sl), staffTransport(staff));
  rt.mapSenders('support', principalOf(pool));
  const db = ordersDb(personas, { now });
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
  // DF12 item 3: each failed decision is a line. The watcher reads the runtime's ledger.
  const watcher = onFailure ? watchFailures({ db: rt.store.db, context: { ...(() => { const text = readFileSync(join(source, 'concierge.poly'), 'utf8'); return { routes: routesOf(text), domains: domainsOf(text) }; })(), secrets: apiKey ? [apiKey] : [] }, onLine: onFailure }) : null;

  return {
    mode, meter, rt, room, pool, staff, standIn, admission, providers, db, settle, wa, limiter, connect,
    /** Tells the staff of each refund the gate escalated on the claimed personas' desks (host/notice.mjs). */
    async pumpStaff() {
      const desks = [];
      for (const p of pool.claimed()) desks.push(await rt.threadId('support', p.phone));
      return forwardEscalations(rt, { desks, notice, noticed });
    },
    /**
     * DF21: what the presenter's `status` prints: the room's statistics, the stand-in's report, the guests whose Desk has a refund of
     * Unknown outcome (DF19) and, with a meter, the spend line.
     */
    async status() {
      const unknown = [];
      for (const p of pool.claimed()) {
        const id = await rt.threadId('support', p.phone);
        let st = null;
        try { st = (await rt.getState(id)).state; } catch { st = null; }
        if (st?.refund === 'Unknown') unknown.push(p.id);
      }
      return { ...room.stats(), stripe: standIn.report(), unknown: unknown.sort(), ...(meter ? { spend: formatSpend(meter) } : {}) };
    },
    /** DF21: a person ends an Unknown refund of a guest's Desk: the presenter's signed invocation record, dispatched as Resolve. */
    async resolve(desk, outcome) {
      if (outcome !== 'done' && outcome !== 'not-done') throw new Error('resolve: the outcome is done or not-done');
      const persona = pool.claimed().find((p) => p.id === desk);
      const instance = persona ? await rt.threadId('support', persona.phone) : null;
      if (!instance || !(await rt.instances()).some((i) => i.id === instance)) throw new Error(`no desk for ${desk}`);
      const done = outcome === 'done';
      const actionId = `resolve-${randomBytes(6).toString('hex')}`;
      const at = new Date(now()).toISOString();
      const credentials = signRecord({ kind: 'invocation', subject: invocationSubject({ instance, action: 'Resolve', data: { done }, actionId }), by: admission.person.keyId, at }, admission.person.privateKeyPem);
      const r = await rt.dispatch(instance, 'Resolve', { done }, { credentials, actionId });
      if (r.stepKind !== 'accepted') throw new Error(`the Resolve step was refused: ${r.rejectReason ?? r.stepKind}`);
      return { resolved: true, desk, instance, outcome, by: admission.person.keyId, at };
    },
    /** The presenter's approval of an escalated intent: the person's signed record (PF9.6). */
    async approve(intentId) {
      const esc = await rt.escalationOf(intentId);
      // DF17 item 3: no escalation, nothing is signed, and the message says what to do.
      if (!esc) throw new Error(`no escalation was found for intent ${intentId}: copy the id from the staff panel`);
      const at = new Date(now()).toISOString();
      await rt.approve(signRecord({ kind: 'approval', subject: esc.hash, by: admission.person.keyId, at }, admission.person.privateKeyPem));
      return { approved: true, intent: intentId, by: admission.person.keyId, subject: esc.hash, at };
    },
    async close() {
      if (closed) return;
      closed = true;
      watcher?.stop();
      await rt.close();
      await standIn.close();
      authority.remove();
    },
  };
}
