// PS23.4, G4 (PT33.1): only a module of the standard library may declare an effect idempotent by nature. A module is one of the library when its file sits
// under std/ and its digest is the one std/PINS.json pins, as the runtime's own models are identified by their digests (S143). A file that is edited, or a
// copy elsewhere, is not pinned. `scripts/pin-std-digests.mjs` writes the pins; changing a library file means pinning it again, in the same commit.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { STD } from './uses.js';

/** The pinned digest of a text: line endings are normalised, so a checkout on any platform pins alike. */
export const pinDigest = (text: string): string => 'sha256:' + createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/** Whether `file` is a library file whose digest is pinned. */
export function pinnedStd(file: string, std: string = STD): boolean {
  const rel = relative(resolve(std), resolve(file));
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) return false;
  const pins = join(std, 'PINS.json');
  if (!existsSync(pins)) return false;
  try {
    const table = JSON.parse(readFileSync(pins, 'utf8')) as { files?: Record<string, string> };
    return table.files?.[rel.split(sep).join('/')] === pinDigest(readFileSync(file, 'utf8'));
  } catch { return false; }
}
