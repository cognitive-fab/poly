// PS23.10, PT33.13 (ruled 2026-10-14): class none is true. An effect of class none gets a capability limited to GET and HEAD.
// A write (POST, PUT, PATCH, DELETE) is refused before it is sent, with PL6412 NONE_CLASS_WRITE, and audited. Any other class may write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRefused, capabilitiesFor, RUNTIME_FAULTS } from '@poly/runtime';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const NONE = 'test/fixtures/s526/runtime/none.poly';
const REVERSIBLE = 'test/fixtures/s526/runtime/reversible.poly';
const URL_ = 'https://api.psp.example/v1/work';

/** One attempt of the effect with the handler `script`; what the transport saw and what was audited. */
async function attempt(name, file, machine, script, extra = {}) {
  const a = await admitted(name, [file]);
  const calls = [];
  const { rt } = await loaded(a, { transports: { egress: async (req) => { calls.push(req); return { status: 200, headers: {}, body: {} }; } }, ...extra });
  try {
    let seen;
    handleWith(rt, 's526.work', async (_payload, caps) => { seen = { out: await script(caps) }; return {}; });
    await rt.create(machine, { id: 'job-n' });
    await rt.dispatch('job-n', 'Go', {});
    await rt.worker.tick();
    return { seen, calls, audit: await rt.audit('job-n') };
  } finally { await rt.close(); }
}

const refused = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

for (const [method, call] of [
  ['POST', (caps) => caps.egress.post(URL_, { amount: 40 })],
  ['PUT', (caps) => caps.egress.put(URL_, { amount: 40 })],
  ['PATCH', (caps) => caps.egress.patch(URL_, { amount: 40 })],
  ['DELETE', (caps) => caps.egress.delete(URL_)],
]) {
  test(`PS23.10: a ${method} by an effect of class none is refused PL6412 before it is sent, and audited`, async () => {
    const { seen, calls, audit } = await attempt(`s526-none-${method}`, NONE, 's526none.Job', (caps) => refused(() => call(caps)));
    assert.ok(seen.out instanceof CapabilityRefused, `the write throws CapabilityRefused, got ${seen.out}`);
    assert.match(seen.out.message, /PL6412 NONE_CLASS_WRITE/);
    assert.equal(calls.length, 0, 'the transport was never called');
    assert.ok(audit.some((r) => r.rule === 'PL6412'), JSON.stringify(audit.slice(0, 3)));
  });
}

test('PS23.10: an effect of class none that only reads works (GET and HEAD)', async () => {
  const { seen, calls, audit } = await attempt('s526-none-read', NONE, 's526none.Job', async (caps) => { await caps.egress.get(`${URL_}?id=1`); return caps.egress.head(URL_); });
  assert.ok(seen, 'the handler ran');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'HEAD']);
  assert.ok(!audit.some((r) => r.rule === 'PL6412'));
});

test('CONTROL: PS23.10: the same effect with class reversible may write', async () => {
  const { calls, audit } = await attempt('s526-none-control', REVERSIBLE, 's526rev.Job', (caps) => caps.egress.post(URL_, { amount: 40 }));
  assert.deepEqual(calls.map((c) => c.method), ['POST']);
  assert.ok(!audit.some((r) => r.rule === 'PL6412'));
});

test('PS23.10: caps.api of a class none effect is limited the same way', async () => {
  const sent = [];
  const audits = [];
  const api = { request: async (r) => { sent.push(r); return { status: 200, headers: {}, body: '' }; } };
  const decl = { class: 'none', labels: ['egress:external'], targets: { egress: ['https://x.example/v1/'] }, uses: { credential: 'c', scopes: [], holder: null } };
  const caps = capabilitiesFor(decl, {}, async (reason, rule) => { audits.push(rule ?? 'PL6406'); }, api);
  await caps.api.get('https://x.example/v1/a');
  for (const call of [() => caps.api.post('https://x.example/v1/a', 'b'), () => caps.api.put('https://x.example/v1/a', 'b'), () => caps.api.patch('https://x.example/v1/a', 'b'), () => caps.api.delete('https://x.example/v1/a')]) {
    const e = await refused(call);
    assert.ok(e instanceof CapabilityRefused && /PL6412/.test(e.message), String(e));
  }
  assert.deepEqual(sent.map((r) => r.method), ['GET']);
  assert.equal(audits.filter((r) => r === 'PL6412').length, 4);
});

test('PS23.10, its own fault: none-class-writes-allowed lets a class none effect write, and nothing else changes', async () => {
  assert.ok(RUNTIME_FAULTS.includes('none-class-writes-allowed'));
  const run = (extra) => attempt('s526-none-fault', NONE, 's526none.Job', (caps) => refused(() => caps.egress.post(URL_, {})), extra);
  const clean = await run({});
  assert.ok(clean.seen.out instanceof CapabilityRefused && clean.calls.length === 0);
  const faulty = await run({ fault: 'none-class-writes-allowed' });
  assert.equal(faulty.seen.out, null, 'with the fault the write is not refused');
  assert.deepEqual(faulty.calls.map((c) => c.method), ['POST']);
});
