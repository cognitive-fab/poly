#!/usr/bin/env node
// Import-boundary check (CLAUDE.md standing rules, PS9.3, PT14).
//
// Two rules are enforced here, over every TypeScript source under packages/*/src:
//
// 1. poly-ref shares no code with the compiler. It may import node builtins,
//    its own files and @cognitive-fab/sam-pattern (to drive a lowered module).
//    From @poly/core it may import types only (`import type`), which the
//    compiler erases under verbatimModuleSyntax. Nothing from @poly/lang,
//    @poly/lower, @poly/embed or @poly/check, ever.
// 2. No language-model call on a check or decision path. No package may import
//    a model SDK, and no check package may call fetch or open a socket.
// 3. A host-neutral core with thin host adapters (S167, M6). No package names a host or imports a host's SDK
//    (an MCP or language-server SDK, an editor's or an agent harness's API); what a host launches lives under
//    adapters/<host>/, and an adapter is configuration only (.json and .md files), never code.
// 4. poly new is the only place a model is called (PF9.3, S169). poly-new may start a subprocess (Claude Code, headless);
//    no other package imports it, except poly-agent, which serves it, and the command line, which loads it by name.
//
// A file that cannot be read is an error, never a pass (no silent clean).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_SDKS = [/^@anthropic-ai\//, /^openai$/, /^@openai\//, /^@google\/genai$/, /^@google\/generative-ai$/, /^cohere-ai$/, /^@mistralai\//, /^ollama$/, /^langchain/, /^@langchain\//];
const NETWORK_MODULES = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'http', 'https', 'net', 'tls', 'dgram'];
const PROCESS_MODULES = ['node:child_process', 'child_process', 'node:worker_threads', 'worker_threads'];
const REF_ALLOWED = [/^node:/, /^@cognitive-fab\/sam-pattern$/];
// Rule 3: host SDKs, and the names of the hosts an adapter serves.
const HOST_SDKS = [/^@modelcontextprotocol\//, /^vscode-languageserver/, /^vscode-jsonrpc/, /^vscode$/, /^@anthropic-ai\/claude-code/, /^@anthropic-ai\/claude-agent-sdk/];
const HOST_NAMES = /['"`](claude-code|deepseek-harness|dsh|dsh-mcp-client|cordis\.yml)['"`]/;
const ADAPTER_FILES = /\.(json|md)$/;

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
        if (imp.spec.includes('poly-core') || imp.spec.includes('poly-lang') || imp.spec.includes('poly-lower') || imp.spec.includes('poly-check') || imp.spec.includes('poly-embed')) {
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
  for (const imp of importsOf(text)) if (HOST_SDKS.some((re) => re.test(imp.spec))) v.push(`${file}:${imp.line} imports host SDK '${imp.spec}' (the core is host-neutral, S167)`);
  if (/['"`]@poly\/new['"`]/.test(text) && pkg !== 'poly-new' && pkg !== 'poly-agent' && file !== 'packages/poly-check/src/cli.ts') v.push(`${file} names @poly/new, the package that calls a model; only poly-agent and the command line may load it (PF9.3, S169)`);
  if (HOST_NAMES.test(text)) v.push(`${file} names a host (${HOST_NAMES.exec(text)[1]}); a host's name belongs in adapters/, never in the core (S167)`);
  if (/\bfetch\s*\(/.test(text)) v.push(`${file} calls fetch (no network or model call on a check path)`);
  // Review finding P8: indirect routes. A subprocess or a computed global can reach the network, and a
  // require made at run time, a template literal or a concatenated name can reach the compiler.
  for (const imp of importsOf(text)) {
    if (PROCESS_MODULES.includes(imp.spec) && pkg !== 'poly-new') v.push(`${file}:${imp.line} imports '${imp.spec}' (a subprocess can reach a model; no model call on a check path)`);
  }
  if (/\bglobalThis\s*\[/.test(text)) v.push(`${file} reads a global by a computed name (it can reach fetch)`);
  if (pkg === 'poly-ref') {
    const compiler = text.match(/['"`]@poly\/(lang|lower|check|embed)\b/g) ?? [];
    if (compiler.length) v.push(`${file} names a compiler package in a string (${compiler[0].slice(1)}); poly-ref shares no code with the compiler`);
    // Every static import of @poly/core is judged above; any other mention of it is a way around that check.
    const staticCore = importsOf(text).filter((i) => i.spec === '@poly/core').length;
    const coreNames = (text.match(/['"`]@poly\/core['"`]/g) ?? []).length;
    if (coreNames > staticCore) v.push(`${file} names @poly/core outside a type-only import; poly-ref may import AST types only`);
    if (/['"`]@poly\/['"`]\s*\+/.test(text)) v.push(`${file} builds a @poly package name at run time`);
  }
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
  // Rule 3: an adapter is configuration only.
  const adapters = join(root, 'adapters');
  for (const file of everyFile(adapters)) {
    const name = relative(root, file).split(sep).join('/');
    if (!ADAPTER_FILES.test(file)) violations.push(`${name} is not configuration: an adapter holds .json and .md files only, and launches poly mcp or poly lsp (S167)`);
  }
  return violations;
}

function everyFile(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((e) => (statSync(join(dir, e)).isDirectory() ? everyFile(join(dir, e)) : [join(dir, e)]));
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
