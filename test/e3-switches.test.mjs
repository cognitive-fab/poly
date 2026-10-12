// plan-e3.md, owner's ruling of 2026-10-11 (step 3): reading the mechanisms through the secrets capability must not give the
// classifier a credential-egress finding (PL7001), and the scan must not treat the switches as secrets.
//
// PL7001 is polycheck's region witness: an effect that reads a secret and can send out, with no gate in between. The
// classifier reads the secret `mechanisms` and has no egress, so the region is unreachable. The control gives it an egress
// label and a URL, and the region is then reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilitiesFor } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { checkExample } from './examples-expected.mjs';
import { sharedBuild } from './e3-loop-helpers.mjs';
import { makeHost } from '../examples/harness/host/transports.mjs';
import { scanText } from '../examples/harness/host/handlers/scan.mjs';

const DIR = join(ROOT, 'examples', 'harness');
const OUT = join(ROOT, '.poly', 'test-build', 'e3-switches');
const CLASSIFY = '    labels { read:private, write:store }\n    targets { secrets: ["mechanisms"], store: ["calls"] }';

test('PL7001: the harness is admitted CLEAN and no region witness is reported, with the classifier reading the switches', { timeout: 900_000 }, async () => {
  const a = await sharedBuild();
  assert.equal(a.result.verdict, 'CLEAN');
  assert.ok(!JSON.stringify(a.result.report).includes('PL7001'), 'the admission report holds no PL7001');
  const program = readFileSync(join(DIR, 'harness.poly'), 'utf8');
  assert.ok(program.includes(CLASSIFY), 'the classifier declares the secret and the table, and no egress');
});

test('PL7001, control: the same classifier with an egress label and a URL reaches the credential-egress region', { timeout: 900_000 }, async () => {
  const program = readFileSync(join(DIR, 'harness.poly'), 'utf8');
  assert.equal(program.split(CLASSIFY).length, 2);
  const leaky = program.replace(CLASSIFY, '    labels { read:private, write:store, egress:external }\n    targets { secrets: ["mechanisms"], store: ["calls"], egress: exact "https://example.com/classify" }');
  const dir = join(OUT, 'egress');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'harness.poly'), leaky);
  writeFileSync(join(dir, 'harness.policy.poly'), readFileSync(join(DIR, 'harness.policy.poly'), 'utf8'));
  cpSync(join(DIR, 'prices'), join(dir, 'prices'), { recursive: true });
  const r = await checkExample(join(dir, 'harness.poly'), join(dir, 'root'), 'e3-switches-egress');
  const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code);
  assert.ok(codes.includes('PL7001'), `the control reached no region: ${codes.join(' ')}`);
});

test('the scan does not treat the switches as secrets: the known secrets are the vault\'s list alone, and the switches are visible to the classifier alone', { timeout: 900_000 }, async () => {
  const token = `canary-${'ab'.repeat(12)}`;
  const host = makeHost({ known: [token] });
  host.setMechanisms({ fusion: true, compaction: false, pack: true, reducer: false });
  const known = JSON.parse(host.transports.secrets('known-secrets'));
  assert.deepEqual(known, [token], 'the vault\'s list holds only the vault\'s secrets');
  const switches = host.transports.secrets('mechanisms');
  assert.ok(!known.some((k) => switches.includes(k) || k.includes(switches)));
  // a tool output that holds the switches, in any form the host writes them, is not flagged
  for (const text of [switches, `config: ${switches}`, `mechanisms=${JSON.stringify({ fusion: true })}`, 'fusion on, compaction off, pack on, reducer off']) {
    assert.equal(scanText(text, known).clean, true, text);
  }
  // each effect reads only the secrets it declares: the scan reads the vault's list and not the switches, the classifier the switches and not the list
  const a = await sharedBuild();
  const kinds = {};
  for (const dir of readdirSync(a.build).filter((d) => d.startsWith('harness.') && !d.includes('.task.'))) {
    Object.assign(kinds, JSON.parse(readFileSync(join(a.build, dir, 'effects.manifest.json'), 'utf8')).effects);
  }
  const capsOf = (kind) => capabilitiesFor({ labels: kinds[kind].labels, targets: kinds[kind].targets }, host.transports, async () => {});
  assert.equal(await capsOf('tool.scan').secrets.get('known-secrets'), JSON.stringify([token]));
  await assert.rejects(capsOf('tool.scan').secrets.get('mechanisms'), /PL6406|not among the declared secrets/);
  assert.equal(await capsOf('tool.classify').secrets.get('mechanisms'), switches);
  await assert.rejects(capsOf('tool.classify').secrets.get('known-secrets'), /PL6406|not among the declared secrets/);
  // no other effect can read either
  for (const [kind, decl] of Object.entries(kinds)) {
    if (kind.startsWith('decision.') || kind === 'tool.scan' || kind === 'tool.classify') continue;
    assert.ok(!(decl.targets?.secrets ?? []).length, `${kind} declares a secret`);
  }
  assert.ok(existsSync(DIR));
});
