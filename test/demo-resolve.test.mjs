// DF21 item 4: operatorVerifier and runResolve over a fake demo for each outcome.
// The verifier accepts a person's invocation record and refuses bad credentials.
// runResolve never throws and returns { ok, line } for each case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signRecord, invocationSubject } from '@poly/core';
import { operatorVerifier, runResolve } from '../demo/host/resolve.mjs';

// Generate test keys
function genKeyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
}

const personKey = genKeyPair();
const agentKey = genKeyPair();
const unknownKey = genKeyPair();

const PERSON = {
  name: 'presenter',
  keyId: 'presenter-key-1',
  publicKey: personKey.publicKey,
  privateKeyPem: personKey.privateKey,
};

const AGENT = {
  name: 'bot',
  keyId: 'agent-key-1',
  publicKey: agentKey.publicKey,
  privateKeyPem: agentKey.privateKey,
};

const UNKNOWN_PERSON = {
  name: 'unknown',
  keyId: 'unknown-key',
  publicKey: unknownKey.publicKey,
  privateKeyPem: unknownKey.privateKey,
};

const keyrings = { people: [PERSON], agents: [AGENT] };
const verify = operatorVerifier(keyrings);

// Helper to build signed invocation record
const signed = (who, instance, action, data, actionId) => signRecord(
  { kind: 'invocation', subject: invocationSubject({ instance, action, data, actionId }), by: who.keyId, at: '2026-10-20T00:00:00.000Z' },
  who.privateKeyPem,
);

// ---- operatorVerifier tests ----

test('DF21 item 1: operatorVerifier accepts a person invocation record and gives { principal: <name> }', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(PERSON, 'guest-01', 'Resolve', { done: true }, 'resolve-1');
  const result = verify(record, ctx);
  assert.deepEqual(result, { principal: 'presenter' });
});

test('DF21 item 1: operatorVerifier accepts both done: true and done: false', () => {
  const ctx2 = { instance: 'guest-02', action: 'Resolve', data: { done: false }, actionId: 'resolve-2' };
  const record2 = signed(PERSON, 'guest-02', 'Resolve', { done: false }, 'resolve-2');
  assert.deepEqual(verify(record2, ctx2), { principal: 'presenter' });
});

