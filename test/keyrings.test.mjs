// S194 (M9, as ruled): a keyring change is signed by a person already trusted, and the first rings are anchored
// outside the project, so an agent that can edit poly.json and holds the admission key cannot add its own key under
// people and sign as a person (PT12.5). The anchor's location comes from the owner's per-user configuration, never
// from poly.json; this test process reads a folder of its own (runtime-helpers' useTestAnchors). Each test failed on
// the tree before its change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admit, AdmitError, commandNamed } from '@poly/check';
import { keyringDigest, keyringSubject, keyringsOf, signRecord } from '@poly/core';
import { load, LoadError } from '@poly/runtime';
import { AGENT, ANCHORS, PERSON, makeKey, makePerson, project } from './runtime-helpers.mjs';

const SOURCES = ['conformance/m4/outbox.poly'];
const rings = (people, agents = [AGENT]) => ({ people: people.map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey })), agents: agents.map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey })) });
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const CONFIG = join(ANCHORS, 'anchors.json');
function setRings(dir, r) {
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify({ ...readJson(pj), ...r }, null, 2));
}
function writeHistory(dir, entries) {
  mkdirSync(join(dir, 'keyrings'), { recursive: true });
  writeFileSync(join(dir, 'keyrings', 'history.json'), JSON.stringify(entries, null, 2));
}
function setAnchorLocation(name, location) {
  const doc = readJson(CONFIG);
  if (location === undefined) delete doc.anchors[name]; else doc.anchors[name] = location;
  writeFileSync(CONFIG, JSON.stringify(doc, null, 2));
}
/** A history entry for `next`, after `prev`, signed by `signer`. */
const entry = (prev, next, signer) => ({ rings: next, record: signRecord({ kind: 'keyring', subject: keyringSubject(keyringDigest(prev), keyringDigest(next)), by: signer.keyId, at: '2026-10-06T00:00:00.000Z' }, signer.privateKeyPem) });
const refusedKeyring = (e) => e instanceof AdmitError && /PL6410/.test(e.message);
/** Runs a command with a person key written, outside the repository, for the command only. */
async function withKeyFile(name, who, run) {
  const file = join(dirname(makeKey(`${name}-holder`).file), `${name}-person.pem`);
  writeFileSync(file, who.privateKeyPem);
  try { return await run(file); } finally { rmSync(file); }
}

test('S194: a project whose first rings have the anchor\'s digest is admitted, and the certificate binds the anchor, the chain and its source', async () => {
  const dir = project('kr-ok', SOURCES, makeKey('kr-ok'), 'test-keyrings');
  const r = await admit(dir);
  const first = keyringDigest(rings([PERSON]));
  assert.deepEqual(r.certificate.poly.keyringChain, { anchor: first, head: first, source: 'test' });
});

test('S194: rings with no anchor, an anchor of other rings, an anchor that is a folder or not absolute, are refused PL6410', async () => {
  const dir = project('kr-no-anchor', SOURCES, makeKey('kr-no-anchor'), 'test-keyrings');
  const file = readJson(CONFIG).anchors['kr-no-anchor'].slice('file:'.length);
  setAnchorLocation('kr-no-anchor', undefined);
  await assert.rejects(admit(dir), refusedKeyring, 'no anchor');
  setAnchorLocation('kr-no-anchor', `file:${file}`);
  writeFileSync(file, `${keyringDigest(rings([makePerson('other')]))}\n`);
  await assert.rejects(admit(dir), refusedKeyring, 'another anchor');
  // Polywatch: a folder in place of the anchor file is a refusal, not a bare EISDIR.
  setAnchorLocation('kr-no-anchor', `file:${dirname(file)}`);
  await assert.rejects(admit(dir), refusedKeyring, 'a folder');
  setAnchorLocation('kr-no-anchor', 'file:relative.anchor');
  await assert.rejects(admit(dir), refusedKeyring, 'a relative path');
});

test('S194: an agent key added to people without a keyring record is refused, and so is a record the new key signs itself, or a malformed one', async () => {
  const dir = project('kr-added', SOURCES, makeKey('kr-added'), 'test-keyrings');
  const intruder = makePerson('intruder');
  const first = rings([PERSON]);
  const widened = rings([PERSON, intruder]);
  setRings(dir, widened);
  await assert.rejects(admit(dir), refusedKeyring, 'no record');
  writeHistory(dir, [{ rings: first }, entry(first, widened, intruder)]);
  await assert.rejects(admit(dir), refusedKeyring, 'signed by the new key');
  writeHistory(dir, [{ rings: first }, { rings: widened, record: entry(first, rings([PERSON, makePerson('x')]), PERSON).record }]);
  await assert.rejects(admit(dir), refusedKeyring, 'another subject');
  // Polywatch: a record that is not an object, or lacks its fields, is a refusal like any other.
  for (const record of [null, 'signed', { kind: 'keyring' }]) {
    writeHistory(dir, [{ rings: first }, { rings: widened, record }]);
    await assert.rejects(admit(dir), refusedKeyring, JSON.stringify(record));
  }
});

test('S194: a change signed by a person of the previous ring is admitted, and the chain\'s head is the new rings', async () => {
  const dir = project('kr-signed', SOURCES, makeKey('kr-signed'), 'test-keyrings');
  const first = rings([PERSON]);
  const next = rings([PERSON, makePerson('second')]);
  setRings(dir, next);
  writeHistory(dir, [{ rings: first }, entry(first, next, PERSON)]);
  const r = await admit(dir);
  assert.deepEqual(r.certificate.poly.keyringChain, { anchor: keyringDigest(first), head: keyringDigest(next), source: 'test' });
  assert.equal(keyringDigest(r.certificate.poly.keyrings), keyringDigest(keyringsOf(dir, readJson(join(dir, 'poly.json')))));
});

