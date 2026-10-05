// The code review of M6, part C (the language server): each finding, reproduced by a script under .poly/review-m6-c,
// is a test here that failed before its fix. A scripted client, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { applyFix, checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { lspClient, uriOf } from './lsp-client.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const DIR = join(ROOT, '.poly', 'test-review-m6-c');
const BRIEF = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
const FIXES = readFileSync(join(ROOT, 'conformance', 'm2', 'errors', 'fixes.poly'), 'utf8');
const WORLD = '\nworld Shop { WORLD_BODY_KEEP_ME }\n';

async function server(rootUri, cwd = ROOT) {
  mkdirSync(cwd, { recursive: true });
  const c = lspClient(process.execPath, [CLI, 'lsp'], { cwd });
  await c.request('initialize', { processId: null, rootUri, capabilities: {} });
  c.notify('initialized', {});
  return c;
}
const fresh = (name) => { const d = join(DIR, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
const open = (c, uri, text, languageId = 'poly') => c.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
const published = (c, uri) => c.wait((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
const frame = (o) => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...o }), 'utf8'); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]); };

test('review C-F1: a header with no Content-Length is dropped, and the requests after it are answered', { timeout: 60_000 }, async () => {
  const c = await server(null);
  try {
    c.raw(Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n', 'ascii'));
    c.raw(frame({ id: 900, method: 'nope/unknown' }));
    const r = await c.replied(900, 5_000);
    assert.ok(r, 'a request after the header is answered');
    assert.equal(r.error?.code, -32601);
  } finally { await c.kill(); }
});

test('review C-F2: a request whose handler throws gets -32603, and a body that is not JSON gets -32700 with id null', { timeout: 60_000 }, async () => {
  const c = await server(null);
  try {
    c.raw(frame({ id: 901, method: 'textDocument/formatting' }));
    const r = await c.replied(901, 5_000);
    assert.equal(r?.error?.code, -32603, 'a reply to a request with no params');
    c.raw(frame({ method: 'textDocument/didOpen' }));
    const body = Buffer.from('{"jsonrpc":"2.0","id":902,"method":"shutdown"', 'utf8');
    c.raw(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    c.raw(frame({ id: 903, method: 'nope/unknown' }));
    assert.equal((await c.replied(903, 5_000))?.error?.code, -32601, 'the server goes on after both');
    assert.ok(c.received.some((m) => m.id === null && m.error?.code === -32700), JSON.stringify(c.received));
  } finally { await c.kill(); }
});

test('review C-F3: formatting and fixes are refused for a module with text the parser skips (PL0901), never dropping it', { timeout: 180_000 }, async () => {
  const dir = fresh('skipped');
  const c = await server(uriOf(join(dir, 'ws')));
  try {
    const f1 = join(dir, 'brief-world.poly');
    open(c, uriOf(f1), BRIEF + WORLD);
    await published(c, uriOf(f1));
    const edits = await c.request('textDocument/formatting', { textDocument: { uri: uriOf(f1) }, options: { tabSize: 2, insertSpaces: true } });
    assert.ok(edits === null || edits.every((e) => e.newText.includes('WORLD_BODY_KEEP_ME')), JSON.stringify(edits)?.slice(0, 200));
    const f2 = join(dir, 'fixes-world.poly');
    const text = FIXES.replace('machine Desk {\n', 'machine Desk {\n  version 2 from 1 { MIGRATION_BODY_KEEP_ME }\n') + WORLD;
    assert.notEqual(text, FIXES + WORLD);
    open(c, uriOf(f2), text);
    const d = (await published(c, uriOf(f2))).params.diagnostics.find((x) => x.data?.fixes?.length);
    assert.ok(d, 'a fixable diagnostic');
    const actions = await c.request('textDocument/codeAction', { textDocument: { uri: uriOf(f2) }, range: d.range, context: { diagnostics: [d] } });
    assert.deepEqual(actions, [], 'no fix is offered that would delete the skipped text');
    // The same rule in poly fix and poly fmt, which print the module the same way.
    const o = applyFix(text, d.data.fixes[0], f2);
    assert.equal(o.status, 'refused');
    assert.equal(o.code, 'PL0901');
    writeFileSync(f2, text);
    const r = spawnSync(process.execPath, [CLI, 'fmt', f2, '--write'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(readFileSync(f2, 'utf8'), text);
  } finally { await c.close(); }
});

test('review C-F3: a code action names the whole fix id', { timeout: 180_000 }, async () => {
  const dir = fresh('title');
  const c = await server(uriOf(join(dir, 'ws')));
  try {
    const f = join(dir, 'fixes.poly');
    open(c, uriOf(f), FIXES);
    const d = (await published(c, uriOf(f))).params.diagnostics.find((x) => x.data?.fixes?.length);
    const actions = await c.request('textDocument/codeAction', { textDocument: { uri: uriOf(f) }, range: d.range, context: { diagnostics: [d] } });
    assert.ok(actions.length >= 1);
    assert.ok(actions[0].title.includes(d.data.fixes[0].id), actions[0].title);
  } finally { await c.close(); }
});

test('review C-F4: two servers on one workspace build in folders of their own', { timeout: 300_000 }, async () => {
  const dir = fresh('shared');
  const ws = join(dir, 'ws');
  const file = join(ROOT, 'examples', 'checkout', 'checkout.poly');
  const text = readFileSync(file, 'utf8');
  const servers = [await server(uriOf(ws)), await server(uriOf(ws))];
  try {
    for (const c of servers) open(c, uriOf(file), text);
    const ROUNDS = 4;
    for (let v = 2; v < 2 + ROUNDS; v++) for (const c of servers) c.notify('textDocument/didChange', { textDocument: { uri: uriOf(file), version: v }, contentChanges: [{ text: text + `\n// edit ${v}\n` }] });
    for (const c of servers) for (let i = 0; i <= ROUNDS; i++) {
      const p = (await published(c, uriOf(file))).params.diagnostics.filter((d) => d.code !== 'verdict');
      assert.deepEqual(p.map((d) => `${d.code}: ${d.message}`), []);
    }
    assert.deepEqual(readdirSync(join(ws, '.poly', 'lsp')).sort(), servers.map((c) => String(c.pid)).sort());
  } finally { for (const c of servers) await c.close(); }
});

test('review C-F5: the editor sees the verdict, what did not run and what is vacuous, never a silent clean', { timeout: 180_000 }, async () => {
  const dir = fresh('silent');
  const file = join(ROOT, 'examples', 'checkout', 'checkout.poly');
  const text = readFileSync(file, 'utf8');
  const r = await checkFile(file, { root: join(dir, 'cli'), text, through: 2 });
  assert.equal(r.verdict, 'INCONCLUSIVE');
  const c = await server(uriOf(join(dir, 'ws')));
  try {
    open(c, uriOf(file), text);
    const ds = (await published(c, uriOf(file))).params.diagnostics;
    const v = ds.find((d) => d.code === 'verdict');
    assert.ok(v, JSON.stringify(ds));
    assert.equal(v.severity, 3);
    assert.match(v.message, /INCONCLUSIVE/);
    assert.match(v.message, /not run/);
    assert.match(v.message, /configuration/);
  } finally { await c.close(); }
});

test('review C-F6: a command with no root runs in the workspace, not in the server\'s working directory', { timeout: 180_000 }, async () => {
  const dir = fresh('cmd-root');
  const ws = join(dir, 'ws');
  const cwd = join(dir, 'editor-cwd');
  mkdirSync(ws, { recursive: true });
  const c = await server(uriOf(ws), cwd);
  try {
    await c.request('workspace/executeCommand', { command: 'poly.check', arguments: [{ target: join(ROOT, 'conformance', 'm6', 'brief.poly') }] });
    assert.ok(existsSync(join(ws, '.poly', 'report.json')), 'the report is in the workspace');
    assert.ok(!existsSync(join(cwd, '.poly')), 'nothing is written in the working directory');
  } finally { await c.close(); }
});

test('review C-F7: a killed server\'s folder is swept by the next server, and an untitled buffer is checked', { timeout: 120_000 }, async () => {
  const c = await server(null);
  const own = join(tmpdir(), `poly-lsp-${c.pid}`);
  try {
    open(c, uriOf(join(DIR, 'any.poly')), 'module brief\n');
    await published(c, uriOf(join(DIR, 'any.poly')));
    assert.ok(existsSync(own), 'the server builds in a folder named by its process');
  } finally { await c.kill(); }
  const next = await server(null);
  try {
    assert.ok(!existsSync(own), 'the dead server\'s folder is gone');
    const uri = 'untitled:Untitled-1';
    open(next, uri, 'module m\nmachine M { state { n : 0..1 = 0 }\n action A()\n on A { n\' = Bogus }\n}\n');
    const ds = (await published(next, uri)).params.diagnostics;
    assert.ok(ds.some((d) => /^PL\d{4}$/.test(d.code)), JSON.stringify(ds));
    assert.ok(!ds.some((d) => d.code === 'ERROR'), JSON.stringify(ds));
    await next.request('textDocument/formatting', { textDocument: { uri }, options: {} });
  } finally { await next.close(); }
});
