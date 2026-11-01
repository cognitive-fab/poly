// PT1.2, finding 32: every location poly.json writes as `file:PATH` is read by one rule. An absolute PATH names that
// file as written; a relative PATH names the file at that path from the project's directory, the one that holds
// poly.json. No location is joined under the project when its path is absolute. A key file kept outside the project,
// as S126 asks, is therefore named by its absolute path, and one key named by an absolute path and by the relative path
// to the same file gives the same key and the same rings digest (PT12.5). Written from the specification alone, before
// the code (rule 7a). The defect these tests pin: a `file:` key path under `people` or `agents` was joined under the
// project even when absolute, so the absolute path of a key outside the project named no file, or another file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { admit } from '@poly/check';
import { keyringDigest, keyringsOf } from '@poly/core';
import { AGENT, PERSON, makeKey, makePerson, project } from './runtime-helpers.mjs';

// S126: key files live outside any repository, in a folder of this run, removed when the file's tests end.
const TMP = mkdtempSync(join(tmpdir(), 'poly-f32-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const KEYS = join(TMP, 'keys');
mkdirSync(KEYS, { recursive: true });
const PERSON_FILE = join(KEYS, 'ops.pub.pem');
const AGENT_FILE = join(KEYS, 'ci-agent.pub.pem');
writeFileSync(PERSON_FILE, PERSON.publicKey);
writeFileSync(AGENT_FILE, AGENT.publicKey);

const toSlashes = (p) => p.split(sep).join('/');
// PT12.5: a ring holds each key as its SPKI export, so keys are compared by their SPKI bytes, not by PEM text.
const spki = (pem) => createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
const entryOf = (who, publicKey) => ({ name: who.name, keyId: who.keyId, publicKey });

/** A project directory outside the repository, holding its poly.json; the manifest is returned as written. */
function projectAt(name, { people, agents }) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const manifest = { poly: '1', name, modules: [], people, agents };
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')) };
}

/** The rings with both keys written inline as PEM: the baseline every `file:` form must equal (PT12.5). */
function inlineRings(dir) {
  return keyringsOf(dir, { poly: '1', name: 'inline', modules: [], people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, AGENT.publicKey)] });
}

/**
 * An absolute path with its drive letter removed and forward slashes. On Windows it is still absolute (rooted on the
 * current drive); on POSIX it is the path itself. Joined under a project directory, its text names a file inside it.
 */
const driveless = (p) => toSlashes(p.replace(/^[A-Za-z]:/, ''));

test('PT1.2, finding 32: a people key named file:<absolute path> outside the project is read from that file', () => {
  assert.ok(isAbsolute(PERSON_FILE));
  const { dir, manifest } = projectAt('abs-people', { people: [entryOf(PERSON, `file:${PERSON_FILE}`)], agents: [entryOf(AGENT, AGENT.publicKey)] });
  const rings = keyringsOf(dir, manifest);
  assert.equal(spki(rings.people[0].publicKey), spki(PERSON.publicKey), 'the certified people key is the key in the file');
  assert.equal(keyringDigest(rings), keyringDigest(inlineRings(dir)), 'the rings digest is the one of the key written inline');
});

test('PT1.2, finding 32: an agents key named file:<absolute path> outside the project is read from that file', () => {
  assert.ok(isAbsolute(AGENT_FILE));
  const { dir, manifest } = projectAt('abs-agents', { people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, `file:${AGENT_FILE}`)] });
  const rings = keyringsOf(dir, manifest);
  assert.equal(spki(rings.agents[0].publicKey), spki(AGENT.publicKey), 'the certified agents key is the key in the file');
  assert.equal(keyringDigest(rings), keyringDigest(inlineRings(dir)), 'the rings digest is the one of the key written inline');
});

// Passes on the code before the fix: a relative path was already read from the project's directory. The working
// directory of this process is the worktree root, not the project, so this also shows that relative means from the
// project's directory and never from the working directory. It is the guard the relative half of the next tests uses.
test('PT1.2, finding 32: a people or agents key named by a relative file: path is read from the project\'s directory', () => {
  const { dir, manifest } = projectAt('rel-only', {
    people: [entryOf(PERSON, `file:${toSlashes(relative(join(TMP, 'rel-only'), PERSON_FILE))}`)],
    agents: [entryOf(AGENT, `file:${toSlashes(relative(join(TMP, 'rel-only'), AGENT_FILE))}`)],
  });
  assert.notEqual(resolve(process.cwd()), resolve(dir));
  const rings = keyringsOf(dir, manifest);
  assert.equal(spki(rings.people[0].publicKey), spki(PERSON.publicKey));
  assert.equal(spki(rings.agents[0].publicKey), spki(AGENT.publicKey));
  assert.equal(keyringDigest(rings), keyringDigest(inlineRings(dir)));
});

