// S194 (M9, as ruled): a change to the people or agents ring is signed by a person already trusted, and the first
// rings are anchored outside the project (PT12.5). Without it, an agent that can edit poly.json and holds the
// admission key could add its own key under people and sign as a person. The chain is kept in keyrings/history.json:
// the first entry's rings have the anchor's digest, and each later entry carries a `keyring` record over
// { parent, rings } by a key of the previous entry's people ring.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { keyringDigest, keyringSubject, keyringsOf, signRecord, verifyRecord, type Keyrings, type Manifest, type SignedRecord } from '@poly/core';

/** Every refusal of the chain; admission reports it as an AdmitError. */
export class KeyringError extends Error {
  constructor(problem: string) { super(`not admitted: PL6410 KEYRING_NOT_SIGNED: ${problem} (S194)`); this.name = 'KeyringError'; }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Whether a path lies in a tree under version control, by its real path (as the key files are judged, S126). */
export function underVersionControl(file: string): boolean {
  const lexical = resolve(file);
  let real = lexical;
  try { real = realpathSync.native(lexical); } catch {
    try { real = join(realpathSync.native(dirname(lexical)), basename(lexical)); } catch { /* no such directory */ }
  }
  for (let d = dirname(real); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/** The anchor's file: `file:PATH` only, outside the project and outside any tree under version control. */
export function anchorFile(dir: string, location: string): string {
  if (!location.startsWith('file:') || location.length === 5) throw new KeyringError(`keys.anchor is ${JSON.stringify(location)}; the anchor is named by file:PATH only`);
  const where = location.slice(5);
  const file = isAbsolute(where) ? where : join(dir, where);
  const rel = relative(resolve(dir), resolve(file));
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new KeyringError(`the anchor ${file} is inside the project; the owner keeps it outside`);
  if (underVersionControl(file)) throw new KeyringError(`the anchor ${file} is inside a tree under version control; the owner keeps it outside`);
  return file;
}

function readAnchor(dir: string, location: string): string {
  const file = anchorFile(dir, location);
  if (!existsSync(file)) throw new KeyringError(`the anchor ${file} does not exist`);
  const text = readFileSync(file, 'utf8').trim();
  if (!DIGEST.test(text)) throw new KeyringError(`the anchor ${file} holds no sha256 digest`);
  return text;
}

interface Entry { rings: Keyrings; record?: SignedRecord }

function readHistory(dir: string): Entry[] | null {
  const file = join(dir, 'keyrings', 'history.json');
  if (!existsSync(file)) return null;
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new KeyringError(`keyrings/history.json does not parse: ${(e as Error).message}`); }
  const ring = (l: unknown) => Array.isArray(l) && l.every((h) => h && typeof h === 'object' && typeof h.name === 'string' && typeof h.keyId === 'string' && typeof h.publicKey === 'string');
  if (!Array.isArray(doc) || !doc.length || !doc.every((e) => e && typeof e === 'object' && e.rings && ring(e.rings.people) && ring(e.rings.agents))) {
    throw new KeyringError('keyrings/history.json is not a list of { rings: { people, agents }, record? }');
  }
  return doc as Entry[];
}

const digestOf = (k: Keyrings, where: string): string => {
  try { return keyringDigest(k); } catch (e) { throw new KeyringError(`${where}: a public key does not parse: ${(e as Error).message}`); }
};

/**
 * The anchor's digest and the digest of the chain's last rings, or null for a project whose rings are both empty and
 * that names no anchor. Every way the chain can fail is a KeyringError. `testAnchor` is for tests only (S194).
 */
export function keyringChain(dir: string, manifest: Manifest, current: Keyrings, testAnchor?: string): { anchor: string; head: string } | null {
  const location = manifest.keys?.anchor;
  if (testAnchor !== undefined && !DIGEST.test(testAnchor)) throw new KeyringError('the test anchor is not a sha256 digest');
  const anchor = testAnchor ?? (location ? readAnchor(dir, location) : undefined);
  if (!anchor) {
    if (!current.people.length && !current.agents.length) return null;
    throw new KeyringError('poly.json names people or agents, and no keyring anchor (keys.anchor)');
  }
  const entries = readHistory(dir) ?? [{ rings: current }];
  const digests = entries.map((e, i) => digestOf(e.rings, `keyrings/history.json entry ${i}`));
  if (entries[0].record !== undefined) throw new KeyringError('the first rings carry a record; the anchor pins them');
  if (digests[0] !== anchor) throw new KeyringError(`the first rings have the digest ${digests[0]}, and the anchor is ${anchor}`);
  for (let i = 1; i < entries.length; i++) {
    const r = entries[i].record;
    if (r === undefined) throw new KeyringError(`entry ${i} changes the rings with no keyring record`);
    const v = verifyRecord(r, entries[i - 1].rings, { kind: 'keyring', subject: keyringSubject(digests[i - 1], digests[i]) });
    if (!v.ok) throw new KeyringError(`entry ${i}'s record is refused: ${v.problem}; a change is signed by a key of the previous people ring`);
  }
  const head = digests[digests.length - 1];
  if (head !== digestOf(current, 'poly.json')) throw new KeyringError('the rings in poly.json are not the last rings of keyrings/history.json; a change is signed with poly sign keyrings');
  return { anchor, head };
}

/** `poly anchor keyrings`: writes the digest of the rings in poly.json to the anchor file. The owner's command. */
export function writeAnchor(dir: string, manifest: Manifest, out: string): { path: string; digest: string } {
  const file = anchorFile(dir, out);
  const digest = keyringDigest(keyringsOf(dir, manifest));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${digest}\n`);
  return { path: file, digest };
}

/**
 * `poly sign keyrings`: appends the rings in poly.json to the history, signed by a key of the last rings' people.
 * With no history yet, the last rings are the ones the last certificate binds (`certified`), which become its first entry.
 */
export function signKeyrings(dir: string, manifest: Manifest, by: string, privateKeyPem: string, at: string, certified?: Keyrings): { path: string; head: string } {
  const current = keyringsOf(dir, manifest);
  const history = readHistory(dir) ?? (certified ? [{ rings: certified }] : null);
  if (!history) throw new KeyringError('there is no keyrings/history.json and no certificate whose rings it would start from');
  mkdirSync(join(dir, 'keyrings'), { recursive: true });
  const prev = history[history.length - 1].rings;
  const parent = digestOf(prev, 'the last rings');
  const rings = digestOf(current, 'poly.json');
  if (parent === rings) throw new KeyringError('the rings in poly.json are already the last rings of the history');
  const record = signRecord({ kind: 'keyring', subject: keyringSubject(parent, rings), by, at }, privateKeyPem);
  const v = verifyRecord(record, prev, { kind: 'keyring' });
  if (!v.ok) throw new KeyringError(`the record is refused: ${v.problem}`);
  const path = join(dir, 'keyrings', 'history.json');
  writeFileSync(path, JSON.stringify([...history, { rings: current, record }], null, 2) + '\n');
  return { path, head: rings };
}
