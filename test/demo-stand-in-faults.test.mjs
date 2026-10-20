// DF22: fault scripts (lost-all and down) over real startStandIn, and parseArgs of launcher.
// lost-all applies request and resets connection per attempt with stable key (one refund object).
// down answers 503 and applies nothing. parseArgs accepts/refuses the --stand-in-fault flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createAuthority } from '../demo/stand-in/stripe/tls.mjs';
import { startStandIn } from '../demo/stand-in/stripe/server.mjs';
import { parseArgs } from '../demo/launch.mjs';
import { LaunchRefused } from '../demo/host/assemble.mjs';

const CHARGES = [{ id: 'ch_ex1002', amount: 12000, currency: 'usd' }];
const AUTH = { authorization: 'Bearer sk_test_standin_synthetic' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded', ...AUTH };

function call(standIn, authority, { method = 'POST', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: standIn.port, method, path, ca: authority.ca, servername: 'api.stripe.com', headers: { host: 'api.stripe.com', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function withStandIn(options, fn) {
  const authority = createAuthority();
  const standIn = await startStandIn({ authority, charges: CHARGES, ...options });
  try { return await fn(standIn, authority); } finally { await standIn.close(); authority.remove(); }
}

// ---- lost-all fault tests ----

test('DF22: lost-all fault applies the request and resets connection', async () => {
  await withStandIn({ fault: 'lost-all' }, async (s, authority) => {
    await assert.rejects(
      call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_ex1002&amount=4000' }),
      (e) => /socket hang up|ECONNRESET|reset/i.test(String(e.message) + String(e.code)),
    );
    assert.equal(s.report().refunds, 1, 'the refund was applied though its answer was lost');
  });
});

test('DF22: lost-all with stable key leaves one refund object after three requests', async () => {
  await withStandIn({ fault: 'lost-all' }, async (s, authority) => {
    const headers = { ...FORM, 'idempotency-key': 'stable-key' };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(call(s, authority, { method: 'POST', path: '/v1/refunds', headers, body: 'charge=ch_ex1002&amount=4000' }));
    }
    assert.equal(s.report().refunds, 1, 'three attempts with one key should leave one refund object');
    assert.equal(s.report().amountRefunded.ch_ex1002, 4000, 'amount refunded should equal the request amount');
  });
});

// ---- down fault tests ----

test('DF22: down fault answers 503 and applies nothing', async () => {
  await withStandIn({ fault: 'down' }, async (s, authority) => {
    const response = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_ex1002&amount=4000' });
    assert.equal(response.status, 503);
    assert.equal(s.report().refunds, 0, 'no refund was created');
  });
});

test('DF22: down fault leaves no refunds on multiple requests', async () => {
  await withStandIn({ fault: 'down' }, async (s, authority) => {
    for (let i = 0; i < 3; i++) {
      const response = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_ex1002&amount=4000' });
      assert.equal(response.status, 503);
    }
    assert.equal(s.report().refunds, 0, 'no refund was created on any attempt');
  });
});

// ---- none (control) fault tests ----

test('DF22: none fault is unchanged and works normally', async () => {
  await withStandIn({ fault: 'none' }, async (s, authority) => {
    const response = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_ex1002&amount=4000' });
    assert.equal(response.status, 200);
    assert.equal(s.report().refunds, 1, 'the refund was created and answer was returned');
  });
});

// ---- standIn.reset tests ----

test('DF22: standIn.reset() switches the fault on a running stand-in', async () => {
  await withStandIn({ fault: 'lost-all' }, async (s, authority) => {
    // First request with lost-all gets reset
    await assert.rejects(
      call(s, authority, { method: 'POST', path: '/v1/refunds', headers: { ...FORM, 'idempotency-key': 'k1' }, body: 'charge=ch_ex1002&amount=4000' }),
    );
    assert.equal(s.report().refunds, 1);

    // Reset to none
    s.reset({ fault: 'none' });

    // Next request succeeds
    const response = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: { ...FORM, 'idempotency-key': 'k2' }, body: 'charge=ch_ex1002&amount=4000' });
    assert.equal(response.status, 200);
    // reset starts the stand-in again from its charges, so the refund of the lost-all request is gone and only this one exists.
    assert.equal(s.report().refunds, 1);
  });
});

// ---- parseArgs tests ----

test('DF22: parseArgs accepts --stand-in-fault with --recorded', () => {
  const result = parseArgs(['--recorded', '--stand-in-fault', 'lost-all']);
  assert.equal(result.mode, 'recorded');
  assert.equal(result.standInFault, 'lost-all');
});

test('DF22: parseArgs accepts --stand-in-fault with --stub-model', () => {
  const result = parseArgs(['--stub-model', '--cap-usd', '0.01', '--stand-in-fault', 'down']);
  assert.equal(result.mode, 'stub-model');
  assert.equal(result.standInFault, 'down');
});

test('DF22: parseArgs defaults standInFault to null without flag', () => {
  const result = parseArgs(['--recorded']);
  assert.equal(result.standInFault, null);
});

test('DF22: parseArgs refuses unknown --stand-in-fault name', () => {
  assert.throws(() => parseArgs(['--recorded', '--stand-in-fault', 'nope']), (e) => {
    assert.ok(e instanceof LaunchRefused);
    assert.ok(e.message.includes('--stand-in-fault names lost-all or down, not nope') || e.message.includes('nope'));
    return true;
  });
});

test('DF22: parseArgs refuses --stand-in-fault with --live', () => {
  assert.throws(() => parseArgs(['--live', '--cap-usd', '5', '--stand-in-fault', 'lost-all']), (e) => {
    assert.ok(e instanceof LaunchRefused);
    assert.ok(e.message.includes('--stand-in-fault applies to --recorded or --stub-model'));
    return true;
  });
});
