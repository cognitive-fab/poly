// Shared by the M4 tests: admission keys generated at test time, outside the repository (S126), project
// directories under .poly, and an admitted build loaded into poly-runtime.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { admit, policySubjects, policySignaturePath, useTestAnchors } from '@poly/check';
import { acceptTestAnchors, load } from '@poly/runtime';
import { keyringDigest, signRecord } from '@poly/core';
import { ROOT } from './helpers.mjs';

const KEYS = mkdtempSync(join(tmpdir(), 'poly-keys-'));

// S194, as ruled: a test process reads its keyring anchors from a folder of its own, never the owner's per-user
// configuration, and its certificates (source "test") load only in a process that accepts test anchors.
export const ANCHORS = join(KEYS, 'anchors');
mkdirSync(ANCHORS, { recursive: true });
useTestAnchors(ANCHORS);
acceptTestAnchors();

/** Anchors a project's first rings: the digest in a file outside the repository, named in the test anchor folder. */
export function anchorProject(name, rings) {
  const file = join(KEYS, `${name}.anchor`);
  writeFileSync(file, `${keyringDigest(rings)}\n`);
  const config = join(ANCHORS, 'anchors.json');
  const doc = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : { anchors: {} };
  doc.anchors[name] = `file:${file}`;
  writeFileSync(config, JSON.stringify(doc, null, 2));
  return file;
}

export function makeKey(name = 'admission') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const file = join(KEYS, `${name}.pem`);
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { id: `test-${name}`, file, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** PT12.5: a person's (or an agent's) signing key, generated for the run and never stored in the repository. */
export function makePerson(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { name, keyId: `key-${name}`, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** The keyrings every test project certifies: one person, one agent (S150). */
export const PERSON = makePerson('ops');
export const AGENT = makePerson('ci-agent');

/** A signed approval of an intent's escalation, by a key holder (PT12.5, S150). */
export async function approvalFor(rt, intentId, who = PERSON, subject) {
  const esc = await rt.escalationOf(intentId);
  return signRecord({ kind: 'approval', subject: subject ?? esc?.hash ?? 'none', by: who.keyId, at: '2026-10-02T00:00:00.000Z' }, who.privateKeyPem);
}
export const approveAs = async (rt, intentId, who = PERSON) => rt.approve(await approvalFor(rt, intentId, who));

/**
 * A test's handler module (S142): the certified export delegates to a script the test sets through another export,
 * so each test scripts its handler while rt.handle still takes only the certified function.
 */
export const HANDLERS_TS = [
  'type Script = (payload: unknown, caps: unknown, ctx: unknown) => unknown;',
  'let script: Script = (payload) => ({ ok: true, payload });',
  'export function setScript(s: Script) { script = s; }',
  'export async function handle(payload: unknown, caps: unknown, ctx: unknown) { return script(payload, caps, ctx); }',
  '',
].join('\n');

/** Registers a test's script for a kind through the certified handler (S142). */
export function handleWith(rt, kind, script) {
  const h = rt.handlerExports('src/handlers.ts');
  h.setScript(script);
  rt.handle(kind, h.handle);
}

/** A project directory under .poly with the given sources copied in, a clean handler module and an admission key. */
export function project(name, sources, key, base = 'test-cert') {
  const dir = join(ROOT, '.poly', base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const s of sources) copyFileSync(join(ROOT, s), join(dir, 'src', s.split('/').pop()));
  writeFileSync(join(dir, 'src', 'handlers.ts'), HANDLERS_TS);
  // S194: the first rings are anchored by a file outside the project, named in this process's test anchor folder.
  anchorProject(name, { people: [PERSON], agents: [AGENT] });
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'], handlers: ['src/handlers.ts'], keys: { admission: { id: key.id, location: `file:${key.file}` } }, people: [{ name: PERSON.name, keyId: PERSON.keyId, publicKey: PERSON.publicKey }], agents: [{ name: AGENT.name, keyId: AGENT.keyId, publicKey: AGENT.publicKey }] }, null, 2));
  return dir;
}

/**
 * S194, Q8: signs each policy scope of a project with a person's key, held in memory, as `poly sign policy` does: over
 * the document its declaring module lowers to, its source and the pinned engine.
 */
export async function signPolicies(dir, who = PERSON) {
  for (const s of await policySubjects(dir)) {
    const path = policySignaturePath(dir, s.scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(signRecord({ kind: 'policy', subject: s.subject, by: who.keyId, at: '2026-10-06T00:00:00.000Z' }, who.privateKeyPem), null, 2));
  }
}

/** Whether any of the sources declares a policy, so its project needs a person's signature before admission. */
export const hasPolicies = (sources) => sources.some((s) => /^\s*policy\s+[A-Za-z_][\w-]*\s*\{/m.test(readFileSync(join(ROOT, s), 'utf8')));

/** Admits the sources as a project and returns what `load` needs. Its policies are signed by PERSON (S194). */
export async function admitted(name, sources, key = makeKey(name)) {
  const dir = project(name, sources, key, 'test-runtime');
  if (hasPolicies(sources)) await signPolicies(dir);
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate };
}

/** Loads an admitted build with an in-memory store and a clock the test drives. */
export async function loaded(a, extra = {}) {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, now: clock.now, ...extra });
  return { rt, clock };
}
