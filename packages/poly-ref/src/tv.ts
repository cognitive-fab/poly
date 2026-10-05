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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importArtefact } from './import-artefact.js';
import { checkMachine, ENGINE, type MachineReport } from './check.js';
import { loadLoweredModule } from './load.js';
import { pathTo, type Edge } from './explore.js';
import { evaluate, type Verdict } from './eval.js';
import { alpha, alphaData, flatten, flattenData } from './alpha.js';
import { keyOf, stateKey, statePlain, toPlain, type State, type Value } from './values.js';
import type { Intent } from './step.js';
import { dataDomain, detachedAlone, type RMachine } from './model.js';
import { isTerminal, transition, carriesContent } from './step.js';
import { readBack } from './artefacts.js';

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

export async function translationValidate(module: Module, machineName: string, buildDir: string, opts: { maxStates?: number; principals?: number; isolation?: 'openshell'; program?: Module[] } = {}): Promise<TvResult> {
  const report = checkMachine(module, machineName, opts);
  const { graph: g, model: M } = report;
  // Finding 5: sam-pattern resolves from poly's own install, wherever the build directory is.
  const mod = loadLoweredModule<SamModule>(join(buildDir, 'next.cjs'));
  const contract = JSON.parse(readFileSync(join(buildDir, 'contract.json'), 'utf8')) as { stateKeys: { name: string }[]; terminalKey?: string; terminalStates?: unknown[] };
  const rt: RuntimeFacts = { terminalKey: contract.terminalKey ?? contract.stateKeys[0].name, terminalStates: contract.terminalStates ?? [] };
  // A machine with no effect declarations has no mapper; its R_M emits nothing, which the comparison checks.
  const mapperPath = join(buildDir, 'effects.cjs');
  const mapper = existsSync(mapperPath) ? loadLoweredModule<{ effects: (pre: object, a: string, d: object, post: object, k: string) => unknown }>(mapperPath).effects : null;
  const props = (await importArtefact(join(buildDir, 'invariants.mjs'))) as PropertyModule;

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
    // S78: the kernel resolves a detached child's marker at commit, and the comparison is after resolution. The
    // mapper reads the post-state as the acceptor wrote it, before the commit.
    const raw = got.post;
    // Only the children this step creates are resolved: a marker written by any other step stays a marker, as
    // the kernel leaves it, and the comparison sees it (review C6).
    const created = new Set(e.label.effects.filter((x) => x.type === 'create').map((x) => (x as { key: string }).key));
    got.post = resolveChildren(raw, M, created) as Record<string, unknown>;
    const want = e.label.verdict;
    if (got.verdict.kind !== want.kind || (want.kind === 'rejected' && got.verdict.reason !== want.reason)) {
      mismatch(`${what}: the lowered module gives ${verdictText(got.verdict)}, R_M gives ${verdictText(want)}`, where);
      continue;
    }
    const expected = e.outcome.state;
    // A lowered state α cannot read (an unresolved child marker, say) is a mismatch, not a crash (review C6).
    let seen: string;
    try { seen = keyOf(alphaKey(alpha(got.post, M), M)); } catch { seen = `unreadable ${stable(got.post)}`; }
    if (seen !== keyOf(alphaKey(expected, M))) {
      mismatch(`${what}: next states differ through α: lowered ${stable(got.post)}, R_M ${stable(flatten(expected, M))}`, where);
      continue;
    }
    if (stable(project(got.post, flatPre)) !== stable(flatten(expected, M))) {
      mismatch(`${what}: the flat next state differs where α cannot see it: lowered ${stable(got.post)}, expected ${stable(flatten(expected, M))}`, where);
      continue;
    }
    // The intent sequence (PS9.2, decisions-m1.md): the kernel calls the mapper on accepted steps only, so
    // R_L's E is the mapper's output there and empty elsewhere, as R_M's is by PS3.2.
    if (want.kind !== 'accepted') continue;
    const wantE = e.label.effects.flatMap(loweredIntents);
    let gotE: unknown;
    try {
      gotE = resolveChildren(mapper ? mapper(structuredClone(flatPre), e.label.action, structuredClone(flatData), structuredClone(raw), 'accepted') : [], M, created);
    } catch (err) {
      mismatch(`${what}: the effects mapper threw: ${(err as Error).message}; R_M emits ${stable(wantE)}`, where);
      continue;
    }
    if (stable(gotE) !== stable(wantE)) mismatch(`${what}: the lowered effects are ${stable(gotE)}, R_M emits ${stable(wantE)}`, where);
  }

  // PS3.2's claims row (PD5.1.2c, S101): the exploration offers only claims in their domains, so the row is compared
  // here, in every reachable state and for every action with claims, on claims that are missing, malformed, or have a
  // value outside a field's domain. R_M rejects each with claims-unverified, unless row 1 rejects it first.
  for (const a of M.actions.filter((x) => x.claims)) {
    const sample = dataDomain(a, M)[0];
    const good = flattenData(sample, a.name, M);
    const fields = a.claims!.type.k === 'record' ? M.records.get(a.claims!.type.name)!.fields : [];
    const bad: [string, Record<string, unknown>][] = [
      ['missing', Object.fromEntries(Object.entries(good).filter(([k]) => k !== '$claims'))],
      ['malformed', { ...good, $claims: 'not-claims' }],
      ...fields.map((f): [string, Record<string, unknown>] => [`${f.name} outside its domain`, { ...good, $claims: { ...(good.$claims as object), [f.name]: f.type.k === 'principal' ? '' : '__outside__' } }]),
      // Review A-F5: just past an integer range, a null or non-string principal, an enum name spelt otherwise.
      ...fields.flatMap((f): [string, Record<string, unknown>][] => {
        const withValue = (why: string, v: unknown): [string, Record<string, unknown>] => [why, { ...good, $claims: { ...(good.$claims as object), [f.name]: v } }];
        if (f.type.k === 'int') { const hi = f.type.hi; return [withValue(`${f.name} = hi + 1`, hi + 1), withValue(`${f.name} as a string`, String(hi))]; }
        if (f.type.k === 'principal') return [withValue(`${f.name}: null`, null), withValue(`${f.name}: 7`, 7)];
        if (f.type.k === 'union') { const c = M.unions.get(f.type.name)!.ctors[0].name; return [withValue(`${f.name} spelt otherwise`, c.toLowerCase() === c ? c.toUpperCase() : c.toLowerCase()), withValue(`${f.name} tagged`, { $: c })]; }
        return [];
      }),
      ['with an extra field', { ...good, $claims: { ...(good.$claims as object), extra: 1 } }],
    ];
    for (const [i, s] of g.states.entries()) {
      const flatPre = flatten(s, M);
      for (const [why, d] of bad) {
        // Each of these is not a value of the claims type, so R_M sees no claims: $claims is null after rows 1 and 2.
        const want = transition(M, s, a.name, { ...alphaData(good, a.name, M), $claims: null }).verdict;
        const got = stepModule(mod, rt, flatPre, a.name, d);
        const text = `${a.name} with claims ${why} from ${stateKey(s, M.fieldNames)}`;
        if ('error' in got) { mismatch(`the lowered module threw on ${text}: ${got.error}; R_M gives ${verdictText(want)}`, pathTo(g, i)); continue; }
        if (got.verdict.kind !== want.kind || (want.kind === 'rejected' && got.verdict.reason !== want.reason)) mismatch(`${text}: the lowered module gives ${verdictText(got.verdict)}, R_M gives ${verdictText(want)}`, pathTo(g, i));
        transitions++;
      }
    }
  }

  // PS3.2's content row (S180): check never offers a missing body, so the row is compared here, in every reachable state
  // and for every action whose data can carry a Content, on the runtime's mark of a missing body. R_M rejects it with
  // content-missing, unless an earlier row answers first. Actions with no handler are probed too (S180 ruling): R_M
  // answers them unhandled, and the runtime never calls the module for them (PS9.1a), so a row order that differs
  // between the two is seen here and nowhere else, since check never offers a missing body.
  for (const a of M.actions.filter((x) => carriesContent(x.params.map((p) => p.type)))) {
    // Review C-F3: the runtime marks a missing body only on a digest, never on none, so the probe's data names a body
    // in every Content parameter; with none there, a row that fires only on none would pass.
    const domain = dataDomain(a, M);
    const sample = domain.find((d) => a.params.every((p) => p.type.k !== 'content' || d[p.name] !== null)) ?? domain[0];
    const good = flattenData(sample, a.name, M);
    for (const [i, s] of g.states.entries()) {
      const want = transition(M, s, a.name, { ...alphaData(good, a.name, M), $content: 'missing' }).verdict;
      const got = stepModule(mod, rt, flatten(s, M), a.name, { ...good, $content: 'missing' });
      const text = `${a.name} with a missing body from ${stateKey(s, M.fieldNames)}`;
      if ('error' in got) { mismatch(`the lowered module threw on ${text}: ${got.error}; R_M gives ${verdictText(want)}`, pathTo(g, i)); continue; }
      if (got.verdict.kind !== want.kind || (want.kind === 'rejected' && got.verdict.reason !== want.reason)) mismatch(`${text}: the lowered module gives ${verdictText(got.verdict)}, R_M gives ${verdictText(want)}`, pathTo(g, i));
      transitions++;
    }
  }

  // The runtime applies row 1 from contract.json (PS9.1a), and the module keeps its own guard for polygraph (S6),
  // which hides a wrong list from the transitions above: a missing terminal state still keeps completions and
  // cancels from firing. So the list must agree with term on every reachable state (review finding R3).
  for (const [i, s] of g.states.entries()) {
    const listed = rt.terminalStates.includes(flatten(s, M)[rt.terminalKey]);
    if (listed !== isTerminal(M, s)) mismatch(`contract.json ${listed ? 'lists' : 'does not list'} the control value of ${stateKey(s, M.fieldNames)} as terminal, and term gives ${!listed} (PS1.3)`, pathTo(g, i));
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
      const want = e.label.verdict.kind !== 'accepted' || evaluate(p.expr, { M, state: s, data: e.label.data, locals: new Map(), pre: s, post, action: e.label.action, intents: e.label.effects }) === true;
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
  // The standing rule after the M1 review: the artefacts the engines read without running the module are read back.
  for (const message of await readBack(module, M, buildDir, g.states)) mismatch(message, []);
  // Review D-F1, S152: under isolation, a machine with effects must have its sandbox policy.
  if (opts.isolation === 'openshell' && M.effects.size && !existsSync(join(buildDir, 'openshell.policies.yaml'))) mismatch('openshell.policies.yaml is missing, and isolation is asked for (S152)', []);
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

const plainRecord = (r: Record<string, Value>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toPlain(v)]));

