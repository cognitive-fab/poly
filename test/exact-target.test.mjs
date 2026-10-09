// S455 (PT6.5 "Exact targets", decisions-v1 "S455, accepted, both halves"): an egress target written `exact "<url>"`
// admits that URL and nothing under it. The manifest writes it as { "exact": "<url>" } among the kind's strings;
// `egress` and `api` refuse any other URL with PL6406, a redirect included; `exact` on another kind of target, and an
// exact URL not written in its normalised form, are PL1201; the generated OpenShell policy names the exact path alone.
// The Gmail case: a gmail.compose token may also send, and the exact drafts target is what keeps a draft from sending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { CapabilityRefused } from '@poly/runtime';
import { ROOT, build } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';
import { desk } from './grants-helpers.mjs';

const SRC = 'test/fixtures/exact-target/drafts.poly';
const CREDS = 'test/fixtures/exact-target/creds-exact.poly';
const DRAFTS = 'https://api.example.com/v1/drafts';
const LABELS = 'https://api.example.com/v1/labels';
const REFUNDS = 'https://api.test-oauth.example/v1/refunds';
const codes = (src) => { const r = parse(src); return r.module ? [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code) : r.diagnostics.map((d) => d.code); };
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };

test('S455: an exact egress target is accepted and written to the manifest as { exact }; exact on secrets, a query and an upper-case host are PL1201', () => {
  const src = readFileSync(join(ROOT, SRC), 'utf8');
  assert.deepEqual(codes(src), []);
  const printed = format(parse(src).module);
  assert.ok(printed.includes(`targets { egress: exact "${DRAFTS}" }`), printed);
  assert.deepEqual(codes(printed), []);
  const [m] = build(join(ROOT, SRC), 'exact-target');
  const man = JSON.parse(m.lowered.files['effects.manifest.json']).effects;
  assert.deepEqual(man['mail.draft'].targets, { egress: [{ exact: DRAFTS }] });
  // A list keeps the exact target beside the prefix, each in its own form.
  const mixed = man['mail.mixed'].targets.egress;
  assert.equal(mixed.length, 2, JSON.stringify(mixed));
  assert.ok(mixed.some((t) => JSON.stringify(t) === JSON.stringify({ exact: DRAFTS })), JSON.stringify(mixed));
  assert.ok(mixed.includes(LABELS), JSON.stringify(mixed));

  const eff = (labels, targets) => `module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { emit call(1) }\n  effect call(n: 0..1) {\n    labels { ${labels} }\n    targets { ${targets} }\n    class none\n  }\n}\n`;
  assert.deepEqual(codes(eff('egress:external', `egress: exact "${DRAFTS}"`)), []);
  assert.deepEqual(codes(eff('egress:external', `egress: [exact "${DRAFTS}", "${LABELS}"]`)), []);
  // exact is allowed on egress only.
  assert.deepEqual(codes(eff('egress:external, read:private', 'secrets: [exact "PSP_KEY"]')), ['PL1201']);
  // The URL is written as a prefix is: no query, no upper-case host.
  assert.deepEqual(codes(eff('egress:external', `egress: exact "${DRAFTS}?x=1"`)), ['PL1201']);
  assert.deepEqual(codes(eff('egress:external', 'egress: exact "https://API.example.com/v1/drafts"')), ['PL1201']);
});

/** A host egress transport that records each request and answers by URL. */
function transports(answers = {}) {
  const calls = [];
  return { calls, transports: { egress: async (req) => { calls.push(req); return answers[req.url] ?? { status: 200, headers: {}, body: { ok: true } }; } } };
}

async function run(name, kind, action, script, answers) {
  const a = await admitted(name, [SRC]);
  const t = transports(answers);
  const { rt } = await loaded(a, { transports: t.transports });
  let out;
  handleWith(rt, kind, async (_payload, caps) => { out = await script(caps); return {}; });
  await rt.create('drafts.Mail', { id: 'm1' });
  await rt.dispatch('m1', action, {});
  await rt.worker.tick();
  const audit = await rt.audit('m1');
  await rt.close();
  return { out, calls: t.calls, audit };
}

test('S455: egress reaches the exact URL and nothing under it; a prefix beside it still admits its subpaths', async () => {
  const outside = [`${DRAFTS}/send`, `${DRAFTS}/x`, `${DRAFTS}/`, `${DRAFTS}?x=1`, 'https://api.example.com/v1/drafts-evil'];
  const { out, calls, audit } = await run('exact-egress', 'mail.mixed', 'Mixed', async (caps) => {
    const ok = [
      await caps.egress.post(DRAFTS, { raw: 'x' }),
      // The same normalisation as a prefix: the host is lowercased and the default port dropped.
      await caps.egress.get('https://API.example.com:443/v1/drafts'),
      await caps.egress.post(`${LABELS}/l_1`, { name: 'n' }),
    ];
    const errors = [];
    for (const u of outside) errors.push(await refused(caps.egress.post(u, { raw: 'x' })));
    return { ok, errors };
  });
  assert.ok(out, 'the handler ran');
  assert.equal(out.ok.length, 3);
  for (const [i, e] of out.errors.entries()) assert.ok(e instanceof CapabilityRefused, `${outside[i]}: ${e}`);
  assert.deepEqual(calls.map((r) => [r.method, r.url]), [['POST', DRAFTS], ['GET', DRAFTS], ['POST', `${LABELS}/l_1`]]);
  const rows = audit.filter((r) => r.rule === 'PL6406');
  assert.equal(rows.length, outside.length, JSON.stringify(audit));
  assert.ok(rows.every((r) => r.action === 'mail.mixed'));
});

