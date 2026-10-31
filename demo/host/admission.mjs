// The demo's admission: the demo copy of the concierge, checked and admitted as a project, with keys made for the run. The admission
// key, the person's key (the one that signs the policy, the grant request and each approval) and the agent's key are generated at
// start and held in memory or in the run's temporary folder; none is written under the repository, and none is the owner's. The
// keyring's first rings are anchored by a file in that folder and named in a folder of anchors of the run's own (S194), so the
// owner's per-user configuration is never touched. The certificate says so: it is admitted under a throwaway anchor, which the
// runtime accepts only in a process that accepts such anchors.
//
// DF27: in a test run (POLY_TEST_RUN), each admission is kept in a store under the system's temporary folder, keyed by the run,
// the project, the source bytes, the handlers and the toolchain digest, and every later call for that key gets a copy of it.
// Measured on the v1.4.0 serial suite (2026-10-30): a demo test that assembles once took 630 s to 940 s, nearly all of it
// the admission, and most admissions were of one source.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { admit, policySubjects, policySignaturePath, toolchainDigest, useTestAnchors } from '@poly/check';
import { acceptTestAnchors } from '@poly/runtime';
import { canonicalize, keyringDigest, newAnchor, signRecord, writeAnchorFile } from '@poly/core';
import { settle, storeDir, storeRoot, storedAdmission } from './admission-store.mjs';

export { storeDir, storedAdmission };

/** A signing key for a person or an agent (PT12.5), generated for the run. */
export function makePerson(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { name, keyId: `key-${name}`, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** The handler module the project certifies (S142): the certified export delegates to a script the host sets. */
export const HANDLERS_TS = [
  'type Script = (payload: unknown, caps: unknown, ctx: unknown) => unknown;',
  'let script: Script = (payload) => ({ ok: true, payload });',
  'export function setScript(s: Script) { script = s; }',
  'export async function handle(payload: unknown, caps: unknown, ctx: unknown) { return script(payload, caps, ctx); }',
  '',
].join('\n');

const SOURCES = ['concierge.poly', 'concierge.policy.poly'];
const FOLDERS = ['maps', 'prices'];

/** DF27 item 4: every file the admission copies, by its path relative to the source (forward slashes), as base64 bytes. */
function sourceFiles(source) {
  const files = {};
  const add = (p) => { files[relative(source, p).split(sep).join('/')] = readFileSync(p).toString('base64'); };
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else add(p); } };
  for (const f of SOURCES) add(join(source, f));
  // A folder the source lacks adds nothing to the key; the admission itself refuses such a source when it copies.
  for (const f of FOLDERS) if (existsSync(join(source, f))) walk(join(source, f));
  return files;
}

/**
 * DF27 item 4: the store's key, the SHA-256 of the canonical JSON (RFC 8785) of the run, the project's name, the bytes of every
 * file the admission copies, the handlers and the toolchain digest. The digest is an argument, so the seeded control of item 9
 * (b) can give two digests for one source.
 */
export function admissionKey({ run, project, source, toolchain, handlers = HANDLERS_TS }) {
  return createHash('sha256').update(canonicalize({ run, project, files: sourceFiles(source), handlers, toolchain })).digest('hex');
}

/** DF27 items 2, 3 and 7: shared only in a named test run, and never when the caller or POLY_DEMO_ADMISSION asks for fresh. */
export function admissionMode({ admission = 'shared', env = process.env } = {}) {
  if (admission !== 'shared' && admission !== 'fresh') throw new Error(`admission is 'shared' or 'fresh', not ${JSON.stringify(admission)}`);
  if (admission === 'fresh' || env.POLY_DEMO_ADMISSION === 'fresh' || !env.POLY_TEST_RUN) return 'fresh';
  return 'shared';
}

/** DF27 item 5: the run's id names a folder of the store, so only a plain name is used as one. */
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

let admissions = 0;
/** DAC31: the real admissions this process made, which the test of one admission per key counts. */
export const admissionCount = () => admissions;

/**
 * Admits `source` (a folder holding concierge.poly, its policy, maps/ and prices/) as a project under `workdir`, and returns
 * what the runtime's load needs, with the person who signed it. The report is the check's: its verdict and each machine's instance.
 * DF27 item 7: `admission: 'shared'` (the default) gives a copy of the run's stored admission of the same key; `'fresh'` admits.
 */
export async function admitDemoConcierge({ source, workdir, name = 'demo-concierge', admission = 'shared' }) {
  if (admissionMode({ admission }) === 'fresh') return { ...(await admitFresh({ source, workdir, name })), shared: false };
  const run = process.env.POLY_TEST_RUN;
  if (!RUN_ID.test(run)) throw new Error(`POLY_TEST_RUN names a folder of the demo's store, so it is letters, digits and hyphens (at most 64), not ${JSON.stringify(run)}`);
  const key = admissionKey({ run, project: name, source, toolchain: toolchainDigest() });
  if (!storedAdmission(key)) await stored(key, source, name);
  return copyOf(key, workdir, name);
}

