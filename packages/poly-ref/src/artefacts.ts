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
import { valuesOf, monitorStart, monitorStep, type RMachine, type RPathProperty } from './model.js';
import { initialState, durationMs } from './step.js';
import { evaluate, evaluateAt } from './eval.js';
import { flatten, flatValue } from './alpha.js';
import { checkJoint } from './joint.js';
import type { Value } from './values.js';

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
};

/** The mismatches between the artefacts in `dir` and the source, one message each (PL2501 in tv.ts). */
export async function readBack(module: A.Module, M: RMachine, dir: string): Promise<string[]> {
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
  const manifestPath = join(dir, 'effects.manifest.json');
  if (effects.length || existsSync(manifestPath)) {
    if (!existsSync(manifestPath)) out.push('effects.manifest.json is missing, and the machine declares effects');
    else {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { effects: Record<string, Record<string, unknown>> };
      const byKind = new Map(effects.map((e) => [M.effects.get(e.name)!.kind, e]));
      differ('effects.manifest.json kinds', Object.keys(manifest.effects).sort(), [...byKind.keys()].sort());
      for (const [kind, e] of byKind) {
        const entry = manifest.effects[kind];
        if (!entry) continue;
        differ(`effects.manifest.json ${kind}.payloadSchema`, Object.keys((entry.payloadSchema as object) ?? {}), e.params.map((p) => p.name));
        const hooks = { ok: 'onSuccess', failed: 'onFailure', exhausted: 'onExhausted' } as const;
        for (const [outcome, hook] of Object.entries(hooks)) {
          const it = e.items.find((x): x is A.EffectItem & { kind: 'EffOutcome' } => x.kind === 'EffOutcome' && x.outcome === outcome);
          if (!it) { differ(`effects.manifest.json ${kind}.${hook}`, entry[hook] ?? null, null); continue; }
          // S67: a completion's constant data, encoded as the value is everywhere else.
          const target = M.actions.find((x) => x.name === it.action);
          const data = Object.fromEntries(it.args.map((arg) => {
            const p = target?.params.find((x) => x.name === arg.name)!;
            const v: Value = evaluateAt(arg.value, { M, state: {}, data: {}, locals: new Map() }, p.type);
            return [arg.name!, flatValue(v, p.type, M)];
          }));
          differ(`effects.manifest.json ${kind}.${hook}`, entry[hook], it.args.length ? { action: it.action, data } : { action: it.action });
        }
        const retry = e.items.find((x): x is A.EffectItem & { kind: 'EffRetry' } => x.kind === 'EffRetry');
        differ(`effects.manifest.json ${kind}.retry`, entry.retry ?? null, retry ? { maxAttempts: retry.attempts, baseMs: durationMs(retry.base), timeoutMs: durationMs(retry.timeout) } : null);
        const labels = e.items.find((x): x is A.EffectItem & { kind: 'EffLabels' } => x.kind === 'EffLabels');
        differ(`effects.manifest.json ${kind}.labels`, entry.labels ?? null, labels ? labels.labels : null);
        differ(`effects.manifest.json ${kind}.class`, entry.class, M.effects.get(e.name)!.cls);
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
        const bad = pathDisagreement(p, l.pred);
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
  return out;
}

/**
 * A sequence of emissions on which the lowered path property and PS5.4 disagree, or null. Every sequence of
 * up to four emissions over the property's kinds and one other kind is tried, which decides an order of two
 * kinds, and each counted kind is repeated up to two past its bound, which decides every count bound.
 */
function pathDisagreement(p: RPathProperty, pred: (path: unknown) => boolean): { kinds: string[]; lowered: boolean } | null {
  const kinds = [...new Set(p.clauses.flatMap((c) => (c.k === 'count' ? [c.kind] : [c.first, c.then]))), '__other'];
  const sequences: string[][] = [];
  let frontier: string[][] = [[]];
  for (let n = 0; n <= 4; n++) {
    sequences.push(...frontier);
    frontier = frontier.flatMap((s) => kinds.map((k) => [...s, k]));
  }
  for (const c of p.clauses) if (c.k === 'count') for (let n = 0; n <= c.max + 2; n++) sequences.push(Array(n).fill(c.kind));
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
