// The project manifest, `poly.json` (PT1.2, decision M1-6).
//
//   { "poly": "1", "name": "orders", "modules": ["src/*.poly"],
//     "host": "typescript", "require": { "grade": false },
//     "engines": { "polygraph": "^8.3", "polyaxion": "^2" } }
//
// Only the fields PT1.2 states are read. A field the build needs that PT1.2
// does not have is a spec issue, raised before it is used (M1-6), so an
// unknown field is refused here rather than silently ignored.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface Manifest {
  poly: '1';
  name: string;
  modules: string[];
  host?: 'typescript';
  require?: { grade?: boolean };
  engines?: Record<string, string>;
  /** S72: the effect handler modules `poly lint handlers` reads (PT6.5). */
  handlers?: string[];
  /**
   * S126: the admission key, named by id and location, never by value. A location is `env:NAME` (a variable
   * holding the private key, PEM) or `file:PATH` (a file outside version control). No private key is committed.
   */
  keys?: { admission: { id: string; location: string } };
}

export class ManifestError extends Error {}

const KNOWN = new Set(['poly', 'name', 'modules', 'host', 'require', 'engines', 'handlers', 'keys']);

export function parseManifest(text: string, where = 'poly.json'): Manifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ManifestError(`${where}: not JSON (${(e as Error).message})`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ManifestError(`${where}: expected an object`);
  const m = raw as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!KNOWN.has(k)) throw new ManifestError(`${where}: unknown field "${k}" (PT1.2 lists poly, name, modules, host, require, engines, handlers, keys)`);
  if (m.poly !== '1') throw new ManifestError(`${where}: "poly" must be "1"`);
  if (typeof m.name !== 'string' || !m.name) throw new ManifestError(`${where}: "name" must be a non-empty string`);
  if (!Array.isArray(m.modules) || m.modules.length === 0 || !m.modules.every((x) => typeof x === 'string' && x)) {
    throw new ManifestError(`${where}: "modules" must be a non-empty list of paths or patterns`);
  }
  if (m.handlers !== undefined && (!Array.isArray(m.handlers) || m.handlers.length === 0 || !m.handlers.every((x) => typeof x === 'string' && x))) {
    throw new ManifestError(`${where}: "handlers" must be a non-empty list of paths or patterns (S72)`);
  }
  if (m.host !== undefined && m.host !== 'typescript') throw new ManifestError(`${where}: "host" must be "typescript"`);
  if (m.require !== undefined) {
    const r = m.require as Record<string, unknown>;
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => k !== 'grade') || (r.grade !== undefined && typeof r.grade !== 'boolean')) {
      throw new ManifestError(`${where}: "require" may only hold "grade": true or false`);
    }
  }
  if (m.engines !== undefined) {
    const e = m.engines as Record<string, unknown>;
    if (e === null || typeof e !== 'object' || Array.isArray(e) || !Object.values(e).every((v) => typeof v === 'string')) {
      throw new ManifestError(`${where}: "engines" must map engine names to version ranges`);
    }
  }
  if (m.keys !== undefined) {
    const k = m.keys as Record<string, unknown>;
    const a = (k && typeof k === 'object' && !Array.isArray(k) ? k.admission : undefined) as Record<string, unknown> | undefined;
    const ok = a && typeof a === 'object' && Object.keys(k).length === 1 && Object.keys(a).sort().join(',') === 'id,location'
      && typeof a.id === 'string' && a.id !== '' && typeof a.location === 'string' && /^(env|file):./.test(a.location);
    if (!ok) throw new ManifestError(`${where}: "keys" must be { "admission": { "id": "...", "location": "env:NAME" or "file:PATH" } } (S126)`);
  }
  return m as unknown as Manifest;
}

/** A module pattern to a regular expression: `*` within one path segment, `**` across segments. */
function patternToRegExp(pattern: string): RegExp {
  let re = '';
  const p = pattern.split('\\').join('/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += p[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Links are not followed: a module is a file inside the project directory, and a link can lead out of it or loop.
function allFiles(dir: string, root: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.poly' || e.name === '.git' || e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) allFiles(p, root, out);
    else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
  }
}

/** The project directory's manifest and the module files it names, sorted. */
export function loadProject(dir: string): { manifest: Manifest; files: string[]; handlers: string[] | null } {
  const path = join(dir, 'poly.json');
  if (!existsSync(path)) throw new ManifestError(`${dir}: no poly.json (a project directory needs its manifest, PT1.2)`);
  const manifest = parseManifest(readFileSync(path, 'utf8'), path);
  const every: string[] = [];
  allFiles(dir, dir, every);
  const files = new Set<string>();
  for (const pattern of manifest.modules) {
    const re = patternToRegExp(pattern);
    const hits = every.filter((f) => re.test(f));
    if (hits.length === 0) throw new ManifestError(`${path}: module pattern "${pattern}" matches no file`);
    for (const h of hits) {
      // S71: a module is a .poly file, or a .ts file in the embedded surface (PT2.5).
      if (!h.endsWith('.poly') && !h.endsWith('.ts')) throw new ManifestError(`${path}: module pattern "${pattern}" matches ${h}, which is not a .poly or .ts module`);
      files.add(h);
    }
  }
  // S72: the handler modules, when the manifest names them.
  let handlers: string[] | null = null;
  if (manifest.handlers) {
    const hs = new Set<string>();
    for (const pattern of manifest.handlers) {
      const re = patternToRegExp(pattern);
      const hits = every.filter((f) => re.test(f));
      if (hits.length === 0) throw new ManifestError(`${path}: handler pattern "${pattern}" matches no file`);
      for (const h of hits) {
        if (!/\.(ts|js|mjs|cjs)$/.test(h)) throw new ManifestError(`${path}: handler pattern "${pattern}" matches ${h}, which is not a TypeScript or JavaScript module`);
        hs.add(h);
      }
    }
    handlers = [...hs].sort().map((f) => join(dir, f));
  }
  return { manifest, files: [...files].sort().map((f) => join(dir, f)), handlers };
}
