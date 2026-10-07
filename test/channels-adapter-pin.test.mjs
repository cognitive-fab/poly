// M8 plan step 10 (S182, PT20.2): the runtime adapter is certified. Admission binds each channel's adapter by package
// name, version and digest; load refuses a runtime whose adapter package differs; rt.connectChannel takes only an
// adapter made by the certified package, of the channel's declared adapter. The broken variant, a certificate with a
// stale adapter digest, is in the explicit list of toolchain faults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { certificateDigest, signDigest } from '@poly/core';
import { load } from '@poly/runtime';
import { whatsapp, sms } from '@poly/io';
import { admitted, loaded } from './runtime-helpers.mjs';

const SOURCE = ['conformance/m8/concierge/concierge.poly'];
const WA = { appSecret: 'a', accessToken: 'b', phoneNumberId: '106540352242922', verifyToken: 'c', apiVersion: 'v23.0' };

test('S182: the certificate binds each channel\'s adapter by package name, version and digest', { timeout: 300_000 }, async () => {
  const a = await admitted('pin-adapters', SOURCE);
  const pkg = JSON.parse(readFileSync(new URL('../packages/poly-io/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(a.cert.poly.adapters.map((x) => [x.channel, x.adapter, x.package, x.version]), [['staff', 'slack', '@poly/io', pkg.version], ['support', 'whatsapp', '@poly/io', pkg.version], ['text', 'sms', '@poly/io', pkg.version]]);
  for (const x of a.cert.poly.adapters) assert.match(x.digest, /^sha256:[0-9a-f]{64}$/);
});

test('S182: rt.connectChannel takes only an adapter made by the certified package, of the channel\'s declared adapter', { timeout: 300_000 }, async () => {
  const a = await admitted('pin-connect', SOURCE);
  const { rt } = await loaded(a);
  try {
    // A look-alike: every field an adapter has, made outside the certified package.
    const real = whatsapp(WA);
    const lookalike = { kind: real.kind, provider: real.provider, sender: real.sender, verify: real.verify, send: real.send };
    assert.throws(() => rt.connectChannel('support', lookalike, {}), /PL6408.*not made by the certified @poly\/io/);
    assert.throws(() => rt.connectChannel('support', sms({ accountSid: 'AC', authToken: 't', from: '+1' }), {}), /PL6408.*declares adapter whatsapp/);
    rt.connectChannel('support', real, {});
  } finally { await rt.close(); }
});

test('S182: load refuses a build admitted with another adapter package', { timeout: 300_000 }, async () => {
  const a = await admitted('pin-load', SOURCE);
  const cert = JSON.parse(readFileSync(a.certificate, 'utf8'));
  cert.poly.adapters[0].digest = 'sha256:' + '0'.repeat(64);
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, a.key.id, readFileSync(a.key.file, 'utf8'))];
  writeFileSync(a.certificate, JSON.stringify(cert));
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust }), /admitted with @poly\/io .* sha256:0{64}; this runtime has/);
});

// Ruled on step 10 (S191), lifted in M9 (S205): the certificate of a build with channels named the limit that its
// journal held the correspondents' addresses. Addresses are now kept only in the erasable store (test/erasure.test.mjs).
test('S191, S205: the certificate of a build with channels no longer names the address limit', { timeout: 300_000 }, async () => {
  const a = await admitted('pin-limit', SOURCE);
  assert.ok(!a.cert.poly.limits.some((l) => /S191/.test(l)), JSON.stringify(a.cert.poly.limits));
});
