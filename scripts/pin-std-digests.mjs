// Writes std/PINS.json: the digest of each .poly file of the standard library (PS23.4, G4). Run it after any change to a library file; the pins are committed with
// the change. A file that is not pinned is not the library, and may not declare an effect idempotent by nature.
// usage: node scripts/pin-std-digests.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const STD = join(fileURLToPath(import.meta.url), '..', '..', 'std');
// Like every script that writes under the repository, it refuses to run in a tree that is an experiment's (M4).
assertNotExperimentTree(join(STD, '..'));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) walk(f);
    else if (name.endsWith('.poly')) files.push(f);
  }
};
walk(STD);
const digest = (text) => 'sha256:' + createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const table = { v: 1, files: Object.fromEntries(files.map((f) => [relative(STD, f).split(sep).join('/'), digest(readFileSync(f, 'utf8'))])) };
writeFileSync(join(STD, 'PINS.json'), JSON.stringify(table, null, 2) + '\n');
console.log(`pinned ${files.length} files in std/PINS.json`);
