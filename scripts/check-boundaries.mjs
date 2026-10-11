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
// 5. Network code lives in poly-io alone (S182). poly-io imports node builtins, its own files, and the runtime adapter
//    interface (@poly/runtime/adapters) as types only; no check package imports poly-io, in any form. Outside it, no
//    package imports an npm package but poly's own, the vendored engines and typescript, uses a socket global, or
//    names a network module in a string (review C-F8, M8b).
// 2. No language-model call on a check or decision path. No package may import
//    a model SDK, and no check package may call fetch or open a socket.
// 3. A host-neutral core with thin host adapters (S167, M6). No package names a host or imports a host's SDK
//    (an MCP or language-server SDK, an editor's or an agent harness's API); what a host launches lives under
//    adapters/<host>/, and an adapter is configuration only (.json and .md files), never code: it launches poly mcp,
//    poly lsp or poly run --mcp (the project's workflows, S175), and declares no hooks. Sources are .ts, .mts and .cts.
// 4. poly new is the only place a model is called (PF9.3, S169). poly-new may start a subprocess (Claude Code, headless);
//    no other package imports it, except poly-agent, which serves it, and the command line, which loads it by name.
//
// 6. poly-mine is the only package besides poly-new that may start a process (S507, ruled 2026-10-11): polyx, run by path.
//    It imports node:child_process, node:crypto, node:fs and node:path and nothing else; it starts a process only with
//    execFileSync, so with a fixed argument vector and no shell; it reads the environment by name, never whole, so the
//    child's environment is built fresh from an allowlist; and it never names a polyx command but mine (the word
//    annotate, the command that calls a model, appears nowhere in it). The pin, the timeout and the cap on output are
//    tested by running it (test/polyx-seam.test.mjs). Only packages/poly-check/src/mine.ts may name @poly/mine.
//
// A file that cannot be read is an error, never a pass (no silent clean).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_SDKS = [/^@anthropic-ai\//, /^openai$/, /^@openai\//, /^@google\/genai$/, /^@google\/generative-ai$/, /^cohere-ai$/, /^@mistralai\//, /^ollama$/, /^langchain/, /^@langchain\//];
// Review C-F8 (M8b): node:dns resolves names over the network, so it is a network module too.
const NETWORK_MODULES = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:dns/promises', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises'];
// Review C-F8 (M8b): a network module named in a string is a way to load it without an import statement
// (createRequire(…)('node:net')). Only the handler lint, which lists them to refuse them, names them.
const NETWORK_STRINGS = /['"`](node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises)['"`]/;
const NAMES_NETWORK_TO_REFUSE = ['packages/poly-check/src/lint.ts'];
// Review C-F8 (M8b): outside poly-io a package imports node builtins, its own files, poly's packages, the vendored
// engines and the TypeScript compiler; any other npm package could carry a socket (undici, ws).
const NPM_ALLOWED = [/^typescript$/, /^@poly\//, /^@cognitive-fab\//];
// Review C-F8 (M8b): the browser-style sockets Node offers as globals, used as values (not named in a string).
const SOCKET_GLOBALS = /(?<!['"`\w])(WebSocket|EventSource)(?!['"`\w])/;
// S182: the packages on a check path, which never import poly-io.
const CHECK_PACKAGES = ['poly-core', 'poly-lang', 'poly-lower', 'poly-ref', 'poly-embed', 'poly-check', 'poly-agent'];
const PROCESS_MODULES = ['node:child_process', 'child_process', 'node:worker_threads', 'worker_threads'];
const REF_ALLOWED = [/^node:/, /^@cognitive-fab\/sam-pattern$/];
// Rule 3: host SDKs, and the names of the hosts an adapter serves.
const HOST_SDKS = [/^@modelcontextprotocol\//, /^vscode-languageserver/, /^vscode-jsonrpc/, /^vscode$/, /^@anthropic-ai\/claude-code/, /^@anthropic-ai\/claude-agent-sdk/];
// Anywhere in a source, in a string, a comment or a name (polywatch on step 8), in any case and with a space or a
// hyphen (review D-F1): the core never names a host. A host's command line, quoted on its own, is its name too.
const HOST_NAMES = /(?<![\w-])(claude[- ]code|deepseek[- ]harness|dsh-mcp-client|dsh|cordis\.yml)(?![\w-])|['"`]claude(\.cmd|\.exe)?['"`]/i;
// A host SDK's name as a string, wherever it is: a computed or template import starts from one (review D-F1).
const HOST_SDK_STRINGS = /['"`](@modelcontextprotocol\/|vscode-languageserver|vscode-jsonrpc|vscode['"`]|@anthropic-ai\/claude-code|@anthropic-ai\/claude-agent-sdk)/;
const ADAPTER_FILES = /\.(json|md)$/;
// Review D-F4: what an adapter may launch: poly's own two servers, and `poly run --mcp` over the project's
// workflows on poly-runtime (S175).
const ADAPTER_LAUNCHES = [
  (s) => s.command === 'poly' && JSON.stringify(s.args) === '["mcp"]',
  (s) => s.command === 'poly' && JSON.stringify(s.args) === '["lsp"]',
  // S175: the project's workflows, served on poly-runtime (the polyflow server's launch is no longer allowed).
  (s) => s.command === 'poly' && JSON.stringify(s.args) === '["run","--mcp","--project","${PROJECT}"]' && s.env === undefined,
];

// Every static import, re-export, dynamic import and require, with whether it is type-only.
const IMPORT_RE = /(^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\b(import|require)\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g;
const CALLED_REQUIRE_RE = /\bcreateRequire\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g;

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
  // Review C-F8 (M8b): a require made by createRequire and called at once is an import too.
  for (const m of text.matchAll(CALLED_REQUIRE_RE)) out.push({ spec: m[1], typeOnly: false, line: lineAt(m.index) });
  return out;
}

/** Violations for one file of one package. */
export function violationsOf(pkg, file, text) {
  const v = [];
  for (const imp of importsOf(text)) {
    if (MODEL_SDKS.some((re) => re.test(imp.spec))) v.push(`${file}:${imp.line} imports model SDK '${imp.spec}' (no model call on a check path)`);
    if (NETWORK_MODULES.includes(imp.spec) && pkg !== 'poly-io') v.push(`${file}:${imp.line} imports network module '${imp.spec}' (network code lives in poly-io alone, S182)`);
    if (pkg === 'poly-io') {
      const relativeSpec = imp.spec.startsWith('./') || imp.spec.startsWith('../');
      // Review C-F8 (M8b): a relative path stays inside poly-io's own source, so it reaches no other package and no
      // package under node_modules by its path.
      if (relativeSpec) { if (!posix.normalize(posix.join(file.startsWith('packages/') ? posix.dirname(file) : posix.join('packages/poly-io/src', posix.dirname(file)), imp.spec)).startsWith('packages/poly-io/src/')) v.push(`${file}:${imp.line} reaches outside packages/poly-io/src by relative path '${imp.spec}' (S182)`); }
      else if (imp.spec === '@poly/runtime/adapters') { if (!imp.typeOnly) v.push(`${file}:${imp.line} imports a value from @poly/runtime/adapters; poly-io imports the adapter interface as types only (S182)`); }
      else if (!/^node:/.test(imp.spec)) v.push(`${file}:${imp.line} poly-io imports '${imp.spec}'; it imports node builtins and the runtime adapter interface only (S182)`);
    }
    if (pkg !== 'poly-io' && !imp.spec.startsWith('.') && !imp.spec.startsWith('node:') && !imp.spec.startsWith('${') && !NETWORK_MODULES.includes(imp.spec) && !NPM_ALLOWED.some((re) => re.test(imp.spec))) v.push(`${file}:${imp.line} imports the npm package '${imp.spec}'; outside poly-io a package imports node builtins, poly's packages, the vendored engines and typescript only (S182)`);
    if (CHECK_PACKAGES.includes(pkg) && (imp.spec === '@poly/io' || imp.spec.startsWith('@poly/io/') || /(^|\/)poly-io(\/|$)/.test(imp.spec))) v.push(`${file}:${imp.line} a check package imports poly-io, the package with network code (S182)`);
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
  const sdkStrings = (text.match(new RegExp(HOST_SDK_STRINGS.source, 'g')) ?? []).length;
  if (sdkStrings > importsOf(text).filter((i) => HOST_SDKS.some((re) => re.test(i.spec))).length) v.push(`${file} names a host SDK in a string (${HOST_SDK_STRINGS.exec(text)[1]}); the core is host-neutral (S167)`);
  // Rule 4, every route to poly-new (review D-F2): its name or a subpath of it, a relative path into it, or a @poly
  // name built at run time, which can be any package.
  if (pkg !== 'poly-new' && pkg !== 'poly-agent' && file !== 'packages/poly-check/src/cli.ts') {
    if (/['"`]@poly\/new(\/[^'"`]*)?['"`]/.test(text)) v.push(`${file} names @poly/new, the package that calls a model; only poly-agent and the command line may load it (PF9.3, S169)`);
    if (importsOf(text).some((i) => /(^|\/)poly-new(\/|$)/.test(i.spec))) v.push(`${file} reaches poly-new by a relative path; only poly-agent and the command line may load it (PF9.3, S169)`);
    if (/['"`]@poly\/[^'"`]*['"`]\s*\+|`@poly\/[^`]*\$\{/.test(text)) v.push(`${file} builds a @poly package name at run time, a route to poly-new (PF9.3, S169)`);
  }
  // poly-new starts the host's command line (S169), so it alone may name the host.
  if (pkg !== 'poly-new' && HOST_NAMES.test(text)) { const m = HOST_NAMES.exec(text); v.push(`${file} names a host (${m[1] ?? m[0]}); a host's name belongs in adapters/, never in the core (S167)`); }
  if (/\bfetch\s*\(/.test(text)) v.push(`${file} calls fetch (no network or model call on a check path)`);
  if (pkg !== 'poly-io' && SOCKET_GLOBALS.test(text)) v.push(`${file} uses ${SOCKET_GLOBALS.exec(text)[1]}, a socket; network code lives in poly-io alone (S182)`);
  if (pkg !== 'poly-io' && !NAMES_NETWORK_TO_REFUSE.includes(file) && NETWORK_STRINGS.test(text)) v.push(`${file} names the network module ${NETWORK_STRINGS.exec(text)[0]} in a string, a way to load it without an import; network code lives in poly-io alone (S182)`);
  // Review finding P8: indirect routes. A subprocess or a computed global can reach the network, and a
  // require made at run time, a template literal or a concatenated name can reach the compiler.
  for (const imp of importsOf(text)) {
    if (PROCESS_MODULES.includes(imp.spec) && pkg !== 'poly-new' && !(pkg === 'poly-mine' && /^(node:)?child_process$/.test(imp.spec))) v.push(`${file}:${imp.line} imports '${imp.spec}' (a subprocess can reach a model; no model call on a check path)`);
  }
  // Rule 6: what poly-mine may import and how it may start a process.
  if (pkg === 'poly-mine') {
    const ok = ['node:child_process', 'node:crypto', 'node:fs', 'node:path'];
    for (const imp of importsOf(text)) if (!ok.includes(imp.spec)) v.push(`${file}:${imp.line} poly-mine imports '${imp.spec}'; it imports ${ok.join(', ')} only (S507)`);
    if (/\b(spawn|spawnSync|exec|execSync|execFile|fork)\s*\(/.test(text)) v.push(`${file} starts a process other than with execFileSync; poly-mine uses a fixed argument vector and no shell (S507)`);
    if (/\bshell\s*:/.test(text)) v.push(`${file} sets a shell option; poly-mine starts its process with no shell (S507)`);
    if (/process\s*\.\s*env(?!\s*[.\[])/.test(text)) v.push(`${file} reads the whole environment; poly-mine builds the child's environment fresh from an allowlist, by name (S507)`);
    if (/annotate/i.test(text)) v.push(`${file} names annotate, the polyx command that calls a model; the only polyx command poly-mine runs is mine (S507)`);
    if (!/execFileSync\s*\(/.test(text)) v.push(`${file} does not start its process with execFileSync (S507)`);
  }
  // Rule 6: the way to poly-mine is poly-check's mine command alone.
  if (pkg !== 'poly-mine' && file !== 'packages/poly-check/src/mine.ts' && (/['"`]@poly\/mine(\/[^'"`]*)?['"`]/.test(text) || importsOf(text).some((i) => /(^|\/)poly-mine(\/|$)/.test(i.spec)))) v.push(`${file} names @poly/mine, the package that starts polyx; only poly-check's mine command may load it (S507)`);
  // Review D-F2: a builtin reached without an import statement, by a name the import check cannot see.
  if (pkg !== 'poly-new' && /\bgetBuiltinModule\b|\bprocess\s*\.\s*binding\b/.test(text)) v.push(`${file} loads a builtin module by name at run time (it can reach a subprocess or the network)`);
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
    // Review D-F3: tsc compiles .mts and .cts sources under src as well.
    else if (/\.[mc]?ts$/.test(p) && !/\.d\.[mc]?ts$/.test(p)) out.push(p);
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
    if (!ADAPTER_FILES.test(file)) { violations.push(`${name} is not configuration: an adapter holds .json and .md files only, and launches poly mcp or poly lsp (S167)`); continue; }
    if (file.endsWith('.json')) violations.push(...adapterJson(name, file));
  }
  return violations;
}

/**
 * Review D-F4: an adapter's JSON is configuration, but configuration can launch anything. Every server it declares
 * (mcpServers, lspServers, at any depth) must be one ADAPTER_LAUNCHES allows, and it declares no hooks: a hook runs a
 * command on the host's events, which is code by another name. A file that does not parse is refused.
 */
function adapterJson(name, file) {
  const v = [];
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return [`${name} does not parse as JSON (${e.message})`]; }
  if (/(^|\/)hooks(\/|\.json$)/.test(name)) v.push(`${name}: an adapter carries no hooks (S167)`);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, x] of Object.entries(node)) {
      if (k === 'hooks') v.push(`${name}: an adapter carries no hooks (S167)`);
      if ((k === 'mcpServers' || k === 'lspServers') && x && typeof x === 'object') {
        for (const [server, s] of Object.entries(x)) if (!ADAPTER_LAUNCHES.some((ok) => ok(s ?? {}))) v.push(`${name}: server ${server} launches ${JSON.stringify([s?.command, ...(s?.args ?? [])])}; an adapter launches poly mcp, poly lsp or poly run --mcp only (S167, S175)`);
      }
      visit(x);
    }
  };
  visit(doc);
  return v;
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
