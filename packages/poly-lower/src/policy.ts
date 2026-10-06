// Lowering policies to `polyaxion.policy.json` version 2 (PT8.2). One document per trust scope: every policy whose
// scope is that scope, so the obligations' order inside the document is poly's to fix (deny rules first, then
// escalate, then warn), which is what PS8.3's combination needs from an engine that reports its first refusal.
//
// PS8.2 is carried by rewriting, since Polyaxion applies a rule whose `when` is unknown and refuses an unknown
// `require` as `indeterminate` (section 1 of plan-m5):
//   when W require Q else s on unknown u
//   ⇒ rule o            when coalesce(W', false) require coalesce(Q', false)   severity s
//     rule o.unknown    when isNull(W')          require false                 severity u   (unless u is skip)
// With no `when`, the first rule alone, with no `when`. A machine obligation lowers to Polyaxion's machine: a guard
// whose condition is true or unknown refuses, a transition fires only on true (PT8.2).
//
// The proposal's fields are reserved action fields the gate host fills (S147): `effect.*` is `action.effect.*`,
// `effect.labels` is `action.effects` (Polyaxion's label field), `proposal.kind` is `action.proposal`,
// `machine("m.M").f` is `action.machines['m.M'].f`, `decision("d").f` is `action.decisions['d'].f`, and
// `decision("d").taken` is `!isNull(action.decisions['d'])`. A Conf is in thousandths, as the runtime records it.
import type * as A from '@poly/core';

