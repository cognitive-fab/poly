// plan-e3.md E3.4: the harness admitted and loaded under poly-runtime, with its real handler files certified (not a test
// script standing in for them), and the recorded provider. Shared by the E3 runtime tests.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';

export const EX = join(ROOT, 'examples', 'harness');
export const HANDLER_FILES = ['verify', 'scan', 'classify', 'tools', 'archive', 'compact', 'intake'].map((n) => `src/handlers/${n}.mjs`);

/**
 * Admits the harness module and its policy as a project whose handler modules are the example's own files. `edit` may
 * rewrite the program or the policy text (a seeded variant) before admission.
 */
export async function admittedHarness(name, { edit = (s) => s, editPolicy = (s) => s, handlers = HANDLER_FILES } = {}) {
  const key = makeKey(name);
  const dir = project(name, ['examples/harness/harness.poly', 'examples/harness/harness.policy.poly'], key, 'test-e3');
  writeFileSync(join(dir, 'src', 'harness.poly'), edit(readFileSync(join(EX, 'harness.poly'), 'utf8')));
  writeFileSync(join(dir, 'src', 'harness.policy.poly'), editPolicy(readFileSync(join(EX, 'harness.policy.poly'), 'utf8')));
  cpSync(join(EX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  cpSync(join(EX, 'host', 'handlers'), join(dir, 'src', 'handlers'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  manifest.handlers = handlers;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest, null, 2));
  await signPolicies(dir);
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate, result: r };
}

export { loaded };
