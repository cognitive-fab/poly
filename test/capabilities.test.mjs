// S134, S151, PT6.5: bound capabilities. An effect declares targets next to its labels; the manifest carries them;
// at run time a handler receives capability objects over the host's transports, bound to the declared URL prefixes,
// secret names, commands and tables. A call outside the bounds throws before the transport is called and is audited,
// and every redirect hop is checked against the declared prefix. poly-runtime imports no network module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { CapabilityRefused } from '@poly/runtime';
import { violationsOf, checkRepository } from '../scripts/check-boundaries.mjs';
import { ROOT, build } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const SRC = 'conformance/m5/capabilities.poly';
const codes = (src) => { const r = parse(src); return r.module ? [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code) : r.diagnostics.map((d) => d.code); };

test('S151: targets parse, format back to the same module, and are written to the manifest', () => {
  const src = readFileSync(join(ROOT, SRC), 'utf8');
  assert.deepEqual(codes(src), []);
  const printed = format(parse(src).module);
  assert.match(printed, /targets \{ egress: "https:\/\/api\.psp\.example\/v1\/charges", secrets: \["PSP_KEY"\] \}/);
  assert.deepEqual(codes(printed), []);
  const [m] = build(join(ROOT, SRC), 'capabilities');
  const man = JSON.parse(m.lowered.files['effects.manifest.json']).effects;
  assert.deepEqual(man['payment.charge'].targets, { egress: ['https://api.psp.example/v1/charges'], secrets: ['PSP_KEY'] });
  assert.deepEqual(man['orders.note'].targets, { store: ['notes'] });
  assert.equal(man['orders.ping'].targets, undefined);
});

test('S151: a target the labels do not grant is PL6303, and an egress target that is not a plain http(s) prefix is PL1201', () => {
  const eff = (labels, targets) => `module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { emit call(1) }\n  effect call(n: 0..1) {\n    labels { ${labels} }\n    targets { ${targets} }\n    class none\n  }\n}\n`;
  assert.deepEqual(codes(eff('egress:external', 'egress: "https://a.example/v1/"')), []);
  assert.deepEqual(codes(eff('egress:public', 'egress: ["https://a.example/v1/", "https://b.example/"]')), []);
  assert.deepEqual(codes(eff('read:store', 'egress: "https://a.example/v1/"')), ['PL6303']);
  assert.deepEqual(codes(eff('egress:external', 'exec: ["git"]')), ['PL6303']);
  assert.deepEqual(codes(eff('egress:external', 'store: ["t"]')), ['PL6303']);
  assert.deepEqual(codes(eff('egress:external', 'egress: "ftp://a.example/"')), ['PL1201']);
  assert.deepEqual(codes(eff('egress:external', 'egress: "https://user@a.example/"')), ['PL1201']);
  assert.deepEqual(codes(eff('egress:external', 'egress: "https://a.example/v1?x=1"')), ['PL1201']);
  assert.deepEqual(codes(eff('egress:external', 'egress: "/v1"')), ['PL1201']);
  assert.deepEqual(codes(eff('egress:external', 'egress: "https://a.example/", egress: "https://b.example/"')), ['PL1002']);
  assert.deepEqual(codes(eff('egress:external', 'mail: ["x"]')), ['PL1001']);
});

/** A host egress transport that records each request and answers by URL. */
function transports(answers = {}) {
  const calls = { egress: [], secrets: [], exec: [], store: [] };
  return {
    calls,
    transports: {
      egress: async (req) => { calls.egress.push(req); return answers[req.url] ?? { status: 200, headers: {}, body: { ok: true } }; },
      secrets: async (name) => { calls.secrets.push(name); return `secret-of-${name}`; },
      exec: async (command, args) => { calls.exec.push([command, args]); return { code: 0 }; },
      store: { read: async (table, key) => { calls.store.push(['read', table, key]); return null; }, write: async (table, key, value) => { calls.store.push(['write', table, key, value]); } },
    },
  };
}

async function run(name, kind, action, script, answers) {
  const a = await admitted(name, [SRC]);
  const t = transports(answers);
  const { rt } = await loaded(a, { transports: t.transports });
  let seen;
  handleWith(rt, kind, async (_payload, caps, ctx) => { seen = { caps, out: await script(caps, ctx) }; return {}; });
  await rt.create('caps.Order', { id: 'o1' });
  await rt.dispatch('o1', action, {});
  await rt.worker.tick();
  const audit = await rt.audit('o1');
  await rt.close();
  return { seen, calls: t.calls, audit };
}

const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };

