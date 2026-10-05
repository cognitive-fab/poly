// `poly lsp` (PF9.1, PT14, S168, S171, M6 step 7): the language server, over stdio, JSON-RPC 2.0 with Content-Length
// framing, with no SDK. It serves both surfaces: `.poly` and `.policy.poly` files, and embedded modules (`.ts`).
//
//   - Diagnostics: poly check's stages 0 to 2 on every open and change, of the text the editor holds; every stage on
//     save (PT14). Each diagnostic sits at poly check's line and column. A verdict other than CLEAN is one more,
//     information, diagnostic naming what did not run and what is vacuous (PT12.3a: no silent clean).
//   - Formatting: poly fmt's text for a standalone module; nothing for an embedded one, which is TypeScript's, and
//     nothing for a module holding text the parser skips (PL0901), which printing would delete.
//   - Code actions: each typed fix of a diagnostic (PT12.1), on both surfaces, computed against the text the editor
//     holds now; a fix whose node no longer has its digest is refused (PL0201) and not offered.
//   - Commands: every registry command the language server serves, as workspace/executeCommand `poly.<name>`, which
//     returns the command's JSON (S171).
//
// The server knows no host: an editor or an agent harness starts it, configured by a host adapter (adapters/).
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyFix, checkFile, COMMANDS, type CheckReport } from '@poly/check';
import { format, parse } from '@poly/lang';
import type { Diagnostic, Fix } from '@poly/core';

interface Message { jsonrpc?: string; id?: number | string | null; method?: string; params?: any }
interface LspDiagnostic { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; code: string; source: 'poly'; message: string; data?: { fixes: Fix[] } }

export interface LspOptions { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; version?: string; root?: string }

const SEVERITY: Record<string, number> = { error: 1, finding: 1, warning: 2, note: 3 };

/**
 * A poly diagnostic as the editor shows it: at poly check's line and column (1-based there, 0-based here). One poly
 * check reports with no position is shown at the top of the file, never dropped (polywatch on step 7).
 */
export function toLsp(d: Diagnostic): LspDiagnostic {
  const at = d.at.line ? { line: d.at.line - 1, character: Math.max(0, (d.at.col ?? 1) - 1) } : { line: 0, character: 0 };
  return { range: { start: at, end: at }, severity: SEVERITY[d.severity] ?? 1, code: d.code, source: 'poly', message: d.message, ...(d.fixes?.length ? { data: { fixes: d.fixes } } : {}) };
}

const diagnosticsOf = (r: CheckReport): Diagnostic[] => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics), ...(r.policies ?? []).flatMap((p) => p.diagnostics)];

const TOP = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/**
 * No silent clean (PT12.3a, review C-F5): a verdict other than CLEAN reaches the editor as one information diagnostic
 * at the top of the file, naming what did not run and what is vacuous, as poly check's own report does.
 */
export function verdictOf(r: CheckReport): LspDiagnostic | null {
  if (r.verdict === 'CLEAN') return null;
  const notRun = new Map<string, string[]>();
  const add = (what: string, reason: string) => { if (!notRun.has(reason)) notRun.set(reason, []); notRun.get(reason)!.push(what); };
  for (const m of r.machines) for (const n of m.notRun) add(`${m.machine} ${n.property}`, n.reason);
  for (const c of r.configurations ?? []) for (const s of c.stages) if (s.status === 'not-run') add(`configuration ${c.configuration}`, s.reason ?? 'not run');
  for (const p of r.policies ?? []) for (const s of p.stages) if (s.status === 'not-run') add(`policies of ${p.scope}`, s.reason ?? 'not run');
  const vacuous = [...r.machines, ...(r.configurations ?? []), ...(r.policies ?? [])].flatMap((m) => m.vacuous.map((v) => v.property));
  const parts = [`poly check: ${r.verdict}`];
  for (const [reason, what] of notRun) parts.push(`not run: ${what.join(', ')} (${reason})`);
  if (vacuous.length) parts.push(`vacuous: ${vacuous.join(', ')}`);
  return { range: TOP, severity: 3, code: 'verdict', source: 'poly', message: parts.join('; ') };
}

