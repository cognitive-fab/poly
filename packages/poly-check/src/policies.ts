// Stage 5 (PT8): the policies of a module, per trust scope.
//
//   policy-types      names, types and references against the program (PT8, S147: PL6502)
//   policy-lower      one polyaxion.policy.json v2 per scope (PT8.2), written to .poly/build/policies/
//   policy-admission  Polyaxion's admitPolicy: compile, harden, check, discharge (PT8.4)
//   policy-tv         translation validation: poly-ref's PS8 decisions against the engine's plan interpreter, over
//                     every reachable pair of policy states and every proposal of the decision table
//   never             each `never` statement proved by poly-ref over the decision table (S149: PL6503)
//
// Polyaxion is an optional peer (S145): where it is absent, admission and translation validation are listed as not
// run with the reason, and the scope is not CLEAN.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPolicies, policyProgram, diag, type Diagnostic, type Module, type Policy, type Verdict } from '@poly/core';
import { lowerPolicyScope, type PolicyDoc } from '@poly/lower';
import { policyFacts, checkNever, validatePolicy } from '@poly/ref';

export type PolicyStage = 'policy-types' | 'policy-lower' | 'policy-admission' | 'policy-tv' | 'never';

export interface PolicyReport {
  scope: string;
  policies: string[];
  stages: { stage: PolicyStage; status: 'ran' | 'not-run'; engine: string; verdict?: Verdict; reason?: string; note?: string }[];
  notRun: { property: string; reason: string }[];
  vacuous: { property: string; reason: 'vacuous'; antecedent: string }[];
  diagnostics: Diagnostic[];
  verdict: Verdict;
  /** The lowered document, by path relative to the root and SHA-256 of its bytes. */
  artefact?: { path: string; digest: string };
  /** S147: the machines the scope's policies read with machine(…). */
  reads: string[];
}

export const policySlug = (scope: string) => scope.replace(/[^A-Za-z0-9._-]/g, '_');

