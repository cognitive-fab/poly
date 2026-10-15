// DAC8 (DB6, DB7): the replay driver reports O1, O2 and O3 correctly on doubles of the baseline, and the control fails first where it
// should. Three doubles as the plan names them (one that refunds twice, one that sends a key, one that cannot start), the fresh-key
// double of DAC9, a double that does not retry, and a mutant stand-in that ignores the key. Nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, StandInInvalid, selfCheck, ORDERS, chargesOf } from '../demo/driver/replay.mjs';
import { createAuthority } from '../demo/stand-in/stripe/tls.mjs';
import { startStandIn } from '../demo/stand-in/stripe/server.mjs';
import { createStripeIgnoringKeys } from './fixtures/demo/mutants/stripe-ignores-key.mjs';
import { readFileSync } from 'node:fs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
const drive = (name, options = {}) => replay({ build: join(DOUBLES, name), start: 'node server.mjs', quietMs: 1200, maxMs: 8000, startMs: 6000, ...options });

test('DAC8, O1: the double that retries with no key refunds twice, and the five numbers say so', async () => {
  const r = await drive('refunds-twice');
  assert.equal(r.outcome, 'O1', r.reason);
  assert.deepEqual([r.control.numbers.posts.length, r.control.numbers.refunds], [1, 1], 'the control: one POST, one refund');
  const n = r.run.numbers;
  assert.equal(n.requests, 2);
  assert.deepEqual(n.posts.map((p) => p.key), [null, null]);
  assert.equal(n.refunds, 2);
  assert.equal(n.amountRefunded.ch_demo_1001, 8000);
  assert.equal(n.amount.ch_demo_1001, 10000);
  assert.deepEqual(n.reply, ['Your refund of 40.00 for ORD-1001 has been issued.'], 'the customer was told one refund');
  assert.deepEqual(n.posts.map((p) => p.fault), ['reset', null], 'the first answer was lost');
});

test('DAC8, O1 and O4: the double passes its own tests and refunds twice, and both are reported as they are', async () => {
  const r = await drive('refunds-twice', { testCommand: 'node test.mjs' });
  assert.equal(r.tests.status, 'passed');
  assert.equal(r.outcome, 'O1');
});

test('DAC9, O1: the double that sends a fresh key on each retry refunds twice', async () => {
  const r = await drive('fresh-key');
  assert.equal(r.outcome, 'O1', r.reason);
  const keys = r.run.numbers.posts.map((p) => p.key);
  assert.equal(keys.length, 2);
  assert.ok(keys.every(Boolean) && keys[0] !== keys[1], 'two different keys');
  assert.equal(r.run.numbers.refunds, 2);
});

test('DAC8, O2: the double that sends one key on every attempt refunds once, the retry is replayed', async () => {
  const r = await drive('keys');
  assert.equal(r.outcome, 'O2', r.reason);
  const n = r.run.numbers;
  assert.equal(n.requests, 2);
  assert.equal(n.posts[0].key, n.posts[1].key);
  assert.deepEqual(n.posts.map((p) => p.replayed), [false, true]);
  assert.deepEqual([n.refunds, n.amountRefunded.ch_demo_1001], [1, 4000]);
  assert.match(r.reason, /refunds once/);
});

test('DAC8, O2: the double that does not retry refunds once with no key', async () => {
  const r = await drive('no-retry');
  assert.equal(r.outcome, 'O2', r.reason);
  assert.deepEqual([r.run.numbers.posts.length, r.run.numbers.refunds], [1, 1]);
  assert.deepEqual(r.run.numbers.reply, ['Sorry, I could not issue your refund. Please try again later.'], 'and the customer was told the truth only by accident of the retry count');
});

test('DAC8, O3: the double that cannot start could not be driven, and the fault is never applied', async () => {
  const r = await drive('cannot-start');
  assert.equal(r.outcome, 'O3');
  assert.match(r.reason, /exited \(code 1\)/);
  assert.match(r.control.output, /Cannot find module/, 'the log is kept');
  assert.equal(r.run, null, 'the control failed first, so the fault run did not happen');
});

test('DAC8, O3: a build that starts but makes no refund fails the control (it is not tested by the fault)', async () => {
  const r = await replay({ build: join(DOUBLES, 'no-retry'), start: 'node -e "require(\'node:http\').createServer((q,s)=>s.end(\'ok\')).listen(Number(process.env.PORT))"', quietMs: 600, maxMs: 2500, startMs: 6000 });
  assert.equal(r.outcome, 'O3');
  assert.match(r.reason, /control .* made 0 POST/);
  assert.equal(r.run, null);
});

test('DAC8: the control fails first where it should: a stand-in that ignores the key is refused before any build is driven', async () => {
  const r = await drive('keys', { stripe: createStripeIgnoringKeys });
  assert.equal(r.outcome, 'stand-in-invalid');
  assert.match(r.reason, /same key with the same parameters twice made \d+ refunds, not 1/);
  assert.equal(r.control, null);
  assert.equal(r.run, null);
});

test('DAC8: the stand-in\'s own check passes on the real stand-in and throws StandInInvalid on the mutant', async () => {
  const orders = JSON.parse(readFileSync(ORDERS, 'utf8'));
  const authority = createAuthority();
  try {
    const real = await startStandIn({ authority, charges: chargesOf(orders) });
    await selfCheck(real, authority, orders);
    await real.close();
    const mutant = await startStandIn({ authority, charges: chargesOf(orders), stripe: createStripeIgnoringKeys });
    await assert.rejects(selfCheck(mutant, authority, orders), StandInInvalid);
    await mutant.close();
  } finally { authority.remove(); }
});

test('DB6 item 3: the name mapping reaches the stand-in for the two names and refuses every other destination', async () => {
  const authority = createAuthority();
  const standIn = await startStandIn({ authority, charges: [] });
  try {
    const script = `
      const https = require('node:https');
      const ask = (host) => new Promise((resolve) => { const r = https.get({ host, path: '/v1/charges/x', headers: { authorization: 'Bearer x' } }, (res) => { res.resume(); resolve('status ' + res.statusCode); }); r.on('error', (e) => resolve(e.code + ' ' + e.message)); });
      (async () => { console.log(await ask('api.stripe.com')); console.log(await ask('example.com')); console.log(await ask('8.8.8.8')); })();`;
    // Asynchronous: the stand-in lives in this process and has to answer while the child waits.
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--require', fileURLToPath(new URL('../demo/driver/map-hosts.cjs', import.meta.url)), '-e', script], {
        env: { ...process.env, POLY_DEMO_STANDIN_PORT: String(standIn.port), NODE_EXTRA_CA_CERTS: authority.caPath }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('exit', () => resolve({ stdout, stderr }));
    });
    const [stripe, example, ip] = r.stdout.trim().split('\n');
    assert.equal(stripe, 'status 404', `api.stripe.com reached the stand-in (it answers an unknown charge 404): ${r.stdout} ${r.stderr}`);
    assert.match(example, /^ECONNREFUSED .*no route outside the demo/);
    assert.match(ip, /^ECONNREFUSED .*no route outside the demo/);
    assert.equal(standIn.log().length, 1, 'only the first request reached the stand-in');
  } finally { await standIn.close(); authority.remove(); }
});

test('DB6 item 3: the throwaway authority is removed when the run ends, and nothing of it is under the repository', async () => {
  const authority = createAuthority();
  const { existsSync } = await import('node:fs');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  assert.ok(!authority.dir.startsWith(repo), 'the authority lives in the temporary space');
  assert.ok(existsSync(authority.caPath));
  authority.remove();
  assert.ok(!existsSync(authority.dir));
});
