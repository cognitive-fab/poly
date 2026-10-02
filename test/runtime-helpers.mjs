// Shared by the M4 tests: admission keys generated at test time, outside the repository (S126), project
// directories under .poly, and an admitted build loaded into poly-runtime.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { load } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const KEYS = mkdtempSync(join(tmpdir(), 'poly-keys-'));

export function makeKey(name = 'admission') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const file = join(KEYS, `${name}.pem`);
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { id: `test-${name}`, file, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** A project directory under .poly with the given sources copied in, a clean handler module and an admission key. */
export function project(name, sources, key, base = 'test-cert') {
  const dir = join(ROOT, '.poly', base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const s of sources) copyFileSync(join(ROOT, s), join(dir, 'src', s.split('/').pop()));
  writeFileSync(join(dir, 'src', 'handlers.ts'), 'export async function handle(payload: unknown) { return { ok: true, payload } }\n');
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'], handlers: ['src/handlers.ts'], keys: { admission: { id: key.id, location: `file:${key.file}` } } }, null, 2));
  return dir;
}

/** Admits the sources as a project and returns what `load` needs. */
export async function admitted(name, sources, key = makeKey(name)) {
  const dir = project(name, sources, key, 'test-runtime');
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate };
}

/** Loads an admitted build with an in-memory store and a clock the test drives. */
export async function loaded(a, extra = {}) {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, now: clock.now, ...extra });
  return { rt, clock };
}