export interface PolicyDoc {
  polyaxion: '2';
  id: string;
  version: string;
  scope: string;
  description: string;
  vars: Record<string, { type: 'number' | 'boolean'; domain: (number | boolean)[]; initial: number | boolean }>;
  obligations: Record<string, unknown>[];
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The PX text of a policy expression. Names that are not variables are constructors, compared as strings. */
export function px(e: A.Expr, vars: Set<string>): string {
  const r = (x: A.Expr) => px(x, vars);
  switch (e.kind) {
    case 'Bool': return e.value ? 'true' : 'false';
    case 'Int': return String(e.value);
    case 'Decimal': return String(e.value);
    case 'String': return q(e.value);
    case 'Name': return vars.has(e.name) ? `state.${e.name}` : q(e.name);
    case 'Member': {
      const o = e.object;
      if (o.kind === 'Name' && o.name === 'effect' && !vars.has('effect')) return e.prop === 'labels' ? 'action.effects' : `action.effect.${e.prop}`;
      if (o.kind === 'Name' && o.name === 'proposal' && !vars.has('proposal')) return 'action.proposal';
      if (o.kind === 'Name' && o.name === 'send' && !vars.has('send')) return `action.send.${e.prop}`;
      // PD5.1.2d: the emitting step's claims, a reserved action field the gate host fills.
      if (o.kind === 'Name' && o.name === 'step' && !vars.has('step')) return `action.step.${e.prop}`;
      // PD5.2.2c: the emitting step's lineage, a reserved action field the gate host fills.
      if (o.kind === 'Name' && o.name === 'lineage' && !vars.has('lineage')) return `action.lineage.${e.prop}`;
      if (o.kind === 'Call' && o.callee === 'machine') return `action.machines[${q((o.args[0] as A.StringLit).value)}].${e.prop}`;
      if (o.kind === 'Call' && o.callee === 'decision') {
        const d = `action.decisions[${q((o.args[0] as A.StringLit).value)}]`;
        return e.prop === 'taken' ? `!isNull(${d})` : `${d}.${e.prop}`;
      }
      if (o.kind === 'Member' && o.object.kind === 'Call' && o.object.callee === 'decision') return `${r(o)}.${e.prop}`;
      // A qualified constructor `Type.C` is the string 'C'.
      if (o.kind === 'Name') return q(e.prop);
      return `${r(o)}.${e.prop}`;
    }
    case 'Call':
      if (e.callee === 'unknown') return `isNull(${r(e.args[0])})`;
      // PS8.8: the gate host computes the ages of the emitting step's claims at the decision, as reserved action fields.
      if (e.callee === 'age') return 'action.step.age';
      if (e.callee === 'statusAge') return 'action.step.statusAge';
      if (e.callee === 'has') return `(${r(e.args[1])} in ${r(e.args[0])})`;
      throw new Error(`no PX form for ${e.callee}(…)`);
    case 'Unary': return `${e.op}(${r(e.arg)})`;
    case 'Binary':
      if (e.op === 'implies') return `(!(${r(e.left)}) || (${r(e.right)}))`;
      return `(${r(e.left)} ${e.op} ${r(e.right)})`;
    case 'In': return `(${r(e.expr)} in [${e.set.map(r).join(', ')}])`;
    default: throw new Error(`no PX form for ${e.kind}`);
  }
}

/** A proposal of the runtime (PT9.1, PT9.9), as the gate host names it to the engine. */
export const PROPOSAL = "(action.kind in ['custom.poly.effect', 'custom.poly.send'])";

/** The default of PS8.2 for an unknown `when`. */
export const defaultOnUnknown = (s: A.RuleObligation['severity']) => (s === 'warn' ? 'warn' : 'escalate');

/** The document a trust scope's policies lower to, and the machines its rules read (S147). */
/**
 * Deliberately broken policy lowerings, for one test only (the standing rule on artefacts): translation validation
 * must catch each with PL2501. `poly check` never sets one.
 */
export const POLICY_FAULTS = ['drop-unknown-rule', 'deny-as-warn', 'drop-guard'] as const;
export type PolicyFault = (typeof POLICY_FAULTS)[number];

/**
 * A machine obligation's transitions, as the engine must take them (review B7, B12). PS8's machine takes, from a
 * state, the first transition whose condition is true, as written; the engine applies every matching transition, so
 * the last would win. Each transition is therefore split per source state (`*` is every state) and conjoined with the
 * negation of every earlier transition out of the same state. Each also carries the proposal conjunct, which gives the
 * engine an action condition to route by when the written one reads only a var, and leaves the engine's own actions
 * (the end of a session) out, as poly-ref does.
 */
function transitionsOf(it: A.MachineObligation, names: Set<string>): { from: string[]; when: string; to: string }[] {
  const out: { from: string[]; when: string; to: string }[] = [];
  for (const state of it.states) {
    const here = it.transitions.filter((t) => t.from === '*' || t.from.includes(state));
    here.forEach((t, k) => {
      const earlier = here.slice(0, k).map((e) => ` && !coalesce(${px(e.when, names)}, false)`).join('');
      out.push({ from: [state], when: `${PROPOSAL} && coalesce(${px(t.when, names)}, false)${earlier}`, to: t.to });
    });
  }
  return out;
}

export function lowerPolicyScope(scope: string, policies: A.Policy[], sourceDigest: string, fault?: PolicyFault): PolicyDoc {
  const vars: PolicyDoc['vars'] = {};
  for (const p of policies) for (const v of p.vars) {
    const spec = v.type.kind === 'TBool'
      ? { type: 'boolean' as const, domain: [false, true], initial: (v.init as A.BoolLit).value }
      : { type: 'number' as const, domain: Array.from({ length: (v.type as A.TRange).hi - (v.type as A.TRange).lo + 1 }, (_, k) => (v.type as A.TRange).lo + k), initial: (v.init as A.IntLit).value };
    if (vars[v.name] && JSON.stringify(vars[v.name]) !== JSON.stringify(spec)) throw new Error(`policies in scope ${scope} declare var ${v.name} with different domains`);
    vars[v.name] = spec;
  }
  const names = new Set(Object.keys(vars));
  const rank = { deny: 0, escalate: 1, warn: 2 } as const;
  const rules: { rank: number; o: Record<string, unknown> }[] = [];
  const others: Record<string, unknown>[] = [];
  for (const p of policies) for (const it of p.items) {
    const id = `${p.name}.${it.name}`;
    const source = { policy: p.name, obligation: it.name };
    switch (it.kind) {
      case 'RuleObligation': {
        // A rule judges the runtime's proposals only; the engine's own actions (the end of a session) pass it.
        const W = it.when ? px(it.when, names) : null;
        const Q = px(it.require, names);
        const severity = fault === 'deny-as-warn' && it.severity === 'deny' ? 'warn' : it.severity;
        rules.push({ rank: rank[it.severity], o: { id, kind: 'rule', text: it.text, severity, when: W ? `${PROPOSAL} && coalesce(${W}, false)` : PROPOSAL, require: `coalesce(${Q}, false)`, source } });
        const u = it.onUnknown ?? defaultOnUnknown(it.severity);
        if (W && u !== 'skip' && fault !== 'drop-unknown-rule') rules.push({ rank: rank[u], o: { id: `${id}.unknown`, kind: 'rule', text: `${it.text} (its condition is unknown, PS8.2)`, severity: u, when: `${PROPOSAL} && isNull(${W})`, require: 'false', source: { ...source, unknown: true } } });
        break;
      }
      case 'MachineObligation':
        others.push({
          id, kind: 'machine', text: it.text, source,
          machine: {
            states: it.states, initial: it.initial,
            transitions: transitionsOf(it, names),
            guards: fault === 'drop-guard' ? [] : it.guards.map((g) => ({ in: g.in, when: px(g.when, names), reason: g.reason })),
            discharge: it.end,
          },
        });
        break;
      case 'InvariantObligation':
        others.push({ id, kind: 'invariant', text: it.text, invariant: px(it.expr, names), source });
        break;
      case 'Recalled':
        others.push({ id, kind: 'recalled', text: it.text, source });
        break;
      case 'Never':
        break; // proved by poly-ref over the decision table (S149); nothing to enforce
    }
  }
  // S156, PD5.2.3: a scope that requires attribution denies a compensable or irreversible effect whose origin has no claims.
  if (policies.some((p) => p.requiresAttribution)) rules.push({ rank: rank.deny, o: { id: `${scope}.attribution`, kind: 'rule', text: 'A compensable or irreversible effect has an origin with claims (PD5.2.3).', severity: 'deny', when: `${PROPOSAL} && (action.proposal == 'effect') && (action.effect.class in ['compensable', 'irreversible'])`, require: 'coalesce(!isNull(action.lineage.origin), false)', source: { policy: policies.find((p) => p.requiresAttribution)!.name, obligation: '$attribution' } } });
  const obligations = [...rules.sort((a, b) => a.rank - b.rank).map((r) => r.o), ...others];
  return { polyaxion: '2', id: `poly/${scope}`, version: sourceDigest, scope, description: `The policies of scope ${scope}: ${policies.map((p) => p.name).join(', ')}.`, vars, obligations };
}