test('PT1.2, finding 32: a people key named by its absolute path and by its relative path gives the same rings and digest', () => {
  const dir = join(TMP, 'abs-rel-people');
  const rel = toSlashes(relative(dir, PERSON_FILE));
  assert.ok(!isAbsolute(rel), rel);
  const a = projectAt('abs-rel-people', { people: [entryOf(PERSON, `file:${PERSON_FILE}`)], agents: [entryOf(AGENT, AGENT.publicKey)] });
  const byAbsolute = keyringsOf(a.dir, a.manifest);
  const r = projectAt('abs-rel-people', { people: [entryOf(PERSON, `file:${rel}`)], agents: [entryOf(AGENT, AGENT.publicKey)] });
  const byRelative = keyringsOf(r.dir, r.manifest);
  assert.deepEqual(byAbsolute, byRelative);
  assert.equal(keyringDigest(byAbsolute), keyringDigest(byRelative));
});

test('PT1.2, finding 32: an agents key named by its absolute path and by its relative path gives the same rings and digest', () => {
  const dir = join(TMP, 'abs-rel-agents');
  const rel = toSlashes(relative(dir, AGENT_FILE));
  assert.ok(!isAbsolute(rel), rel);
  const a = projectAt('abs-rel-agents', { people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, `file:${AGENT_FILE}`)] });
  const byAbsolute = keyringsOf(a.dir, a.manifest);
  const r = projectAt('abs-rel-agents', { people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, `file:${rel}`)] });
  const byRelative = keyringsOf(r.dir, r.manifest);
  assert.deepEqual(byAbsolute, byRelative);
  assert.equal(keyringDigest(byAbsolute), keyringDigest(byRelative));
});

/**
 * The decoy: the absolute path of the real key file, without its drive letter, joined under the project, names another
 * PEM file holding a third key (neither PERSON's nor AGENT's, so no ring lists one key twice). The rule of PT1.2 reads
 * the absolute path; a reader that joins it under the project reads the decoy.
 */
function decoyProject(name, realFile) {
  const abs = driveless(realFile);
  assert.ok(isAbsolute(abs), `${abs} is absolute`);
  // The driveless form names the real file only when the working directory is on the real file's drive.
  assert.equal(resolve(abs), resolve(realFile), 'the driveless path names the real key file');
  const dir = join(TMP, name);
  const decoyFile = join(dir, abs);
  mkdirSync(dirname(decoyFile), { recursive: true });
  const decoy = makePerson(`${name}-decoy`);
  writeFileSync(decoyFile, decoy.publicKey);
  assert.ok(existsSync(decoyFile), decoyFile);
  assert.notEqual(resolve(decoyFile), resolve(realFile));
  return { abs, decoy };
}

test('PT1.2, finding 32: a people key at an absolute path is read there, never from the same text joined under the project', () => {
  const { abs, decoy } = decoyProject('decoy-people', PERSON_FILE);
  const { dir, manifest } = projectAt('decoy-people', { people: [entryOf(PERSON, `file:${abs}`)], agents: [entryOf(AGENT, AGENT.publicKey)] });
  const rings = keyringsOf(dir, manifest);
  assert.notEqual(spki(rings.people[0].publicKey), spki(decoy.publicKey), 'the decoy inside the project was read');
  assert.equal(spki(rings.people[0].publicKey), spki(PERSON.publicKey), 'the key at the absolute path is certified');
});

test('PT1.2, finding 32: an agents key at an absolute path is read there, never from the same text joined under the project', () => {
  const { abs, decoy } = decoyProject('decoy-agents', AGENT_FILE);
  const { dir, manifest } = projectAt('decoy-agents', { people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, `file:${abs}`)] });
  const rings = keyringsOf(dir, manifest);
  assert.notEqual(spki(rings.agents[0].publicKey), spki(decoy.publicKey), 'the decoy inside the project was read');
  assert.equal(spki(rings.agents[0].publicKey), spki(AGENT.publicKey), 'the key at the absolute path is certified');
});

// The project helper anchors the rings { people: [PERSON], agents: [AGENT] } (S194); a people key read from its
// absolute file is the same SPKI key, so the anchored digest still holds and admission certifies that key (PT12.5).
test('PT1.2, finding 32: a project whose people key is file:<absolute path> outside the project is admitted, and certifies that key', async () => {
  const dir = project('f32-admit', ['conformance/m4/outbox.poly'], makeKey('f32-admit'), 'test-keyrings');
  const pj = join(dir, 'poly.json');
  const m = JSON.parse(readFileSync(pj, 'utf8'));
  m.people = [entryOf(PERSON, `file:${PERSON_FILE}`)];
  writeFileSync(pj, JSON.stringify(m, null, 2));
  const r = await admit(dir);
  assert.equal(spki(r.certificate.poly.keyrings.people[0].publicKey), spki(PERSON.publicKey));
  const anchored = keyringDigest({ people: [entryOf(PERSON, PERSON.publicKey)], agents: [entryOf(AGENT, AGENT.publicKey)] });
  assert.equal(r.certificate.poly.keyringChain.anchor, anchored);
  assert.equal(r.certificate.poly.keyringChain.head, anchored);
});
