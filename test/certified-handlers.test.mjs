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

// S154 (M5b step 16): an installed package a handler imports is hashed: the closure follows the bare import through
// Node's resolution into node_modules, every file it reaches there and each package's package.json, and certifies them
// under packageFiles; load refuses a change (PL6403). Packages are hashed, not linted: the limits say the sandbox is
// what stops a package's own I/O.
test('S154: an installed package is hashed; a changed file inside it is PL6403 at load', async () => {
  const dir = withClosure('package', "import { pad } from 'leftpad-poly';\nexport function shape(p: unknown) { return { ok: true, p, s: pad('x') }; }\n");
  const pkg = join(dir, 'node_modules', 'leftpad-poly');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'leftpad-poly', version: '1.0.0', type: 'module', exports: { '.': './lib/index.js' } }));
  writeFileSync(join(pkg, 'lib', 'index.js'), "import { fill } from './fill.js';\nexport function pad(s) { return fill(s); }\n");
  writeFileSync(join(pkg, 'lib', 'fill.js'), "export function fill(s) { return ' ' + s; }\n");
  writeFileSync(join(pkg, 'lib', 'unused.js'), 'export const unused = 1;\n');
  const r = await admit(dir);
  const h = r.certificate.poly.handlers;
  assert.deepEqual(h.packages, ['leftpad-poly']);
  assert.deepEqual(Object.keys(h.packageFiles).sort(), ['node_modules/leftpad-poly/lib/fill.js', 'node_modules/leftpad-poly/lib/index.js', 'node_modules/leftpad-poly/package.json']);
  for (const [p, d] of Object.entries(h.packageFiles)) assert.equal(d, sha256OfBytes(readFileSync(join(dir, p))), p);
  assert.ok(h.lockfile && /package-lock\.json$/.test(h.lockfile.path), JSON.stringify(h.lockfile));
  assert.ok(r.certificate.poly.limits.some((l) => /packages are hashed, not linted/.test(l)));
  const rt = await load(join(dir, '.poly', 'build'), opts(dir, r));
  await rt.close();
  writeFileSync(join(pkg, 'lib', 'fill.js'), "export function fill(s) { return '!' + s; }\n");
  await assert.rejects(load(join(dir, '.poly', 'build'), opts(dir, r)), (e) => e instanceof LoadError && /PL6403/.test(e.message) && /leftpad-poly\/lib\/fill\.js/.test(e.message));
});

// Polywatch on S142: a signed certificate whose handlers block is malformed is refused as PL6403, never a TypeError.
test('polywatch: a certificate whose handler files are null is refused at load with PL6403', async () => {
  const { certificateDigest, signDigest } = await import('@poly/core');
  const dir = withClosure('null-files');
  const r = await admit(dir);
  const body = JSON.parse(readFileSync(r.certificatePath, 'utf8'));
  body.poly.handlers.files = null;
  delete body.digest; delete body.signatures;
  const digest = certificateDigest(body);
  const forged = { ...body, signatures: [signDigest(digest, key.id, readFileSync(key.file, 'utf8'))], digest };
  writeFileSync(r.certificatePath, JSON.stringify(forged));
  await assert.rejects(load(join(dir, '.poly', 'build'), opts(dir, r)), (e) => e instanceof LoadError && /PL6403/.test(e.message));
});

// Review of M5b, D-F4: the runtime imports the verified copy of the handlers, so the certified package files are
// copied beside it as they sit beside the handlers; an uncertified package elsewhere in the project is not what runs.
test('S154: a handler imports the certified package, not another one the project holds', async () => {
  const dir = project('nested-modules', SOURCES, key, 'test-handlers');
  writeFileSync(join(dir, 'src', 'handlers.ts'), "import tag from 'lib';\nexport async function handle(payload: unknown) { return { ok: true, tag, payload }; }\nexport function which() { return tag; }\n");
  const pkg = (where, value) => {
    mkdirSync(join(where, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(join(where, 'node_modules', 'lib', 'package.json'), JSON.stringify({ name: 'lib', main: 'index.js' }));
    writeFileSync(join(where, 'node_modules', 'lib', 'index.js'), `module.exports = ${JSON.stringify(value)};\n`);
  };
  pkg(join(dir, 'src'), 'certified');
  pkg(dir, 'not certified');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  const r = await admit(dir);
  assert.deepEqual(Object.keys(r.certificate.poly.handlers.packageFiles).sort(), ['src/node_modules/lib/index.js', 'src/node_modules/lib/package.json']);
  const rt = await load(join(dir, '.poly', 'build'), opts(dir, r));
  try { assert.equal(rt.handlerExports('src/handlers.ts').which(), 'certified'); } finally { await rt.close(); }
});

// Polywatch on the M5b fixes: a package Node resolves from a node_modules above the project is certified under a
// '../' path. The runtime imports the handlers' verified copy, so that package must be copied and re-checked too,
// or the handler would import the original file outside the run directory.
test('S154: a certified package above the project is imported from the verified copy', async () => {
  const dir = project('package-above', SOURCES, key, 'test-handlers-above');
  const above = join(dir, '..', 'node_modules', 'above-poly');
  mkdirSync(above, { recursive: true });
  writeFileSync(join(above, 'package.json'), JSON.stringify({ name: 'above-poly', version: '1.0.0', type: 'module', exports: './index.js' }));
  writeFileSync(join(above, 'index.js'), 'export const where = import.meta.url;\n');
  writeFileSync(join(dir, 'src', 'handlers.ts'), "import { where } from 'above-poly';\nexport async function handle(payload: unknown) { return { ok: true, payload }; }\nexport function which() { return where; }\n");
  const r = await admit(dir);
  assert.deepEqual(Object.keys(r.certificate.poly.handlers.packageFiles).sort(), ['../node_modules/above-poly/index.js', '../node_modules/above-poly/package.json']);
  const rt = await load(join(dir, '.poly', 'build'), opts(dir, r));
  try {
    const where = rt.handlerExports('src/handlers.ts').which();
    assert.ok(where.startsWith(pathToFileURL(join(dir, '.poly', 'run')).href), where);
  } finally { await rt.close(); }
});

// Polywatch on the M5b fixes: an imports-map specifier ('#…') in a handler would resolve through the project's
// package.json to the original files, not the verified copy, so it is refused as such, never as a missing package.
test('S154: an imports-map specifier in a handler is PL6402 with its reason', async () => {
  const { checkProject } = await import('@poly/check');
  const dir = withClosure('imports-map', "import { x } from '#internal';\nexport function shape(p: unknown) { return { ok: true, p, x }; }\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'imports-map', type: 'module', imports: { '#internal': './src/lib/deep.ts' } }));
  const report = await checkProject(dir, { root: dir });
  const d = report.handlers.diagnostics.find((x) => x.code === 'PL6402');
  assert.ok(d && /imports map/.test(d.message) && !/no installed package/.test(d.message), JSON.stringify(report.handlers.diagnostics));
});