test('DF21 item 1: operatorVerifier refuses a record signed by the agent key', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(AGENT, 'guest-01', 'Resolve', { done: true }, 'resolve-1');
  assert.equal(verify(record, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses a record signed by an unknown key', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(UNKNOWN_PERSON, 'guest-01', 'Resolve', { done: true }, 'resolve-1');
  assert.equal(verify(record, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses a record over another action id', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(PERSON, 'guest-01', 'Resolve', { done: true }, 'resolve-2');
  assert.equal(verify(record, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses a record over other data', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(PERSON, 'guest-01', 'Resolve', { done: false }, 'resolve-1');
  assert.equal(verify(record, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses a record over another instance', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const record = signed(PERSON, 'guest-02', 'Resolve', { done: true }, 'resolve-1');
  assert.equal(verify(record, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses an unsigned object', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  const unsigned = { kind: 'invocation', subject: invocationSubject({ instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' }) };
  assert.equal(verify(unsigned, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses undefined', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  assert.equal(verify(undefined, ctx), null);
});

test('DF21 item 1: operatorVerifier refuses the old v1.3.0 credentials object { principal: x }', () => {
  const ctx = { instance: 'guest-01', action: 'Resolve', data: { done: true }, actionId: 'resolve-1' };
  assert.equal(verify({ principal: 'presenter' }, ctx), null);
});

// ---- runResolve tests with a fake demo ----

const fakeDemoSuccess = {
  resolve: async (desk, outcome) => ({
    resolved: true,
    desk,
    instance: 'inst-1',
    outcome,
    by: PERSON.keyId,
    at: '2026-10-20T00:00:00.000Z',
  }),
};

const fakeDemoNoDesk = {
  resolve: async (desk) => {
    throw new Error('no desk for ' + desk);
  },
};

const fakeDemoNotUnknown = {
  resolve: async () => {
    throw new Error('not-unknown');
  },
};

const fakeDemoRefundInFlight = {
  resolve: async () => {
    throw new Error('refund-in-flight');
  },
};

const fakeDemoClaimsUnverified = {
  resolve: async () => {
    throw new Error('claims-unverified');
  },
};

const fakeDemoMultilineLong = {
  resolve: async () => {
    throw new Error('not-unknown: the refund is already issued and cannot be resolved again at this time due to system constraints and policy requirements that prevent re-processing of completed transactions in the accounting system because the operation is not idempotent and would cause ledger corruption and financial inconsistency');
  },
};

test('DF21 item 2: runResolve missing desk gives usage message', async () => {
  const result = await runResolve(fakeDemoSuccess, undefined, 'done');
  assert.equal(result.ok, false);
  assert.equal(result.line, 'usage: resolve <desk> done|not-done');
});

test('DF21 item 2: runResolve missing outcome gives usage message', async () => {
  const result = await runResolve(fakeDemoSuccess, 'guest-01', undefined);
  assert.equal(result.ok, false);
  assert.equal(result.line, 'usage: resolve <desk> done|not-done');
});

test('DF21 item 2: runResolve wrong outcome word gives usage message', async () => {
  const result = await runResolve(fakeDemoSuccess, 'guest-01', 'maybe');
  assert.equal(result.ok, false);
  assert.equal(result.line, 'usage: resolve <desk> done|not-done');
});

test('DF21 item 2: runResolve guest with no desk gives resolve refused message', async () => {
  const result = await runResolve(fakeDemoNoDesk, 'guest-99', 'done');
  assert.equal(result.ok, false);
  assert.equal(result.line, 'resolve refused: no desk for guest-99');
});

test('DF21 item 2: runResolve success with done gives correct message', async () => {
  const result = await runResolve(fakeDemoSuccess, 'guest-03', 'done');
  assert.equal(result.ok, true);
  assert.equal(result.line, `resolved: desk guest-03 is issued, signed by the presenter key ${PERSON.keyId}`);
});

test('DF21 item 2: runResolve success with not-done gives correct message', async () => {
  const result = await runResolve(fakeDemoSuccess, 'guest-03', 'not-done');
  assert.equal(result.ok, true);
  assert.equal(result.line, `resolved: desk guest-03 is none, signed by the presenter key ${PERSON.keyId}`);
});

test('DF21 item 2: runResolve not-unknown rejection is reported with code', async () => {
  const result = await runResolve(fakeDemoNotUnknown, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused: /);
  assert.ok(result.line.includes('not-unknown'));
});

test('DF21 item 2: runResolve refund-in-flight rejection is reported with code', async () => {
  const result = await runResolve(fakeDemoRefundInFlight, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused: /);
  assert.ok(result.line.includes('refund-in-flight'));
});

test('DF21 item 2: runResolve claims-unverified rejection is reported with code', async () => {
  const result = await runResolve(fakeDemoClaimsUnverified, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused: /);
  assert.ok(result.line.includes('claims-unverified'));
});

test('DF21 item 2: runResolve multiline message is truncated to 200 characters', async () => {
  const result = await runResolve(fakeDemoMultilineLong, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused: /);
  const messagePart = result.line.replace('resolve refused: ', '');
  assert.ok(messagePart.length <= 200, `message part should be at most 200 chars, got ${messagePart.length}`);
  assert.ok(messagePart.includes('not-unknown'));
});

test('DF21 item 2: runResolve never throws on Error exception', async () => {
  const result = await runResolve({ resolve: async () => { throw new Error('test error'); } }, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused:/);
});

test('DF21 item 2: runResolve never throws on string exception', async () => {
  const result = await runResolve({ resolve: async () => { throw 'string error'; } }, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused:/);
});

test('DF21 item 2: runResolve never throws on object without prototype', async () => {
  const result = await runResolve({ resolve: async () => { throw Object.create(null); } }, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused:/);
});

test('DF21 item 2: runResolve never throws on null exception', async () => {
  const result = await runResolve({ resolve: async () => { throw null; } }, 'guest-01', 'done');
  assert.equal(result.ok, false);
  assert.match(result.line, /^resolve refused:/);
});
