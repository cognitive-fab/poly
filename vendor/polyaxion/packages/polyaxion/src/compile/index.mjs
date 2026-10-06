// compile: polyaxion.policy.json → plan → polysec policy triple on disk.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compilePolicy } from '../core/policy.mjs';
import { buildPlan, CompileError } from './plan.mjs';
import { emitTriple } from './emit.mjs';
import { digest } from '../core/canon.mjs';
import { fileURLToPath } from 'node:url';

const CORE_STEP = resolve(fileURLToPath(new URL('../core/step.mjs', import.meta.url))).replace(/\\/g, '/');

export { buildPlan, emitTriple, CompileError };

/** Compile a policy document in memory. */
export function compileToTriple(doc, opts = {}) {
  const compiled = compilePolicy(doc);
  const plan = buildPlan(compiled, opts);
  const triple = emitTriple(plan, opts);
  return { compiled, plan, triple, findings: plan.findings };
}

/** Write the triple (and invariants.mjs, plan.json) to a directory; returns paths and digests. */
export function writeTriple(doc, outDir, opts = {}) {
  const r = compileToTriple(doc, opts);
  mkdirSync(outDir, { recursive: true });
  const files = {
    module: join(outDir, 'next.cjs'),
    contract: join(outDir, 'contract.json'),
    security: join(outDir, 'security.json'),
    invariants: join(outDir, 'invariants.mjs'),
    plan: join(outDir, 'plan.json'),
    authoring: join(outDir, 'policy.json'),
    env: join(outDir, 'polyaxion.env.json'),
  };
  writeFileSync(files.module, r.triple.module);
  writeFileSync(files.contract, r.triple.contract);
  writeFileSync(files.security, r.triple.security);
  writeFileSync(files.invariants, r.triple.invariants);
  writeFileSync(files.plan, JSON.stringify(r.plan, null, 2) + '\n');
  writeFileSync(files.authoring, JSON.stringify(r.compiled.doc, null, 2) + '\n');
  // machine-specific and not part of the digest: where this checkout's interpreter lives, for triples loaded outside an npm install
  writeFileSync(files.env, JSON.stringify({ core: CORE_STEP }, null, 2) + '\n');
  const tripleDigest = digest({ module: r.triple.module, contract: r.triple.contract, security: r.triple.security, authoring: r.compiled.hash });
  return { ...r, dir: resolve(outDir), files, tripleDigest };
}

export function readTriple(dir) {
  const p = (f) => join(dir, f);
  if (!existsSync(p('next.cjs')) || !existsSync(p('contract.json')) || !existsSync(p('security.json'))) throw new Error(`not a policy triple directory: ${dir}`);
  return { dir: resolve(dir), module: readFileSync(p('next.cjs'), 'utf8'), contract: JSON.parse(readFileSync(p('contract.json'), 'utf8')), security: JSON.parse(readFileSync(p('security.json'), 'utf8')), plan: existsSync(p('plan.json')) ? JSON.parse(readFileSync(p('plan.json'), 'utf8')) : null };
}
