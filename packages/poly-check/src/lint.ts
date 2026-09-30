// `poly lint handlers` (PT6.5, S72): the effect handler modules a project names in poly.json's `handlers` are
// read, never run, and any reach for ambient authority is PL6401 AMBIENT_EFFECT_IN_HANDLER. A handler gets
// its capabilities from the runtime, by its effect's labels and targets; it imports none of its own.
//
// This is a discipline, not a proof (PT6.5): the lint rejects the forms it can see, including a dynamic
// import, a computed require and a read of globalThis by a computed name, and only the sandbox enforces the
// boundary.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { diag, type Diagnostic } from '@poly/core';

/** Modules that grant ambient authority: the file system, the network, processes, and the host's environment. */
const AMBIENT = new Set([
  'fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'dns/promises', 'child_process',
  'worker_threads', 'cluster', 'os', 'process', 'vm', 'inspector', 'module', 'undici',
]);
const bare = (spec: string) => spec.replace(/^node:/, '');

export function lintHandlerText(text: string, file: string): Diagnostic[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: Diagnostic[] = [];
  const report = (node: ts.Node, message: string) => {
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(diag('PL6401', { line: at.line + 1, col: at.character + 1 }, `${file}: ${message} (PT6.5)`));
  };
  const moduleSpec = (node: ts.Node, spec: string) => {
    if (AMBIENT.has(bare(spec))) report(node, `the handler imports ${spec}; a handler receives its capabilities from the runtime`);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) moduleSpec(n, n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) moduleSpec(n, n.moduleReference.expression.text);
    if (ts.isCallExpression(n)) {
      const dynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if (dynamic || required) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteral(a)) moduleSpec(n, a.text);
        else report(n, `the handler ${dynamic ? 'imports' : 'requires'} a module named at run time, which the lint cannot see`);
      }
      if (ts.isIdentifier(n.expression) && n.expression.text === 'fetch') report(n, 'the handler calls the global fetch; egress is the egress capability its labels grant');
    }
    if (ts.isPropertyAccessExpression(n)) {
      const obj = n.expression;
      if (ts.isIdentifier(obj) && obj.text === 'process' && n.name.text === 'env') report(n, 'the handler reads process.env; a secret is the secrets capability its labels grant');
      if (ts.isIdentifier(obj) && obj.text === 'globalThis' && ['fetch', 'process', 'require'].includes(n.name.text)) report(n, `the handler reads globalThis.${n.name.text}`);
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'globalThis' || n.expression.text === 'process')) report(n, `the handler reads ${n.expression.text} by a computed name`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function lintHandlers(files: string[]): Diagnostic[] {
  return files.flatMap((f) => lintHandlerText(readFileSync(f, 'utf8'), f));
}
