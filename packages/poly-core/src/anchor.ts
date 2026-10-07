// S194, S210 (M9, as ruled): the keyring anchor, which keeps outside the project what a person decided, and the chain
// of keyring changes verified from it. Admission (`@poly/check`) and load (`@poly/runtime`) both read it here, so load
// verifies the chain as admission does (S210, D1) and neither trusts the project's own files for it.
//
// The anchor's location is read from the owner's per-user configuration (.poly/anchors.json under the home directory
// the operating system gives the user), never from poly.json and never from the environment, so an agent confined to
// the project cannot redirect it. The anchor itself is `{ v: 2, id, project, first, head, policies, production }`
// (PT12.5): its first rings, the last rings admitted, the highest policy sequence admitted per scope, and whether the
// project is production. Admission only moves `head` and `policies` forward (S210, D2, D7).
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { keyringDigest, keyringSubject, verifyRecord, type Keyrings, type SignedRecord } from './records.js';

/** Every refusal of the chain; admission and load report it with their own prefix. */
export class KeyringError extends Error {
  constructor(readonly problem: string) { super(`PL6410 KEYRING_NOT_SIGNED: ${problem} (S194, S210)`); this.name = 'KeyringError'; }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ANCHOR_ID = /^anchor-[0-9a-f]{32}$/;

/** PT12.5, S210: the anchor's fields. */
export interface Anchor { v: 2; id: string; project: string; first: string; head: string; policies: Record<string, number>; production: boolean }
export type AnchorSource = 'user' | 'test';

/** Where the per-user configuration is: the test folder `useTestAnchors` named, or the user's own. */
let testConfig: string | null = null;

/**
 * For tests only (S194): this process reads its anchors from `dir` in place of the owner's per-user configuration. A
 * certificate admitted that way records `source: "test"`, and load reads its anchor from here only in a process that
 * accepts test anchors, which a production runtime never does.
 */
export function useTestAnchors(dir: string | null): string | null { const prev = testConfig; testConfig = dir === null ? null : resolve(dir); return prev; }

function configFile(source?: AnchorSource): { file: string; source: AnchorSource } {
  if (source === 'test' || (source === undefined && testConfig)) {
    if (!testConfig) throw new KeyringError('the certificate was admitted with a test anchor, and this process names no test configuration');
    return { file: join(testConfig, 'anchors.json'), source: 'test' };
  }
  // os.userInfo reads the account's home directory from the operating system, not from HOME or USERPROFILE.
  return { file: join(userInfo().homedir, '.poly', 'anchors.json'), source: 'user' };
}

export function readAnchorConfig(source?: AnchorSource): { file: string; source: AnchorSource; anchors: Record<string, string> } {
  const { file, source: s } = configFile(source);
  if (!existsSync(file)) return { file, source: s, anchors: {} };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new KeyringError(`the per-user configuration ${file} cannot be read: ${(e as Error).message}`); }
  const anchors = (doc as { anchors?: unknown } | null)?.anchors;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors) || !Object.values(anchors).every((v) => typeof v === 'string')) throw new KeyringError(`the per-user configuration ${file} is not { "anchors": { "<project>": "file:PATH" } }`);
  return { file, source: s, anchors: anchors as Record<string, string> };
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
export function anchorFile(dir: string, location: string): string {
  if (!location.startsWith('file:') || !isAbsolute(location.slice(5))) throw new KeyringError(`the anchor is ${JSON.stringify(location)}; it is named by file: and an absolute path only`);
  const file = location.slice(5);
  const rel = relative(resolve(dir), resolve(file));
  // Polywatch: `..anchor` inside the project starts with '..' too; only the parent itself or a path through it is out.
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) throw new KeyringError(`the anchor ${file} is inside the project; the owner keeps it outside`);
  if (underVersionControl(file)) throw new KeyringError(`the anchor ${file} is inside a tree under version control; the owner keeps it outside`);
  return file;
}

/** The anchor's document, or why it is refused. A bare digest is the form before S210, refused until anchored again. */
export function parseAnchor(text: string, file: string, project: string): Anchor {
  if (DIGEST.test(text.trim())) throw new KeyringError(`the anchor ${file} holds only a digest, the form before S210; the owner anchors the project again with poly anchor keyrings`);
  let a: Partial<Anchor>;
  try { a = JSON.parse(text) as Partial<Anchor>; } catch { throw new KeyringError(`the anchor ${file} is not JSON`); }
  const policies = a?.policies;
  const ok = a && a.v === 2 && typeof a.id === 'string' && ANCHOR_ID.test(a.id) && typeof a.project === 'string' && typeof a.first === 'string' && DIGEST.test(a.first) && typeof a.head === 'string' && DIGEST.test(a.head) && typeof a.production === 'boolean'
    && policies && typeof policies === 'object' && !Array.isArray(policies) && Object.values(policies).every((n) => Number.isSafeInteger(n) && n > 0);
  if (!ok) throw new KeyringError(`the anchor ${file} is not { v: 2, id, project, first, head, policies, production } (PT12.5)`);
  if (a.project !== project) throw new KeyringError(`the anchor ${file} is project ${a.project}'s, not ${project}'s`);
  return a as Anchor;
}

