// M6 step 7 (PF9.1, PT14, S168, S171): `poly lsp` is the language server, over stdio, on both surfaces. It publishes
// the diagnostics of poly check's stages 0 to 2 on every edit, at poly check's positions, and the later stages on save;
// it formats a standalone module (an embedded one is TypeScript's to format); it offers each typed fix as a code
// action, on both surfaces, and offers none whose digest no longer holds; and it serves the registry's commands
// through workspace/executeCommand. A scripted client, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, COMMANDS } from '@poly/check';
import { parse, format } from '@poly/lang';
import { printModule } from '@poly/embed';
import { ROOT } from './helpers.mjs';
import { lspClient, uriOf } from './lsp-client.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const DIR = join(ROOT, '.poly', 'test-lsp');
const FIXES = readFileSync(join(ROOT, 'conformance', 'm2', 'errors', 'fixes.poly'), 'utf8');

async function server() {
  const c = lspClient(process.execPath, [CLI, 'lsp'], { cwd: ROOT });
  const init = await c.request('initialize', { processId: null, rootUri: uriOf(DIR), capabilities: {} });
  c.notify('initialized', {});
  return { c, init };
}
const open = (c, path, text, languageId = 'poly') => c.notify('textDocument/didOpen', { textDocument: { uri: uriOf(path), languageId, version: 1, text } });
const published = (c, path, pred = () => true) => c.wait((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uriOf(path) && pred(m.params));
const key = (d) => `${d.code} ${d.range.start.line + 1}:${d.range.start.character + 1}`;

test('S168: on open, the stage 0 to 2 diagnostics of poly check, at its positions, on both surfaces', { timeout: 180_000 }, async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const poly = join(DIR, 'fixes.poly');
  const ts = join(DIR, 'fixes.ts');
  writeFileSync(poly, FIXES);
  writeFileSync(ts, printModule(parse(FIXES).module));
  const { c, init } = await server();
  try {
    assert.equal(init.serverInfo.name, 'poly');
    assert.ok(init.capabilities.documentFormattingProvider);
    assert.ok(init.capabilities.codeActionProvider);
    for (const [path, lang] of [[poly, 'poly'], [ts, 'typescript']]) {
      open(c, path, readFileSync(path, 'utf8'), lang);
      const got = (await published(c, path)).params.diagnostics;
      const r = await checkFile(path, { root: join(DIR, 'cli') });
      const want = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].filter((d) => ['types', 'parse', 'lower', 'validate', 'model-check', 'deadlock', 'liveness'].includes(d.stage) && d.at.line);
      assert.deepEqual(got.map(key).sort(), want.map((d) => `${d.code} ${d.at.line}:${d.at.col}`).sort(), path);
      assert.ok(got.every((d) => d.source === 'poly'));
    }
  } finally { await c.close(); }
});

test('S168: the later stages run on save, not on each edit', { timeout: 180_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const src = readFileSync(join(ROOT, 'conformance', 'm6', 'customer-brief.poly'), 'utf8');
  const mutant = src.replace('    require briefState == review else reject "nothing-awaiting-approval"\n    briefState\' = posting', '    require briefState == review || briefState == drafting else reject "nothing-awaiting-approval"\n    briefState\' = posting');
  assert.notEqual(mutant, src);
  const path = join(DIR, 'customer-brief.poly');
  writeFileSync(path, mutant);
  const { c } = await server();
  try {
    open(c, path, mutant);
    const onOpen = (await published(c, path)).params.diagnostics;
    assert.ok(!onOpen.some((d) => d.code === 'PL4001'), 'the effects stage (3) does not run on an edit');
    c.notify('textDocument/didSave', { textDocument: { uri: uriOf(path) } });
    const onSave = (await published(c, path, (p) => p.diagnostics.some((d) => d.code === 'PL4001'))).params.diagnostics;
    assert.ok(onSave.some((d) => d.code === 'PL4001' && /no-post-without-prior-approval/.test(d.message)));
  } finally { await c.close(); }
});

test('S168: formatting gives poly fmt\'s text for a standalone module, and nothing for an embedded one', { timeout: 120_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const src = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
  const messy = src.replace('module brief', 'module    brief');
  const path = join(DIR, 'messy.poly');
  writeFileSync(path, messy);
  const ts = join(DIR, 'brief.ts');
  writeFileSync(ts, printModule(parse(src).module));
  const { c } = await server();
  try {
    open(c, path, messy);
    const edits = await c.request('textDocument/formatting', { textDocument: { uri: uriOf(path) }, options: { tabSize: 2, insertSpaces: true } });
    assert.equal(edits.length, 1);
    const r = parse(messy);
    assert.equal(edits[0].newText, format(r.module, r.trivia));
    open(c, ts, readFileSync(ts, 'utf8'), 'typescript');
    assert.equal(await c.request('textDocument/formatting', { textDocument: { uri: uriOf(ts) }, options: { tabSize: 2, insertSpaces: true } }), null);
  } finally { await c.close(); }
});

