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
  for (const p of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.ts'), join(base, 'index.js')]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
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
function packageEntry(dir: string, subpath: string): string | null {
  let pkg: { exports?: unknown; main?: string; module?: string };
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return null; }
  const pick = (x: unknown): string | null => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) { for (const y of x) { const r = pick(y); if (r) return r; } return null; }
    if (x && typeof x === 'object') for (const c of ['import', 'node', 'default', 'require']) if (c in (x as object)) { const r = pick((x as Record<string, unknown>)[c]); if (r) return r; }
    return null;
  };
  const key = subpath ? `./${subpath}` : '.';
  let target: string | null = null;
  if (pkg.exports !== undefined) {
    const ex = pkg.exports as Record<string, unknown>;
    const sugar = typeof ex === 'string' || Array.isArray(ex) || (ex && typeof ex === 'object' && !Object.keys(ex).some((k) => k.startsWith('.')));
    target = sugar ? (key === '.' ? pick(ex) : null) : pick(ex[key]);
  }
  if (!target) target = subpath || pkg.main || 'index.js';
  return resolveRelative(join(dir, 'package.json'), target.startsWith('.') ? target : `./${target}`);
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
        const entry = pdir ? packageEntry(pdir, parts.slice(spec.startsWith('@') ? 2 : 1).join('/')) : null;
        if (!pdir || !entry) { uncertifiable(file, `the import '${spec}' resolves to no installed package file, so the certificate cannot name it`); continue; }
        packageQueue.push(join(pdir, 'package.json'), entry);
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
    for (const spec of specifiers(b.toString('utf8'), file)) {
      if (spec.startsWith('./') || spec.startsWith('../')) { const t = resolveRelative(file, spec); if (t) packageQueue.push(t); continue; }
      if (spec.startsWith('/') || /^[a-z]+:/i.test(spec) || isBuiltin(spec)) continue;
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const pdir = packageDir(file, name);
      const entry = pdir ? packageEntry(pdir, parts.slice(spec.startsWith('@') ? 2 : 1).join('/')) : null;
      if (pdir && entry) packageQueue.push(join(pdir, 'package.json'), entry);
    }
  }
  const lockfile = nearestLockfile(absRoot);
  if (packages.size && !lockfile) diagnostics.push(diag('PL6402', { line: 1, col: 1 }, `the handlers import ${[...packages].sort().join(', ')}, and no lockfile is above the project to record (S142)`));
  const digests = Object.fromEntries([...bytes].sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, b]) => [p, sha256OfBytes(b)]));
  const packageFiles = Object.fromEntries([...packageBytes].sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, b]) => [p, sha256OfBytes(b)]));
  return { roots: files.map((f) => rel(absRoot, resolve(f))).sort(), bytes, digests, packages: [...packages].sort(), packageFiles, lockfile, diagnostics };
}
