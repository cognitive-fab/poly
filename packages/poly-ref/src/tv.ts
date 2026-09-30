// Translation validation (PS9.2, PS9.3).
//
// The lowering is correct for M on I iff R_L and R_M agree on every (s, a, d)
// with s in Reach(I) and d in D(a): the same verdict kind, the same reason
// and the same next state, compared through α; and the lowered property
// modules agree with PS5 on every reachable state and transition. poly-ref
// drives the lowered module itself, through the SAM v2 surface it exports,
// and computes R_M with its own interpreter. Any difference is PL2501
// LOWERING_MISMATCH, addressed to the toolchain; the verdict is REFUSED.
import type { Diagnostic, Module, WitnessStep } from '@poly/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkMachine, ENGINE, type MachineReport } from './check.js';
import { loadLoweredModule } from './load.js';
import { pathTo, type Edge } from './explore.js';
import { evaluate, type Verdict } from './eval.js';
import { alpha, flatten, flattenData } from './alpha.js';
import { keyOf, stateKey, statePlain, toPlain, type State } from './values.js';
import type { RMachine } from './model.js';

interface SamModule {
  instance: (o: object) => { lastStep: () => { intent?: string; classification: string; rejections: { reason?: string }[] } };
  init: () => void;
  setState: (s: object) => void;
  getState: () => Record<string, unknown>;
  actions: Record<string, (d: object) => unknown>;
}

interface PropertyModule {
  stateInvariants?: { name: string; pred: (s: object) => boolean }[];
  transitionInvariants?: { name: string; pred: (pre: object, a: string, d: object, post: object, v: object) => boolean }[];
  rejectionInvariants?: { name: string; pred: (s: object, a: string, d: object, v: object) => boolean }[];
}

export interface TvResult {
  machine: string;
  /** Transitions compared: every (s, a, d) of Reach(I) × D(a). */
  transitions: number;
  /** State and transition property evaluations compared. */
  propertyChecks: number;
  mismatches: Diagnostic[];
  report: MachineReport;
}

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
};

/** What the runtime reads from contract.json to answer an action before the module (PS9.1a). */
interface RuntimeFacts { terminalKey: string; terminalStates: unknown[] }

/** Runs one step of the lowered module and reads its verdict (PS9.1). */
function stepModule(mod: SamModule, rt: RuntimeFacts, pre: Record<string, unknown>, action: string, data: Record<string, unknown>): { verdict: Verdict; post: Record<string, unknown> } | { error: string } {
  // S35: an action outside the module's action surface never reaches the module. The runtime answers it
  // as polyrun does: rejected("terminal") in a terminal state (row 1), unhandled elsewhere (row 3).
  if (typeof mod.actions[action] !== 'function') {
    const verdict: Verdict = rt.terminalStates.includes(pre[rt.terminalKey]) ? { kind: 'rejected', reason: 'terminal' } : { kind: 'unhandled' };
    return { verdict, post: structuredClone(pre) };
  }
  try {
    mod.init();
    mod.setState(structuredClone(pre));
    mod.actions[action](structuredClone(data));
    const step = mod.instance({}).lastStep();
    if (step.intent !== undefined && step.intent !== action) return { error: `lastStep() reports ${String(step.intent)}, not ${action}` };
    const post = mod.getState();
    switch (step.classification) {
      case 'rejected': return { verdict: { kind: 'rejected', reason: step.rejections[0]?.reason }, post };
      case 'unhandled': return { verdict: { kind: 'unhandled' }, post };
      case 'mutated':
      case 'identity-by-mutation':
      case 'unchanged': return { verdict: { kind: 'accepted' }, post }; // sam-pattern 2.3: framed, no write (M1-1)
      default: return { error: `unknown classification ${step.classification}` };
    }
  } catch (e) {
    const err = e as Error;
    return { error: `${err.name}: ${err.message}` };
  }
}

const verdictText = (v: Verdict) => (v.kind === 'rejected' ? `rejected(${v.reason})` : v.kind);

