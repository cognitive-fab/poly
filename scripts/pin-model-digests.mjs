#!/usr/bin/env node
// S143: rewrites RUNTIME_MODEL_DIGESTS in packages/poly-core/src/reserved.ts from PT9.7's model at every bound, so a
// change to the model and its pinned digests land in one commit. test/reserved-runtime.test.mjs recomputes them and
// fails while they differ. Run after any change to packages/poly-runtime/model/outbox-intent.poly.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';
import { parse } from '@poly/lang';
import { digest } from '@poly/core';
import { modelSource, BOUNDS } from '@poly/runtime/model';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
assertNotExperimentTree(ROOT);
const file = join(ROOT, 'packages', 'poly-core', 'src', 'reserved.ts');
const text = readFileSync(file, 'utf8');
const digests = BOUNDS.map((m) => digest(parse(modelSource(m)).module));
const start = text.indexOf('export const RUNTIME_MODEL_DIGESTS');
const end = text.indexOf(']);', start) + 3;
if (start < 0 || end < 3) throw new Error('RUNTIME_MODEL_DIGESTS not found');
const block = `export const RUNTIME_MODEL_DIGESTS: ReadonlySet<string> = new Set([\n${digests.map((d) => `  '${d}',`).join('\n')}\n]);`;
writeFileSync(file, text.slice(0, start) + block + text.slice(end));
console.log(`pinned ${digests.length} digests`);
