// Every artefact the runtime reads is checked (the standing rule after the M1 review, decisions-m1.md).
//
// Translation validation (tv.ts) compares next.cjs, invariants.mjs and the effects mapper by running
// them. The other artefacts are data or predicates the engines read without running the module:
//   - contract.json: the state keys, the initial state, the actions, dataDomain and terminalStates;
//   - effects.manifest.json: each kind with its payload keys, completions and their data, retry,
//     labels and class (PT6.1, S67);
//   - effect-invariants.mjs: each path property as polyrun's check-effects evaluates it (PS5.4);
//   - invariants.compose.mjs: each compose invariant as check-product evaluates it (PS7.3).
// Each is read back here and compared with what 04-semantics gives for the source, computed by
// poly-ref's own model. The timer and child wiring is part of the mapper's intents, which tv.ts compares.
import type * as A from '@poly/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { valuesOf, monitorStart, monitorStep, replyPath, type RMachine, type RPathProperty, type RType } from './model.js';
import { initialState, durationMs } from './step.js';
import { evaluate, evaluateAt } from './eval.js';
import { flatten, flatValue } from './alpha.js';
import { checkJoint } from './joint.js';
import type { State, Value } from './values.js';

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
};

/** The mismatches between the artefacts in `dir` and the source, one message each (PL2501 in tv.ts). */
export async function readBack(module: A.Module, M: RMachine, dir: string, states: State[] = []): Promise<string[]> {
  const out: string[] = [];
  const decl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === M.name)!;
  const differ = (what: string, got: unknown, want: unknown) => { if (stable(got) !== stable(want)) out.push(`${what}: the artefact has ${stable(got)}, the source gives ${stable(want)}`); };

  // ── contract.json ──
  const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')) as { stateKeys: { name: string }[]; initState: unknown; actions: Record<string, { dataFields: Record<string, unknown> }>; dataDomain?: Record<string, Record<string, unknown[]>> };
  const init = flatten(initialState(M), M);
  differ('contract.json stateKeys', contract.stateKeys.map((k) => k.name), Object.keys(init));
  differ('contract.json initState', contract.initState, init);
  // S35: only handled actions are in the lowered module and its contract, in declaration order.
  const handled = M.actions.filter((a) => M.handlers.has(a.name));
  differ('contract.json actions', Object.keys(contract.actions), handled.map((a) => a.name));
  for (const a of handled) {
    differ(`contract.json actions.${a.name}.dataFields`, Object.keys(contract.actions[a.name]?.dataFields ?? {}), a.params.map((p) => p.name));
    if (!a.params.length) continue;
    // D(a) per parameter (PS1.1): its check domain, or every value of its type, encoded as the runtime sees it.
    const want = Object.fromEntries(a.params.map((p) => [p.name, (p.check ?? valuesOf(p.type, M)).map((v) => flatValue(v, p.type, M))]));
    differ(`contract.json dataDomain.${a.name}`, contract.dataDomain?.[a.name], want);
  }

  // ── effects.manifest.json ──
  const effects = decl.items.filter((i): i is A.EffectDecl => i.kind === 'EffectDecl');
  const decisions = decl.items.filter((i): i is A.Decision => i.kind === 'Decision');
  const manifestPath = join(dir, 'effects.manifest.json');
  // A completion: its constant data (S67), and the reply's paths it binds as `map` (PD1.7, S79).
  const outcome = (it: A.EffOutcomeItem): unknown => {
    const target = M.actions.find((x) => x.name === it.action);
    const data: [string, unknown][] = [];
    const map: [string, string][] = [];
    for (const arg of it.args) {
      const path = it.bind !== undefined ? replyPath(arg.value, it.bind) : null;
      if (path) { map.push([arg.name!, ['$.result', ...path].join('.')]); continue; }
      const p = target?.params.find((x) => x.name === arg.name)!;
      // PD1.3a: an int constant given as a Conf is in [0, 1], so 1 is 1000 thousandths.
      const v: Value = p.type.k === 'conf' && arg.value.kind === 'Int' ? arg.value.value * 1000 : evaluateAt(arg.value, { M, state: {}, data: {}, locals: new Map() }, p.type);
      data.push([arg.name!, flatValue(v, p.type, M)]);
    }
    return { action: it.action, ...(data.length ? { data: Object.fromEntries(data) } : {}), ...(map.length ? { map: Object.fromEntries(map) } : {}) };
  };
  if (effects.length || decisions.length || existsSync(manifestPath)) {
    if (!existsSync(manifestPath)) out.push('effects.manifest.json is missing, and the machine declares effects');
    else {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { effects: Record<string, Record<string, unknown>> };
      const byKind = new Map(effects.map((e) => [M.effects.get(e.name)!.kind, e]));
      // PD2.4, S129: an adjudicated decision's outcome kind, read from the handlers here, not from the lowering.
      const judged = new Set<string>();
      const walk = (body: A.Stmt[]): void => { for (const s of body) { if (s.kind === 'Intent' && s.op === 'adjudicate') judged.add(s.target); if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); } if (s.kind === 'Match') for (const a of s.arms) walk(a.body); if (s.kind === 'For') walk(s.body); } };
      for (const h of M.handlers.values()) walk(h.body);
      differ('effects.manifest.json kinds', Object.keys(manifest.effects).sort(), [...byKind.keys(), ...decisions.map((d) => M.decisions.get(d.name)!.kind), ...[...judged].map((d) => `outcome.${d}`)].sort());
      for (const d of judged) {
        differ(`effects.manifest.json outcome.${d}`, manifest.effects[`outcome.${d}`] ?? null, { payloadSchema: { outcome: { type: 'string', required: true } }, retry: { maxAttempts: 1, baseMs: 500, timeoutMs: 30000 }, class: 'none', outcome: { decision: d } });
      }
      for (const [kind, e] of byKind) {
        const entry = manifest.effects[kind];
        if (!entry) continue;
        differ(`effects.manifest.json ${kind}.payloadSchema`, Object.keys((entry.payloadSchema as object) ?? {}), e.params.map((p) => p.name));
        const hooks = { ok: 'onSuccess', failed: 'onFailure', exhausted: 'onExhausted' } as const;
        for (const [which, hook] of Object.entries(hooks)) {
          const it = e.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === which);
          if (!it) { differ(`effects.manifest.json ${kind}.${hook}`, entry[hook] ?? null, null); continue; }
          differ(`effects.manifest.json ${kind}.${hook}`, entry[hook], outcome(it));
        }
        const retry = e.items.find((x): x is A.EffectItem & { kind: 'EffRetry' } => x.kind === 'EffRetry');
        differ(`effects.manifest.json ${kind}.retry`, entry.retry ?? null, retry ? { maxAttempts: retry.attempts, baseMs: durationMs(retry.base), timeoutMs: durationMs(retry.timeout) } : { maxAttempts: 5, baseMs: 500, timeoutMs: 30000 }); // PT6.1, S137
        const labels = e.items.find((x): x is A.EffectItem & { kind: 'EffLabels' } => x.kind === 'EffLabels');
        differ(`effects.manifest.json ${kind}.labels`, entry.labels ?? null, labels ? labels.labels : null);
        // S151: the capability bounds, read back exactly: a wider prefix in the manifest is a wider capability at run time.
        const targets = e.items.find((x): x is A.EffTargets => x.kind === 'EffTargets');
        differ(`effects.manifest.json ${kind}.targets`, entry.targets ?? null, targets ? Object.fromEntries(targets.targets.map((t) => [t.key, t.values])) : null);
        differ(`effects.manifest.json ${kind}.class`, entry.class, M.effects.get(e.name)!.cls);
      }
      // PD1.7: a decision, tried once within its timeout, class none; a timeout is its failure.
      for (const d of decisions) {
        const kind = M.decisions.get(d.name)!.kind;
        const entry = manifest.effects[kind];
        if (!entry) continue;
        differ(`effects.manifest.json ${kind}.payloadSchema`, Object.keys((entry.payloadSchema as object) ?? {}), d.params.map((p) => p.name));
        const timeout = d.items.find((x) => x.kind === 'DecTimeout') as { value: string } | undefined;
        differ(`effects.manifest.json ${kind}.retry`, entry.retry ?? null, { maxAttempts: 1, timeoutMs: timeout ? durationMs(timeout.value) : 0 });
        const ok = d.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === 'ok');
        const failed = d.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === 'failed');
        differ(`effects.manifest.json ${kind}.onSuccess`, entry.onSuccess ?? null, ok ? outcome(ok) : null);
        differ(`effects.manifest.json ${kind}.onFailure`, entry.onFailure ?? null, failed ? outcome(failed) : null);
        differ(`effects.manifest.json ${kind}.onExhausted`, entry.onExhausted ?? null, failed ? outcome(failed) : null);
        const labels = d.items.find((x) => x.kind === 'EffLabels') as { labels: string[] } | undefined;
        differ(`effects.manifest.json ${kind}.labels`, entry.labels ?? null, labels ? labels.labels : null);
        differ(`effects.manifest.json ${kind}.class`, entry.class, 'none');
        const provider = d.items.find((x) => x.kind === 'DecProvider') as { value: string } | undefined;
        const band = d.items.find((x) => x.kind === 'DecBand') as { lo: number; hi: number } | undefined;
        const answers = (t: RType): unknown => (t.k === 'record' ? Object.fromEntries(M.records.get(t.name)!.fields.map((f) => [f.name, answers(f.type)])) : valuesOf(t, M).map((v) => flatValue(v, t, M)));
        differ(`effects.manifest.json ${kind}.decision`, entry.decision, { provider: provider?.value ?? null, result: answers(resultType(d.result, M)), ...(band ? { band: [band.lo, band.hi] } : {}) });
      }
    }
  }

  // ── effect-invariants.mjs (PS5.4) ──
  const pathFile = join(dir, 'effect-invariants.mjs');
  if (M.pathProperties.length) {
    if (!existsSync(pathFile)) out.push('effect-invariants.mjs is missing, and the machine has path properties');
    else {
      const lowered = ((await import(pathToFileURL(pathFile).href + `?v=${Date.now()}-${Math.random()}`)) as { effectInvariants?: { name: string; pred: (p: unknown) => boolean }[] }).effectInvariants ?? [];
      for (const p of M.pathProperties) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`effect-invariants.mjs has no predicate ${p.name}`); continue; }
        const bad = pathDisagreement(p, l.pred, [...[...M.effects.values()].map((e) => e.kind), ...[...M.decisions.values()].map((d) => d.kind), 'timer', 'cancelTimer', 'spawnChild', 'signalChild', 'sendTo', 'createInstance']);
        if (bad) out.push(`effect-invariants.mjs ${p.name} is ${bad.lowered} on the emissions ${stable(bad.kinds)}, and PS5.4 gives ${!bad.lowered}`);
      }
    }
  }

  // ── invariants.compose.mjs (PS7.3) ──
  const compose = decl.items.filter((i): i is A.Property => i.kind === 'Property' && i.form === 'compose');
  const composeFile = join(dir, 'invariants.compose.mjs');
  if (compose.length) {
    if (!existsSync(composeFile)) out.push('invariants.compose.mjs is missing, and the machine has compose invariants');
    else {
      const lowered = ((await import(pathToFileURL(composeFile).href + `?v=${Date.now()}-${Math.random()}`)) as { stateInvariants?: { name: string; pred: (j: unknown) => boolean }[] }).stateInvariants ?? [];
      const joint = checkJoint(module, M.name);
      for (const p of compose) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`invariants.compose.mjs has no predicate ${p.name}`); continue; }
        for (const j of joint.graph.states) {
          const children = new Map(j.children.map(([k, c]) => [k, c.state]));
          const want = evaluate(p.expr, { M: j.parent.machine, state: j.parent.state, data: {}, locals: new Map(), joint: { parent: j.parent.state, children } }) === true;
          // check-product's joint state: each instance's flat state (PS9.1b), by child key.
          const view = { parent: { state: flatten(j.parent.state, j.parent.machine) }, children: Object.fromEntries(j.children.map(([k, c]) => [k, { state: flatten(c.state, c.machine) }])) };
          let got: boolean | string;
          try { got = l.pred(view) === true; } catch (e) { got = `a throw (${(e as Error).message})`; }
          if (got !== want) { out.push(`invariants.compose.mjs ${p.name} is ${got} on a reachable joint state, and PS7.3 gives ${want}`); break; }
        }
      }
    }
  }
  // ── liveness.mjs (S74) ──
  const live = M.liveness.filter((p) => !p.quant);
  const liveFile = join(dir, 'liveness.mjs');
  if (live.length) {
    if (!existsSync(liveFile)) out.push('liveness.mjs is missing, and the machine has liveness properties');
    else {
      const lowered = ((await import(pathToFileURL(liveFile).href + `?v=${Date.now()}-${Math.random()}`)) as { liveness?: { name: string; goal: (s: unknown) => boolean; from: ((s: unknown) => boolean) | null; fair: unknown }[] }).liveness ?? [];
      for (const p of live) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`liveness.mjs has no predicate ${p.name}`); continue; }
        differ(`liveness.mjs ${p.name}.fair`, l.fair, (p.fair ?? []).map((g) => g.members.map((x) => ({ action: x.action, perValue: x.perValue }))));
        if ((l.from === null) !== (p.from === null)) out.push(`liveness.mjs ${p.name} has ${l.from ? 'a' : 'no'} start predicate, and the source ${p.from ? 'has' : 'has none'}`);
        for (const s of states) {
          const flat = flatten(s, M);
          const env = { M, state: s, data: {}, locals: new Map() };
          const pairs: [string, ((x: unknown) => boolean) | null, A.Expr | null][] = [['goal', l.goal, p.expr], ['from', l.from, p.from]];
          for (const [what, fn, e] of pairs) {
            if (!fn || !e) continue;
            let got: boolean | string;
            try { got = fn(flat) === true; } catch (err) { got = `a throw (${(err as Error).message})`; }
            const want = evaluate(e, env) === true;
            if (got !== want) { out.push(`liveness.mjs ${p.name}.${what} is ${got} on a reachable state, and PS5.5 gives ${want}`); break; }
          }
        }
      }
    }
  }
  return out;
}

