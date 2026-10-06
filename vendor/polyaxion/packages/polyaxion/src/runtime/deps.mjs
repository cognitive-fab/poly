// Where the runtime finds what it shares with polysec and polyman (spec 07 §3).
//
// Two layouts, one code path:
//   installed   — @cognitive-fab/polysec-core and @cognitive-fab/polyman are
//                 dependencies, resolved by specifier like any package;
//   monorepo    — the same code sits beside us as packages/polysec-core and
//                 packages/polysec/polyman, reached by path.
//
// polysec-core has no build step, so the package wins when it resolves and
// the sibling is the fallback for a checkout that never ran npm install.
// polyman is TypeScript with a built dist: in a checkout the source beside us
// is newer than any build of it, so the sibling source wins when it exists and
// the package (dist) is what an installed polyaxion gets. Which one answered is
// recorded in `resolved` and reported by `status`, so nobody has to guess.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIBLING_CORE = resolve(HERE, '../../../polysec-core/src');
const SIBLING_POLYMAN = resolve(HERE, '../../../polysec/polyman/src');

/** name → 'package' | 'sibling', filled as modules are first loaded. */
export const resolved = {};
const cache = new Map();

function locate(specifier) {
  try { return import.meta.resolve(specifier); }
  catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || e.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return null; throw e; }
}

function load(name, { specifier, sibling, prefer }) {
  if (cache.has(name)) return cache.get(name);
  const p = (async () => {
    const order = prefer === 'sibling' && existsSync(sibling) ? ['sibling', 'package'] : ['package', 'sibling'];
    let lastError = null;
    for (const how of order) {
      if (how === 'package') {
        const url = locate(specifier);
        if (!url) continue;
        try { const m = await import(url); resolved[name] = 'package'; return m; }
        catch (e) {
          // the package resolved but its own file is missing (an unbuilt dist): fall through; anything else is real
          if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(fileURLToPath(url).split(/[\\/]/).pop())) { lastError = e; continue; }
          throw e;
        }
      } else {
        if (!existsSync(sibling)) continue;
        const m = await import(pathToFileURL(sibling).href); resolved[name] = 'sibling'; return m;
      }
    }
    const e = new Error(`cannot resolve ${specifier}: not installed as a package and no sibling checkout at ${sibling}${lastError ? ` (${lastError.message})` : ''}`);
    e.code = 'ERR_MODULE_NOT_FOUND'; throw e;
  })();
  cache.set(name, p);
  return p;
}

const KNOWN = {
  'polysec-core': { specifier: '@cognitive-fab/polysec-core/lib', sibling: join(SIBLING_CORE, 'polysec-lib.mjs'), prefer: 'package' },
  polyman: { specifier: '@cognitive-fab/polyman', sibling: join(SIBLING_POLYMAN, 'index.ts'), prefer: 'sibling' },
};

/** Where each shared dependency would come from, without loading it: 'package' | 'sibling' | 'missing'. Loaded ones report what actually answered. */
export function probe() {
  const out = {};
  for (const [name, d] of Object.entries(KNOWN)) {
    const loaded = Object.entries(resolved).find(([k]) => k === name || k.startsWith(name + '/'));
    if (loaded) { out[name] = loaded[1]; continue; }
    const pkg = locate(d.specifier) ? 'package' : null; const sib = existsSync(d.sibling) ? 'sibling' : null;
    out[name] = (d.prefer === 'sibling' ? (sib ?? pkg) : (pkg ?? sib)) ?? 'missing';
  }
  return out;
}

/** A polysec-core module by short name: lib, harden, canon, notary, catalogue, tool-labels. */
export const core = (mod) => load(`polysec-core/${mod}`, { specifier: `@cognitive-fab/polysec-core/${mod}`, sibling: join(SIBLING_CORE, `polysec-${mod}.mjs`), prefer: 'package' });

/** polyman's entry, or one of its adapters: '' (the kernel), 'mcp', 'vercel'. */
export const polyman = (sub = '') => load(`polyman${sub ? '/' + sub : ''}`, { specifier: `@cognitive-fab/polyman${sub ? '/' + sub : ''}`, sibling: join(SIBLING_POLYMAN, `${sub || 'index'}.ts`), prefer: 'sibling' });
