// The demo's admission: the demo copy of the concierge, checked and admitted as a project, with keys made for the run. The admission
// key, the person's key (the one that signs the policy, the grant request and each approval) and the agent's key are generated at
// start and held in memory or in the run's temporary folder; none is written under the repository, and none is the owner's. The
// keyring's first rings are anchored by a file in that folder and named in a folder of anchors of the run's own (S194), so the
// owner's per-user configuration is never touched. The certificate says so: it is admitted under a throwaway anchor, which the
// runtime accepts only in a process that accepts such anchors.
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admit, policySubjects, policySignaturePath, useTestAnchors } from '@poly/check';
import { acceptTestAnchors } from '@poly/runtime';
import { keyringDigest, newAnchor, signRecord, writeAnchorFile } from '@poly/core';

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

/**
 * Admits `source` (a folder holding concierge.poly, its policy, maps/ and prices/) as a project under `workdir`, and returns
 * what the runtime's load needs, with the person who signed it. The report is the check's: its verdict and each machine's instance.
 */
export async function admitDemoConcierge({ source, workdir, name = 'demo-concierge' }) {
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
  for (const sub of ['maps', 'prices']) cpSync(join(source, sub), join(dir, 'src', sub), { recursive: true });
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
  const r = await admit(dir);
  return { dir, key, person, agent, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report };
}
