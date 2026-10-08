// S194 (M9, as ruled): a change to the people or agents ring is signed by a person already trusted, and the first
// rings are anchored outside the project (PT12.5). Without it, an agent that can edit poly.json and holds the
// admission key could add its own key under people and sign as a person. The chain is kept in keyrings/history.json:
// the first entry's rings are the anchor's first rings, and each later entry carries a `keyring` record over
// { anchor, parent, rings } by a key of the previous entry's people ring.
//
// S210 (as ruled): the anchor and the chain's verification live in @poly/core (anchor.ts), so load verifies the chain
// as admission does. This file holds admission's use of them and the owner's commands.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  KeyringError as CoreKeyringError, anchorFile, changeAnchor, createAnchor, keyringRecordOk, keyringSubject, keyringsOf, nameAnchor, newAnchor, readAnchor, readHistory, ringsDigest, signRecord, verifyChain, verifyHistory,
  type Anchor, type Keyrings, type Manifest,
} from '@poly/core';

export { useTestAnchors, underVersionControl } from '@poly/core';

/** Every refusal of the chain; admission reports it as an AdmitError. */
export class KeyringError extends Error {
  constructor(problem: string) { super(`not admitted: PL6410 KEYRING_NOT_SIGNED: ${problem} (S194)`); this.name = 'KeyringError'; }
}
const admitting = <T>(f: () => T): T => { try { return f(); } catch (e) { if (e instanceof CoreKeyringError) throw new KeyringError(e.problem); throw e; } };

/**
 * The project's chain verified from its anchor, or null for a project whose rings are both empty and that has no
 * anchor. Every way the chain can fail is a KeyringError.
 */
export function keyringChain(dir: string, manifest: Manifest, current: Keyrings): { anchor: Anchor; file: string; head: string; chain: string[]; source: 'user' | 'test' } | null {
  return admitting(() => verifyChain(dir, manifest.name, current));
}

/**
 * `poly anchor keyrings`: writes the anchor of the rings in poly.json, with `production` as the owner says (S210), and
 * records its location for this project in the per-user configuration. The owner's command.
 */
export function writeAnchor(dir: string, manifest: Manifest, out: string, production = false): { path: string; digest: string; id: string; config: string } {
  return admitting(() => {
    const file = anchorFile(dir, `file:${resolve(out)}`);
    const a = newAnchor(manifest.name, ringsDigest(keyringsOf(dir, manifest), 'poly.json'), production);
    // c201ccf, S321: a new anchor is written under its lock, as every change is.
    createAnchor(file, a);
    return { path: file, digest: a.first, id: a.id, config: nameAnchor(manifest.name, file) };
  });
}

/** `poly anchor production on|off` (S210, D9): sets whether the project is production, on the anchor and nowhere else. */
export function setProduction(dir: string, manifest: Manifest, production: boolean): { path: string; production: boolean } {
  return admitting(() => {
    const found = readAnchor(dir, manifest.name);
    if (!found) throw new CoreKeyringError(`the owner's per-user configuration names no anchor for project ${manifest.name}`);
    // Polywatch: under the anchor's lock, read again, so an admission's head and sequences are never written back.
    changeAnchor(found.file, manifest.name, (a) => ({ ...a, production }));
    return { path: found.file, production };
  });
}

/**
 * `poly sign keyrings`: appends the rings in poly.json to the history, signed for this project by a key of the last
 * rings' people. With no history yet, the last rings are the ones the last certificate binds (`certified`), which
 * become its first entry, and only when they are the anchored first rings.
 */
export function signKeyrings(dir: string, manifest: Manifest, by: string, privateKeyPem: string, at: string, certified?: Keyrings): { path: string; head: string } {
  return admitting(() => {
    const current = keyringsOf(dir, manifest);
    // Polywatch: a history that would never admit is not extended or written, whether it exists or starts here.
    const found = readAnchor(dir, manifest.name);
    if (!found) throw new CoreKeyringError(`the owner's per-user configuration names no anchor for project ${manifest.name}`);
    let history = readHistory(dir);
    if (!history) {
      if (!certified) throw new CoreKeyringError('there is no keyrings/history.json and no certificate whose rings it would start from');
      if (ringsDigest(certified, 'the certified rings') !== found.anchor.first) throw new CoreKeyringError('keyrings/history.json is missing, and the certified rings are not the anchored first rings; restore the history');
      history = [{ rings: certified }];
    }
    // Polywatch: a history that does not hold the head last admitted would never admit (S210, D2), so it is not extended.
    if (!verifyHistory(history, found.anchor).includes(found.anchor.head)) throw new CoreKeyringError(`keyrings/history.json does not hold the rings last admitted (${found.anchor.head}); a history is never cut back (S210)`);
    mkdirSync(join(dir, 'keyrings'), { recursive: true });
    const prev = history[history.length - 1].rings;
    const parent = ringsDigest(prev, 'the last rings');
    const rings = ringsDigest(current, 'poly.json');
    if (parent === rings) throw new CoreKeyringError('the rings in poly.json are already the last rings of the history');
    const subject = keyringSubject(found.anchor.id, parent, rings);
    const record = signRecord({ kind: 'keyring', subject, by, at }, privateKeyPem);
    const v = keyringRecordOk(record, prev, subject);
    if (!v.ok) throw new CoreKeyringError(`the record is refused: ${v.problem}`);
    const path = join(dir, 'keyrings', 'history.json');
    writeFileSync(path, JSON.stringify([...history, { rings: current, record }], null, 2) + '\n');
    return { path, head: rings };
  });
}

export const historyExists = (dir: string): boolean => existsSync(join(dir, 'keyrings', 'history.json'));
