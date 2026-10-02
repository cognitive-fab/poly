// PT6.5, S152 (M5b step 17): the opt-in OpenShell sandbox. With `isolation: "openshell"` in poly.json, the lowering
// generates one OpenShell policy per effect kind from its labels and targets, deterministically, into the artefact
// openshell.policies.yaml, which admission certifies and translation validation reads back against the source. The
// generated policy allows exactly the declared prefixes (host, port, path), binds the declared secrets as providers,
// gives no network at all to a kind with no egress label, and keeps the filesystem to a scratch directory.
// Enforcement needs an OpenShell gateway (Linux 6.2 or later); where none is configured it is listed as not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { ROOT, build } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const SRC = join(ROOT, 'conformance/m5/capabilities.poly');

test('S152: the policy of each effect kind allows exactly its declared targets, and nothing for a kind without egress', () => {
  const [m] = build(SRC, 'sandbox', { isolation: 'openshell' });
  const text = m.lowered.files['openshell.policies.yaml'];
  assert.ok(text, Object.keys(m.lowered.files).join(', '));
  const policies = JSON.parse(text);
  assert.deepEqual(Object.keys(policies).sort(), ['orders.note', 'orders.ping', 'payment.charge']);
  const charge = policies['payment.charge'];
  assert.equal(charge.version, 1);
  assert.deepEqual(charge.filesystem_policy, { include_workdir: false, read_only: ['/usr', '/lib', '/etc/ssl'], read_write: ['/sandbox/scratch'] });
  const endpoints = Object.values(charge.network_policies).flatMap((p) => p.endpoints);
  assert.deepEqual(endpoints.map((e) => [e.host, e.port, e.path, e.credential_binding?.provider]).sort(), [
    ['api.psp.example', 443, '/v1/charges', 'PSP_KEY'],
    ['api.psp.example', 443, '/v1/charges/**', 'PSP_KEY'],
  ]);
  assert.deepEqual(policies['orders.ping'].network_policies, {});
  assert.deepEqual(policies['orders.note'].network_policies, {});
  // Deterministic: the same source gives the same bytes.
  const [again] = build(SRC, 'sandbox-again', { isolation: 'openshell' });
  assert.equal(again.lowered.files['openshell.policies.yaml'], text);
  // Without the option, no sandbox policy is generated.
  const [plain] = build(SRC, 'sandbox-plain');
  assert.equal(plain.lowered.files['openshell.policies.yaml'], undefined);
});

test('S152: admission certifies the generated policy, and translation validation reads it back', async () => {
  const key = makeKey('sandbox');
  const dir = project('sandbox-admit', ['conformance/m5/capabilities.poly'], key);
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...manifest, isolation: 'openshell' }, null, 2));
  const admitted = await admit(dir);
  const certified = Object.keys(admitted.certificate.artefacts).filter((p) => p.endsWith('openshell.policies.yaml'));
  assert.deepEqual(certified, ['.poly/build/caps.Order/openshell.policies.yaml']);
  // Review D-F5: the certificate says the policy is not enforced by this runtime (not run), never leaves it implied.
  assert.ok(admitted.certificate.poly.limits.some((l) => /does not enforce them[\s\S]*not run/.test(l)));
  const r = await checkFile(SRC, { root: join(ROOT, '.poly', 'test-sandbox'), isolation: 'openshell' });
  assert.equal(r.verdict, 'CLEAN');
  const m = r.machines[0];
  assert.ok(m.artefactDigests['openshell.policies.yaml'], JSON.stringify(Object.keys(m.artefactDigests ?? {})));
  const onDisk = readFileSync(join(m.buildDir, 'openshell.policies.yaml'), 'utf8');
  assert.match(onDisk, /"api\.psp\.example"/);
});

test('S152: enforcement through an OpenShell gateway', { skip: process.env.POLY_OPENSHELL_GATEWAY ? false : 'not run: no OpenShell gateway is configured (POLY_OPENSHELL_GATEWAY), and enforcement needs one on Linux 6.2 or later (S152)' }, () => {
  assert.fail('an enforcement run against a configured gateway is not written: no gateway is available to this repository');
});
