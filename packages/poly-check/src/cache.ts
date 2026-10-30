// The result cache (PT14a). A machine's result from strict validate() onward, and a configuration's result, are stored
// under the SHA-256 of what they depend on and read back when the key recurs. The key covers more than a result needs:
// one that missed an input would change a verdict, and one that holds an extra input only costs a check. The cache is
// read only when the caller passes a directory (the command line's poly check does by default); poly admit, the
// language server, edit-check and the test suite never pass one, so a certificate never rests on a cached result.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { canonicalize, digest, sha256Hex, type Module } from '@poly/core';
import type * as A from '@poly/core';
import { STD } from './uses.js';

/** Bumped when the shape of an entry changes, so an older entry is a miss and never misread. */
const FORMAT = 1;

const HERE_REQUIRE = createRequire(import.meta.url);

/** The directory of a package, from an entry point it resolves to. */
function packageDir(spec: string): string | null {
  let dir: string;
  try { dir = dirname(HERE_REQUIRE.resolve(spec)); } catch { return null; }
  for (let k = 0; k < 8; k++, dir = dirname(dir)) if (existsSync(join(dir, 'package.json'))) return dir;
  return null;
}

/** Every file under a directory with one of the extensions, as relative path and bytes, in a fixed order. */
function filesUnder(root: string, exts: RegExp, out: [string, string][] = [], rel = ''): [string, string][] {
  let names: string[];
  try { names = readdirSync(join(root, rel)).sort(); } catch { return out; }
  for (const n of names) {
    if (n === 'node_modules' || n === '.poly') continue;
    const p = join(root, rel, n);
    const r = rel ? `${rel}/${n}` : n;
    if (statSync(p).isDirectory()) filesUnder(root, exts, out, r);
    else if (exts.test(n)) out.push([r, sha256Hex(readFileSync(p, 'latin1'))]);
  }
  return out;
}

let toolchain: string | null = null;

/**
 * PT14a: the bytes of the built checker and of the engines it runs, and std. A version string is not enough: a checkout
 * being edited keeps its version, and its cache would outlive the code that wrote it.
 */
export function toolchainDigest(): string {
  if (toolchain) return toolchain;
  const parts: Record<string, [string, string][] | null> = {};
  for (const pkg of ['@poly/core', '@poly/lang', '@poly/lower', '@poly/ref', '@poly/check']) {
    const dir = packageDir(pkg);
    parts[pkg] = dir ? filesUnder(join(dir, 'dist', 'src'), /\.(js|cjs|mjs)$/) : null;
  }
  for (const [name, spec] of [['@cognitive-fab/sam-pattern', '@cognitive-fab/sam-pattern'], ['@cognitive-fab/polygraph', '@cognitive-fab/polygraph/scripts/check.mjs']]) {
    const dir = packageDir(spec);
    parts[name] = dir ? filesUnder(dir, /\.(js|cjs|mjs|json)$/) : null;
  }
  parts.std = filesUnder(STD, /./);
  toolchain = 'sha256:' + sha256Hex(canonicalize(parts));
  return toolchain;
}

/** The key of one result: its kind and parts, with the format and the toolchain. */
export function cacheKey(kind: 'machine' | 'configuration', parts: Record<string, unknown>): string {
  return 'sha256:' + sha256Hex(canonicalize({ format: FORMAT, kind, toolchain: toolchainDigest(), ...parts }));
}

const fileOf = (dir: string, kind: string, key: string) => join(dir, `v${FORMAT}`, kind, `${key.slice('sha256:'.length)}.json`);

/** An entry, or null. An entry that does not parse, or whose recorded key is not its name, is a miss, never a pass. */
export function readEntry<T>(dir: string, kind: 'machine' | 'configuration', key: string): T | null {
  const f = fileOf(dir, kind, key);
  if (!existsSync(f)) return null;
  try {
    const e = JSON.parse(readFileSync(f, 'utf8')) as { key?: string; value?: T };
    return e && e.key === key && e.value !== undefined ? e.value : null;
  } catch { return null; }
}

/** Writes an entry to a temporary file and renames it, so a concurrent reader sees a whole entry or none. */
export function writeEntry(dir: string, kind: 'machine' | 'configuration', key: string, value: unknown): void {
  const f = fileOf(dir, kind, key);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ key, value }));
  try { renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
}

// ── what a key reads of the program ──────────────────────────────────────────

/** Declarations whose expansion reads handlers across machines (PS15 to PS18): with any, the narrowing is off. */
const EXPANDED = new Set(['Channel', 'Credential', 'Route', 'Budget', 'Source', 'Audience']);

/** Whether a program's keys may read other machines as their interfaces (PT14a); false when anything is expanded. */
export function narrowable(program: Module[], extras: number): boolean {
  return extras === 0 && program.every((m) => m.decls.every((d) => !EXPANDED.has(d.kind)));
}

/** A machine with each handler's body removed: the handler, its action and its `by` stay (PT14a). */
function interfaceOf(m: A.Machine): unknown {
  return { ...m, items: m.items.map((i) => (i.kind === 'Handler' ? { ...i, body: [] } : i)) };
}

/** A configuration without its properties, as a machine's key reads it (PT14a). */
function withoutProperties(c: A.Configuration): unknown {
  return { ...c, properties: [] };
}

/** Facts the key needs from the compiler's check of a module: each machine's attached and detached children. */
export type Spawns = Map<string, string[]>;

/** The machines a set of roots runs or can spawn, transitively, by name in their own module. */
export function closure(roots: string[], spawns: Spawns): Set<string> {
  const out = new Set<string>();
  const todo = [...roots];
  while (todo.length) {
    const n = todo.pop()!.split('.').pop()!;
    if (out.has(n)) continue;
    out.add(n);
    todo.push(...(spawns.get(n) ?? []));
  }
  return out;
}

/** Digests by node, so a check that computes many keys canonicalizes each declaration once. */
const DIGESTS = new WeakMap<object, string>();
const INTERFACES = new WeakMap<object, string>();
const CONFIGS = new WeakMap<object, string>();
function memo(map: WeakMap<object, string>, node: object, f: () => unknown): string {
  let d = map.get(node);
  if (d === undefined) { d = digest(f()); map.set(node, d); }
  return d;
}

/** The declarations of one key, as digests: the local module narrowed when it may be, every other module in full. */
export function programView(modules: Module[], local: string, opts: { narrow: boolean; full: Set<string>; configuration?: string }): unknown {
  const seen = new Set<string>();
  const out: { module: string; decls: string[] }[] = [];
  for (const m of modules) {
    const d = memo(DIGESTS, m, () => m);
    if (seen.has(d)) continue;
    seen.add(d);
    if (!opts.narrow || m.name !== local) { out.push({ module: m.name, decls: [d] }); continue; }
    out.push({
      module: m.name,
      decls: m.decls.map((x) => {
        if (x.kind === 'Machine' && !opts.full.has(x.name)) return memo(INTERFACES, x, () => interfaceOf(x));
        if (x.kind === 'Configuration' && x.name !== opts.configuration) return memo(CONFIGS, x, () => withoutProperties(x));
        return memo(DIGESTS, x, () => x);
      }),
    });
  }
  return out;
}
