// S194 (M9, as ruled): a keyring change is signed by a person already trusted, and the first rings are anchored
// outside the project, so an agent that can edit poly.json and holds the admission key cannot add its own key under
// people and sign as a person (PT12.5). Each test failed on the tree before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admit, AdmitError } from '@poly/check';
import { keyringDigest, keyringSubject, keyringsOf, signRecord } from '@poly/core';
import { load, LoadError } from '@poly/runtime';
import { AGENT, PERSON, makeKey, makePerson, project } from './runtime-helpers.mjs';

const SOURCES = ['conformance/m4/outbox.poly'];
const rings = (people, agents = [AGENT]) => ({ people: people.map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey })), agents: agents.map((p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey })) });
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
function setRings(dir, r) {
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify({ ...readJson(pj), ...r }, null, 2));
}
function writeHistory(dir, entries) {
  mkdirSync(join(dir, 'keyrings'), { recursive: true });
  writeFileSync(join(dir, 'keyrings', 'history.json'), JSON.stringify(entries, null, 2));
}
/** A history entry for `next`, after `prev`, signed by `signer`. */
const entry = (prev, next, signer) => ({ rings: next, record: signRecord({ kind: 'keyring', subject: keyringSubject(keyringDigest(prev), keyringDigest(next)), by: signer.keyId, at: '2026-10-06T00:00:00.000Z' }, signer.privateKeyPem) });
const refusedKeyring = (e) => e instanceof AdmitError && /PL6410/.test(e.message);

test('S194: a project whose first rings have the anchor\'s digest is admitted, and the certificate binds the anchor and the chain', async () => {
  const dir = project('kr-ok', SOURCES, makeKey('kr-ok'), 'test-keyrings');
  const r = await admit(dir);
  const first = keyringDigest(rings([PERSON]));
  assert.deepEqual(r.certificate.poly.keyringChain, { anchor: first, head: first });
});

test('S194: rings with no anchor, or an anchor of other rings, are refused PL6410 at admission', async () => {
  const dir = project('kr-no-anchor', SOURCES, makeKey('kr-no-anchor'), 'test-keyrings');
  const pj = join(dir, 'poly.json');
  const m = readJson(pj);
  const anchorFile = m.keys.anchor.slice('file:'.length);
  delete m.keys.anchor;
  writeFileSync(pj, JSON.stringify(m, null, 2));
  await assert.rejects(admit(dir), refusedKeyring, 'no anchor');
  m.keys.anchor = `file:${anchorFile}`;
  writeFileSync(pj, JSON.stringify(m, null, 2));
  writeFileSync(anchorFile, `${keyringDigest(rings([makePerson('other')]))}\n`);
  await assert.rejects(admit(dir), refusedKeyring, 'another anchor');
});

test('S194: an agent key added to people without a keyring record is refused, and so is a record the new key signs itself', async () => {
  const dir = project('kr-added', SOURCES, makeKey('kr-added'), 'test-keyrings');
  const intruder = makePerson('intruder');
  const first = rings([PERSON]);
  const widened = rings([PERSON, intruder]);
  setRings(dir, widened);
  await assert.rejects(admit(dir), refusedKeyring, 'no record');
  writeHistory(dir, [{ rings: first }, entry(first, widened, intruder)]);
  await assert.rejects(admit(dir), refusedKeyring, 'signed by the new key');
  // Over another subject: a record by a trusted person, for other rings.
  writeHistory(dir, [{ rings: first }, { rings: widened, record: entry(first, rings([PERSON, makePerson('x')]), PERSON).record }]);
  await assert.rejects(admit(dir), refusedKeyring, 'another subject');
});

test('S194: a change signed by a person of the previous ring is admitted, and the chain\'s head is the new rings', async () => {
  const dir = project('kr-signed', SOURCES, makeKey('kr-signed'), 'test-keyrings');
  const first = rings([PERSON]);
  const next = rings([PERSON, makePerson('second')]);
  setRings(dir, next);
  writeHistory(dir, [{ rings: first }, entry(first, next, PERSON)]);
  const r = await admit(dir);
  assert.deepEqual(r.certificate.poly.keyringChain, { anchor: keyringDigest(first), head: keyringDigest(next) });
  // The certified rings are the ones in poly.json, read as admission reads them.
  assert.equal(keyringDigest(r.certificate.poly.keyrings), keyringDigest(keyringsOf(dir, readJson(join(dir, 'poly.json')))));
});

test('S194: rings changed after admission are refused at load, PL6405', async () => {
  const key = makeKey('kr-load');
  const dir = project('kr-load', SOURCES, key, 'test-keyrings');
  const r = await admit(dir);
  setRings(dir, rings([PERSON, makePerson('late')]));
  await assert.rejects(load(join(dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }), (e) => e instanceof LoadError && /PL6405/.test(e.message));
});

test('S194: the test anchor is an option of admit only; poly.json refuses a field for it, and the anchor file is never inside the project', async () => {
  const dir = project('kr-option', SOURCES, makeKey('kr-option'), 'test-keyrings');
  const pj = join(dir, 'poly.json');
  const m = readJson(pj);
  delete m.keys.anchor;
  writeFileSync(pj, JSON.stringify(m, null, 2));
  const r = await admit(dir, { trustAnchor: keyringDigest(rings([PERSON])) });
  assert.equal(r.certificate.poly.keyringChain.anchor, keyringDigest(rings([PERSON])));
  writeFileSync(pj, JSON.stringify({ ...m, trustAnchor: 'sha256:0' }, null, 2));
  await assert.rejects(admit(dir), /unknown field|trustAnchor/);
  writeFileSync(join(dir, 'anchor.txt'), `${keyringDigest(rings([PERSON]))}\n`);
  writeFileSync(pj, JSON.stringify({ ...m, keys: { ...m.keys, anchor: 'file:anchor.txt' } }, null, 2));
  await assert.rejects(admit(dir), refusedKeyring, 'an anchor inside the project');
});

test('S194: poly anchor keyrings and poly sign keyrings are the owner\'s commands, never over MCP, and their output admits', async () => {
  const { execFileSync } = await import('node:child_process');
  const { commandNamed } = await import('@poly/check');
  for (const name of ['anchor-keyrings', 'sign-keyrings']) assert.equal(commandNamed(name).mcp, null, name);
  const cli = join(process.cwd(), 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const key = makeKey('kr-cli');
  const dir = project('kr-cli', SOURCES, key, 'test-keyrings');
  const pj = join(dir, 'poly.json');
  const m = readJson(pj);
  const anchor = m.keys.anchor.slice('file:'.length) + '.cli';
  execFileSync(process.execPath, [cli, 'anchor', 'keyrings', '--out', anchor, '--project', dir], { encoding: 'utf8' });
  writeFileSync(pj, JSON.stringify({ ...m, keys: { ...m.keys, anchor: `file:${anchor}` } }, null, 2));
  await admit(dir);
  // The owner adds a person, and signs the change with a key of the certified people ring, read from a file.
  const second = makePerson('second');
  setRings(dir, rings([PERSON, second]));
  const personFile = join(dirname(key.file), 'kr-cli-person.pem');
  writeFileSync(personFile, PERSON.privateKeyPem);
  execFileSync(process.execPath, [cli, 'sign', 'keyrings', '--by', PERSON.keyId, '--key', personFile, '--project', dir], { encoding: 'utf8' });
  rmSync(personFile);
  const r = await admit(dir);
  assert.equal(r.certificate.poly.keyringChain.head, keyringDigest(rings([PERSON, second])));
});
