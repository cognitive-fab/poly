// PD5.2.3, S156: attribution. In a scope that requires it, a compensable or irreversible effect reachable from an
// origin with no claims is PL6701 UNATTRIBUTED_EFFECT, with the path from the unattributed action to the effect.
//
// In check, lineage is its origin class (S105): an outside action's origin is its claims, or none when it has no
// `by`; a step a completion or a timer starts inherits the origin of the step that emitted the effect or set the
// timer (PD5.2.2a). So an action is attributed when it has claims, or when it is only ever started by completions and
// timers whose every emitter is attributed. The runtime denies such an effect too, by the scope's attribution rule.
import type { Diagnostic, Module, Stmt, WitnessStep } from '@poly/core';
import { checkMachine, ENGINE } from './check.js';
import { pathTo } from './explore.js';
import { statePlain, toPlain } from './values.js';

export function unattributedEffects(module: Module, machineName: string, opts: { maxStates?: number } = {}): Diagnostic[] {
  const m = module.decls.find((d) => d.kind === 'Machine' && d.name === machineName);
  if (!m || m.kind !== 'Machine') return [];
  const report = checkMachine(module, machineName, opts);
  const M = report.model;
  // Which actions start which: an effect's or a decision's completions, and the actions timers fire.
  const emitters = new Map<string, Set<string>>();
  const wire = (target: string, from: string) => { if (!emitters.has(target)) emitters.set(target, new Set()); emitters.get(target)!.add(from); };
  const walk = (body: Stmt[], from: string): void => {
    for (const s of body) {
      if (s.kind === 'Intent' && (s.op === 'emit' || s.op === 'decide')) {
        const decl = m.items.find((i) => (i.kind === 'EffectDecl' || i.kind === 'Decision') && i.name === s.target) as { items: { kind: string; action?: string }[] } | undefined;
        for (const o of decl?.items ?? []) if (o.kind === 'EffOutcome' && o.action) wire(o.action, from);
      }
      if (s.kind === 'Intent' && s.op === 'after') wire(s.target, from);
      if (s.kind === 'If') { walk(s.then, from); walk(s.else ?? [], from); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body, from);
      if (s.kind === 'For') walk(s.body, from);
    }
  };
  for (const it of m.items) if (it.kind === 'Handler') walk(it.body, it.action);
  const claimed = new Set(M.actions.filter((a) => a.claims).map((a) => a.name));
  // The greatest fixpoint: assume every wired action attributed, and withdraw it while an emitter is not.
  const attributed = new Set(M.actions.filter((a) => claimed.has(a.name) || emitters.has(a.name)).map((a) => a.name));
  for (let changed = true; changed;) {
    changed = false;
    for (const a of [...attributed]) {
      if (claimed.has(a)) continue;
      if ([...(emitters.get(a) ?? [])].some((x) => !attributed.has(x))) { attributed.delete(a); changed = true; }
    }
  }
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  const { graph: g } = report;
  for (const e of g.edges) {
    if (e.label.verdict.kind !== 'accepted' || attributed.has(e.label.action)) continue;
    for (const x of e.label.effects) {
      if (x.type !== 'effect') continue;
      const eff = [...M.effects.values()].find((f) => f.kind === x.kind);
      if (!eff || (eff.cls !== 'compensable' && eff.cls !== 'irreversible')) continue;
      const key = `${e.label.action}\u0000${x.kind}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const trace: WitnessStep[] = [...pathTo(g, e.from), e].map((s) => ({
        pre: statePlain(g.states[s.from]),
        action: s.label.action,
        data: Object.fromEntries(Object.entries(s.label.data).map(([k, v]) => [k, toPlain(v)])),
        post: statePlain(s.outcome.state),
        verdict: s.label.verdict.kind,
      }));
      out.push({
        code: 'PL6701', name: 'UNATTRIBUTED_EFFECT', severity: 'finding', stage: 'policy', engine: ENGINE,
        at: { module: module.name, machine: M.name },
        message: `${M.id}: ${e.label.action} emits ${x.kind} (${eff.cls}) from an origin with no claims: ${claimed.has(e.label.action) ? '' : `${e.label.action} has no \`by\``}${emitters.has(e.label.action) ? ', and a step that starts it is unattributed' : ''} (PD5.2.3, S156)`,
        property: `${M.id}.${x.kind}`,
        witness: { id: '', length: trace.length, trace },
      } as Diagnostic);
    }
  }
  return out;
}