test('S134: egress to the declared prefix reaches the host transport; any other URL throws before it, and is audited', async () => {
  const outside = [
    'https://api.psp.example/v1/refunds',
    'https://api.psp.example/v1/charges-evil',
    'https://api.psp.example/v1/charges/../refunds',
    'https://api.psp.example/v1/charges/%2e%2e/refunds',
    'https://api.psp.example.evil.com/v1/charges',
    'https://x@api.psp.example/v1/charges',
    'http://api.psp.example/v1/charges',
    'https://api.psp.example:8443/v1/charges',
    'file:///etc/passwd',
    'not a url',
  ];
  const { seen, calls, audit } = await run('caps-egress', 'payment.charge', 'Charge', async (caps) => {
    const ok = [await caps.egress.post('https://api.psp.example/v1/charges', { amount: 1 }), await caps.egress.get('https://API.psp.example:443/v1/charges/ch_1?expand=x')];
    const errors = [];
    for (const u of outside) errors.push(await refused(caps.egress.get(u)));
    return { ok, errors, key: await caps.secrets.get('PSP_KEY'), other: await refused(caps.secrets.get('OTHER_KEY')) };
  });
  assert.equal(seen.out.ok.length, 2);
  assert.deepEqual(calls.egress.map((r) => [r.method, r.url]), [['POST', 'https://api.psp.example/v1/charges'], ['GET', 'https://api.psp.example/v1/charges/ch_1?expand=x']]);
  for (const [i, e] of seen.out.errors.entries()) assert.ok(e instanceof CapabilityRefused, `${outside[i]}: ${e}`);
  assert.equal(seen.out.key, 'secret-of-PSP_KEY');
  assert.ok(seen.out.other instanceof CapabilityRefused);
  assert.deepEqual(calls.secrets, ['PSP_KEY']);
  const rows = audit.filter((r) => r.rule === 'PL6406');
  assert.equal(rows.length, outside.length + 1, JSON.stringify(audit));
  assert.ok(rows.every((r) => r.action === 'payment.charge'));
  assert.ok(Object.isFrozen(seen.caps) && Object.isFrozen(seen.caps.egress));
  assert.deepEqual(Object.keys(seen.caps).sort(), ['egress', 'secrets']);
});

test('S151: every redirect hop is checked against the prefix; a hop outside it throws before that request', async () => {
  const answers = {
    'https://api.psp.example/v1/charges/a': { status: 302, headers: { Location: '/v1/charges/b' } },
    'https://api.psp.example/v1/charges/b': { status: 200, headers: {}, body: 'b' },
    'https://api.psp.example/v1/charges/c': { status: 307, headers: { location: 'https://evil.example/steal' } },
    'https://api.psp.example/v1/charges/d': { status: 301, headers: { location: '../admin' } },
    'https://api.psp.example/v1/charges/loop': { status: 302, headers: { location: '/v1/charges/loop' } },
  };
  const { seen, calls, audit } = await run('caps-redirect', 'payment.charge', 'Charge', async (caps) => ({
    b: await caps.egress.get('https://api.psp.example/v1/charges/a'),
    c: await refused(caps.egress.post('https://api.psp.example/v1/charges/c', { x: 1 })),
    d: await refused(caps.egress.get('https://api.psp.example/v1/charges/d')),
    loop: await refused(caps.egress.get('https://api.psp.example/v1/charges/loop')),
  }), answers);
  assert.equal(seen.out.b.body, 'b');
  assert.ok(seen.out.c instanceof CapabilityRefused && /redirect/.test(seen.out.c.message), String(seen.out.c));
  assert.ok(seen.out.d instanceof CapabilityRefused);
  assert.ok(seen.out.loop instanceof Error && /redirects/.test(seen.out.loop.message));
  const urls = calls.egress.map((r) => r.url);
  assert.ok(!urls.some((u) => u.startsWith('https://evil.example') || u.endsWith('/v1/admin')), JSON.stringify(urls));
  assert.deepEqual(urls.slice(0, 4), ['https://api.psp.example/v1/charges/a', 'https://api.psp.example/v1/charges/b', 'https://api.psp.example/v1/charges/c', 'https://api.psp.example/v1/charges/d']);
  assert.equal(audit.filter((r) => r.rule === 'PL6406').length, 2);
});

test('S134: a handler gets only what its labels grant: write:store gives store.write over the declared tables, and no egress', async () => {
  const note = await run('caps-store', 'orders.note', 'Note', async (caps) => ({ keys: Object.keys(caps), store: Object.keys(caps.store).sort(), w: await caps.store.write('notes', 'k', 1), bad: await refused(caps.store.write('orders', 'k', 1)) }));
  assert.deepEqual(note.seen.out.keys, ['store']);
  assert.deepEqual(note.seen.out.store, ['write']);
  assert.ok(note.seen.out.bad instanceof CapabilityRefused);
  assert.deepEqual(note.calls.store, [['write', 'notes', 'k', 1]]);
  const ping = await run('caps-none', 'orders.ping', 'Ping', async (caps) => ({ keys: Object.keys(caps), egress: caps.egress, read: await refused(caps.store.read('notes', 'k')) }));
  assert.deepEqual(ping.seen.out.keys, ['store']);
  assert.equal(ping.seen.out.egress, undefined);
  assert.ok(ping.seen.out.read instanceof CapabilityRefused, 'read:store with no declared table reads nothing');
  assert.deepEqual(ping.calls.store, []);
});

test('S151: poly-runtime imports no network module, and the boundary check would see one', () => {
  assert.deepEqual(checkRepository(ROOT).filter((v) => v.startsWith('packages/poly-runtime/')), []);
  assert.ok(violationsOf('poly-runtime', 'a.ts', "import http from 'node:http'\n").length >= 1);
  assert.ok(violationsOf('poly-runtime', 'a.ts', "const r = await fetch('https://x')\n").length >= 1);
});
