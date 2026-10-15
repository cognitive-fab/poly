// The replay driver of DB6 (DAC8): it drives a build of the baseline against the stand-in and reports the five numbers.
//
//   1. The stand-in checks itself first (selfCheck): one key with the same parameters twice must give one refund, one key with other
//      parameters an error. A stand-in that fails is not a control, and no build is touched (the report says so).
//   2. The control: the build handles one ordinary refund request, no fault. One POST and one refund object, or the build "could not
//      be driven" (O3) and the fault is never applied.
//   3. The fault: the same request against a fresh process of the build, with the fault script (the first POST /v1/refunds applied and
//      its answer lost). The stand-in's five numbers are the result, and classify() reads them as O1 or O2.
//   4. The build's own tests, run unmodified and reported as they are (O4).
//
// The build is never edited. It believes it talks to api.stripe.com and graph.facebook.com: outside a container the names are mapped
// by map-hosts.cjs, which also refuses every destination that is not the loopback; inside one, by the container (container/).
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthority } from '../stand-in/stripe/tls.mjs';
import { startStandIn } from '../stand-in/stripe/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORDERS = join(HERE, '..', 'baseline', 'orders.json');
const MAP = join(HERE, 'map-hosts.cjs');

/** The one synthetic request every build is driven with (demo/PROVENANCE.md): a customer asks for 40.00 of a 100.00 order. */
export const REQUEST = { order: 'ORD-1001', amount: 4000, text: 'Hello, I\'d like a refund of 40.00 for order ORD-1001 (the blender arrived broken).' };
/** Placeholder values for the settings a build may expect; none of them is a secret, and the stand-in accepts anything. */
export const SYNTHETIC_ENV = {
  STRIPE_API_KEY: 'sk_test_standin_synthetic', STRIPE_SECRET_KEY: 'sk_test_standin_synthetic', STRIPE_KEY: 'sk_test_standin_synthetic',
  WHATSAPP_TOKEN: 'standin-synthetic', WHATSAPP_ACCESS_TOKEN: 'standin-synthetic', WHATSAPP_VERIFY_TOKEN: 'standin-synthetic',
  WHATSAPP_APP_SECRET: 'standin-synthetic', WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
};

export class StandInInvalid extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chargesOf(orders) {
  return orders.map((o) => ({ id: o.charge, amount: o.total, currency: o.currency ?? 'usd' }));
}

/** The WhatsApp Cloud API webhook for one text message, signed with the synthetic app secret as the Cloud API signs. */
export function webhook(order, text, secret = SYNTHETIC_ENV.WHATSAPP_APP_SECRET) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-DEMO-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550100000', phone_number_id: SYNTHETIC_ENV.WHATSAPP_PHONE_NUMBER_ID },
      contacts: [{ profile: { name: order.name }, wa_id: order.customer }],
      messages: [{ from: order.customer, id: 'wamid.DEMO.1', timestamp: '1790000000', type: 'text', text: { body: text } }],
    } }] }],
  });
  return { body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } };
}

function request({ port, ca, host, method, path, headers = {}, body }) {
  return new Promise((resolveRequest, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path, ca, servername: host, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The stand-in checks its own key behaviour against a scratch charge (DAC9). Throws StandInInvalid, naming what failed. */
export async function selfCheck(standIn, authority, orders) {
  const scratch = [{ id: 'ch_selfcheck', amount: 1000, currency: 'usd' }];
  standIn.reset({ charges: scratch, fault: 'none' });
  const post = (key, amount) => request({ port: standIn.port, ca: authority.ca, host: 'api.stripe.com', method: 'POST', path: '/v1/refunds',
    headers: { authorization: 'Bearer selfcheck', 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': key }, body: `charge=ch_selfcheck&amount=${amount}` });
  const first = await post('selfcheck-1', 100);
  const again = await post('selfcheck-1', 100);
  const other = await post('selfcheck-1', 200);
  const refunds = standIn.report().refunds;
  const fail = (why) => { throw new StandInInvalid(`the stand-in fails its own check: ${why}`); };
  if (first.status !== 200) fail(`a first request with a new key gave ${first.status}`);
  if (refunds !== 1) fail(`the same key with the same parameters twice made ${refunds} refunds, not 1`);
  if (JSON.parse(again.body).id !== JSON.parse(first.body).id || again.headers['idempotent-replayed'] !== 'true') fail('the repeated key did not return the first response');
  if (other.status !== 400 || JSON.parse(other.body).error?.type !== 'idempotency_error') fail('the same key with other parameters was not an idempotency_error');
  standIn.reset({ charges: chargesOf(orders), fault: 'none' });
}

const freePort = () => new Promise((resolvePort, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolvePort(port)); });
});

function tcpOpen(port) {
  return new Promise((resolveOpen) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolveOpen(true); });
    s.once('error', () => resolveOpen(false));
  });
}

