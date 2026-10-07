// Shared by the M11 tests: the desk of test/fixtures/m11 admitted as a project, with its price tables and calibration
// maps beside the source, and a recorded provider per tier. No test calls a model (S356).
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';

export const FIX = join(ROOT, 'test', 'fixtures', 'm11');
export const DESK = readFileSync(join(FIX, 'desk.poly'), 'utf8');

/** Admits a desk source (the fixture, or a variant of it) with the fixture's files, `files` written over them. */
export async function admittedDesk(name, src = DESK, files = {}) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m11/desk.poly'], key, 'test-routing');
  writeFileSync(join(dir, 'src', 'desk.poly'), src);
  cpSync(join(FIX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, 'src', f), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  // S194: a policy is admitted only with a person's signature.
  if (Object.keys(files).some((f) => f.endsWith('.policy.poly'))) await signPolicies(dir);
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate };
}

/** A recorded answer of the desk's classification: the answer, its raw probability and the tokens the tier reported. */
export const answer = (branch, p, usage = { input: 1000, output: 200 }) => ({ answer: branch, distribution: [[branch, p], ['Other', Math.max(0, 1 - p)]], usage });
