// The new examples (docs/examples/*.md): what their end-to-end tests share. An example is admitted as a project from its
// own directory: the program, its policy beside it, its maps and prices, and host/handlers.ts as the certified handlers
// file (PT10h, S142). Handlers import their types from the build with a type-only import, so the same file compiles
// under `poly check --host` and loads under the runtime. Nothing here knows an example's rules.
import { copyFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';

export const exampleDir = (name) => join(ROOT, 'examples', name);

/**
 * Admits `examples/<name>` as a project. `program` and `policy` name the files to use (the defect copy and its policy,
 * say); the policy is left out when the file does not exist. Returns what `loaded` needs, and the admission report.
 */
export async function admitExample(name, { program = `${name}.poly`, policy = `${name}.policy.poly`, tag = name } = {}) {
  const dir = exampleDir(name);
  const key = makeKey(`ex-${tag}`);
  const p = project(`ex-${tag}`, [], key, 'test-examples-e2e');
  copyFileSync(join(dir, program), join(p, 'src', program));
  if (policy && existsSync(join(dir, policy))) copyFileSync(join(dir, policy), join(p, 'src', policy));
  copyFileSync(join(dir, 'host', 'handlers.ts'), join(p, 'src', 'handlers.ts'));
  for (const d of ['maps', 'prices']) if (existsSync(join(dir, d))) cpSync(join(dir, d), join(p, 'src', d), { recursive: true });
  await signPolicies(p);
  const r = await admit(p);
  return { dir: p, key, build: join(p, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report };
}

/** An egress transport that records each request and answers with `answer(request)`. */
export function recordingEgress(answer = () => ({ status: 200, headers: {}, body: { ok: true } })) {
  const sent = [];
  return { sent, transports: { egress: async (req) => { sent.push(req); return answer(req); } } };
}

/** Loads an admitted example with the transports a test gives; the clock is the test's (runtime-helpers `loaded`). */
export const loadExample = (a, extra = {}) => loaded(a, extra);

/** Runs the worker and the runtime's advance `n` times, so every effect, decision and timer that is due has run. */
export async function settle(rt, n = 20) {
  for (let k = 0; k < n; k++) { await rt.advance?.(); await rt.worker.tick(); }
}
