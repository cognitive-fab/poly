// S194 (M9, as ruled): a change to the people or agents ring is signed by a person already trusted, and the first
// rings are anchored outside the project (PT12.5). Without it, an agent that can edit poly.json and holds the
// admission key could add its own key under people and sign as a person. The chain is kept in keyrings/history.json:
// the first entry's rings have the anchor's digest, and each later entry carries a `keyring` record over
// { parent, rings } by a key of the previous entry's people ring.
//
// Ruled on the keyring change: the anchor's location is read from the owner's per-user configuration
// (.poly/anchors.json under the home directory the operating system gives the user), never from poly.json and never
// from the environment, so an agent confined to the project cannot redirect it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { keyringDigest, keyringSubject, keyringsOf, signRecord, verifyRecord, type Keyrings, type Manifest, type SignedRecord } from '@poly/core';

/** Every refusal of the chain; admission reports it as an AdmitError. */
export class KeyringError extends Error {
  constructor(problem: string) { super(`not admitted: PL6410 KEYRING_NOT_SIGNED: ${problem} (S194)`); this.name = 'KeyringError'; }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Where the per-user configuration is: the test folder `useTestAnchors` named, or the user's own. */
let testConfig: string | null = null;

/**
 * For tests only (S194): this process reads its anchors from `dir` in place of the owner's per-user configuration. A
 * certificate admitted that way records `source: "test"`, and load refuses it unless the loading process accepts test
 * anchors, which a production runtime never does.
 */
export function useTestAnchors(dir: string): void { testConfig = resolve(dir); }

function configFile(): { file: string; source: 'user' | 'test' } {
  if (testConfig) return { file: join(testConfig, 'anchors.json'), source: 'test' };
  // os.userInfo reads the account's home directory from the operating system, not from HOME or USERPROFILE.
  return { file: join(userInfo().homedir, '.poly', 'anchors.json'), source: 'user' };
}

function readConfig(): { file: string; source: 'user' | 'test'; anchors: Record<string, string> } {
  const { file, source } = configFile();
  if (!existsSync(file)) return { file, source, anchors: {} };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new KeyringError(`the per-user configuration ${file} cannot be read: ${(e as Error).message}`); }
  const anchors = (doc as { anchors?: unknown } | null)?.anchors;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors) || !Object.values(anchors).every((v) => typeof v === 'string')) throw new KeyringError(`the per-user configuration ${file} is not { "anchors": { "<project>": "file:PATH" } }`);
  return { file, source, anchors: anchors as Record<string, string> };
}

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

/** The anchor's file: `file:PATH` only, absolute, outside the project and outside any tree under version control. */
function anchorFile(dir: string, location: string): string {
  if (!location.startsWith('file:') || !isAbsolute(location.slice(5))) throw new KeyringError(`the anchor is ${JSON.stringify(location)}; it is named by file: and an absolute path only`);
  const file = location.slice(5);
  const rel = relative(resolve(dir), resolve(file));
  // Polywatch: `..anchor` inside the project starts with '..' too; only the parent itself or a path through it is out.
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) throw new KeyringError(`the anchor ${file} is inside the project; the owner keeps it outside`);
  if (underVersionControl(file)) throw new KeyringError(`the anchor ${file} is inside a tree under version control; the owner keeps it outside`);
  return file;
}

/** The project's anchor, from the per-user configuration, or null when it names none for this project. */
function projectAnchor(dir: string, project: string): { digest: string; source: 'user' | 'test' } | null {
  const config = readConfig();
  const location = Object.hasOwn(config.anchors, project) ? config.anchors[project] : undefined;
  if (location === undefined) return null;
  const file = anchorFile(dir, location);
  let text: string;
  // Polywatch: a directory or an unreadable file is a refusal of the chain like any other, never a bare error.
  try { text = readFileSync(file, 'utf8').trim(); } catch (e) { throw new KeyringError(`the anchor ${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
  if (!DIGEST.test(text)) throw new KeyringError(`the anchor ${file} holds no sha256 digest`);
  return { digest: text, source: config.source };
}

interface Entry { rings: Keyrings; record?: SignedRecord }

/** The digest of the history's last rings, once the first is the anchored one and every later entry is signed. */
function verifyHistory(entries: Entry[], anchor: string): string {
  const digests = entries.map((e, i) => digestOf(e.rings, `keyrings/history.json entry ${i}`));
  if (entries[0].record !== undefined) throw new KeyringError('the first rings carry a record; the anchor pins them');
  if (digests[0] !== anchor) throw new KeyringError(`the first rings have the digest ${digests[0]}, and the anchor is ${anchor}`);
  for (let i = 1; i < entries.length; i++) {
    const r = entries[i].record;
    if (r === undefined) throw new KeyringError(`entry ${i} changes the rings with no keyring record`);
    const v = verified(r, entries[i - 1].rings, keyringSubject(digests[i - 1], digests[i]));
    if (!v.ok) throw new KeyringError(`entry ${i}'s record is refused: ${v.problem}; a change is signed by a key of the previous people ring`);
  }
  return digests[digests.length - 1];
}

function readHistory(dir: string): Entry[] | null {
  const file = join(dir, 'keyrings', 'history.json');
  if (!existsSync(file)) return null;
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new KeyringError(`keyrings/history.json cannot be read: ${(e as Error).message}`); }
  const ring = (l: unknown) => Array.isArray(l) && l.every((h) => h && typeof h === 'object' && typeof h.name === 'string' && typeof h.keyId === 'string' && typeof h.publicKey === 'string');
  // Polywatch: a record that is present is an object; verifyRecord judges the rest.
  const record = (r: unknown) => r === undefined || (r !== null && typeof r === 'object' && !Array.isArray(r));
  if (!Array.isArray(doc) || !doc.length || !doc.every((e) => e && typeof e === 'object' && e.rings && ring(e.rings.people) && ring(e.rings.agents) && record(e.record))) {
    throw new KeyringError('keyrings/history.json is not a list of { rings: { people, agents }, record? }');
  }
  return doc as Entry[];
}

