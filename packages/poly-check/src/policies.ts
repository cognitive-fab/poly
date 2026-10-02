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
import { checkPolicies, policyProgram, diag, type Diagnostic, type Module, type Policy, type Verdict, type WitnessStep } from '@poly/core';
import { lowerPolicyScope, type PolicyDoc } from '@poly/lower';
import { policyFacts, checkNever, validatePolicy, proposalTable, evalPolicyExpr, initialSigma, dischargeCheck, type PolicyFacts } from '@poly/ref';

export type PolicyStage = 'policy-types' | 'policy-lower' | 'policy-admission' | 'consistency' | 'regions' | 'policy-tv' | 'never';

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

/** PT8.4, S161: the fixed map from a program's effect labels to polycheck's flags (PT8.4's table). */
export const REGION_FLAGS: Record<string, string> = {
  'read:web': 'untrusted', 'read:store': 'untrusted', 'read:private': 'sensitive', 'read:repo': 'proprietary',
  'egress:external': 'egress', 'egress:public': 'egress',
};

const scopeGoverns = (scope: string, module: string) => {
  if (!scope.includes('*')) return scope === module;
  const re = new RegExp('^' + scope.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
  return re.test(module);
};

/** The effect kinds a scope's policies name, which polycheck counts as gated (S161). */
function mentionedKinds(ps: Policy[]): Set<string> {
  const out = new Set<string>();
  const isKind = (e: any) => e?.kind === 'Member' && e.prop === 'kind' && e.object?.kind === 'Name' && e.object.name === 'effect';
  const walk = (e: any): void => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'Binary' && (e.op === '==' || e.op === '!=')) for (const [a, b] of [[e.left, e.right], [e.right, e.left]]) if (isKind(a) && b?.kind === 'String') out.add(b.value);
    if (e.kind === 'In' && isKind(e.expr)) for (const x of e.set) if (x.kind === 'String') out.add(x.value);
    for (const v of Object.values(e)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
  };
  for (const p of ps) for (const it of p.items) walk(it);
  return out;
}

/**
 * PT8.4, S161: polycheck over the scope: each effect of a governed module is an action with the flags its labels map
 * to, gated when a policy of the scope names its kind. A region reached with no gate crossed is PL7001 with the
 * path. A region no effect of the program can provide is unreachable: the program's effects are its whole
 * capability surface (its handlers are certified, PT6.5), so that is noted, not left inconclusive.
 */
export function regionCheck(scope: string, ps: Policy[], program: Module[], modelCheck: (m: any) => any, regions: { name: string; kind: string; requires: string[] }[]): { findings: { region: string; message: string; trace: WitnessStep[] }[]; notes: string[] } {
  const gated = mentionedKinds(ps);
  const actions: any[] = [];
  for (const m of program) {
    if (!scopeGoverns(scope, m.name)) continue;
    for (const d of m.decls) {
      if (d.kind !== 'Machine') continue;
      for (const it of d.items) {
        // A decision is an effect of kind decision.<d> with its labels (PD1.7).
        if (it.kind !== 'EffectDecl' && it.kind !== 'Decision') continue;
        const kind = it.kind === 'Decision' ? `decision.${it.name}` : (it.items.find((x) => x.kind === 'EffKind') as { value: string } | undefined)?.value ?? it.name;
        const flags = [...new Set(it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])).map((l) => REGION_FLAGS[l]).filter(Boolean))];
        actions.push({ tool: kind, specifier: null, effects: flags, gateKind: gated.has(kind) ? 'ask' : null, source: `${m.name}.${d.name}`, tag: null });
      }
    }
  }
  const res = modelCheck({ actions, regions });
  const findings: { region: string; message: string; trace: WitnessStep[] }[] = [];
  const notes: string[] = [];
  for (const x of res.results) {
    const name = x.region.name;
    if (x.status === 'BYPASS' || x.status === 'SHELL-EQUIVALENT' || x.status === 'INCONCLUSIVE') {
      const trace: WitnessStep[] = (x.witness ?? []).map((s: any) => ({ pre: null, action: s.action.tool, data: { adds: s.added }, post: { held: s.held } }));
      findings.push({ region: name, trace, message: `region ${name} (${x.region.requires.join(' + ')}) is reached with no gate crossed: ${trace.map((s) => s.action).join(' → ')}; a policy of scope ${scope} that names ${x.fix?.actions?.join(' or ') ?? 'one of these effects'} would gate it (PT8.4, S161)` });
    } else if (x.status === 'VACUOUS') notes.push(`${name}: unreachable, no effect provides ${x.missingEffects.join(', ')}`);
    else notes.push(`${name}: ${x.mediated ? 'every path crosses a gate' : 'unreachable'}`);
  }
  return { findings, notes };
}