/** An ISO-8601 duration for polyrun's `fireIn`, from milliseconds: 1800000 is PT30M, 200 is PT0.2S. */
export function isoDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = (ms % 60_000) / 1000;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

/**
 * What the effects mapper must return for one intent of R_M's E. An effect is its kind and payload. A
 * timer set is a cancel then a set of its key, since the compiler cannot know whether the key is armed
 * (PT6.3, S26); a cancel is a cancel.
 */
function loweredIntents(x: Intent): unknown[] {
  if (x.type === 'effect') return [{ kind: x.kind, payload: plainRecord(x.payload) }];
  if (x.type === 'cancel') return [{ kind: 'cancelTimer', key: x.key }];
  // PT6.4, S43: absent wiring is left out of the intent, as polyrun reads it.
  if (x.type === 'spawn') {
    return [{
      kind: 'spawnChild', machineId: x.machineId, childKey: x.key,
      ...(x.create ? { creation: { action: x.create.action, data: plainRecord(x.create.data) } } : {}),
      ...(x.onComplete ? { onComplete: x.onComplete } : {}),
      ...(x.onParentTerminal ? { onParentTerminal: x.onParentTerminal } : {}),
    }];
  }
  // S60: createInstance carries no address; the kernel makes it <parent>/<k>.
  if (x.type === 'create') return [{ kind: 'createInstance', machineId: x.machineId, childKey: x.key, ...(x.create ? { creation: { action: x.create.action, data: plainRecord(x.create.data) } } : {}) }];
  if (x.type === 'signal') return [{ kind: 'signalChild', childKey: x.key, action: x.action, data: plainRecord(x.data) }];
  // PT7a, S58: an address is its string, none is null, and an argument written `self` is the kernel's marker.
  if (x.type === 'send') {
    const data = plainRecord(x.data);
    for (const k of x.selfArgs) data[k] = { $ref: 'self' };
    return [{ kind: 'sendTo', target: toPlain(x.target), action: x.action, data }];
  }
  return [{ kind: 'cancelTimer', key: x.key }, { kind: 'timer', key: x.key, fireIn: isoDuration(x.ms), action: x.action, data: plainRecord(x.data) }];
}

/** S78: every `{ $ref: "child", key }` marker replaced by the child's address, as the kernel does at commit. */
function resolveChildren(v: unknown, M: RMachine, created: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveChildren(x, M, created));
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (o.$ref === 'child' && typeof o.key === 'string' && created.has(o.key)) return detachedAlone(M, o.key);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveChildren(x, M, created)]));
}

/** The flat keys the expected state has: the module may keep keys α ignores, which `shape:` covers. */
function project(flat: Record<string, unknown>, like: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(like).map((k) => [k, flat[k]]));
}

function alphaKey(s: State, M: import('./model.js').RMachine): import('./values.js').Value {
  return { ctor: '', payload: Object.fromEntries(M.fieldNames.map((f) => [f, s[f]])) };
}