export async function translationValidate(module: Module, machineName: string, buildDir: string, opts: { maxStates?: number } = {}): Promise<TvResult> {
  const report = checkMachine(module, machineName, opts);
  const { graph: g, model: M } = report;
  // Finding 5: sam-pattern resolves from poly's own install, wherever the build directory is.
  const mod = loadLoweredModule<SamModule>(join(buildDir, 'next.cjs'));
  const contract = JSON.parse(readFileSync(join(buildDir, 'contract.json'), 'utf8')) as { stateKeys: { name: string }[]; terminalKey?: string; terminalStates?: unknown[] };
  const rt: RuntimeFacts = { terminalKey: contract.terminalKey ?? contract.stateKeys[0].name, terminalStates: contract.terminalStates ?? [] };
  const props = (await import(pathToFileURL(join(buildDir, 'invariants.mjs')).href + `?v=${Date.now()}-${Math.random()}`)) as PropertyModule;

  const mismatches: Diagnostic[] = [];
  const trace = (edges: Edge<State>[]): WitnessStep[] => edges.map((e) => ({
    pre: statePlain(g.states[e.from]),
    action: e.label.action,
    data: Object.fromEntries(Object.entries(e.label.data).map(([k, v]) => [k, toPlain(v)])),
    post: statePlain(e.outcome.state),
    verdict: verdictText(e.label.verdict),
  }));
  const mismatch = (message: string, path: Edge<State>[]) => {
    mismatches.push({
      code: 'PL2501', name: 'LOWERING_MISMATCH', severity: 'error', stage: 'translation-validation', engine: ENGINE,
      at: { module: module.name, machine: M.name }, message: `${message} (addressed to the toolchain, not the author)`,
      witness: { id: '', length: path.length, trace: trace(path) },
    });
  };

  // Transitions (PS9.2): every edge of the explored graph is one (s, a, d).
  let transitions = 0;
  for (const e of g.edges) {
    transitions++;
    const s = g.states[e.from];
    const flatPre = flatten(s, M);
    const flatData = flattenData(e.label.data, e.label.action, M);
    const got = stepModule(mod, rt, flatPre, e.label.action, flatData);
    const where = [...pathTo(g, e.from), e];
    const what = `${e.label.action}(${stable(flatData)}) from ${stateKey(s, M.fieldNames)}`;
    if ('error' in got) { mismatch(`the lowered module threw on ${what}: ${got.error}; R_M gives ${verdictText(e.label.verdict)}`, where); continue; }
    const want = e.label.verdict;
    if (got.verdict.kind !== want.kind || (want.kind === 'rejected' && got.verdict.reason !== want.reason)) {
      mismatch(`${what}: the lowered module gives ${verdictText(got.verdict)}, R_M gives ${verdictText(want)}`, where);
      continue;
    }
    const expected = e.outcome.state;
    if (keyOf(alphaKey(alpha(got.post, M), M)) !== keyOf(alphaKey(expected, M))) {
      mismatch(`${what}: next states differ through α: lowered ${stable(got.post)}, R_M ${stable(flatten(expected, M))}`, where);
      continue;
    }
    if (stable(project(got.post, flatPre)) !== stable(flatten(expected, M))) {
      mismatch(`${what}: the flat next state differs where α cannot see it: lowered ${stable(got.post)}, expected ${stable(flatten(expected, M))}`, where);
    }
  }

  // Property modules (PS9.2, last sentence). Every property must be present: the declared ones, and the
  // automatic ones PT3.5, PS9.1b and PS4.2a require. A missing or throwing predicate is a mismatch in
  // itself, never read as false, so a dropped property cannot hide where PS5 is also false.
  let propertyChecks = 0;
  const declaredInv = new Map(M.invariants.map((p) => [p.name, p]));
  const lowState = new Map((props.stateInvariants ?? []).map((x) => [x.name, x]));
  const lowStep = new Map((props.transitionInvariants ?? []).map((x) => [x.name, x]));
  const lowRej = new Map((props.rejectionInvariants ?? []).map((x) => [x.name, x]));
  for (const name of [...declaredInv.keys(), ...automaticInvariants(M)]) {
    if (!lowState.has(name)) mismatch(`state invariant ${name} is missing from the lowered property module`, []);
  }
  for (const p of M.stepProperties) if (!lowStep.has(p.name)) mismatch(`step property ${p.name} is missing from the lowered property module`, []);
  for (const p of M.rejectProperties) if (!lowRej.has(p.name)) mismatch(`reject property ${p.name} is missing from the lowered property module`, []);
  const call = (f: () => boolean): boolean | string => {
    try { return f() === true; } catch (err) { return `threw ${(err as Error).message}`; }
  };
  for (const [i, s] of g.states.entries()) {
    const flat = flatten(s, M);
    for (const inv of props.stateInvariants ?? []) {
      propertyChecks++;
      const got = call(() => inv.pred(flat));
      const p = declaredInv.get(inv.name);
      const want = p ? evaluate(p.expr, { M, state: s, data: {}, locals: new Map() }) === true : true;
      if (got !== want) mismatch(`state invariant ${inv.name} is ${got} in the lowered module and ${want} by PS5.1 in ${stateKey(s, M.fieldNames)}`, pathTo(g, i));
    }
  }
  for (const e of g.edges) {
    const s = g.states[e.from];
    const post = e.outcome.state;
    const flatPre = flatten(s, M);
    const flatPost = flatten(post, M);
    const flatData = flattenData(e.label.data, e.label.action, M);
    const v = e.label.verdict.kind === 'rejected' ? { rejected: true, reason: e.label.verdict.reason } : { rejected: false, reason: null };
    for (const p of M.stepProperties) {
      const lowered = lowStep.get(p.name);
      if (!lowered) continue; // reported missing above
      propertyChecks++;
      const want = e.label.verdict.kind !== 'accepted' || evaluate(p.expr, { M, state: s, data: e.label.data, locals: new Map(), pre: s, post, action: e.label.action }) === true;
      const got = call(() => lowered.pred(flatPre, e.label.action, flatData, flatPost, v));
      if (got !== want) mismatch(`step property ${p.name} is ${got} in the lowered module and ${want} by PS5.2`, [...pathTo(g, e.from), e]);
    }
    for (const p of M.rejectProperties) {
      const lowered = lowRej.get(p.name);
      if (!lowered) continue; // reported missing above
      propertyChecks++;
      const want = evaluate(p.expr, { M, state: s, data: e.label.data, locals: new Map(), pre: s, action: e.label.action, verdict: e.label.verdict }) === true;
      const got = call(() => lowered.pred(flatPre, e.label.action, flatData, v));
      if (got !== want) mismatch(`reject property ${p.name} is ${got} in the lowered module and ${want} by PS5.3`, [...pathTo(g, e.from), e]);
    }
  }
  return { machine: M.name, transitions, propertyChecks, mismatches, report };
}