/**
 * PT8.4: Polyaxion's exploration (its checks, harden, and the m2 discharge check) draws its actions from a policy's
 * examples, and its own sampler does not reach the reserved fields of a runtime proposal. So each lowered obligation
 * is given, as examples, every proposal of the decision table, one step each from the initial state, allowed or
 * refused as PS8 says of that obligation alone. Admission then also requires the engine to agree with each.
 */
export function withExamples(doc: PolicyDoc, scope: { scope: string; policies: Policy[] }, facts: PolicyFacts, max = 400): void {
  const rows = proposalTable(scope, facts).rows.slice(0, max);
  const t3 = (v: unknown) => (v === true ? true : v === false ? false : null);
  const sigma = initialSigma(scope);
  const vars: Record<string, any> = {};
  for (const p of scope.policies) for (const v of p.vars) vars[v.name] = (v.init as { value: unknown }).value;
  const action = (row: Record<string, unknown>) => ({ kind: row.proposal === 'send' ? 'custom.poly.send' : 'custom.poly.effect', ...row });
  for (const o of doc.obligations) {
    const src = (o as { source?: { policy: string; obligation: string; unknown?: boolean } }).source;
    const p = scope.policies.find((x) => x.name === src?.policy);
    const it = p?.items.find((x) => x.name === src?.obligation);
    if (!it || (it.kind !== 'RuleObligation' && it.kind !== 'MachineObligation')) continue;
    const allow: unknown[][] = [];
    const deny: unknown[][] = [];
    for (const row of rows) {
      let refused = false;
      if (it.kind === 'RuleObligation') {
        const w = it.when ? t3(evalPolicyExpr(it.when, row, vars)) : true;
        const u = it.onUnknown ?? (it.severity === 'warn' ? 'warn' : 'escalate');
        if (src?.unknown) refused = w === null && u !== 'warn' && u !== 'skip';
        else refused = w === true && t3(evalPolicyExpr(it.require, row, vars)) !== true && it.severity !== 'warn';
      } else {
        const id = `${p!.name}.${it.name}`;
        refused = it.guards.some((g) => g.in.includes(sigma[id]) && t3(evalPolicyExpr(g.when, row, vars)) !== false);
      }
      (refused ? deny : allow).push([action(row)]);
    }
    (o as { examples?: unknown }).examples = { allow, deny };
  }
}

type Discharge = (set: string[], mandate: string) => { trap: { sigma: unknown; path: WitnessStep[] } | null; capHit: boolean };
type Mandates = { findings: { mandate: string; node: string; line?: number; message: string; path: WitnessStep[] }[]; mandates: number; checks: number; bounded: string[] };

/**
 * PT8.5, PS8.6, S148: each mandate (a machine obligation with end states) that cannot be discharged under the
 * obligations together, with a minimal conflicting subset: obligations are tried for removal in declaration order, and
 * one is dropped when the mandate stays undischargeable without it. Minimal, not the smallest; the number of discharge
 * checks it took is reported. `discharge` is poly-ref's PS8.6 check over a subset (review B3, B9: the policy
 * machines explored together, an escalation not a deny). A check that hit its bound concludes nothing: the mandate
 * is listed under `bounded` (review B11).
 */
