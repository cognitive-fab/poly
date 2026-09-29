#!/usr/bin/env node
// Import-boundary check (CLAUDE.md standing rules, PS9.3, PT14).
//
// Two rules are enforced here, over every TypeScript source under packages/*/src:
//
// 1. poly-ref shares no code with the compiler. It may import node builtins,
//    its own files and @cognitive-fab/sam-pattern (to drive a lowered module).
//    From @poly/core it may import types only (`import type`), which the
//    compiler erases under verbatimModuleSyntax. Nothing from @poly/lang,
//    @poly/lower or @poly/check, ever.
// 2. No language-model call on a check or decision path. No package may import
//    a model SDK, and no check package may call fetch or open a socket.
//
// A file that cannot be read is an error, never a pass (no silent clean).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_SDKS = [/^@anthropic-ai\//, /^openai$/, /^@openai\//, /^@google\/genai$/, /^@google\/generative-ai$/, /^cohere-ai$/, /^@mistralai\//, /^ollama$/, /^langchain/, /^@langchain\//];
const NETWORK_MODULES = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'http', 'https', 'net', 'tls', 'dgram'];
const REF_ALLOWED = [/^node:/, /^@cognitive-fab\/sam-pattern$/];

// Every static import, re-export, dynamic import and require, with whether it is type-only.
const IMPORT_RE = /(^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\b(import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Imports of one source text: [{ spec, typeOnly, line }]. */
export function importsOf(text) {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(IMPORT_RE)) {
    // `import { type A, type B } from` is also type-only when every specifier is.
    const clause = m[4];
    const braced = /^\{([\s\S]*)\}$/.exec(clause.trim());
    const allTypeSpecifiers = braced !== null && braced[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
    out.push({ spec: m[5], typeOnly: Boolean(m[3]) || allTypeSpecifiers, line: lineAt(m.index + m[1].length) });
  }
  for (const m of text.matchAll(BARE_IMPORT_RE)) out.push({ spec: m[2], typeOnly: false, line: lineAt(m.index + m[1].length) });
  for (const m of text.matchAll(DYNAMIC_RE)) out.push({ spec: m[2], typeOnly: false, line: lineAt(m.index) });
  return out;
}

/** Violations for one file of one package. */
export function violationsOf(pkg, file, text) {
  const v = [];
  for (const imp of importsOf(text)) {
    if (MODEL_SDKS.some((re) => re.test(imp.spec))) v.push(`${file}:${imp.line} imports model SDK '${imp.spec}' (no model call on a check path)`);
    if (NETWORK_MODULES.includes(imp.spec)) v.push(`${file}:${imp.line} imports network module '${imp.spec}' (no model call on a check path)`);
    if (pkg === 'poly-ref') {
      const relativeSpec = imp.spec.startsWith('./') || imp.spec.startsWith('../');
      if (relativeSpec) {
        if (imp.spec.includes('poly-core') || imp.spec.includes('poly-lang') || imp.spec.includes('poly-lower') || imp.spec.includes('poly-check')) {
          v.push(`${file}:${imp.line} reaches into another package by relative path '${imp.spec}'`);
        }
        continue;
      }
      if (imp.spec === '@poly/core') {
        if (!imp.typeOnly) v.push(`${file}:${imp.line} imports a value from @poly/core; poly-ref may import AST types only (import type)`);
        continue;
      }
      if (!REF_ALLOWED.some((re) => re.test(imp.spec))) v.push(`${file}:${imp.line} poly-ref imports '${imp.spec}', which is outside its boundary`);
    }
  }
  if (/\bfetch\s*\(/.test(text)) v.push(`${file} calls fetch (no network or model call on a check path)`);
  return v;
}

function sources(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function checkRepository(root) {
  const violations = [];
  const packagesDir = join(root, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    for (const file of sources(join(packagesDir, pkg, 'src'))) {
      violations.push(...violationsOf(pkg, relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8')));
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const violations = checkRepository(root);
  if (violations.length) {
    for (const v of violations) console.error(`boundary: ${v}`);
    console.error(`boundary check FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('boundary check passed');
}