const digestOf = (k: Keyrings, where: string): string => {
  try { return keyringDigest(k); } catch (e) { throw new KeyringError(`${where}: a public key does not parse: ${(e as Error).message}`); }
};

const verified = (r: unknown, prev: Keyrings, subject: string) => {
  try { return verifyRecord(r, prev, { kind: 'keyring', subject }); } catch (e) { return { ok: false as const, problem: `the record cannot be read: ${(e as Error).message}` }; }
};

/**
 * The anchor's digest, the digest of the chain's last rings and where the anchor came from, or null for a project
 * whose rings are both empty and that has no anchor. Every way the chain can fail is a KeyringError.
 */
export function keyringChain(dir: string, manifest: Manifest, current: Keyrings): { anchor: string; head: string; source: 'user' | 'test' } | null {
  const anchor = projectAnchor(dir, manifest.name);
  if (!anchor) {
    if (!current.people.length && !current.agents.length) return null;
    throw new KeyringError(`poly.json names people or agents, and the owner's per-user configuration names no anchor for project ${manifest.name}`);
  }
  const entries = readHistory(dir) ?? [{ rings: current }];
  const head = verifyHistory(entries, anchor.digest);
  if (head !== digestOf(current, 'poly.json')) throw new KeyringError('the rings in poly.json are not the last rings of keyrings/history.json; a change is signed with poly sign keyrings');
  return { anchor: anchor.digest, head, source: anchor.source };
}

/**
 * `poly anchor keyrings`: writes the digest of the rings in poly.json to the anchor file and records its location for
 * this project in the per-user configuration. The owner's command.
 */
export function writeAnchor(dir: string, manifest: Manifest, out: string): { path: string; digest: string; config: string } {
  const file = anchorFile(dir, `file:${resolve(out)}`);
  const digest = keyringDigest(keyringsOf(dir, manifest));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${digest}\n`);
  const config = readConfig();
  mkdirSync(dirname(config.file), { recursive: true });
  writeFileSync(config.file, JSON.stringify({ anchors: { ...config.anchors, [manifest.name]: `file:${file}` } }, null, 2) + '\n');
  return { path: file, digest, config: config.file };
}

/**
 * `poly sign keyrings`: appends the rings in poly.json to the history, signed by a key of the last rings' people.
 * With no history yet, the last rings are the ones the last certificate binds (`certified`), which become its first
 * entry, and only when they are the anchored first rings.
 */
export function signKeyrings(dir: string, manifest: Manifest, by: string, privateKeyPem: string, at: string, certified?: Keyrings): { path: string; head: string } {
  const current = keyringsOf(dir, manifest);
  // Polywatch: a history that would never admit is not extended or written, whether it exists or starts here.
  const anchor = projectAnchor(dir, manifest.name);
  if (!anchor) throw new KeyringError(`the owner's per-user configuration names no anchor for project ${manifest.name}`);
  let history = readHistory(dir);
  if (!history) {
    if (!certified) throw new KeyringError('there is no keyrings/history.json and no certificate whose rings it would start from');
    if (digestOf(certified, 'the certified rings') !== anchor.digest) throw new KeyringError('keyrings/history.json is missing, and the certified rings are not the anchored first rings; restore the history');
    history = [{ rings: certified }];
  }
  verifyHistory(history, anchor.digest);
  mkdirSync(join(dir, 'keyrings'), { recursive: true });
  const prev = history[history.length - 1].rings;
  const parent = digestOf(prev, 'the last rings');
  const rings = digestOf(current, 'poly.json');
  if (parent === rings) throw new KeyringError('the rings in poly.json are already the last rings of the history');
  const record = signRecord({ kind: 'keyring', subject: keyringSubject(parent, rings), by, at }, privateKeyPem);
  const v = verified(record, prev, keyringSubject(parent, rings));
  if (!v.ok) throw new KeyringError(`the record is refused: ${v.problem}`);
  const path = join(dir, 'keyrings', 'history.json');
  writeFileSync(path, JSON.stringify([...history, { rings: current, record }], null, 2) + '\n');
  return { path, head: rings };
}
