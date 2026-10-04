// Importing a lowered ES module artefact (invariants, path, compose and liveness modules).
//
// An ES module is never unloaded, so each distinct URL imported stays in memory for the life of the process. The URL
// used to carry a timestamp, so that a rewritten file was read again; it also made every check of an unchanged file
// keep a new copy (M6 step 1: about 23 KB per check of conformance/m5/refund.poly). The URL now carries the digest of
// the file's bytes: a changed file is read again, and an unchanged one is the module already loaded.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function importArtefact<T = unknown>(path: string): Promise<T> {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return (await import(`${pathToFileURL(path).href}?sha256=${digest}`)) as T;
}
