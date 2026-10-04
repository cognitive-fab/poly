// Importing a lowered ES module artefact. An ES module is never unloaded, so the URL carries the digest of the file's
// bytes, never a timestamp: a changed file is read again, and checking an unchanged one again keeps no new copy (M6
// step 1). poly-ref has its own copy of this function, since it shares no code with the compiler.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function importArtefact<T = unknown>(path: string): Promise<T> {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return (await import(`${pathToFileURL(path).href}?sha256=${digest}`)) as T;
}