/** Starts the build's command in its directory, with the stand-in's names mapped and its authority trusted. */
function startBuild({ build, start, port, standInPort, authority, mapNames, extraEnv }) {
  const env = { ...process.env, ...SYNTHETIC_ENV, PORT: String(port), NODE_EXTRA_CA_CERTS: authority.caPath, ...extraEnv };
  if (mapNames) {
    env.POLY_DEMO_STANDIN_PORT = String(standInPort);
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(MAP.replace(/\\/g, '/'))}`.trim();
  }
  const child = spawn(start, { cwd: build, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let exited = null;
  const keep = (c) => { output = (output + c.toString('utf8')).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  return {
    output: () => output,
    exited: () => exited,
    async listening(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (exited) return false;
        if (await tcpOpen(port)) return true;
        await sleep(100);
      }
      return false;
    },
    stop() {
      if (exited) return;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    },
  };
}

async function sendWebhook({ port, path, order, text }) {
  const w = webhook(order, text);
  return new Promise((resolveSend) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...w.headers, 'content-length': Buffer.byteLength(w.body) } }, (res) => {
      res.resume();
      res.on('end', () => resolveSend({ status: res.statusCode }));
    });
    req.on('error', (e) => resolveSend({ error: e.message }));
    req.end(w.body);
  });
}

/** Waits until the stand-in has seen requests and then none for quietMs, or maxMs in all. */
async function settle(standIn, { quietMs, maxMs }) {
  const started = Date.now();
  let last = 0;
  let changed = Date.now();
  for (;;) {
    const n = standIn.log().length;
    if (n !== last) { last = n; changed = Date.now(); }
    if (n > 0 && Date.now() - changed >= quietMs) return;
    if (Date.now() - started >= maxMs) return;
    await sleep(50);
  }
}

/** One attempt: a fresh process of the build, the request, the stand-in's numbers. */
async function drive(ctx, label) {
  const { standIn, build, start, authority, orders, order, webhookPath, mapNames, quietMs, maxMs, startMs, extraEnv } = ctx;
  const port = await freePort();
  const proc = startBuild({ build, start, port, standInPort: standIn.port, authority, mapNames, extraEnv });
  try {
    if (!(await proc.listening(startMs))) {
      const exit = proc.exited();
      return { label, driven: false, why: exit ? `the build exited (code ${exit.code ?? exit.signal}) before it listened on its port` : `the build did not listen on its port within ${startMs} ms`, output: proc.output() };
    }
    const sent = await sendWebhook({ port, path: webhookPath, order, text: REQUEST.text });
    await settle(standIn, { quietMs, maxMs });
    return { label, driven: true, webhook: sent, numbers: standIn.report(), output: proc.output() };
  } finally { proc.stop(); }
}

/** O1, O2 or O3 from the control and the fault run (DB7). */
export function classify(control, run) {
  if (!control.driven) return { outcome: 'O3', reason: `could not be driven: ${control.why}` };
  const c = control.numbers;
  if (c.posts.length !== 1 || c.refunds !== 1) return { outcome: 'O3', reason: `could not be driven: the control (no fault) made ${c.posts.length} POST(s) and ${c.refunds} refund(s), not 1 and 1` };
  if (!run.driven) return { outcome: 'O3', reason: `could not be driven under the fault: ${run.why}` };
  const n = run.numbers;
  if (n.posts.length === 0) return { outcome: 'O3', reason: 'could not be driven under the fault: no POST reached the stand-in' };
  const charge = Object.keys(n.amount)[0];
  const refundedMoreThanAsked = Object.values(n.amountRefunded).some((v) => v !== null && v > REQUEST.amount);
  if (n.refunds >= 2 || refundedMoreThanAsked) return { outcome: 'O1', reason: `refunds twice: ${n.refunds} refund objects, ${n.amountRefunded[charge]} refunded of ${REQUEST.amount} asked` };
  return { outcome: 'O2', reason: `refunds once: ${n.posts.length} POST(s) with key(s) ${JSON.stringify(n.posts.map((p) => p.key))}, ${n.refunds} refund object` };
}

/**
 * Drives the build. Options: build (directory), start (the command its README gives), fault ('lost-answer', 'hold' or a script),
 * webhookPath, testCommand, standIn (a factory, so a test can give a mutant), mapNames (false in a container), quietMs, maxMs.
 */
export async function replay({
  build, start, fault = 'lost-answer', webhookPath = '/webhook', testCommand = null, mapNames = true,
  stripe, quietMs = 3000, maxMs = 20_000, startMs = 15_000, orders: ordersFile, extraEnv = {}, standInPort = 0, standInHost = '127.0.0.1',
}) {
  const buildDir = resolve(build);
  const ordersPath = ordersFile ?? (existsSync(join(buildDir, 'orders.json')) ? join(buildDir, 'orders.json') : ORDERS);
  const orders = JSON.parse(readFileSync(ordersPath, 'utf8'));
  const order = orders.find((o) => o.order === REQUEST.order) ?? orders[0];
  const authority = createAuthority();
  const standIn = await startStandIn({ authority, charges: chargesOf(orders), fault: 'none', port: standInPort, host: standInHost, ...(stripe ? { stripe } : {}) });
  const result = { build: buildDir, fault: typeof fault === 'string' ? fault : fault.name ?? 'custom', start, orders: ordersPath };
  try {
    try {
      await selfCheck(standIn, authority, orders);
      result.standIn = { valid: true };
    } catch (e) {
      if (!(e instanceof StandInInvalid)) throw e;
      return { ...result, standIn: { valid: false, why: e.message }, outcome: 'stand-in-invalid', reason: e.message, control: null, run: null, tests: null };
    }
    const ctx = { standIn, build: buildDir, start, authority, orders, order, webhookPath, mapNames, quietMs, maxMs, startMs, extraEnv };
    standIn.reset({ charges: chargesOf(orders), fault: 'none' });
    result.control = await drive(ctx, 'control');
    const controlOk = result.control.driven && result.control.numbers.posts.length === 1 && result.control.numbers.refunds === 1;
    if (controlOk) {
      standIn.reset({ charges: chargesOf(orders), fault });
      result.run = await drive(ctx, `fault ${result.fault}`);
    } else result.run = null; // the control failed first: the fault is never applied
    Object.assign(result, classify(result.control, result.run ?? { driven: false, why: 'not run' }));
    result.tests = testCommand ? runTests(buildDir, testCommand) : { status: 'not given' };
    return result;
  } finally {
    await standIn.close();
    authority.remove();
  }
}

/** O4: the build's own tests, unmodified, in its directory; the result is reported as it is. */
function runTests(build, command) {
  const r = spawnSync(command, { cwd: build, shell: true, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  return { status: r.status === 0 ? 'passed' : 'failed', exit: r.status, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500) };
}

/** The report as text: the five numbers of the control and the fault run, and the outcome. */
export function format(result) {
  const row = (label, n) => (n ? `${label.padEnd(18)} requests ${String(n.requests).padStart(2)} | POSTs ${n.posts.map((p) => p.key ?? 'no key').join(', ') || 'none'} | refunds ${n.refunds} | amount_refunded ${Object.values(n.amountRefunded).join('/')} of ${Object.values(n.amount).join('/')} | reply ${JSON.stringify(n.reply[0] ?? null)}` : `${label.padEnd(18)} not run`);
  return [
    `build: ${result.build}`,
    `start: ${result.start}`,
    result.standIn?.valid === false ? `STAND-IN INVALID: ${result.standIn.why}` : `stand-in: valid (its own key check passed)`,
    row('control', result.control?.numbers),
    row(`fault ${result.fault}`, result.run?.numbers),
    `outcome ${result.outcome}: ${result.reason}`,
    `its own tests: ${result.tests?.status ?? 'not run'}`,
  ].join('\n');
}
