// The handler closure (S142): the handler files poly.json names, and every file they reach through relative
// imports, each read once. The lint runs over these bytes, and admission certifies their digests, so the handlers
// the runtime loads are the handlers the lint read (the hash-first rule of review A1, applied to handlers).
//
// What the certificate cannot cover is refused here, as PL6402: a relative import that resolves to no file, or to a
// file outside the project, and an absolute path or URL. S154: an installed package (a bare specifier) is followed
// through Node's resolution into node_modules; every file reached there, and each package's package.json, is hashed
// and certified under packageFiles. Packages are hashed, not linted. The nearest lockfile's digest is recorded too.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { diag, sha256OfBytes, type Diagnostic } from '@poly/core';
import { lintHandlerText } from './lint.js';

/** The lint's version, recorded in the certificate (S142): it names the rules and the set they run over. */
export const LINT_VERSION = 'poly-lint-handlers 2: PT6.5 over the relative-import closure (S72, S142)';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

export interface HandlerClosure {
  /** The files poly.json names, relative to the project root. */
  roots: string[];
  /** Every file of the closure, relative to the project root, with its bytes as read. */
  bytes: Map<string, Buffer>;
  digests: Record<string, string>;
  /** Installed packages the closure imports (bare specifiers). */
  packages: string[];
  /** S154: every file reached inside installed packages, and each package's package.json, by path relative to the root. */
  packageFiles: Record<string, string>;
  /** Review D-F3: imports inside packages that resolve to no file (an optional dependency, say), listed in the limits. */
  packageUnresolved: string[];
  /** The nearest lockfile above the project, relative to its root, and its digest; null when there is none. */
  lockfile: { path: string; digest: string } | null;
  /** PL6402 for what cannot be certified, and the lint's PL6401 over every file. */
  diagnostics: Diagnostic[];
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join('/');

/** The run-time module specifiers of a file: imports, re-exports, `import()` and `require` of a literal. */
function specifiers(text: string, file: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const typeOnly = (ts.isImportDeclaration(n) && !!n.importClause?.isTypeOnly) || (ts.isExportDeclaration(n) && n.isTypeOnly);
    if (!typeOnly && (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) out.push(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The file a relative specifier names, as Node resolves it with type stripping: the path itself, or with an extension. */
function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  // Review D-F3: CommonJS also takes .json, and a directory's own package.json main.
  for (const p of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    const pj = join(base, 'package.json');
    if (existsSync(pj)) {
      try { const main = (JSON.parse(readFileSync(pj, 'utf8')) as { main?: string }).main; if (main) { const m = resolveRelative(pj, main.startsWith('.') ? main : `./${main}`); if (m) return m; } } catch { /* no main */ }
    }
    for (const p of [join(base, 'index.ts'), join(base, 'index.js'), join(base, 'index.json')]) if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Review D-F3: every target a conditional exports or imports entry can resolve to, under any condition but `types`
 * (a superset of what Node picks, which depends on the importer and its conditions), with a subpath pattern applied.
 */
function mapTargets(map: unknown, key: string): string[] {
  const leaves = (x: unknown): string[] => {
    if (typeof x === 'string') return [x];
    if (Array.isArray(x)) return x.flatMap(leaves);
    if (x && typeof x === 'object') return Object.entries(x as Record<string, unknown>).filter(([c]) => c !== 'types').flatMap(([, v]) => leaves(v));
    return [];
  };
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const m = map as Record<string, unknown>;
  if (key in m) return leaves(m[key]);
  // A subpath pattern: the longest key whose prefix (before *) and suffix match; its targets with * replaced.
  const patterns = Object.keys(m).filter((k) => k.includes('*')).sort((a, b) => b.length - a.length);
  for (const p of patterns) {
    const [pre, post] = p.split('*');
    if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
      const star = key.slice(pre.length, key.length - post.length);
      return leaves(m[p]).map((t) => t.split('*').join(star));
    }
  }
  return [];
}

/** S154: the directory of an installed package, found as Node finds it, walking up from a file's directory. */
function packageDir(from: string, name: string): string | null {
  for (let d = dirname(from); ; d = dirname(d)) {
    const p = join(d, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) return null;
  }
}

/** S154: the file an import of a package (and a subpath of it) names, by its exports map, or its main. */
function packageEntries(dir: string, subpath: string): string[] {
  let pkg: { exports?: unknown; main?: string };
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return []; }
  const key = subpath ? `./${subpath}` : '.';
  let targets: string[] = [];
  if (pkg.exports !== undefined) {
    const ex = pkg.exports;
    const sugar = typeof ex === 'string' || Array.isArray(ex) || (ex && typeof ex === 'object' && !Object.keys(ex as object).some((k) => k.startsWith('.')));
    targets = sugar ? (key === '.' ? mapTargets({ '.': ex }, '.') : []) : mapTargets(ex, key);
  }
  if (!targets.length) targets = [subpath || pkg.main || 'index.js'];
  return targets.map((t) => resolveRelative(join(dir, 'package.json'), t.startsWith('.') ? t : `./${t}`)).filter((x): x is string => x !== null);
}

/** Review D-F3: a `#name` import, by the "imports" map of the nearest package.json above the file. */
function importsEntries(from: string, spec: string): { files: string[]; bare: string[] } {
  for (let d = dirname(from); ; d = dirname(d)) {
    const pj = join(d, 'package.json');
    if (existsSync(pj)) {
      let imports: unknown;
      try { imports = (JSON.parse(readFileSync(pj, 'utf8')) as { imports?: unknown }).imports; } catch { imports = undefined; }
      const targets = mapTargets(imports, spec);
      return { files: targets.filter((t) => t.startsWith('.')).map((t) => resolveRelative(pj, t)).filter((x): x is string => x !== null), bare: targets.filter((t) => !t.startsWith('.')) };
    }
    if (dirname(d) === d) return { files: [], bare: [] };
  }
}

function nearestLockfile(root: string): { path: string; digest: string } | null {
  for (let d = resolve(root); ; d = dirname(d)) {
    for (const name of LOCKFILES) {
      const p = join(d, name);
      if (existsSync(p)) return { path: rel(root, p), digest: sha256OfBytes(readFileSync(p)) };
    }
    if (dirname(d) === d) return null;
  }
}

/** Reads the closure of the handler files once, lints it, and lists what the certificate cannot cover (S142). */
export function handlerClosure(root: string, files: string[]): HandlerClosure {
  const absRoot = resolve(root);
  const bytes = new Map<string, Buffer>();
  const packages = new Set<string>();
  const packageBytes = new Map<string, Buffer>();
  const packageQueue: string[] = [];
  const unresolved = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const uncertifiable = (file: string, message: string) => diagnostics.push(diag('PL6402', { line: 1, col: 1 }, `${rel(absRoot, file)}: ${message} (S142)`));
  const queue = files.map((f) => resolve(f));
  while (queue.length) {
    const file = queue.shift()!;
    const path = rel(absRoot, file);
    if (bytes.has(path)) continue;
    if (path.startsWith('../') || path === '..') { uncertifiable(file, 'the file is outside the project, so the certificate cannot name it'); continue; }
    const b = readFileSync(file);
    bytes.set(path, b);
    const text = b.toString('utf8');
    diagnostics.push(...lintHandlerText(text, path));
    for (const spec of specifiers(text, file)) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolveRelative(file, spec);
        if (!target) { uncertifiable(file, `the import '${spec}' names no file`); continue; }
        if (rel(absRoot, target).startsWith('../')) { uncertifiable(file, `the import '${spec}' is outside the project, so the certificate cannot name it`); continue; }
        queue.push(target);
      } else if (spec.startsWith('/') || (/^[a-z]+:/i.test(spec) && !spec.startsWith('node:'))) {
        uncertifiable(file, `the import '${spec}' is an absolute path or URL, which the certificate cannot name`);
      } else if (!isBuiltin(spec)) {
        // A bare specifier: an installed package. Its name is the first segment, or the first two for a scope.
        const parts = spec.split('/');
        const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        packages.add(name);
        // S154: followed into the package, which is hashed with what it reaches.
        const pdir = packageDir(file, name);
        const entries = pdir ? packageEntries(pdir, parts.slice(spec.startsWith('@') ? 2 : 1).join('/')) : [];
        if (!pdir || !entries.length) { uncertifiable(file, `the import '${spec}' resolves to no installed package file, so the certificate cannot name it`); continue; }
        packageQueue.push(join(pdir, 'package.json'), ...entries);
      }
    }
  }
  // S154: the files reached inside installed packages, through their relative imports and the packages they import.
  while (packageQueue.length) {
    const file = packageQueue.shift()!;
    const path = rel(absRoot, file);
    if (packageBytes.has(path)) continue;
    const b = readFileSync(file);
    packageBytes.set(path, b);
    if (file.endsWith('package.json')) continue;
    if (file.endsWith('.json')) continue;
    for (const spec of specifiers(b.toString('utf8'), file)) {
      // Review D-F3: a specifier that resolves to nothing is listed, never dropped silently.
      if (spec.startsWith('./') || spec.startsWith('../')) { const t = resolveRelative(file, spec); if (t) packageQueue.push(t); else unresolved.add(`${rel(absRoot, file)}: '${spec}'`); continue; }
      if (spec.startsWith('/') || /^[a-z]+:/i.test(spec) || isBuiltin(spec)) continue;
      const bares = [spec];
      if (spec.startsWith('#')) {
        const im = importsEntries(file, spec);
        packageQueue.push(...im.files);
        bares.splice(0, 1, ...im.bare);
        if (!im.files.length && !im.bare.length) unresolved.add(`${rel(absRoot, file)}: '${spec}'`);
      }
      for (const bare of bares) {
        if (isBuiltin(bare)) continue;
        const parts = bare.split('/');
        const name = bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const pdir = packageDir(file, name);
        const entries = pdir ? packageEntries(pdir, parts.slice(bare.startsWith('@') ? 2 : 1).join('/')) : [];
        if (pdir && entries.length) packageQueue.push(join(pdir, 'package.json'), ...entries);
        else unresolved.add(`${rel(absRoot, file)}: '${bare}'`);
      }
    }
  }
  const lockfile = nearestLockfile(absRoot);
  if (packages.size && !lockfile) diagnostics.push(diag('PL6402', { line: 1, col: 1 }, `the handlers import ${[...packages].sort().join(', ')}, and no lockfile is above the project to record (S142)`));
  const digests = Object.fromEntries([...bytes].sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, b]) => [p, sha256OfBytes(b)]));
  const packageFiles = Object.fromEntries([...packageBytes].sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, b]) => [p, sha256OfBytes(b)]));
  return { roots: files.map((f) => rel(absRoot, resolve(f))).sort(), bytes, digests, packages: [...packages].sort(), packageFiles, packageUnresolved: [...unresolved].sort(), lockfile, diagnostics };
}
