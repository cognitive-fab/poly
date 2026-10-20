#!/usr/bin/env node
// DF23, Act 1 part 4: the smallest lint a careful team would write for a TypeScript refund agent: "a POST to /v1/refunds carries an
// Idempotency-Key". It reads the syntax of every `.ts` file under a folder (not node_modules, not *.test.ts) with the TypeScript
// compiler API, finds each `fetch` whose first argument is or contains the text `/v1/refunds` (a string, a template or a
// concatenation) and whose options are an object literal with `method: "POST"`, and says whether the `headers` literal names an
// Idempotency-Key (any case). A call it cannot decide is `undecided`, and a lint that found nothing to check does not say clean.
//
//   node demo/lint/refund-key.mjs <folder>
//   exit 0: every call keyed. exit 1: a call without the key. exit 2: no call found, or a call it cannot decide (and none unkeyed).
//
// What it sees is a local fact: the key is in the call. What it cannot see is a path fact: a build that keys every call and issues a
// second refund, with a fresh key, for the same order after an uncertain end. The fixture test/fixtures/lint/reissue is such a build, and
// the lint says clean. That is the point of the part: only a check over the machine sees it (DF19, DF23).
// It is not run on a poly build: the handler of a poly build is JavaScript and has no header, because the runtime attaches the key (PT33.4).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The `.ts` files under a folder, sorted, skipping node_modules and the tests. */
function tsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      if (e === 'node_modules') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The literal text of an expression that is a string, a template or a concatenation of them and of anything else, or null if it has none. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => (literalText(s.expression) ?? '') + s.literal.text).join('');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return `${literalText(node.left) ?? ''}${literalText(node.right) ?? ''}`;
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  return null;
}

/** The name of a property of an object literal when it is written as an identifier or a string, else null. */
function nameOf(prop) {
  const n = prop.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

// A shorthand property (`headers,`) is a property whose value is a name, not a literal: the caller reads it as not decidable.
const property = (obj, name) => obj.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameOf(p)?.toLowerCase() === name);

/** 'keyed', 'unkeyed', 'undecided' for a refund call's options, or null when the call is not a POST (a read, which has no key to check). */
function judge(options) {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'undecided';
  const method = property(options, 'method');
  if (!method) return null;
  if (!ts.isPropertyAssignment(method) || (!ts.isStringLiteral(method.initializer) && !ts.isNoSubstitutionTemplateLiteral(method.initializer))) return 'undecided';
  if (method.initializer.text.toUpperCase() !== 'POST') return null;
  const headers = property(options, 'headers');
  if (!headers) return options.properties.some((p) => ts.isSpreadAssignment(p)) ? 'undecided' : 'unkeyed';
  if (!ts.isPropertyAssignment(headers) || !ts.isObjectLiteralExpression(headers.initializer)) return 'undecided';
  const named = headers.initializer.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameOf(p)?.toLowerCase() === 'idempotency-key');
  if (named) return 'keyed';
  return headers.initializer.properties.some((p) => ts.isSpreadAssignment(p)) ? 'undecided' : 'unkeyed';
}

/** The refund calls of one source file: [{ line, verdict }]. */
function callsOf(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && node.arguments.length >= 1) {
      const url = literalText(node.arguments[0]);
      if (url !== null && url.includes('/v1/refunds')) {
        const verdict = judge(node.arguments[1]);
        if (verdict !== null) found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, verdict });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function lint(folder) {
  const root = resolve(folder);
  const lines = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return { status: 2, lines: [`refund-key: ${folder} is not a folder`] };
  const files = tsFiles(root);
  if (files.length === 0) return { status: 2, lines: [`refund-key: not a TypeScript build: no .ts file under ${folder}`] };
  const counts = { keyed: 0, unkeyed: 0, undecided: 0 };
  for (const f of files) {
    for (const c of callsOf(f)) {
      counts[c.verdict]++;
      lines.push(`${relative(root, f).split(sep).join('/')}:${c.line}  ${c.verdict}  POST /v1/refunds`);
    }
  }
  const n = counts.keyed + counts.unkeyed + counts.undecided;
  lines.push(`refund-key: ${n} call(s) checked, ${counts.unkeyed} unkeyed, ${counts.undecided} undecided`);
  const status = counts.unkeyed > 0 ? 1 : n === 0 || counts.undecided > 0 ? 2 : 0;
  return { status, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) { console.log('usage: node demo/lint/refund-key.mjs <folder>'); process.exit(2); }
  const { status, lines } = lint(folder);
  for (const l of lines) console.log(l);
  process.exit(status);
}
