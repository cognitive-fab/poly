// S194 (Q8, M9, as ruled): a person signs every policy. The subject of a scope's `policy` record binds its name, the
// digest of the document its policies lower to (the bytes the engine runs), the digest of the source file that
// declares them (a scope's policies live in one module, PT8.2) and the engine pin. This file computes the subjects as
// admission does, from the same check of the declaring module, and writes a signature for `poly sign policy`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadProject, policySubject, sha256OfBytes, signRecord, type Module, type PolicySubjectParts } from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkFile } from './pipeline.js';
import { policySlug } from './policies.js';

export interface PolicyScopeSubject { scope: string; slug: string; file: string; parts: PolicySubjectParts; subject: string }

/** Where a scope's signature is kept in the project. */
export const policySignaturePath = (dir: string, scope: string): string => join(dir, 'policies', `${policySlug(scope)}.sig.json`);

/**
 * Each policy scope of a project with its subject, by checking each module that declares a policy as `poly check`
 * does (the project's program given), so the document is the one admission certifies. The engine is the pinned one.
 */
export async function policySubjects(dir: string, opts: { std?: string } = {}): Promise<PolicyScopeSubject[]> {
  const { files } = loadProject(dir);
  const program: Module[] = [];
  const programFiles: { file: string; module: Module }[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const m = (f.endsWith('.ts') ? readEmbedded(text, f) : parse(text)).module;
    if (m) { program.push(m); programFiles.push({ file: f, module: m }); }
  }
  const { polyaxionPeer } = await import('@poly/runtime');
  const peer = polyaxionPeer({ fresh: true });
  if (!peer.ok) throw new Error(`the gate engine is not the pinned one, so no policy can be signed: ${peer.reason}`);
  const out: PolicyScopeSubject[] = [];
  for (const pf of programFiles) {
    if (!pf.module.decls.some((d) => d.kind === 'Policy')) continue;
    const r = await checkFile(pf.file, { root: dir, program, programFiles, ...(opts.std ? { std: opts.std } : {}) });
    const rel = relative(dir, pf.file).split(sep).join('/');
    for (const p of r.policies ?? []) {
      if (!p.artefact) throw new Error(`the policies of scope ${p.scope} were not lowered (${p.verdict}); fix them before signing`);
      const parts: PolicySubjectParts = { scope: p.scope, document: p.artefact.digest, sources: { [rel]: r.sourceDigest ?? sha256OfBytes(readFileSync(pf.file)) }, engine: { name: 'polyaxion', commit: peer.commit } };
      out.push({ scope: p.scope, slug: policySlug(p.scope), file: rel, parts, subject: policySubject(parts) });
    }
  }
  return out;
}

/** `poly sign policy`: the scope's `policy` record, signed with a person's key, written beside the sources. */
export async function signPolicy(dir: string, scope: string, by: string, privateKeyPem: string, at: string): Promise<{ path: string; subject: string }> {
  const s = (await policySubjects(dir)).find((x) => x.scope === scope);
  if (!s) throw new Error(`the project declares no policy of scope ${scope}`);
  const path = policySignaturePath(dir, scope);
  mkdirSync(join(dir, 'policies'), { recursive: true });
  writeFileSync(path, JSON.stringify(signRecord({ kind: 'policy', subject: s.subject, by, at }, privateKeyPem), null, 2) + '\n');
  return { path, subject: s.subject };
}
