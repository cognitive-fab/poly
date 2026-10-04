// `poly lsp` (PF9.1, PT14, S168, S171, M6 step 7): the language server, over stdio, JSON-RPC 2.0 with Content-Length
// framing, with no SDK. It serves both surfaces: `.poly` and `.policy.poly` files, and embedded modules (`.ts`).
//
//   - Diagnostics: poly check's stages 0 to 2 on every open and change, of the text the editor holds; every stage on
//     save (PT14). Each diagnostic sits at poly check's line and column.
//   - Formatting: poly fmt's text for a standalone module; nothing for an embedded one, which is TypeScript's.
//   - Code actions: each typed fix of a diagnostic (PT12.1), on both surfaces, computed against the text the editor
//     holds now; a fix whose node no longer has its digest is refused (PL0201) and not offered.
//   - Commands: every registry command the language server serves, as workspace/executeCommand `poly.<name>`, which
//     returns the command's JSON (S171).
//
// The server knows no host: an editor or an agent harness starts it, configured by a host adapter (adapters/).
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

/** A poly diagnostic as the editor shows it: at poly check's line and column (1-based there, 0-based here). */
function toLsp(d: Diagnostic): LspDiagnostic | null {
  if (!d.at.line) return null;
  const at = { line: d.at.line - 1, character: Math.max(0, (d.at.col ?? 1) - 1) };
  return { range: { start: at, end: at }, severity: SEVERITY[d.severity] ?? 1, code: d.code, source: 'poly', message: d.message, ...(d.fixes?.length ? { data: { fixes: d.fixes } } : {}) };
}

const diagnosticsOf = (r: CheckReport): Diagnostic[] => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics), ...(r.policies ?? []).flatMap((p) => p.diagnostics)];

export function serveLsp(opts: LspOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const docs = new Map<string, { path: string; text: string }>();
  // The builds of the editor's checks go here, never into the project's own .poly/build.
  let buildRoot = opts.root ?? join(tmpdir(), 'poly-lsp');
  const served = COMMANDS.filter((c) => c.lsp);

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
      ds = diagnosticsOf(r).map(toLsp).filter((x): x is LspDiagnostic => x !== null);
      if (r.error) ds.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, code: 'ERROR', source: 'poly', message: `the check stopped: ${r.error}` });
    } catch (e) {
      ds = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, code: 'ERROR', source: 'poly', message: `the check stopped: ${(e as Error).message}` }];
    }
    write({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: ds } });
  };

  const handle = async (msg: Message) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        if (typeof params?.rootUri === 'string' && params.rootUri.startsWith('file:') && !opts.root) buildRoot = join(fileURLToPath(params.rootUri), '.poly', 'lsp');
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
        const { uri, text } = params.textDocument;
        docs.set(uri, { path: fileURLToPath(uri), text });
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
            actions.push({ title: `poly: ${typeof fix.edit.title === 'string' ? fix.edit.title : `apply fix ${fix.id.slice(0, 12)} for ${d.code}`}`, kind: 'quickfix', diagnostics: [d], isPreferred: (d.data?.fixes ?? []).length === 1, edit: { changes: { [params.textDocument.uri]: [{ range: { start: { line: 0, character: 0 }, end }, newText: o.text }] } } });
          }
        }
        return reply(id, actions);
      }
      case 'workspace/executeCommand': {
        const name = String(params?.command ?? '');
        const cmd = served.find((c) => `poly.${c.name}` === name);
        if (!cmd) return fail(id, -32602, `unknown command ${name}`);
        try {
          const o = await cmd.run((params?.arguments?.[0] ?? {}) as Record<string, unknown>);
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
        if (!Number.isFinite(len) || buf.length < end + 4 + len) return;
        let msg: Message;
        try { msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8')) as Message; } catch { msg = {}; }
        buf = buf.subarray(end + 4 + len);
        chain = chain.then(() => handle(msg)).then(() => undefined, (e) => { process.stderr.write(`[poly lsp] ${(e as Error).stack ?? e}\n`); });
      }
    });
    stdin.on('end', () => { void chain.then(resolve); });
  });
}