/**
 * The automatic invariants a lowered property module must carry, named as the specification names them:
 * domain:<f> for a range field or a map of ranges (PT3.5), shape:<f> for a union with payloads and
 * domain:<f>_<p> for each range payload (PS9.1b), bound:<f> for a field with a check domain (PS4.2a).
 */
export function automaticInvariants(M: RMachine): string[] {
  const out: string[] = [];
  for (const f of M.fields) {
    const t = f.type;
    if (t.k === 'int' && Number.isFinite(t.lo)) out.push(`domain:${f.name}`);
    if (t.k === 'map' && t.value.k === 'int' && Number.isFinite(t.value.lo)) out.push(`domain:${f.name}`);
    if (t.k === 'union') {
      const u = M.unions.get(t.name)!;
      const seen = new Set<string>();
      if (u.ctors.some((c) => c.fields.length)) out.push(`shape:${f.name}`);
      for (const c of u.ctors) {
        for (const pf of c.fields) {
          if (seen.has(pf.name)) continue;
          seen.add(pf.name);
          if (pf.type.k === 'int' && Number.isFinite(pf.type.lo)) out.push(`domain:${f.name}_${pf.name}`);
        }
      }
    }
    if (f.check) out.push(`bound:${f.name}`);
  }
  return out;
}

/** The flat keys the expected state has: the module may keep keys α ignores, which `shape:` covers. */
function project(flat: Record<string, unknown>, like: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(like).map((k) => [k, flat[k]]));
}

function alphaKey(s: State, M: import('./model.js').RMachine): import('./values.js').Value {
  return { ctor: '', payload: Object.fromEntries(M.fieldNames.map((f) => [f, s[f]])) };
}