/** The policies of `module`, checked against `program` (the project's modules), one report per scope. */
export async function policyReports(module: Module, program: Module[], root: string): Promise<PolicyReport[]> {
  const policies = module.decls.filter((d): d is Policy => d.kind === 'Policy');
  if (!policies.length) return [];
  const facts = policyProgram(program);
  const typed = checkPolicies(module, facts);
  const scopes = new Map<string, Policy[]>();
  for (const p of policies) { if (!scopes.has(p.scope)) scopes.set(p.scope, []); scopes.get(p.scope)!.push(p); }
  const { polyaxionPeer, loadPolyaxion, policyEngine } = await import('@poly/runtime');
  const refFacts = policyFacts(program);
  const out: PolicyReport[] = [];
  for (const [scope, ps] of scopes) {
    const ids = new Set(ps.flatMap((p) => [p.id, ...p.items.map((i) => i.id), ...p.vars.map((v) => v.id)]));
    const mine = typed.diagnostics.filter((d) => {
      if (d.at.node && ids.has(d.at.node)) return true;
      // An expression's diagnostic names the expression; it belongs to the policy whose text holds its line.
      return ps.some((p) => p.span && d.at.line !== undefined && d.at.line >= p.span.line && d.at.line <= p.span.endLine);
    });
    const r: PolicyReport = { scope, policies: ps.map((p) => p.name), stages: [], notRun: [], vacuous: [], diagnostics: [...mine], verdict: 'CLEAN', reads: [...new Set(ps.flatMap((p) => typed.reads.get(p.name) ?? []))].sort() };
    out.push(r);
    const refused = mine.some((d) => d.severity === 'error');
    r.stages.push({ stage: 'policy-types', status: 'ran', engine: '@poly/core', verdict: refused ? 'REFUSED' : mine.length ? 'FINDINGS' : 'CLEAN' });
    if (refused) {
      for (const s of ['policy-lower', 'policy-admission', 'policy-tv', 'never'] as PolicyStage[]) r.stages.push({ stage: s, status: 'not-run', engine: '', reason: 'the policies were refused at policy-types' });
      continue;
    }
    // policy-lower: one document per scope, written where admission certifies it.
    const text = JSON.stringify(lowerPolicyScope(scope, ps, 'sha256:' + createHash('sha256').update(JSON.stringify(ps)).digest('hex').slice(0, 16)), null, 2) + '\n';
    const rel = `.poly/build/policies/${policySlug(scope)}.policy.json`;
    mkdirSync(join(root, '.poly', 'build', 'policies'), { recursive: true });
    writeFileSync(join(root, rel), text);
    r.artefact = { path: rel, digest: 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex') };
    const doc = JSON.parse(text) as PolicyDoc;
    r.stages.push({ stage: 'policy-lower', status: 'ran', engine: '@poly/lower', verdict: 'CLEAN', note: `${doc.obligations.length} obligation(s) in ${rel}` });

    // policy-admission and policy-tv need the engine.
    const peer = polyaxionPeer();
    if (!peer.ok) {
      r.stages.push({ stage: 'policy-admission', status: 'not-run', engine: '', reason: peer.reason });
      r.stages.push({ stage: 'policy-tv', status: 'not-run', engine: '', reason: peer.reason });
    } else {
      const px = await loadPolyaxion();
      const admission = await px.admitPolicy(doc, {});
      const errors = (admission.findings ?? []).filter((f: { level: string }) => f.level === 'error');
      for (const f of errors) r.diagnostics.push(diag('PL6001', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, `Polyaxion refuses the policies of scope ${scope} at admission: ${f.obligation ? `${f.obligation}: ` : ''}${f.message} (PT8.4)`));
      if (!admission.servable && !errors.length) r.diagnostics.push(diag('PL6001', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, `Polyaxion does not serve the policies of scope ${scope}: ${admission.refused?.message ?? 'not servable'} (PT8.4)`));
      r.stages.push({ stage: 'policy-admission', status: 'ran', engine: `polyaxion@${peer.commit}`, verdict: admission.servable ? 'CLEAN' : 'REFUSED', note: `coverage ${(admission.coverage ?? []).map((c: { id: string; grade: string }) => `${c.id}: ${c.grade}`).join(', ')}` });
      const engine = policyEngine(px, px.compileToTriple(doc).plan);
      const tv = validatePolicy({ scope, policies: ps }, refFacts, engine);
      if (tv.mismatch) {
        r.diagnostics.push({ ...diag('PL2501', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, `the lowered policies of scope ${scope} disagree with PS8: ${tv.detail} (addressed to the toolchain, not the author)`), witness: { id: '', length: tv.mismatch.length, trace: tv.mismatch } });
      }
      if (tv.capHit) r.diagnostics.push(diag('PL3901', { module: module.name, node: ps[0].id }, `translation validation of scope ${scope} stopped at its bound (${tv.pairs} state pairs)`));
      r.stages.push({ stage: 'policy-tv', status: 'ran', engine: `poly-ref, polyaxion@${peer.commit}`, verdict: tv.mismatch ? 'REFUSED' : tv.capHit ? 'INCONCLUSIVE' : 'CLEAN', note: `${tv.rows} proposals over ${tv.pairs} state pairs agree` });
    }

    // never: poly-ref alone, over the decision table.
    const nev = checkNever({ scope, policies: ps }, refFacts, (node) => ({ module: module.name, node }));
    for (const f of nev.findings) r.diagnostics.push(f);
    for (const v of nev.vacuous) r.vacuous.push({ property: v.property, reason: 'vacuous', antecedent: v.text });
    for (const p of nev.runtimeOnly) r.notRun.push({ property: p, reason: 'runtime-only: it reads a value with no finite domain (S149)' });
    if (nev.capHit) r.diagnostics.push(diag('PL3901', { module: module.name, node: ps[0].id }, `the decision table of scope ${scope} stopped at its bound`));
    const hasNever = ps.some((p) => p.items.some((i) => i.kind === 'Never'));
    r.stages.push(hasNever
      ? { stage: 'never', status: 'ran', engine: 'poly-ref', verdict: nev.findings.length ? 'FINDINGS' : nev.capHit ? 'INCONCLUSIVE' : 'CLEAN', note: `${nev.rows} proposals over ${nev.states} policy states` }
      : { stage: 'never', status: 'ran', engine: 'poly-ref', verdict: 'CLEAN', note: 'no never statement' });
  }
  return out;
}