export function mandates(policies: Policy[], discharge: Discharge): Mandates {
  let checks = 0;
  const units = policies.flatMap((p) => p.items.filter((i) => i.kind !== 'Never' && i.kind !== 'Recalled').map((i) => ({ id: `${p.name}.${i.name}`, node: i.id, line: i.span?.line, kind: i.kind })));
  const findings: Mandates['findings'] = [];
  const bounded: string[] = [];
  const machines = units.filter((u) => u.kind === 'MachineObligation');
  for (const m of machines) {
    const all = units.map((u) => u.id);
    checks++;
    const first = discharge(all, m.id);
    if (first.capHit) { bounded.push(m.id); continue; }
    if (!first.trap) continue;
    let rest = all.filter((u) => u !== m.id);
    for (const u of [...rest]) {
      checks++;
      const r = discharge([m.id, ...rest.filter((x) => x !== u)], m.id);
      if (r.trap && !r.capHit) rest = rest.filter((x) => x !== u);
    }
    const subset = [m.id, ...rest];
    findings.push({ mandate: m.id, node: m.node, line: m.line, path: first.trap.path, message: `mandate ${m.id} cannot be discharged under the obligations ${subset.join(', ')}: from ${JSON.stringify(first.trap.sigma)} no allowed or approved proposal leads to its end states (PS8.6; the subset is minimal by deletion in declaration order, not the smallest; ${checks} discharge check(s))` });
  }
  return { findings, mandates: machines.length, checks, bounded };
}

/** The scope with only the obligations named in `set` (the policies' vars kept). */
const subsetOf = (scope: string, policies: Policy[], set: string[]) => ({ scope, policies: policies.map((p) => ({ ...p, items: p.items.filter((i) => set.includes(`${p.name}.${i.name}`)) })) });

/**
 * PD4.4a, PD4.4b, S148: consistency per mode. A mode is an enum field of a service machine (a singleton) the scope's
 * policies read. For each value (each combination, when they read several), the mandates are checked over the
 * proposals made in that mode; a finding names the mode. A mandate undischargeable in every mode is reported once,
 * without one.
 */
