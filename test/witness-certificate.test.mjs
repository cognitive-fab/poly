// S139: exported witness tests run through the runtime API, through a witness certificate, never an unchecked
// loader. `poly admit --witness` issues it for a program with findings: the same format, purpose "witness", the
// findings listed, signed with a test key. `load` refuses it unless the caller passes allowWitness, and refuses
// that option in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { admitWitness, admit, AdmitError, checkFile, exportWitness, findWitness } from '@poly/check';
import { load, LoadError } from '@poly/runtime';
import { ROOT, BUILD } from './helpers.mjs';

const ephemeral = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id: 'witness-test', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const runTest = (file) => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env }); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];

function seeded(kind, which, name) {
  const dir = join(BUILD, 'witness-cert', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'm.poly');
  copyFileSync(join(ROOT, ...kind, `${which}.poly`), file);
  return { dir, file };
}

test('a witness certificate lists the findings, and load refuses it unless allowWitness, which production refuses', async () => {
  const { dir, file } = seeded(['conformance', 'm2', 'seeded', 'invariant'], 'unfixed', 'refusal');
  const key = ephemeral();
  const out = join(dir, '.poly', 'witness.certificate.json');
  const r = await admitWitness(file, { root: dir, key, out });
  assert.equal(r.certificate.purpose, 'witness');
  assert.deepEqual(r.certificate.findings.map((f) => f.code), ['PL3001']);
  const build = join(dir, '.poly', 'build');
  const trust = { [key.id]: key.publicKey };
  await assert.rejects(load(build, { certificate: out, trust }), (e) => e instanceof LoadError && /witness certificate/.test(e.message));
  const rt = await load(build, { certificate: out, trust, allowWitness: true });
  await rt.close();
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(load(build, { certificate: out, trust, allowWitness: true }), /allowWitness is refused in production/);
  } finally { if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; }
});

test('a witness certificate is never a program certificate: admit still refuses the same program', async () => {
  const { dir, file } = seeded(['conformance', 'm2', 'seeded', 'invariant'], 'unfixed', 'plain');
  await assert.rejects(admit(file, { key: ephemeral() }), (e) => e instanceof AdmitError && /FINDINGS/.test(e.message));
  void dir;
});

test('an exported witness test walks the runtime: PL6203 fails on the unfixed program and passes on the fixed one', async () => {
  const { dir, file } = seeded(['conformance', 'm4', 'seeded', 'adjudication'], 'unfixed', 'pl6203');
  const r = await checkFile(file, { root: dir });
  const d = all(r).find((x) => x.code === 'PL6203');
  const exported = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const failing = runTest(exported);
  assert.notEqual(failing.status, 0, failing.stdout);
  assert.match(failing.stdout, /adjudicates route with no decision event/);
  assert.match(failing.stdout, /walked through poly-runtime/);
  copyFileSync(join(ROOT, 'conformance', 'm4', 'seeded', 'adjudication', 'fixed.poly'), file);
  const passing = runTest(exported);
  assert.equal(passing.status, 0, passing.stdout);
});

test('poly admit --witness from the command line, with a key file outside the repository', async () => {
  const { dir, file } = seeded(['conformance', 'm2', 'seeded', 'invariant'], 'unfixed', 'cli');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const k = ephemeral();
  const keyFile = join(mkdtempSync(join(tmpdir(), 'poly-witness-key-')), 'k.pem');
  writeFileSync(keyFile, k.privateKeyPem);
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'admit', '--witness', file, '--key', keyFile, '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 finding\(s\)/);
  const cert = JSON.parse(readFileSync(join(dir, '.poly', 'witness.certificate.json'), 'utf8'));
  assert.equal(cert.purpose, 'witness');
  assert.equal(spawnSync(process.execPath, [cli, 'admit', '--witness', file, '--root', dir], { encoding: 'utf8' }).status, 64);
});
