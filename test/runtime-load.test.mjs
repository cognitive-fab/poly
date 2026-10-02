// M4a, the load half (PT15, PF8.1, S126): the runtime loads only an admitted build, and refuses every tampering
// with a certified artefact or with the certificate, naming the artefact and both digests. The bytes polyrun
// registers are the bytes checked: they are copied, once verified, to a directory named by the build id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, LoadError } from '@poly/runtime';
import { admitted, makeKey } from './runtime-helpers.mjs';

const a = await admitted('load', ['conformance/m1/effects.poly', 'conformance/m1/children.poly']);
const machineDir = (id) => join(a.dir, a.cert.subject.machines.find((m) => m.id === id).dir);

async function refused(mutate, restore, pattern) {
  mutate();
  try {
    await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust }), (e) => e instanceof LoadError && pattern.test(e.message), String(pattern));
  } finally {
    restore();
  }
}

test('the untouched build loads, registers every certified machine, and steps', async () => {
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust });
  try {
    const o = await rt.create('shop.Order');
    const r = await rt.dispatch(o.id, 'Checkout');
    assert.equal(r.stepKind, 'accepted');
    assert.ok(existsSync(join(a.dir, '.poly', 'run', a.cert.buildId, 'shop.Order', 'next.cjs')));
  } finally { await rt.close(); }
});

test('a changed byte in any certified artefact is refused, naming it and both digests', async () => {
  for (const name of ['next.cjs', 'contract.json', 'effects.cjs', 'effects.manifest.json', 'invariants.mjs']) {
    const f = join(machineDir('effects.Account'), name);
    const original = readFileSync(f);
    await refused(() => appendFileSync(f, ' '), () => writeFileSync(f, original), new RegExp(`${name.replace('.', '\\.')}: changed since certification \\(certified sha256:[0-9a-f]{64}, found sha256:[0-9a-f]{64}\\)`));
  }
});

test('a certified artefact removed, and an artefact added, are refused', async () => {
  const f = join(machineDir('shop.Order'), 'effects.cjs');
  const original = readFileSync(f);
  await refused(() => rmSync(f), () => writeFileSync(f, original), /effects\.cjs: certified but missing/);
  const added = join(machineDir('shop.Order'), 'liveness.mjs');
  if (existsSync(added)) assert.fail('the fixture already has liveness.mjs');
  await refused(() => writeFileSync(added, 'export const goals = {};\n'), () => rmSync(added), /liveness\.mjs: present but not certified/);
});

test('an edited certificate, a bad signature and an unknown key are refused', async () => {
  const original = readFileSync(a.certificate, 'utf8');
  const edit = (f) => () => { const c = JSON.parse(original); f(c); writeFileSync(a.certificate, JSON.stringify(c)); };
  const restore = () => writeFileSync(a.certificate, original);
  await refused(edit((c) => { c.poly.limits = []; }), restore, /certificate: the certificate was edited after it was sealed/);
  await refused(edit((c) => { const s = Buffer.from(c.signatures[0].sig, 'base64'); s[0] ^= 1; c.signatures[0].sig = s.toString('base64'); }), restore, /signature: the signature by .* does not verify/);
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: { [a.key.id]: makeKey('stranger').publicKey } }), /does not verify/);
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: {} }), /is not trusted/);
});

test('a build with no certificate is not loaded (PF8.1)', async () => {
  await assert.rejects(load(a.build, { certificate: join(a.dir, 'nothing.json'), trust: a.trust }), /only admitted programs/);
});

test('a manifest entry without its retry bound is refused at load (S120)', async () => {
  // Signed by the admission key over a manifest whose bound was removed: only the S120 rule can refuse it.
  const b = await admitted('noretry', ['conformance/m1/effects.poly']);
  const dir = join(b.dir, b.cert.subject.machines[0].dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'effects.manifest.json'), 'utf8'));
  for (const e of Object.values(manifest.effects)) delete e.retry;
  writeFileSync(join(dir, 'effects.manifest.json'), JSON.stringify(manifest));
  const { sha256OfBytes, certificateDigest, signDigest } = await import('@poly/core');
  const cert = JSON.parse(readFileSync(b.certificate, 'utf8'));
  cert.artefacts[`${b.cert.subject.machines[0].dir}/effects.manifest.json`] = sha256OfBytes(readFileSync(join(dir, 'effects.manifest.json')));
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, b.key.id, readFileSync(b.key.file, 'utf8'))];
  writeFileSync(b.certificate, JSON.stringify(cert));
  await assert.rejects(load(b.build, { certificate: b.certificate, trust: b.trust }), /declares no retry\.maxAttempts.*S120/);
});

test('polyrun\'s own workers cannot be started beside the OutboxIntent worker (S119)', async () => {
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust });
  try { assert.throws(() => rt.kernel.startWorkers(), /use rt\.startWorkers \(S119\)/); } finally { await rt.close(); }
});