export function mandatesPerMode(scope: string, policies: Policy[], facts: PolicyFacts): Mandates {
  const reads = new Map<string, Set<string>>();
  const walk = (e: any): void => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'Member' && e.object?.kind === 'Call' && e.object.callee === 'machine') {
      const m = e.object.args[0]?.value as string;
      const target = facts.machines.get(m);
      const f = target?.fields.get(e.prop);
      if (target?.service && f?.values && f.values.every((v) => typeof v === 'string')) { if (!reads.has(m)) reads.set(m, new Set()); reads.get(m)!.add(e.prop); }
    }
    for (const v of Object.values(e)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
  };
  for (const p of policies) for (const it of p.items) walk(it);
  const check = (keep?: (row: Record<string, any>) => boolean): Discharge => (set, mandate) => dischargeCheck(subsetOf(scope, policies, set), facts, mandate, keep ? { keep } : {});
  const modes = [...reads].flatMap(([m, fs]) => [...fs].map((f) => ({ machine: m, field: f, values: facts.machines.get(m)!.fields.get(f)!.values as string[] })));
  if (!modes.length) return mandates(policies, check());
  const combos = modes.reduce<Record<string, string>[]>((acc, md) => acc.flatMap((a) => md.values.map((v) => ({ ...a, [`${md.machine}.${md.field}`]: v }))), [{}]);
  const per = combos.map((combo) => {
    const keep = (row: Record<string, any>) => Object.entries(combo).every(([k, v]) => { const i = k.lastIndexOf('.'); const got = row.machines?.[k.slice(0, i)]?.[k.slice(i + 1)]; return got === undefined || got === null || got === v; });
    return { combo, r: mandates(policies, check(keep)) };
  });
  const findings: Mandates['findings'] = [];
  const name = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k} == ${v}`).join(', ');
  const ids = new Set(per.flatMap((p) => p.r.findings.map((f) => f.mandate)));
  for (const id of ids) {
    const hits = per.filter((p) => p.r.findings.some((f) => f.mandate === id));
    if (hits.length === per.length) { const f = hits[0].r.findings.find((x) => x.mandate === id)!; findings.push({ ...f, message: `${f.message}; in every mode` }); continue; }
    for (const h of hits) { const f = h.r.findings.find((x) => x.mandate === id)!; findings.push({ ...f, message: `in mode ${name(h.combo)}: ${f.message} (PD4.4b)` }); }
  }
  return { findings, mandates: per[0]?.r.mandates ?? 0, checks: per.reduce((n, p) => n + p.r.checks, 0), bounded: [...new Set(per.flatMap((p) => p.r.bounded))] };
}

/** The policies of `module`, checked against `program` (the project's modules), one report per scope. */
export async function policyReports(module: Module, program: Module[], root: string): Promise<PolicyReport[]> {
  const policies = module.decls.filter((d): d is Policy => d.kind === 'Policy');
  if (!policies.length) return [];
  const facts = policyProgram(program);
  const typed = checkPolicies(module, facts);
  const scopes = new Map<string, Policy[]>();
  for (const p of policies) { if (!scopes.has(p.scope)) scopes.set(p.scope, []); scopes.get(p.scope)!.push(p); }
  const { polyaxionPeer, polycheckPeer, loadPolyaxion, loadPolycheck, policyEngine } = await import('@poly/runtime');
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
      for (const s of ['policy-lower', 'policy-admission', 'consistency', 'regions', 'policy-tv', 'never'] as PolicyStage[]) r.stages.push({ stage: s, status: 'not-run', engine: '', reason: 'the policies were refused at policy-types' });
      continue;
    }
    // policy-lower: one document per scope, written where admission certifies it.
    const lowered = lowerPolicyScope(scope, ps, 'sha256:' + createHash('sha256').update(JSON.stringify(ps)).digest('hex').slice(0, 16));
    withExamples(lowered, { scope, policies: ps }, refFacts);
    const text = JSON.stringify(lowered, null, 2) + '\n';
    const rel = `.poly/build/policies/${policySlug(scope)}.policy.json`;
    mkdirSync(join(root, '.poly', 'build', 'policies'), { recursive: true });
    writeFileSync(join(root, rel), text);
    r.artefact = { path: rel, digest: 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex') };
    const doc = JSON.parse(text) as PolicyDoc;
    r.stages.push({ stage: 'policy-lower', status: 'ran', engine: '@poly/lower', verdict: 'CLEAN', note: `${doc.obligations.length} obligation(s) in ${rel}` });

    // Stage 5b (PT8.5, PS8.6, S148): an undischargeable mandate is PL6501 with its minimal conflicting subset, by
    // poly-ref's check over the policy machines together (review B3, B4, B9); a bounded check is not clean (B11).
    const consistency = mandatesPerMode(scope, ps, refFacts);
    for (const m of consistency.findings) r.diagnostics.push({ ...diag('PL6501', { module: module.name, node: m.node, line: m.line }, m.message), property: m.mandate, witness: { id: '', length: m.path.length, trace: m.path } });
    for (const m of consistency.bounded) r.notRun.push({ property: m, reason: 'the discharge check stopped at its bound (PS8.6)' });
    r.stages.push({ stage: 'consistency', status: 'ran', engine: 'poly-ref', verdict: consistency.findings.length ? 'FINDINGS' : consistency.bounded.length ? 'INCONCLUSIVE' : 'CLEAN', note: `${consistency.mandates} mandate(s); ${consistency.checks} discharge check(s)` });

    // policy-admission and policy-tv need the engine.
    const peer = polyaxionPeer();
    if (!peer.ok) {
      r.stages.push({ stage: 'policy-admission', status: 'not-run', engine: '', reason: peer.reason });
      r.stages.push({ stage: 'policy-tv', status: 'not-run', engine: '', reason: peer.reason });
    } else {
      const px = await loadPolyaxion();
      const admission = await px.admitPolicy(doc, {});
      const errors = (admission.findings ?? []).filter((f: { level: string; message: string }) => f.level === 'error' && !/not lawfully dischargeable \(m2\)/.test(f.message));
      for (const f of errors) r.diagnostics.push(diag('PL6001', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, `Polyaxion refuses the policies of scope ${scope} at admission: ${f.obligation ? `${f.obligation}: ` : ''}${f.message} (PT8.4)`));
      if (!admission.servable && !errors.length && !consistency.findings.length) {
        // Review B9: the engine's own m2 check explores one machine at a time and counts an escalation as a deny, so
        // it can refuse a scope PS8.6 finds dischargeable; the gate cannot serve it either way, so it stays PL6001.
        const m2 = (admission.findings ?? []).filter((f: { message: string }) => /not lawfully dischargeable \(m2\)/.test(f.message));
        r.diagnostics.push(diag('PL6001', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, m2.length
          ? `Polyaxion does not serve the policies of scope ${scope}: its m2 check finds ${m2.map((f: { obligation?: string }) => f.obligation ?? 'a mandate').join(', ')} not lawfully dischargeable, which PS8.6 finds dischargeable (the engine counts an escalation as a deny on the way; engine change E8) (PT8.4)`
          : `Polyaxion does not serve the policies of scope ${scope}: ${admission.refused?.message ?? 'not servable'} (PT8.4)`));
      }
      r.stages.push({ stage: 'policy-admission', status: 'ran', engine: `polyaxion@${peer.commit}`, verdict: errors.length ? 'REFUSED' : 'CLEAN', note: `coverage ${(admission.coverage ?? []).map((c: { id: string; grade: string }) => `${c.id}: ${c.grade}`).join(', ')}` });
      const engine = policyEngine(px, px.compileToTriple(doc).plan);
      const tv = validatePolicy({ scope, policies: ps }, refFacts, engine);
      if (tv.mismatch) {
        r.diagnostics.push({ ...diag('PL2501', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, `the lowered policies of scope ${scope} disagree with PS8: ${tv.detail} (addressed to the toolchain, not the author)`), witness: { id: '', length: tv.mismatch.length, trace: tv.mismatch } });
      }
      if (tv.capHit) r.diagnostics.push(diag('PL3901', { module: module.name, node: ps[0].id }, `translation validation of scope ${scope} stopped at its bound (${tv.pairs} state pairs)`));
      r.stages.push({ stage: 'policy-tv', status: 'ran', engine: `poly-ref, polyaxion@${peer.commit}`, verdict: tv.mismatch ? 'REFUSED' : tv.capHit ? 'INCONCLUSIVE' : 'CLEAN', note: `${tv.rows} proposals over ${tv.pairs} state pairs agree` });
    }

    // Stage 5a (PT8.4, S161): polycheck's default regions over the effects of the modules the scope governs.
    const pc = polycheckPeer();
    if (!pc.ok) r.stages.push({ stage: 'regions', status: 'not-run', engine: '', reason: pc.reason });
    else {
      const { modelCheck, regions } = await loadPolycheck();
      const reg = regionCheck(scope, ps, program, modelCheck, regions);
      for (const f of reg.findings) r.diagnostics.push({ ...diag('PL7001', { module: module.name, node: ps[0].id, line: ps[0].span?.line }, f.message), property: f.region, witness: { id: '', length: f.trace.length, trace: f.trace } });
      r.stages.push({ stage: 'regions', status: 'ran', engine: `polycheck@${pc.commit}`, verdict: reg.findings.length ? 'FINDINGS' : 'CLEAN', note: reg.notes.join('; ') });
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
