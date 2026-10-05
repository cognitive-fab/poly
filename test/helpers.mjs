// Shared by the gate tests: parse, check and lower a poly source, and write
// its artefacts where Node can resolve @cognitive-fab/sam-pattern.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from '@poly/lang';
import { checkModule, expandChannels } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { resolveUses } from '@poly/check';

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

/** S190, PS15: the tests' own std, with the test channel kind; it never ships in std/. */
export const TEST_STD = join(ROOT, 'test', 'fixtures', 'std');

/** Parse and check a source; any diagnostic is an error for the gate tests that build from it. */
export function load(file) {
  const r = parse(readFileSync(file, 'utf8'));
  if (!r.module) throw new Error(`${file}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
  // S176, S190: the modules its uses name, found as poly check finds them for a lone file, std from the tests' own.
  const uses = resolveUses(r.module, file, undefined, TEST_STD);
  // PS15: each channel expanded, as poly check expands it; poly-ref is given the source and the program as written.
  const x = expandChannels(r.module, uses.program);
  const program = [...uses.program.filter((m) => m !== r.module), x.module, ...x.extra];
  const check = checkModule(x.module, { program });
  const errors = [...r.diagnostics, ...uses.diagnostics, ...x.diagnostics, ...check.diagnostics];
  if (errors.length) throw new Error(`${file}: ${errors.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return { module: r.module, expanded: x.module, extra: x.extra, plans: x.plans, check, program, refProgram: uses.program.filter((m) => m !== r.module) };
}

/** Lower every machine of a source and write each to BUILD/<name>/<module>.<Machine>/. */
export function build(file, name, opts = {}) {
  const { module, expanded, extra, plans, check, program, refProgram } = load(file);
  const out = [];
  const lower = (mod, checked, machine, refMachine) => {
    const { lowered, diagnostics } = lowerMachine(mod, checked, machine, { program, ...(plans.length ? { channels: plans } : {}), ...opts });
    if (!lowered) throw new Error(`${file}: ${diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    // One directory per source file: several sources declare intents.OutboxIntent.
    const dir = join(BUILD, name, basename(file, '.poly'), `${mod.name}.${machine}`);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(lowered.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
    out.push({ machine: refMachine, dir, lowered, module, check: checked, program: refProgram });
  };
  for (const machine of check.machines.keys()) lower(expanded, check, machine, machine);
  // PS15: each channel's conversation, the machine c.Conversation as poly-ref names it.
  for (const x of extra) {
    const checked = checkModule(x, { program });
    for (const machine of checked.machines.keys()) lower(x, checked, machine, `${x.name.slice(module.name.length + 1)}.${machine}`);
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