test('S168: each typed fix is a code action on both surfaces, and one whose digest no longer holds is not offered', { timeout: 180_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const poly = join(DIR, 'fix-actions.poly');
  const ts = join(DIR, 'fix-actions.ts');
  writeFileSync(poly, FIXES);
  writeFileSync(ts, printModule(parse(FIXES).module));
  const { c } = await server();
  try {
    for (const [path, lang] of [[poly, 'poly'], [ts, 'typescript']]) {
      const text = readFileSync(path, 'utf8');
      open(c, path, text, lang);
      const ds = (await published(c, path)).params.diagnostics;
      const d = ds.find((x) => x.code === 'PL1504');
      assert.ok(d, `${path}: ${ds.map((x) => x.code).join(', ')}`);
      const actions = await c.request('textDocument/codeAction', { textDocument: { uri: uriOf(path) }, range: d.range, context: { diagnostics: [d] } });
      assert.ok(actions.length >= 1, path);
      const edit = actions[0].edit.changes[uriOf(path)][0];
      assert.notEqual(edit.newText, text);
      assert.ok(actions[0].isPreferred !== undefined);
      // The binder is renamed in the editor before the action is asked for: the fix's node no longer has its digest.
      const changed = lang === 'poly' ? text.replace(/Busy\(Hgh\)|Hgh/, 'Hgx') : text.split('"Hgh"').join('"Hgx"');
      assert.notEqual(changed, text);
      c.notify('textDocument/didChange', { textDocument: { uri: uriOf(path), version: 2 }, contentChanges: [{ text: changed }] });
      await published(c, path);
      const stale = await c.request('textDocument/codeAction', { textDocument: { uri: uriOf(path) }, range: d.range, context: { diagnostics: [d] } });
      assert.deepEqual(stale, [], `${path}: a stale fix is not offered`);
    }
  } finally { await c.close(); }
});

test('S171: every command the registry gives the language server is an executable command, returning its JSON', { timeout: 120_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const { c, init } = await server();
  try {
    const want = COMMANDS.filter((x) => x.lsp).map((x) => `poly.${x.name}`).sort();
    assert.deepEqual([...init.capabilities.executeCommandProvider.commands].sort(), want);
    const r = await c.request('workspace/executeCommand', { command: 'poly.fmt', arguments: [{ file: join(ROOT, 'conformance', 'm6', 'brief.poly') }] });
    assert.equal(r.changed, false);
    assert.match(r.moduleDigest, /sha256:/);
    await assert.rejects(c.request('workspace/executeCommand', { command: 'poly.approve', arguments: [{}] }), /unknown command/);
  } finally { await c.close(); }
});

// Polywatch on step 7: a check of stages 0 to 2 lists every configuration and policy as not run, and no machine of it
// reads CLEAN, since its later stages did not run (PA0.4).
test('S168: a check through stage 2 lists configurations and policies as not run, and no machine is CLEAN', async () => {
  const r = await checkFile(join(ROOT, 'examples', 'checkout', 'checkout.poly'), { root: join(DIR, 'through'), through: 2 });
  assert.notEqual(r.verdict, 'CLEAN');
  assert.ok(r.machines.length > 0 && r.machines.every((m) => m.verdict !== 'CLEAN'), JSON.stringify(r.machines.map((m) => m.verdict)));
  assert.ok(r.configurations.length > 0, 'the configuration is listed');
  assert.ok(r.configurations.every((c) => c.stages.every((s) => s.status === 'not-run') && c.verdict !== 'CLEAN'), JSON.stringify(r.configurations));
  const p = await checkFile(join(ROOT, 'conformance', 'm5', 'orders.policy.poly'), { root: join(DIR, 'through'), through: 2, program: [] });
  assert.ok(p.policies.length > 0 && p.policies.every((x) => x.stages.every((s) => s.status === 'not-run')), JSON.stringify(p.policies));
});

// Polywatch on step 7: a diagnostic poly check reports with no line is shown at the top of the file, never dropped.
test('S168: a diagnostic with no line is published at the top of the file', async () => {
  const { toLsp } = await import('@poly/agent');
  const d = toLsp({ code: 'PL2501', name: 'X', severity: 'error', stage: 'model-check', at: { module: 'm' }, message: 'an engine finding with no position' });
  assert.deepEqual(d?.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  assert.equal(d.code, 'PL2501');
});

// Polywatch on step 7: a server started with no workspace builds in a folder of its own, so two servers never
// delete or overwrite each other's lowerings in a shared temporary folder.
test('S168: a server with no workspace builds in its own folder, not a shared one', { timeout: 120_000 }, async () => {
  const { tmpdir } = await import('node:os');
  const { existsSync } = await import('node:fs');
  const shared = join(tmpdir(), 'poly-lsp', '.poly', 'build', 'brief.Brief');
  rmSync(join(tmpdir(), 'poly-lsp'), { recursive: true, force: true });
  const c = lspClient(process.execPath, [CLI, 'lsp'], { cwd: ROOT });
  try {
    await c.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    c.notify('initialized', {});
    const path = join(ROOT, 'conformance', 'm6', 'brief.poly');
    open(c, path, readFileSync(path, 'utf8'));
    await published(c, path);
    assert.equal(existsSync(shared), false, 'nothing is built in the shared poly-lsp folder');
  } finally { await c.close(); }
});