/**
 * A sequence of emissions on which the lowered path property and PS5.4 disagree, or null. Every sequence of
 * up to four emissions over the property's kinds and one other kind is tried, which decides an order of two
 * kinds; each counted kind is repeated up to two past its bound, alone and beside each kind the machine can
 * emit; and every kind the machine can emit is tried alone and in pairs.
 */
function pathDisagreement(p: RPathProperty, pred: (path: unknown) => boolean, machineKinds: string[]): { kinds: string[]; lowered: boolean } | null {
  const kinds = [...new Set(p.clauses.flatMap((c) => (c.k === 'count' ? [c.kind] : [c.first, c.then]))), '__other'];
  const sequences: string[][] = [];
  let frontier: string[][] = [[]];
  for (let n = 0; n <= 4; n++) {
    sequences.push(...frontier);
    frontier = frontier.flatMap((s) => kinds.map((k) => [...s, k]));
  }
  for (const c of p.clauses) if (c.k === 'count') for (let n = 0; n <= c.max + 2; n++) sequences.push(Array(n).fill(c.kind));
  // Every kind the machine can emit, not one anonymous other kind, so a predicate that counts another real kind
  // or every emission is told apart (review C5): each alone and in pairs, and beside each counted run.
  const all = [...new Set([...kinds, ...machineKinds])];
  for (const a of all) { sequences.push([a]); for (const b of all) sequences.push([a, b]); }
  for (const c of p.clauses) {
    if (c.k !== 'count') continue;
    for (const o of all) for (let n = 0; n <= c.max + 2; n++) { sequences.push([o, ...Array(n).fill(c.kind)]); sequences.push([...Array(n).fill(c.kind), o]); }
  }
  {
    for (const seq of sequences) {
      let m = monitorStart(p);
      let holds = true;
      for (const k of seq) {
        const r = monitorStep(p, m, [k]);
        if (r.broken >= 0) holds = false;
        m = r.next;
      }
      const path = { emitted: seq.map((kind) => ({ kind, payload: {} })), count: (kind: string) => seq.filter((k) => k === kind).length };
      let lowered: boolean;
      try { lowered = pred(path) === true; } catch { lowered = false; }
      if (lowered !== holds) return { kinds: seq, lowered };
    }
  }
  return null;
}

/** A decision's result type as poly-ref reads types (PD1.2a). */
function resultType(t: A.TypeExpr, M: RMachine): RType {
  switch (t.kind) {
    case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
    case 'TBool': return { k: 'bool' };
    case 'TName': return M.records.has(t.name) ? { k: 'record', name: t.name } : { k: 'union', name: t.name };
    default: throw new Error(`poly-ref: a decision's result is finite, not ${t.kind} (PD1.2a)`);
  }
}