/** The project's anchor from the per-user configuration (or the test one), or null when it names none for the project. */
export function readAnchor(dir: string, project: string, source?: AnchorSource): { anchor: Anchor; file: string; source: AnchorSource } | null {
  const config = readAnchorConfig(source);
  const location = Object.hasOwn(config.anchors, project) ? config.anchors[project] : undefined;
  if (location === undefined) return null;
  const file = anchorFile(dir, location);
  let text: string;
  // Polywatch: a directory or an unreadable file is a refusal of the chain like any other, never a bare error.
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new KeyringError(`the anchor ${file} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
  return { anchor: parseAnchor(text, file, project), file, source: config.source };
}

/** Writes an anchor whole: to a file beside it, then renamed into place, so a reader never sees half of one. */
export function writeAnchorFile(file: string, a: Anchor): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n');
  renameSync(tmp, file);
}

/** How long a change of the anchor waits for another to finish, and when a lock is taken to be a dead process's. */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

/**
 * Polywatch on S210: every read, change and write of an anchor holds its lock (`<anchor>.lock`, created exclusively),
 * so two admissions, or an admission and `poly anchor production`, never write back what the other moved forward. A
 * lock held past the wait is refused (fail closed); one older than a minute is a dead process's, and taken over.
 */
export function changeAnchor(file: string, project: string, change: (a: Anchor) => Anchor): Anchor {
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new KeyringError(`the anchor's lock ${lock} cannot be taken (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; }
      if (Date.now() > until) throw new KeyringError(`the anchor ${file} is being changed by another process (${lock}); nothing was written`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const next = change(parseAnchor(readFileSync(file, 'utf8'), file, project));
    writeAnchorFile(file, next);
    return next;
  } finally { rmSync(lock, { force: true }); }
}

/** A new anchor for a project's first rings: `poly anchor keyrings`. */
export function newAnchor(project: string, first: string, production: boolean): Anchor {
  return { v: 2, id: `anchor-${randomBytes(16).toString('hex')}`, project, first, head: first, policies: {}, production };
}

/** Names the anchor's location for a project in the per-user configuration (or the test one). */
export function nameAnchor(project: string, file: string): string {
  const config = readAnchorConfig();
  mkdirSync(dirname(config.file), { recursive: true });
  writeFileSync(config.file, JSON.stringify({ anchors: { ...config.anchors, [project]: `file:${file}` } }, null, 2) + '\n');
  return config.file;
}

export interface HistoryEntry { rings: Keyrings; record?: SignedRecord }

export function readHistory(dir: string): HistoryEntry[] | null {
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
  return doc as HistoryEntry[];
}

export const ringsDigest = (k: Keyrings, where: string): string => {
  try { return keyringDigest(k); } catch (e) { throw new KeyringError(`${where}: a public key does not parse: ${(e as Error).message}`); }
};

export const keyringRecordOk = (r: unknown, prev: Keyrings, subject: string) => {
  try { return verifyRecord(r, prev, { kind: 'keyring', subject }); } catch (e) { return { ok: false as const, problem: `the record cannot be read: ${(e as Error).message}` }; }
};

/** The digest of each entry's rings, once the first is the anchored one and every later entry is signed for this anchor. */
export function verifyHistory(entries: HistoryEntry[], anchor: Anchor): string[] {
  const digests = entries.map((e, i) => ringsDigest(e.rings, `keyrings/history.json entry ${i}`));
  if (entries[0].record !== undefined) throw new KeyringError('the first rings carry a record; the anchor pins them');
  if (digests[0] !== anchor.first) throw new KeyringError(`the first rings have the digest ${digests[0]}, and the anchor's are ${anchor.first}`);
  for (let i = 1; i < entries.length; i++) {
    const r = entries[i].record;
    if (r === undefined) throw new KeyringError(`entry ${i} changes the rings with no keyring record`);
    // S210, D3: the record names its project by the anchor's id, so one signed for another project does not verify.
    const v = keyringRecordOk(r, entries[i - 1].rings, keyringSubject(anchor.id, digests[i - 1], digests[i]));
    if (!v.ok) throw new KeyringError(`entry ${i}'s record is refused: ${v.problem}; a change is signed for this project by a key of the previous people ring`);
  }
  return digests;
}

/**
 * The chain of a project's rings verified from its anchor: the anchor, where it came from, and the digest of the last
 * rings, which are `current`. Null for a project whose rings are both empty and that has no anchor. S210, D2: the
 * history must hold the anchor's head, so it never goes back past what was admitted. Every failure is a KeyringError.
 */
export function verifyChain(dir: string, project: string, current: Keyrings, source?: AnchorSource): { anchor: Anchor; file: string; source: AnchorSource; head: string; chain: string[] } | null {
  const found = readAnchor(dir, project, source);
  if (!found) {
    if (!current.people.length && !current.agents.length) return null;
    throw new KeyringError(`people or agents are named, and the owner's per-user configuration names no anchor for project ${project}`);
  }
  const entries = readHistory(dir) ?? [{ rings: current }];
  const digests = verifyHistory(entries, found.anchor);
  const head = digests[digests.length - 1];
  if (head !== ringsDigest(current, 'the rings')) throw new KeyringError('the rings are not the last rings of keyrings/history.json; a change is signed with poly sign keyrings');
  if (!digests.includes(found.anchor.head)) throw new KeyringError(`keyrings/history.json does not hold the rings last admitted (${found.anchor.head}); a history is never cut back (S210)`);
  return { ...found, head, chain: digests };
}

/**
 * S210, D2, D7: moves the anchor forward after an admission: its head to the rings admitted, and each scope's policy
 * sequence to the one admitted when that is higher. Read again under the anchor's lock, so two admissions never move
 * it back.
 */
export function advanceAnchor(file: string, project: string, chain: string[], policies: Record<string, number>): Anchor {
  return changeAnchor(file, project, (a) => {
    // The head moves to this chain's last rings only when the kept head lies on this chain, behind or at them.
    const at = chain.indexOf(a.head);
    const next: Anchor = { ...a, head: at >= 0 ? chain[chain.length - 1] : a.head, policies: { ...a.policies } };
    for (const [scope, n] of Object.entries(policies)) if (!(next.policies[scope] >= n)) next.policies[scope] = n;
    return next;
  });
}
