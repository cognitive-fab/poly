// S142: the certificate binds the handlers. `poly admit` records the path and SHA-256 of each handler file and of
// every file it reaches through relative imports, lints that whole set, and records the lint's version and verdict
// and the lockfile's digest (installed packages are not hashed in M4). `load` reads the certified files itself,
// hashes them first and refuses any difference (PL6403). `rt.handle` takes only a function that is, by identity, an
// export of a certified handler file loaded that way; anything else is refused before any step (PL6404). An import
// the certificate cannot cover is refused at admission (PL6402).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit, admitWitness, AdmitError } from '@poly/check';
import { load, LoadError } from '@poly/runtime';
import { sha256OfBytes } from '@poly/core';
import { makeKey, project } from './runtime-helpers.mjs';

const key = makeKey('handlers');
const SOURCES = ['conformance/m4/outbox.poly'];

/** A project whose handler imports a helper, which imports another: the closure is three files. */
function withClosure(name, util = "import { deep } from './deep.ts';\nexport function shape(p: unknown) { return deep(p); }\n") {
  const dir = project(name, SOURCES, key, 'test-handlers');
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'src', 'handlers.ts'), "import { shape } from './lib/util.ts';\nexport async function handle(payload: unknown) { return shape(payload); }\n");
  writeFileSync(join(dir, 'src', 'lib', 'util.ts'), util);
  writeFileSync(join(dir, 'src', 'lib', 'deep.ts'), 'export function deep(p: unknown) { return { ok: true, p }; }\n');
  return dir;
}
const opts = (dir, r) => ({ certificate: r.certificatePath, trust: { [key.id]: key.publicKey } });

test('S142: admission certifies each handler file and its relative imports, with the lint\'s version and verdict', async () => {
  const dir = withClosure('closure');
  const r = await admit(dir);
  const h = r.certificate.poly.handlers;
  assert.deepEqual(h.roots, ['src/handlers.ts']);
  assert.deepEqual(Object.keys(h.files).sort(), ['src/handlers.ts', 'src/lib/deep.ts', 'src/lib/util.ts']);
  for (const [p, d] of Object.entries(h.files)) assert.equal(d, sha256OfBytes(readFileSync(join(dir, p))), p);
  assert.equal(h.lint.verdict, 'CLEAN');
  assert.match(h.lint.version, /\S/);
  assert.deepEqual(h.packages, []);
});

test('S142: the lint runs over the closure: an imported helper reaching for node:fs is PL6401, and not admitted', async () => {
  const dir = withClosure('closure-ambient', "import { readFileSync } from 'node:fs';\nexport function shape(p: unknown) { return { ok: true, p, f: readFileSync }; }\n");
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError);
  const { checkProject } = await import('@poly/check');
  const report = await checkProject(dir, { root: dir });
  assert.ok(report.handlers.diagnostics.some((d) => d.code === 'PL6401' && /util\.ts/.test(d.message)), JSON.stringify(report.handlers));
});

test('S142: a relative import the certificate cannot cover is PL6402: missing, or outside the project', async () => {
  const { checkProject } = await import('@poly/check');
  for (const spec of ['./missing.ts', '../../../outside.ts']) {
    const dir = withClosure(`uncertifiable-${spec.length}`, `import { x } from '${spec}';\nexport function shape(p: unknown) { return { ok: true, p, x }; }\n`);
    const report = await checkProject(dir, { root: dir });
    assert.ok(report.handlers.diagnostics.some((d) => d.code === 'PL6402'), `${spec}: ${JSON.stringify(report.handlers)}`);
    await assert.rejects(admit(dir), (e) => e instanceof AdmitError, spec);
  }
});

test('S142: load refuses a handler file, or a file it imports, changed after admission (PL6403)', async () => {
  for (const f of ['src/handlers.ts', 'src/lib/deep.ts']) {
    const dir = withClosure(`changed-${f.length}`);
    const r = await admit(dir);
    writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8') + '// changed after admission\n');
    await assert.rejects(load(join(dir, '.poly', 'build'), opts(dir, r)), (e) => e instanceof LoadError && /PL6403/.test(e.message) && e.message.includes(f), f);
  }
});

test('S142: rt.handle takes only an export of a certified file the runtime loaded; a closure or another module\'s function is PL6404', async () => {
  const dir = withClosure('identity');
  const r = await admit(dir);
  const rt = await load(join(dir, '.poly', 'build'), opts(dir, r));
  try {
    assert.throws(() => rt.handle('w.work', () => 'ok'), /PL6404/);
    // The same file imported by the host is another module: its function is not the certified one.
    const own = await import(pathToFileURL(join(dir, 'src', 'handlers.ts')).href);
    assert.throws(() => rt.handle('w.work', own.handle), /PL6404/);
    const certified = rt.handlerExports('src/handlers.ts');
    rt.handle('w.work', certified.handle);
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick();
    assert.equal((await rt.getState('j')).state.phase, 'Done');
  } finally { await rt.close(); }
});

test('S142: a witness certificate binds the handlers too', async () => {
  const dir = withClosure('witness');
  const w = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') });
  assert.deepEqual(Object.keys(w.certificate.poly.handlers.files).sort(), ['src/handlers.ts', 'src/lib/deep.ts', 'src/lib/util.ts']);
  const rt = await load(join(dir, '.poly', 'build'), { certificate: w.certificatePath, trust: { [key.id]: key.publicKey }, allowWitness: true });
  try { assert.throws(() => rt.handle('w.work', () => 'ok'), /PL6404/); } finally { await rt.close(); }
});

test('S142: an installed package is not hashed in M4; the certificate records it and the lockfile\'s digest', async () => {
  const dir = withClosure('package', "import ts from 'typescript';\nexport function shape(p: unknown) { return { ok: true, p, v: ts.version }; }\n");
  const r = await admit(dir);
  const h = r.certificate.poly.handlers;
  assert.deepEqual(h.packages, ['typescript']);
  assert.ok(h.lockfile && /package-lock\.json$/.test(h.lockfile.path), JSON.stringify(h.lockfile));
  assert.equal(h.lockfile.digest, sha256OfBytes(readFileSync(join(dir, h.lockfile.path))));
  assert.ok(r.certificate.poly.limits.some((l) => /installed packages/.test(l)));
});
