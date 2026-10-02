#!/usr/bin/env node
// Lowers the OutboxIntent model once per retry bound (S120) into packages/poly-runtime/model/build, with a
// MANIFEST.json of the files' digests, which the runtime checks before it registers them. The runtime's CI
// (test/outbox-intent.test.mjs) lowers them again and requires the same bytes, so the checked-in builds are what
// the source says. Run after any change to model/outbox-intent.poly or to the lowering.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';
import { lowerModels } from './outbox-models.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
assertNotExperimentTree(ROOT);
const out = join(ROOT, 'packages', 'poly-runtime', 'model', 'build');
rmSync(out, { recursive: true, force: true });
const { files, manifest } = lowerModels();
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(join(out, rel.split('/')[0]), { recursive: true });
  writeFileSync(join(out, rel), text);
}
writeFileSync(join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${Object.keys(files).length} files for ${Object.keys(manifest).length / 4} bounds`);
