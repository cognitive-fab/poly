// PT33.4 (ruled 2026-10-14): "write" means every method that is not safe, so POST, PUT, PATCH and DELETE. The key header goes on
// all of them, and the one-write-per-attempt refusal (PL6406) counts all of them. A GET carries no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRefused } from '@poly/runtime';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const KEYED_FIXTURE = 'test/fixtures/s526/runtime/keyed.poly';
const URL_ = 'https://api.psp.example/v1/work';

/** Runs one attempt of the keyed effect with the handler `script` and returns what the transport saw. */
async function attempt(name, script) {
  const a = await admitted(name, [KEYED_FIXTURE]);
  const calls = [];
  const { rt } = await loaded(a, { transports: { egress: async (req) => { calls.push(req); return { status: 200, headers: {}, body: {} }; } } });
  try {
    let seen;
    handleWith(rt, 's526.work', async (_payload, caps, ctx) => { seen = { ctx, out: await script(caps) }; return {}; });
    await rt.create('s526keyed.Job', { id: 'job-m' });
    await rt.dispatch('job-m', 'Go', {});
    await rt.worker.tick();
    return { seen, calls, audit: await rt.audit('job-m') };
  } finally { await rt.close(); }
}

const header = (req, name = 'idempotency-key') => Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

for (const [method, call] of [
  ['PUT', (caps, opts) => caps.egress.put(URL_, { data: 1 }, opts)],
  ['PATCH', (caps, opts) => caps.egress.patch(URL_, { data: 1 }, opts)],
  ['DELETE', (caps, opts) => caps.egress.delete(URL_, opts)],
]) {
  test(`PT33.4: a ${method} of a keyed effect carries the intent id as Idempotency-Key`, async () => {
    const { seen, calls } = await attempt(`s526-m-${method}`, (caps) => call(caps));
    assert.ok(seen, 'the handler ran');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, method);
    assert.equal(header(calls[0]), seen.ctx.idempotencyKey);
  });

  test(`PT33.4: a handler-supplied Idempotency-Key on a ${method} is replaced and audited`, async () => {
    const { seen, calls, audit } = await attempt(`s526-m-forged-${method}`, (caps) => call(caps, { headers: { 'Idempotency-Key': 'forged' } }));
    assert.equal(calls.length, 1);
    assert.equal(header(calls[0]), seen.ctx.idempotencyKey);
    assert.ok(audit.some((r) => r.rule === 'idempotency-header-replaced'), JSON.stringify(audit.slice(0, 3)));
  });

  test(`PT33.4: a ${method} after a POST in the same attempt is refused PL6406 (one write per attempt)`, async () => {
    const { seen, calls } = await attempt(`s526-m-second-${method}`, async (caps) => {
      await caps.egress.post(URL_, { first: true });
      try { await call(caps); } catch (e) { return e; }
      return null;
    });
    assert.ok(seen.out instanceof CapabilityRefused, `the second write throws CapabilityRefused, got ${seen.out}`);
    assert.match(seen.out.message, /PL6406 CAPABILITY_REFUSED/);
    assert.equal(calls.length, 1, 'the transport saw one write');
  });
}

test('PT33.4: a GET still carries no Idempotency-Key, and does not count as a write', async () => {
  const { calls } = await attempt('s526-m-get', async (caps) => { await caps.egress.get(`${URL_}?id=1`); return caps.egress.delete(URL_); });
  assert.equal(calls.length, 2);
  assert.equal(header(calls[0]), undefined);
  assert.ok(header(calls[1]));
});
