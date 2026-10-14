// PT33.5b (ruled after Step 3): how a test builds an unsafe artefact. The checker and admission refuse an unguarded
// irreversible entry, and the runtime has no production path that admits one, so this helper edits the effects
// manifest of an ADMITTED build, recomputes the artefact digest and the certificate digest, and signs the certificate
// with the test trust key directly. It bypasses the checker on purpose. Load must still refuse the result with PL6411
// (the second check), and the worker must still clamp its intents to one attempt (the third).
//
// Nothing under packages/ may import or name this file (test/s526-boundary.test.mjs). It is test data.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { certificateDigest, signDigest, sha256OfBytes } from '@poly/core';

/**
 * Rewrites, in place, the manifest entry `kind` of the admitted project `a` (from test/runtime-helpers.mjs `admitted`):
 * `retry.maxAttempts` becomes `maxAttempts` and any `idempotency` field is removed. The certificate is resealed and
 * signed with a.key. Returns `a`, whose build and certificate now describe the unsafe manifest.
 */
export function forgeUnsafeBuild(a, { kind = 's526.work', maxAttempts = 5 } = {}) {
  const cert = JSON.parse(readFileSync(a.certificate, 'utf8'));
  let edited = 0;
  for (const dir of readdirSync(a.build, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const file = join(a.build, dir.name, 'effects.manifest.json');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const manifest = JSON.parse(text);
    const entry = manifest.effects?.[kind];
    if (!entry) continue;
    entry.retry = { ...entry.retry, maxAttempts };
    delete entry.idempotency;
    const bytes = JSON.stringify(manifest, null, 2);
    writeFileSync(file, bytes);
    const key = `.poly/build/${dir.name}/effects.manifest.json`;
    if (!(key in cert.artefacts)) throw new Error(`forge: the certificate does not list ${key}`);
    cert.artefacts[key] = sha256OfBytes(Buffer.from(bytes, 'utf8'));
    edited++;
  }
  if (edited !== 1) throw new Error(`forge: expected to edit one manifest entry of kind ${kind}, edited ${edited}`);
  delete cert.digest;
  delete cert.signatures;
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, a.key.id, readFileSync(a.key.file, 'utf8'))];
  writeFileSync(a.certificate, JSON.stringify(cert));
  return a;
}
