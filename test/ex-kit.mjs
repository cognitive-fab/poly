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
  // An example with no effect handler (research-agents) has no host/handlers.ts; project() has written a stub.
  if (existsSync(join(dir, 'host', 'handlers.ts'))) copyFileSync(join(dir, 'host', 'handlers.ts'), join(p, 'src', 'handlers.ts'));
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

/**
 * PT12.5: a program with findings is admitted only when a person has signed an acceptance of each. Checks the project,
 * writes one acceptance per finding with a witness, signed by PERSON, into `accepted/`, and returns the findings'
 * codes. The seeded defects of the new examples run in an end-to-end test this way, as an owner who accepted the
 * finding would run them; the README of each says so.
 */
export async function acceptFindings(dir) {
  const { checkProject } = await import('@poly/check');
  const { signRecord } = await import('@poly/core');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { PERSON } = await import('./runtime-helpers.mjs');
  const report = await checkProject(dir, { root: dir });
  const accepted = [];
  mkdirSync(join(dir, 'accepted'), { recursive: true });
  for (const f of report.files) {
    const all = [...f.machines, ...(f.configurations ?? []), ...(f.policies ?? [])].flatMap((m) => m.diagnostics ?? []);
    for (const d of all) {
      if (!d.witness) continue;
      const subject = `${f.moduleDigest}:${d.witness.id}`;
      writeFileSync(join(dir, 'accepted', `${accepted.length}.json`), JSON.stringify(signRecord({ kind: 'acceptance', subject, by: PERSON.keyId, at: '2026-10-02T00:00:00.000Z' }, PERSON.privateKeyPem)));
      accepted.push(d.code);
    }
  }
  return accepted;
}
