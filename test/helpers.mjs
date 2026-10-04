// Shared by the gate tests: parse, check and lower a poly source, and write
// its artefacts where Node can resolve @cognitive-fab/sam-pattern.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const BUILD = join(ROOT, '.poly', 'test-build');

export function polyFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'errors') out.push(...polyFiles(p)); } else if (p.endsWith('.poly')) out.push(p);
  }
  return out.sort();
}

/** Parse and check a source; any diagnostic is an error for the gate tests that build from it. */
export function load(file) {
  const r = parse(readFileSync(file, 'utf8'));
  if (!r.module) throw new Error(`${file}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
  const check = checkModule(r.module);
  const errors = [...r.diagnostics, ...check.diagnostics];
  if (errors.length) throw new Error(`${file}: ${errors.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return { module: r.module, check };
}

/** Lower every machine of a source and write each to BUILD/<name>/<module>.<Machine>/. */
export function build(file, name, opts = {}) {
  const { module, check } = load(file);
  const out = [];
  for (const machine of check.machines.keys()) {
    const { lowered, diagnostics } = lowerMachine(module, check, machine, opts);
    if (!lowered) throw new Error(`${file}: ${diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    // One directory per source file: several sources declare intents.OutboxIntent.
    const dir = join(BUILD, name, basename(file, '.poly'), `${module.name}.${machine}`);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(lowered.files)) writeFileSync(join(dir, f), text);
    out.push({ machine, dir, lowered, module, check });
  }
  return out;
}

/** A fresh require of a lowered next.cjs (the cache is cleared, so rebuilt files are reloaded). */
export function requireModule(dir) {
  const req = createRequire(join(dir, 'next.cjs'));
  const path = req.resolve(join(dir, 'next.cjs'));
  delete req.cache[path];
  return req(path);
}