test('S455: an effect with only an exact target is refused every path under it, before the transport', async () => {
  const { out, calls, audit } = await run('exact-only', 'mail.draft', 'Draft', async (caps) => ({
    ok: await caps.egress.post(DRAFTS, { raw: 'x' }),
    send: await refused(caps.egress.post(`${DRAFTS}/send`, { raw: 'x' })),
    x: await refused(caps.egress.post(`${DRAFTS}/x`, { raw: 'x' })),
  }));
  assert.ok(out.ok);
  assert.ok(out.send instanceof CapabilityRefused, String(out.send));
  assert.ok(out.x instanceof CapabilityRefused, String(out.x));
  assert.deepEqual(calls.map((r) => r.url), [DRAFTS]);
  assert.equal(audit.filter((r) => r.rule === 'PL6406').length, 2, JSON.stringify(audit));
});

test('S455: a redirect from the exact URL to a path under it is refused before that request', async () => {
  const answers = {
    [DRAFTS]: { status: 302, headers: { Location: '/v1/drafts/send' } },
    [`${LABELS}/a`]: { status: 307, headers: { location: '/v1/drafts/x' } },
  };
  const { out, calls, audit } = await run('exact-redirect', 'mail.mixed', 'Mixed', async (caps) => ({
    a: await refused(caps.egress.post(DRAFTS, { raw: 'x' })),
    b: await refused(caps.egress.post(`${LABELS}/a`, { raw: 'x' })),
  }), answers);
  assert.ok(out.a instanceof CapabilityRefused && /redirect/.test(out.a.message), String(out.a));
  assert.ok(out.b instanceof CapabilityRefused && /redirect/.test(out.b.message), String(out.b));
  const urls = calls.map((r) => r.url);
  assert.deepEqual(urls, [DRAFTS, `${LABELS}/a`]);
  assert.equal(audit.filter((r) => r.rule === 'PL6406').length, 2, JSON.stringify(audit));
});

test('S455: through a credential, api reaches the exact URL by the vault and refuses a path under it (the Gmail send case)', { timeout: 300_000 }, async () => {
  const { rt, sent, answers, grant } = await desk('exact-api', {}, [CREDS]);
  try {
    const tokens = await grant('payments', 'm-1', ['refunds.write']);
    let out = null;
    handleWith(rt, 'payments.refund', async (_payload, { api }) => {
      const r = await api.post(REFUNDS, 'amount=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const send = await refused(api.post(`${REFUNDS}/send`, 'amount=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
      out = { status: r.status, send };
      return { status: r.status };
    });
    answers.push(() => ({ status: 200, headers: {}, body: '{"id":"re_1"}' }));
    const before = sent.length;
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.ok(out, 'the handler ran');
    assert.equal(out.status, 200);
    assert.ok(out.send instanceof CapabilityRefused, String(out.send));
    const calls = sent.slice(before);
    assert.deepEqual(calls.map((q) => q.url), [REFUNDS]);
    assert.equal(calls[0].headers.authorization, `Bearer ${tokens.access}`);
    const audit = await rt.audit('d-1');
    assert.equal(audit.filter((r) => r.rule === 'PL6406').length, 1, JSON.stringify(audit));
  } finally { await rt.close(); }
});

test('S455: under openshell isolation the policy names the exact path and nothing under it', () => {
  const [m] = build(join(ROOT, SRC), 'exact-sandbox', { isolation: 'openshell' });
  const text = m.lowered.files['openshell.policies.yaml'];
  assert.ok(text, Object.keys(m.lowered.files).join(', '));
  const policies = JSON.parse(text);
  const endpoints = (kind) => Object.values(policies[kind].network_policies).flatMap((p) => p.endpoints).map((e) => [e.host, e.port, e.path]).sort();
  assert.deepEqual(endpoints('mail.draft'), [['api.example.com', 443, '/v1/drafts']]);
  assert.deepEqual(endpoints('mail.mixed'), [
    ['api.example.com', 443, '/v1/drafts'],
    ['api.example.com', 443, '/v1/labels'],
    ['api.example.com', 443, '/v1/labels/**'],
  ]);
});