test('S194: rings changed after admission are refused at load, PL6405', async () => {
  const key = makeKey('kr-load');
  const dir = project('kr-load', SOURCES, key, 'test-keyrings');
  const r = await admit(dir);
  setRings(dir, rings([PERSON, makePerson('late')]));
  await assert.rejects(load(join(dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }), (e) => e instanceof LoadError && /PL6405/.test(e.message));
});

test('S194, as ruled: poly.json cannot name the anchor, and an anchor inside the project is refused', async () => {
  const dir = project('kr-manifest', SOURCES, makeKey('kr-manifest'), 'test-keyrings');
  const pj = join(dir, 'poly.json');
  const m = readJson(pj);
  writeFileSync(pj, JSON.stringify({ ...m, keys: { ...m.keys, anchor: 'file:/elsewhere.anchor' } }, null, 2));
  await assert.rejects(admit(dir), /keys\.anchor/);
  writeFileSync(pj, JSON.stringify(m, null, 2));
  const inside = join(dir, 'anchor.txt');
  writeFileSync(inside, `${keyringDigest(rings([PERSON]))}\n`);
  setAnchorLocation('kr-manifest', `file:${inside}`);
  await assert.rejects(admit(dir), refusedKeyring, 'an anchor inside the project');
});

test('S194, polywatch: a certificate admitted with a test anchor is refused at load by a process that does not accept test anchors', async () => {
  const key = makeKey('kr-test-source');
  const dir = project('kr-test-source', SOURCES, key, 'test-keyrings');
  const r = await admit(dir);
  assert.equal(r.certificate.poly.keyringChain.source, 'test');
  // This process accepts test anchors (runtime-helpers); a fresh one, as a production runtime is, does not.
  const script = `import { load } from '@poly/runtime';\ntry { await load(${JSON.stringify(join(dir, '.poly', 'build'))}, { certificate: ${JSON.stringify(r.certificatePath)}, trust: ${JSON.stringify({ [key.id]: key.publicKey })} }); console.log('loaded'); } catch (e) { console.log(e.message); }\n`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.match(out, /PL6410.*test keyring anchor/);
});

test('S194: poly anchor keyrings and poly sign keyrings are the owner\'s commands, never over MCP, and their output admits', async () => {
  for (const name of ['anchor-keyrings', 'sign-keyrings']) assert.equal(commandNamed(name).mcp, null, name);
  const key = makeKey('kr-cli');
  const dir = project('kr-cli', SOURCES, key, 'test-keyrings');
  setAnchorLocation('kr-cli', undefined);
  // In process, so the command writes this test's anchor folder and never the owner's configuration.
  const out = join(dirname(key.file), 'kr-cli.cli.anchor');
  const a = await commandNamed('anchor-keyrings').run({ out, project: dir });
  assert.equal(a.result.config, CONFIG);
  assert.equal(readJson(CONFIG).anchors['kr-cli'], `file:${out}`);
  await admit(dir);
  // The owner adds a person, and signs the change with a key of the certified people ring.
  const second = makePerson('second');
  setRings(dir, rings([PERSON, second]));
  await withKeyFile('kr-cli', PERSON, (file) => commandNamed('sign-keyrings').run({ by: PERSON.keyId, key: file, project: dir }));
  const r = await admit(dir);
  assert.equal(r.certificate.poly.keyringChain.head, keyringDigest(rings([PERSON, second])));
});

test('S194, polywatch: with the history deleted, poly sign keyrings refuses certified rings that are not the anchored first rings', async () => {
  const dir = project('kr-lost', SOURCES, makeKey('kr-lost'), 'test-keyrings');
  const first = rings([PERSON]);
  const second = rings([PERSON, makePerson('second')]);
  setRings(dir, second);
  writeHistory(dir, [{ rings: first }, entry(first, second, PERSON)]);
  await admit(dir);
  rmSync(join(dir, 'keyrings'), { recursive: true });
  setRings(dir, rings([PERSON, makePerson('third')]));
  await withKeyFile('kr-lost', PERSON, (file) => assert.rejects(commandNamed('sign-keyrings').run({ by: PERSON.keyId, key: file, project: dir }), /PL6410.*not the anchored first rings/));
});

test('S194, polywatch: an anchor named ..anchor inside a project outside version control is inside the project, and refused', async () => {
  const { cpSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const made = project('kr-dotdot', SOURCES, makeKey('kr-dotdot'), 'test-keyrings');
  const dir = join(mkdtempSync(join(tmpdir(), 'poly-kr-')), 'kr-dotdot');
  cpSync(made, dir, { recursive: true });
  const inside = join(dir, '..anchor');
  writeFileSync(inside, `${keyringDigest(rings([PERSON]))}\n`);
  setAnchorLocation('kr-dotdot', `file:${inside}`);
  await assert.rejects(admit(dir), refusedKeyring, 'a ..anchor inside the project');
});

test('S194, polywatch: poly sign keyrings refuses to extend a history that does not start at the anchored rings', async () => {
  const dir = project('kr-bad-history', SOURCES, makeKey('kr-bad-history'), 'test-keyrings');
  const stranger = rings([makePerson('stranger')]);
  writeHistory(dir, [{ rings: stranger }]);
  setRings(dir, rings([PERSON, makePerson('second')]));
  await withKeyFile('kr-bad-history', PERSON, (file) => assert.rejects(commandNamed('sign-keyrings').run({ by: PERSON.keyId, key: file, project: dir }), /PL6410.*anchor/));
  assert.deepEqual(readJson(join(dir, 'keyrings', 'history.json')), [{ rings: stranger }], 'nothing is written');
});
