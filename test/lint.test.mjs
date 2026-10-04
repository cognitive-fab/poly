// The handler lint (PT6.5, S72; plan-m2 step 7). poly.json's `handlers` names the effect handler modules;
// each is read, never run, and any reach for ambient authority is PL6401, which refuses the project. A
// project with effects and no `handlers` field lists the lint as not run; it is never silently clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lintHandlerText, checkProject } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const codes = (src, file = 'h.ts') => lintHandlerText(src, file).map((d) => d.message.replace(/^[^:]*: /, ''));

test('PT6.5: a handler that uses only its capabilities is clean', () => {
  assert.deepEqual(codes(`
    import type { Capabilities } from '@cognitive-fab/polyrun';
    import { format } from './format.js';
    export async function charge(payload: { amount: number }, caps: Capabilities) {
      return caps.egress.post('/charges', { amount: format(payload.amount) });
    }`), []);
});

test('PT6.5: each reach for ambient authority is PL6401, at its node', () => {
  const cases = [
    ["import { readFileSync } from 'node:fs';", /imports node:fs/],
    ["import * as net from 'net';", /imports net/],
    ["export { request } from 'node:https';", /imports node:https/],
    ["const cp = require('child_process');", /imports child_process/],
    ["const m = await import('node:http');", /imports node:http/],
    ["const m = await import(name);", /named at run time/],
    ["const r = require(name);", /named at run time/],
    ['await fetch("https://psp.example");', /global fetch/],
    ['const key = process.env.PSP_KEY;', /process\.env/],
    ["const f = globalThis['fe' + 'tch'];", /by a computed name/],
    ['const f = globalThis.fetch;', /globalThis\.fetch/],
  ];
  for (const [src, why] of cases) {
    const ds = lintHandlerText(`export async function h() {}\n${src}\n`, 'h.ts');
    assert.equal(ds.length, 1, src);
    assert.equal(ds[0].code, 'PL6401');
    assert.equal(ds[0].at.line, 2, src);
    assert.match(ds[0].message, why, src);
  }
});

function project(name, handlers, files) {
  const dir = join(BUILD, 'lint', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'handlers'), { recursive: true });
  copyFileSync(join(ROOT, 'examples', 'orders', 'orders.poly'), join(dir, 'src', 'orders.poly'));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'handlers', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'], ...(handlers ? { handlers } : {}) }));
  return dir;
}

test('S72: a violating handler refuses the project; a clean one leaves its verdict as it was', async () => {
  const bad = await checkProject(project('bad', ['handlers/*.ts'], { 'charge.ts': "import { writeFileSync } from 'node:fs';\nexport const charge = () => writeFileSync('x', 'y');\n" }));
  assert.equal(bad.handlers.status, 'ran');
  assert.deepEqual(bad.handlers.diagnostics.map((d) => d.code), ['PL6401']);
  assert.equal(bad.verdict, 'REFUSED');
  const good = await checkProject(project('good', ['handlers/*.ts'], { 'charge.ts': 'export const charge = (p, caps) => caps.egress.post("/c", p);\n' }));
  assert.deepEqual([good.handlers.status, good.handlers.files, good.handlers.diagnostics, good.handlers.roots], ['ran', 1, [], ['handlers/charge.ts']]);
  assert.equal(good.verdict, good.files[0].verdict);
});

test('S72: a project with effects and no handlers field lists the lint as not run', async () => {
  const dir = project('none', null, {});
  const p = await checkProject(dir);
  assert.equal(p.handlers.status, 'not-run');
  assert.match(p.handlers.reason, /names no handlers \(S72\)/);
  const out = spawnSync(process.execPath, [CLI, 'check', dir], { encoding: 'utf8' });
  assert.match(out.stdout, /handlers: lint not run \(the project has effects, and poly\.json names no handlers \(S72\)\)/);
  assert.equal(spawnSync(process.execPath, [CLI, 'lint', 'handlers', dir], { encoding: 'utf8' }).status, 64);
});

test('the CLI: poly lint handlers exits 2 on a violation and 0 when clean', () => {
  const bad = spawnSync(process.execPath, [CLI, 'lint', 'handlers', project('cli-bad', ['handlers/**/*.ts'], { 'a.ts': 'const k = process.env.K;\n' })], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /PL6401 AMBIENT_EFFECT_IN_HANDLER .*a\.ts: the handler reads process\.env/);
  const good = spawnSync(process.execPath, [CLI, 'lint', 'handlers', project('cli-good', ['handlers/*.ts'], { 'a.ts': 'export const a = 1;\n' })], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
});
