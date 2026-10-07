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
  'worker_threads', 'cluster', 'os', 'process', 'vm', 'inspector', 'module', 'undici', 'sqlite', 'readline', 'repl',
]);

/**
 * Global names that reach ambient authority without an import: the host's process and module system, the
 * network, and code built at run time. A name the handler declares itself (a capability it was given, say) is
 * its own and is not flagged (review D10).
 */
const AMBIENT_GLOBALS = new Set(['fetch', 'process', 'global', 'globalThis', 'require', 'module', 'eval', 'Function', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Deno', 'Bun']);
const bare = (spec: string) => spec.replace(/^node:/, '');
/** PT22.5: the response headers that can carry a credential back. */
const TOKEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'set-cookie']);

export function lintHandlerText(text: string, file: string): Diagnostic[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: Diagnostic[] = [];
  const report = (node: ts.Node, message: string) => {
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(diag('PL6401', { line: at.line + 1, col: at.character + 1 }, `${file}: ${message} (PT6.5)`));
  };
  const moduleSpec = (node: ts.Node, spec: string) => {
    if (AMBIENT.has(bare(spec))) report(node, `the handler imports ${spec}; a handler receives its capabilities from the runtime`);
    // PT22.5: the vault adapter lives in @poly/io; a handler reaches a provider only through api, never the vault.
    if (spec === '@poly/io' || spec.startsWith('@poly/io/')) report(node, `the handler imports ${spec}, the module of the vault and the channel adapters; a handler calls a provider through api`);
  };
  // PT22.5: a response header that carries a credential, read by name, is PL6824.
  const tokenHeader = (node: ts.Node, name: string) => {
    if (!TOKEN_HEADERS.has(name.toLowerCase())) return;
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(diag('PL6824', { line: at.line + 1, col: at.character + 1 }, `${file}: the handler reads the header ${name}, which can carry a credential; the vault removes it from what api returns, and a handler never reads it (PT22.5)`));
  };
  // A local `fetch` bound to a capability is not the global one, but only within its own scope: a name is
  // declared for a use when a scope enclosing the use declares it (polywatch, after the review).
  const declaresIn = (scope: ts.Node, name: string): boolean => {
    const has = (b: ts.BindingName): boolean => (ts.isIdentifier(b) ? b.text === name : b.elements.some((e) => !ts.isOmittedExpression(e) && has(e.name)));
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => has(p.name))) return true;
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) return true;
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer) && scope.initializer.declarations.some((d) => has(d.name))) return true;
    if (ts.isCatchClause(scope) && scope.variableDeclaration && has(scope.variableDeclaration.name)) return true;
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : null;
    for (const st of statements ?? []) {
      if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => has(d.name))) return true;
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return true;
      if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        const nb = c.namedBindings;
        if (c.name?.text === name || (nb && (ts.isNamespaceImport(nb) ? nb.name.text === name : nb.elements.some((e) => e.name.text === name)))) return true;
      }
    }
    return false;
  };
  const declared = (at: ts.Node, name: string): boolean => {
    for (let a: ts.Node | undefined = at; a; a = a.parent) if (declaresIn(a, name)) return true;
    return false;
  };
  const reported = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    // A type-only import or export grants nothing at run time.
    const typeOnly = (ts.isImportDeclaration(n) && !!n.importClause?.isTypeOnly) || (ts.isExportDeclaration(n) && n.isTypeOnly);
    if (!typeOnly && (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) moduleSpec(n, n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) moduleSpec(n, n.moduleReference.expression.text);
    if (ts.isCallExpression(n)) {
      const dynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(n.expression) && n.expression.text === 'require' && !declared(n, 'require');
      if (dynamic || required) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteral(a)) moduleSpec(n, a.text);
        else report(n, `the handler ${dynamic ? 'imports' : 'requires'} a module named at run time, which the lint cannot see`);
      }
      if (dynamic || required) reported.add(n.expression);
      if (ts.isIdentifier(n.expression) && n.expression.text === 'fetch' && !declared(n, 'fetch')) { report(n, 'the handler calls the global fetch; egress is the egress capability its labels grant'); reported.add(n.expression); }
    }
    if (ts.isPropertyAccessExpression(n)) {
      const obj = n.expression;
      if (ts.isIdentifier(obj) && obj.text === 'process' && n.name.text === 'env' && !declared(n, 'process')) { report(n, 'the handler reads process.env; a secret is the secrets capability its labels grant'); reported.add(obj); }
      if (ts.isIdentifier(obj) && obj.text === 'globalThis' && ['fetch', 'process', 'require'].includes(n.name.text)) { report(n, `the handler reads globalThis.${n.name.text}`); reported.add(obj); }
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) tokenHeader(n, n.argumentExpression.text);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && /^headers$/i.test(ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '')) tokenHeader(n, n.name.text);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['get', 'has', 'getAll'].includes(n.expression.name.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) tokenHeader(n, n.arguments[0].text);
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'globalThis' || n.expression.text === 'process') && !declared(n, n.expression.text)) { report(n, `the handler reads ${n.expression.text} by a computed name`); reported.add(n.expression); }
    // Any other use of an ambient global it does not declare: an alias, a destructuring, a bare reference.
    if (ts.isIdentifier(n) && AMBIENT_GLOBALS.has(n.text) && !declared(n, n.text) && !reported.has(n) && isReference(n)) report(n, `the handler uses the global ${n.text}, which reaches ambient authority`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether an identifier is a use of a name, not a property name, a declaration or a label. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.name === id) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  return true;
}

export function lintHandlers(files: string[]): Diagnostic[] {
  return files.flatMap((f) => lintHandlerText(readFileSync(f, 'utf8'), f));
}
