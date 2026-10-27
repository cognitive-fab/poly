// Shared by the gate tests: parse, check and lower a poly source, and write
// its artefacts where Node can resolve @cognitive-fab/sam-pattern.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from '@poly/lang';
import { checkModule, expandChannels, expandRoutes } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { resolveUses, resolveProviders, resolveRouting } from '@poly/check';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const BUILD = join(ROOT, '.poly', 'test-build');

export function polyFiles(dir, { refused = false } = {}) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'errors') out.push(...polyFiles(p, { refused })); } else if (p.endsWith('.poly')) {
      // A source whose first line expects REFUSED is an error source like those under errors/: no stage after the types can read it.
      // Only the examples' own sweep (test/examples-expected.mjs) asks for it, to compare its verdict with that line.
      if (!refused && /^\/\/ expected: REFUSED\b/.test(readFileSync(p, 'utf8').split(/\r?\n/, 1)[0])) continue;
      out.push(p);
    }
  }
  return out.sort();
}

/** S190, PS15: the tests' own std, with the test channel kind; it never ships in std/. */
export const TEST_STD = join(ROOT, 'test', 'fixtures', 'std');

/**
 * S459 (c), as ruled: a source under examples/ resolves its uses and its provider profiles from std/, as poly check
 * does; every other source from the tests' own std. An example that uses a v1 surface (a credential, a route, a
 * channel) is then checked and built as poly check would check it.
 */
export function stdFor(file) {
  const inside = (dir) => { const rel = relative(join(ROOT, dir), resolve(file)); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
  // The demo copy of the concierge (Step 9) is the example with two cap lines changed, so it is built from the same std.
  return inside('examples') || inside(join('demo', 'concierge')) ? join(ROOT, 'std') : TEST_STD;
}
/** S194: the node arguments of a child process that loads certificates admitted with a test keyring anchor. */
export const ACCEPT_TEST_ANCHORS = ['--import', new URL('./fixtures/accept-test-anchors.mjs', import.meta.url).href];

/** Parse and check a source; any diagnostic is an error for the gate tests that build from it. */
export function load(file) {
  const r = parse(readFileSync(file, 'utf8'));
  if (!r.module) throw new Error(`${file}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
  // S176, S190: the modules its uses name, found as poly check finds them for a lone file, std from the tests' own.
  const std = stdFor(file);
  const uses = resolveUses(r.module, file, undefined, std);
  // PS15: each channel expanded, as poly check expands it; poly-ref is given the source and the program as written.
  const x = expandChannels(r.module, uses.program);
  // PS18: each route's and budget's module m.r and m.b, as poly check expands them.
  const routes = expandRoutes(r.module, uses.program);
  x.extra.push(...routes.extra);
  const program = [...uses.program.filter((m) => m !== r.module), x.module, ...x.extra];
  // PT10e: the provider profiles of its credentials, from the same std.
  const providers = resolveProviders(program, std);
  // PT10r: the price tables and calibration maps its routes name, beside the source.
  const routing = resolveRouting(r.module, file);
  const check = checkModule(x.module, { program, providers, routing });
  const errors = [...r.diagnostics, ...uses.diagnostics, ...x.diagnostics, ...routes.diagnostics, ...check.diagnostics];
  if (errors.length) throw new Error(`${file}: ${errors.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return { module: r.module, expanded: x.module, extra: x.extra, plans: x.plans, check, program, providers, routing, sourceDir: dirname(file), refProgram: uses.program.filter((m) => m !== r.module), std };
}

/** Lower every machine of a source and write each to BUILD/<name>/<module>.<Machine>/. */
export function build(file, name, opts = {}) {
  const { module, expanded, extra, plans, check, program, providers, routing, sourceDir, refProgram, std } = load(file);
  const out = [];
  const lower = (mod, checked, machine, refMachine) => {
    const { lowered, diagnostics } = lowerMachine(mod, checked, machine, { program, ...(plans.length ? { channels: plans } : {}), providers, routing, ...opts });
    if (!lowered) throw new Error(`${file}: ${diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    // One directory per source file: several sources declare intents.OutboxIntent.
    const dir = join(BUILD, name, basename(file, '.poly'), `${mod.name}.${machine}`);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(lowered.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
    out.push({ machine: refMachine, dir, lowered, module, check: checked, program: refProgram, sourceDir, std });
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