const inflight = new Map();
/** DF27 item 5: within one process the calls for one key wait on one admission; across processes the first rename wins. */
function stored(key, source, name) {
  if (!inflight.has(key)) inflight.set(key, store(key, source, name).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function store(key, source, name) {
  // DF27 items 5 and 11: staged inside the run's folder, so a staging folder a killed process leaves goes with the run.
  const staging = join(storeRoot(), process.env.POLY_TEST_RUN, `.staging-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const a = await admitFresh({ source, workdir: staging, name });
    writeFileSync(join(staging, 'admission.json'), JSON.stringify({
      staged: staging, key: { id: a.key.id, publicKey: a.key.publicKey }, person: a.person, agent: a.agent,
      certificate: relative(a.dir, a.certificate).split(sep).join('/'), report: a.report,
    }));
    writeFileSync(join(staging, 'ready.json'), JSON.stringify({ key, at: new Date().toISOString() }));
    settle(staging, storeDir(key));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Every string that names a path under `from` names the same path under `to`. */
function moved(value, from, to) {
  if (typeof value === 'string') return value.startsWith(from) ? to + value.slice(from.length) : value;
  if (Array.isArray(value)) return value.map((v) => moved(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moved(v, from, to)]));
  return value;
}

/**
 * DF27 item 6: the stored project and keys, copied into `workdir` as the fresh admission lays them out, with the anchors and the
 * admission key's location naming the copies. A test that changes its copy never changes the store.
 */
function copyOf(key, workdir, name) {
  const from = storeDir(key);
  const s = JSON.parse(readFileSync(join(from, 'admission.json'), 'utf8'));
  const keys = join(workdir, 'keys');
  const anchors = join(keys, 'anchors');
  const dir = join(workdir, 'project');
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(from, 'project'), dir, { recursive: true });
  mkdirSync(anchors, { recursive: true });
  const keyFile = join(keys, 'admission.pem');
  copyFileSync(join(from, 'keys', 'admission.pem'), keyFile);
  const anchorFile = join(keys, `${name}.anchor`);
  copyFileSync(join(from, 'keys', `${name}.anchor`), anchorFile);
  const config = join(anchors, 'anchors.json');
  const doc = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : { anchors: {} };
  doc.anchors[name] = `file:${anchorFile}`;
  writeFileSync(config, JSON.stringify(doc, null, 2));
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  manifest.keys.admission.location = `file:${keyFile}`;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest, null, 2));
  useTestAnchors(anchors);
  acceptTestAnchors();
  const k = { id: s.key.id, file: keyFile, publicKey: s.key.publicKey };
  return {
    dir, key: k, person: s.person, agent: s.agent, build: join(dir, '.poly', 'build'), certificate: join(dir, ...s.certificate.split('/')),
    trust: { [k.id]: k.publicKey }, report: moved(s.report, join(s.staged, 'project'), dir), shared: true,
  };
}

async function admitFresh({ source, workdir, name }) {
  const keys = join(workdir, 'keys');
  const anchors = join(keys, 'anchors');
  mkdirSync(anchors, { recursive: true });
  useTestAnchors(anchors);
  acceptTestAnchors();

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyFile = join(keys, 'admission.pem');
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const key = { id: `demo-${name}`, file: keyFile, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const person = makePerson('presenter');
  const agent = makePerson('demo-agent');

  const dir = join(workdir, 'project');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of SOURCES) copyFileSync(join(source, f), join(dir, 'src', f));
  for (const sub of FOLDERS) cpSync(join(source, sub), join(dir, 'src', sub), { recursive: true });
  writeFileSync(join(dir, 'src', 'handlers.ts'), HANDLERS_TS);

  const anchorFile = join(keys, `${name}.anchor`);
  writeAnchorFile(anchorFile, newAnchor(name, keyringDigest({ people: [person], agents: [agent] }), false));
  const config = join(anchors, 'anchors.json');
  const doc = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : { anchors: {} };
  doc.anchors[name] = `file:${anchorFile}`;
  writeFileSync(config, JSON.stringify(doc, null, 2));

  writeFileSync(join(dir, 'poly.json'), JSON.stringify({
    poly: '1', name, modules: ['src/*.poly'], handlers: ['src/handlers.ts'],
    keys: { admission: { id: key.id, location: `file:${key.file}` } },
    people: [{ name: person.name, keyId: person.keyId, publicKey: person.publicKey }],
    agents: [{ name: agent.name, keyId: agent.keyId, publicKey: agent.publicKey }],
    credentials: { payments: { store: 'kms' } },
  }, null, 2));

  // S194, Q8: a policy is admitted only signed by a person, so each scope is signed with the person's key, held in memory.
  for (const s of await policySubjects(dir)) {
    const path = policySignaturePath(dir, s.scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ v: 2, sequence: s.parts.sequence, record: signRecord({ kind: 'policy', subject: s.subject, by: person.keyId, at: new Date().toISOString() }, person.privateKeyPem) }, null, 2));
  }
  admissions++;
  const r = await admit(dir);
  return { dir, key, person, agent, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report };
}