/** Whether the process is still running: a signal 0 probes it, and EPERM means it exists under another user. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Removes the build folders, named by process id, of servers that have died without removing them (review C-F7). */
function sweep(dir: string, prefix: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(n);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rmSync(join(dir, n), { recursive: true, force: true });
  }
}

export function serveLsp(opts: LspOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const docs = new Map<string, { path: string; text: string }>();
  // The builds of the editor's checks go in a folder of this server's own, never into the project's own .poly/build,
  // and never into one another server shares: each check rewrites its build, so two servers on one workspace deleted
  // each other's lowerings (polywatch on step 7, review C-F4). The folder is named by the process id, so one a killed
  // server left behind is swept by the next server to start (review C-F7).
  sweep(tmpdir(), 'poly-lsp-');
  let buildRoot = opts.root ?? join(tmpdir(), `poly-lsp-${process.pid}`);
  let workspace: string | null = opts.root ?? null;
  const owned = new Set<string>();
  const own = (dir: string) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); owned.add(dir); };
  process.on('exit', () => { for (const d of owned) rmSync(d, { recursive: true, force: true }); });
  if (!opts.root) own(buildRoot);
  const served = COMMANDS.filter((c) => c.lsp);
  // An unsaved buffer has no file path (untitled:): it is checked as a file of that name in the server's own folder.
  const pathOf = (uri: string, languageId?: string) => uri.startsWith('file:') ? fileURLToPath(uri) : join(buildRoot, 'untitled', `${uri.replace(/[^A-Za-z0-9._-]+/g, '_')}${languageId === 'typescript' ? '.ts' : '.poly'}`);

  const write = (m: unknown) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...(m as object) }), 'utf8');
    stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdout.write(body);
  };
  const reply = (id: Message['id'], result: unknown) => write({ id, result });
  const fail = (id: Message['id'], code: number, message: string) => write({ id, error: { code, message } });

  const publish = async (uri: string, full: boolean) => {
    const doc = docs.get(uri);
    if (!doc) return;
    let ds: LspDiagnostic[] = [];
    try {
      const r = await checkFile(doc.path, { root: buildRoot, text: doc.text, ...(full ? {} : { through: 2 as const }) });
      ds = diagnosticsOf(r).map(toLsp);
      if (r.error) ds.push({ range: TOP, severity: 1, code: 'ERROR', source: 'poly', message: `the check stopped: ${r.error}` });
      const v = verdictOf(r);
      if (v) ds.push(v);
    } catch (e) {
      ds = [{ range: TOP, severity: 1, code: 'ERROR', source: 'poly', message: `the check stopped: ${(e as Error).message}` }];
    }
    write({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: ds } });
  };

  const handle = async (msg: Message) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        if (typeof params?.rootUri === 'string' && params.rootUri.startsWith('file:') && !opts.root) {
          workspace = fileURLToPath(params.rootUri);
          sweep(join(workspace, '.poly', 'lsp'), '');
          buildRoot = join(workspace, '.poly', 'lsp', String(process.pid));
          own(buildRoot);
        }
        return reply(id, {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
            documentFormattingProvider: true,
            codeActionProvider: { codeActionKinds: ['quickfix'] },
            executeCommandProvider: { commands: served.map((c) => `poly.${c.name}`) },
          },
          serverInfo: { name: 'poly', version: opts.version ?? '0.0.0' },
        });
      }
      case 'initialized': return;
      case 'shutdown': return reply(id, null);
      case 'textDocument/didOpen': {
        const { uri, text, languageId } = params.textDocument;
        docs.set(uri, { path: pathOf(uri, languageId), text });
        return publish(uri, false);
      }
      case 'textDocument/didChange': {
        const doc = docs.get(params.textDocument.uri);
        const change = params.contentChanges?.at(-1);
        if (doc && typeof change?.text === 'string') doc.text = change.text;
        return publish(params.textDocument.uri, false);
      }
      case 'textDocument/didSave': return publish(params.textDocument.uri, true);
      case 'textDocument/didClose': docs.delete(params.textDocument.uri); return;
      case 'textDocument/formatting': {
        const doc = docs.get(params.textDocument.uri);
        // S168: formatting where it applies: the standalone surface. An embedded module is TypeScript's to format.
        if (!doc || doc.path.endsWith('.ts')) return reply(id, null);
        const r = parse(doc.text);
        if (!r.module) return reply(id, null);
        // Review C-F3: the parser skips a construct of a later milestone (PL0901), so printing the module would delete
        // it. Formatting is refused, and the editor is told why.
        if (r.diagnostics.some((d) => d.code === 'PL0901')) {
          write({ method: 'window/showMessage', params: { type: 2, message: 'poly fmt: the module holds text the parser skips (PL0901), which formatting would delete; nothing is changed' } });
          return reply(id, null);
        }
        const lines = doc.text.split('\n');
        return reply(id, [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } }, newText: format(r.module, r.trivia) }]);
      }
      case 'textDocument/codeAction': {
        const doc = docs.get(params.textDocument.uri);
        if (!doc) return reply(id, []);
        const actions: unknown[] = [];
        for (const d of (params.context?.diagnostics ?? []) as LspDiagnostic[]) {
          for (const fix of d.data?.fixes ?? []) {
            // PT12.1: the fix is applied to the text the editor holds now; a stale one is refused, so not offered.
            const o = applyFix(doc.text, fix, doc.path);
            if (o.status !== 'applied') continue;
            const end = { line: doc.text.split('\n').length, character: 0 };
            actions.push({ title: `poly: ${typeof fix.edit.title === 'string' ? fix.edit.title : `apply fix ${fix.id} for ${d.code}`}`, kind: 'quickfix', diagnostics: [d], isPreferred: (d.data?.fixes ?? []).length === 1, edit: { changes: { [params.textDocument.uri]: [{ range: { start: { line: 0, character: 0 }, end }, newText: o.text }] } } });
          }
        }
        return reply(id, actions);
      }
      case 'workspace/executeCommand': {
        const name = String(params?.command ?? '');
        const cmd = served.find((c) => `poly.${c.name}` === name);
        if (!cmd) return fail(id, -32602, `unknown command ${name}`);
        try {
          // Review C-F6: a command given no root or project runs in the workspace the editor opened, not in the
          // working directory the editor happened to start the server in.
          const input = { ...((params?.arguments?.[0] ?? {}) as Record<string, unknown>) };
          const props = (cmd.input as { properties?: Record<string, unknown> }).properties ?? {};
          if (workspace) for (const k of ['root', 'project']) if (k in props && input[k] === undefined) input[k] = workspace;
          const o = await cmd.run(input);
          return reply(id, o.result);
        } catch (e) {
          return fail(id, -32603, `${name}: ${(e as Error).message}`);
        }
      }
      case 'exit': process.exit(0);
      default:
        if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
    }
  };

  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    // One message at a time, in arrival order: a change is checked before the code action that follows it.
    let chain: Promise<void> = Promise.resolve();
    stdin.on('data', (b: Buffer) => {
      buf = Buffer.concat([buf, b]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString('ascii'))?.[1]);
        // Review C-F1: a header with no length is dropped; waiting for its body would wedge the server for good.
        if (!Number.isFinite(len)) { buf = buf.subarray(end + 4); continue; }
        if (buf.length < end + 4 + len) return;
        let msg: Message | null;
        try { msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8')) as Message; } catch { msg = null; }
        buf = buf.subarray(end + 4 + len);
        // Review C-F2: JSON-RPC 2.0 answers every request. A body that is not JSON gets -32700 with id null, and a
        // request whose handler throws gets -32603; a client waiting on either would otherwise wait forever.
        if (!msg || typeof msg !== 'object') { chain = chain.then(() => fail(null, -32700, 'the body is not a JSON object')); continue; }
        const m = msg;
        chain = chain.then(() => handle(m)).then(() => undefined, (e) => {
          process.stderr.write(`[poly lsp] ${(e as Error).stack ?? e}\n`);
          if (m.id !== undefined && m.id !== null) fail(m.id, -32603, `${m.method}: ${(e as Error).message}`);
        });
      }
    });
    stdin.on('end', () => { void chain.then(resolve); });
  });
}
