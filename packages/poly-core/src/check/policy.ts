// Policies (PT8, PS8): the names, types and references of a `.policy.poly` against the program it governs.
//
// A policy's inputs are the proposal the gate is asked about (PT9.1): `effect.kind`, `effect.class`,
// `effect.labels`, `effect.machine`, `proposal.kind`, the read of a machine's snapshot `machine("m.M").f`
// (PT8.3, S147), and the recorded decision `decision("d").f` (PD4.3). Each may be missing, so each comparison has
// type Tri (PS8.0). This checker resolves every name, types every expression, and reports a `machine(…)` read that
// can never be known: a machine that is neither a service (a singleton) nor the emitter of any effect (S147).
import type * as A from '../ast.js';
import { diag, type Diagnostic, type NodeAt } from '../diagnostics.js';
import { effectKind, effectClass, LABELS } from './check.js';

/** The type of a policy expression. Every input is optional, so `tri` is the type of a comparison (PS8.0). */
export type PType =
  | { k: 'tri' }
  | { k: 'bool' }
  | { k: 'str'; values: string[] | null }
  | { k: 'int'; lo: number; hi: number }
  | { k: 'enum'; name: string; members: string[] }
  | { k: 'conf' }
  | { k: 'labels' }
  | { k: 'machineRef'; machine: string }
  | { k: 'decisionRef'; decision: string }
  | { k: 'record'; fields: Record<string, PType> };

export interface PolicyMachine {
  id: string;
  service: boolean;
  fields: Map<string, PType>;
  /** The effect kinds this machine can emit, with their class and labels. */
  effects: { kind: string; class: string; labels: string[] }[];
}

export interface PolicyProgram {
  machines: Map<string, PolicyMachine>;
  decisions: Map<string, { machine: string; result: PType }>;
  effectKinds: string[];
  labels: string[];
  /** PD5.1.2d, S104: the fields of the program's claims types a policy can read as step.claims.f (a Principal is not). */
  claims: Record<string, PType>;
  /** Review C3: fields that two claims types declare with different types, with those types' names. */
  claimsConflicts: Map<string, string[]>;
  /** PD5.2.2c: every action of the program as an intent, `module.Machine.Action`. */
  intents: string[];
  /** S185, PT25.1: the program's channels, their kinds, and the message kinds their conversations send. */
  channels: { name: string; kind: string; messageKinds: string[] }[];
}

const CLASSES = ['none', 'reversible', 'compensable', 'irreversible'];

/** What the policies of a project may refer to: its machines, fields, effects and decisions. */
export function policyProgram(modules: A.Module[]): PolicyProgram {
  const machines = new Map<string, PolicyMachine>();
  const decisions = new Map<string, { machine: string; result: PType }>();
  // Polywatch: no prototype, so a field named like an Object member (constructor) is a field like any other.
  const claims: Record<string, PType> = Object.create(null);
  const claimsOwner = new Map<string, string>();
  const claimsConflicts = new Map<string, string[]>();
  const intents: string[] = [];
  for (const m of modules) {
    const enums = new Map<string, string[]>();
    for (const d of m.decls) {
      if (d.kind === 'EnumDecl') enums.set(d.name, d.members);
      if (d.kind === 'TypeDecl' && d.ctors.every((c) => c.fields.length === 0)) enums.set(d.name, d.ctors.map((c) => c.name));
    }
    const typeOf = (t: A.TypeExpr): PType | null => {
      switch (t.kind) {
        case 'TBool': return { k: 'bool' };
        case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
        case 'TName': return enums.has(t.name) ? { k: 'enum', name: t.name, members: enums.get(t.name)! } : null;
        case 'TConf': return { k: 'conf' };
        case 'TString': return { k: 'str', values: null };
        default: return null;
      }
    };
    for (const d of m.decls) if (d.kind === 'RecordDecl' && d.claims) for (const f of d.fields) {
      const t = typeOf(f.type);
      if (!t) continue;
      if (!(f.name in claims) && !claimsConflicts.has(f.name)) { claims[f.name] = t; claimsOwner.set(f.name, d.name); continue; }
      if (claims[f.name] && JSON.stringify(claims[f.name]) !== JSON.stringify(t)) { claimsConflicts.set(f.name, [claimsOwner.get(f.name)!, d.name]); delete claims[f.name]; }
      else if (claimsConflicts.has(f.name)) claimsConflicts.get(f.name)!.push(d.name);
    }
    for (const d of m.decls) {
      if (d.kind !== 'Machine') continue;
      const id = `${m.name}.${d.name}`;
      for (const it of d.items) if (it.kind === 'Action') intents.push(`${id}.${it.name}`);
      const fields = new Map<string, PType>();
      for (const f of d.fields) { const t = typeOf(f.type); if (t) fields.set(f.name, t); }
      const effects: PolicyMachine['effects'] = [];
      for (const it of d.items) {
        if (it.kind === 'EffectDecl') effects.push({ kind: effectKind(it), class: effectClass(it), labels: it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])) });
        if (it.kind === 'Decision') {
          effects.push({ kind: `decision.${it.name}`, class: 'none', labels: it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])) });
          decisions.set(it.name, { machine: id, result: typeOf(it.result) ?? { k: 'str', values: null } });
        }
      }
      machines.set(id, { id, service: d.service, fields, effects });
    }
  }
  // S185: a channel's message kinds are the members of its conversation's send effect's `kind` parameter, an enum of its
  // std module (std.channels.whatsapp's FreeForm and Templated); a kind with none has none.
  const channels: PolicyProgram['channels'] = [];
  for (const m of modules) for (const d of m.decls) {
    if (d.kind !== 'Channel') continue;
    // The std module, or the channel's own conversation module m.c of the expansion, which carries its types (PS15.1).
    const lib = modules.find((x) => x.name === `std.channels.${d.channelKind}`) ?? modules.find((x) => x.name === `${m.name}.${d.name}`);
    const conv = lib?.decls.find((x): x is A.Machine => x.kind === 'Machine' && x.name === 'Conversation');
    const send = conv?.items.find((i): i is A.EffectDecl => i.kind === 'EffectDecl' && i.name === 'send');
    const k = send?.params.find((p) => p.name === 'kind')?.type;
    const e = k?.kind === 'TName' ? lib!.decls.find((x): x is A.EnumDecl => x.kind === 'EnumDecl' && x.name === k.name) : undefined;
    channels.push({ name: d.name, kind: d.channelKind, messageKinds: e ? [...e.members] : [] });
  }
  const all = [...machines.values()].flatMap((m) => m.effects);
  return { machines, decisions, claims, claimsConflicts, intents: intents.sort(), channels, effectKinds: [...new Set(all.map((e) => e.kind))].sort(), labels: [...new Set(all.flatMap((e) => e.labels))].sort() };
}

const DECISION_FIELDS = (result: PType): Record<string, PType> => ({
  taken: { k: 'bool' },
  answer: result,
  conf: { k: 'conf' },
  margin: { k: 'conf' },
  model: { k: 'record', fields: { id: { k: 'str', values: null }, reported: { k: 'str', values: null } } },
  calibration: { k: 'record', fields: { fittedFor: { k: 'str', values: null }, version: { k: 'int', lo: 0, hi: 1_000_000 } } },
});

const boolish = (t: PType | null) => t !== null && (t.k === 'tri' || t.k === 'bool');

export interface PolicyCheck {
  diagnostics: Diagnostic[];
  /** The machines each policy reads with `machine(…)`, by policy name. */
  reads: Map<string, string[]>;
}

/** Checks the policies of a module against the program; `module` names the file's module for diagnostics. */
export function checkPolicies(module: A.Module, program: PolicyProgram): PolicyCheck {
  const diagnostics: Diagnostic[] = [];
  const reads = new Map<string, string[]>();
  const at = (n: A.NodeBase): NodeAt => ({ module: module.name, node: n.id, line: n.span?.line, col: n.span?.col });
  const err = (code: string, n: A.NodeBase, msg: string) => diagnostics.push(diag(code, at(n), msg));
  for (const p of module.decls) {
    if (p.kind !== 'Policy') continue;
    const read = new Set<string>();
    const vars = new Map<string, PType>();
    for (const v of p.vars) {
      const t: PType | null = v.type.kind === 'TBool' ? { k: 'bool' } : v.type.kind === 'TRange' ? { k: 'int', lo: v.type.lo, hi: v.type.hi } : null;
      if (!t) { err('PL1201', v, `var ${v.name}: a policy variable is a bool or an integer range (PT8.1)`); continue; }
      if (vars.has(v.name)) err('PL1002', v, `var ${v.name} is declared twice`);
      vars.set(v.name, t);
      const init = v.init;
      const ok = (t.k === 'bool' && init.kind === 'Bool') || (t.k === 'int' && init.kind === 'Int' && init.value >= t.lo && init.value <= t.hi);
      if (!ok) err('PL1201', v, `var ${v.name}: its initial value is not a literal of its type`);
    }

    /** The type of an expression, with diagnostics; `expect` resolves a bare constructor against the other side. */
    const type = (e: A.Expr, expect: PType | null = null): PType | null => {
      switch (e.kind) {
        case 'Bool': return { k: 'bool' };
        case 'Int': return { k: 'int', lo: e.value, hi: e.value };
        case 'Decimal': return { k: 'conf' };
        case 'String': return { k: 'str', values: [e.value] };
        case 'Name': {
          if (vars.has(e.name)) return vars.get(e.name)!;
          if (e.name === 'effect' || e.name === 'proposal' || e.name === 'send' || e.name === 'step' || e.name === 'lineage') { err('PL1201', e, `${e.name} is read by its fields (effect.kind, effect.class, effect.labels, effect.machine, proposal.kind)`); return null; }
          if (expect?.k === 'enum') {
            if (expect.members.includes(e.name)) return expect;
            err('PL1001', e, `${e.name} is not a constructor of ${expect.name} (${expect.members.join(', ')})`);
            return null;
          }
          err('PL1001', e, `unknown name ${e.name} in a policy: its inputs are effect, send, proposal, machine("…") and decision("…") (PT8.1)`);
          return null;
        }
        case 'Member': {
          if (e.object.kind === 'Name' && e.object.name === 'effect' && !vars.has('effect')) {
            if (e.prop === 'kind') return { k: 'str', values: program.effectKinds };
            if (e.prop === 'class') return { k: 'str', values: CLASSES };
            if (e.prop === 'machine') return { k: 'str', values: [...program.machines.keys()] };
            if (e.prop === 'labels') return { k: 'labels' };
            // S185, PT25.1: a channel send's channel. Every recipient is external in M8 (audiences arrive in M10, S181).
            if (e.prop === 'channel') return { k: 'record', fields: { name: { k: 'str', values: program.channels.map((c) => c.name) }, kind: { k: 'str', values: [...new Set(program.channels.map((c) => c.kind))] }, recipient: { k: 'str', values: null }, recipientClass: { k: 'str', values: ['external'] }, messageKind: { k: 'str', values: [...new Set(program.channels.flatMap((c) => c.messageKinds))] } } };
            err('PL1001', e, `effect has no field ${e.prop} (kind, class, labels, machine, channel)`);
            return null;
          }
          if (e.object.kind === 'Name' && e.object.name === 'send' && !vars.has('send')) {
            // PS8.7, PT9.9: a send between trust scopes, proposed like an effect.
            if (e.prop === 'to') return { k: 'str', values: [...program.machines.keys()] };
            if (e.prop === 'action' || e.prop === 'scope') return { k: 'str', values: null };
            err('PL1001', e, `send has no field ${e.prop} (to, action, scope)`);
            return null;
          }
          // PD5.2.2c: the lineage of the emitting step: its origin's claims and its intent.
          if (e.object.kind === 'Name' && e.object.name === 'lineage' && !vars.has('lineage')) {
            if (e.prop === 'origin') return { k: 'record', fields: program.claims };
            if (e.prop === 'intent') return { k: 'str', values: program.intents };
            err('PL1001', e, `lineage has no field ${e.prop} (origin, intent); no expression names a hop (PD5.2.2c)`);
            return null;
          }
          // PD5.1.2d, S104: the claims of the step that emitted the proposal.
          if (e.object.kind === 'Name' && e.object.name === 'step' && !vars.has('step')) {
            if (e.prop === 'claims') return { k: 'record', fields: program.claims };
            // PS8.9, PD6.2: the agent and the person it acts for, from the step's innermost mandate.
            if (e.prop === 'mandate') return { k: 'record', fields: { delegate: { k: 'str', values: null }, delegator: { k: 'str', values: null } } };
            err('PL1001', e, `step has no field ${e.prop} (claims, mandate)`);
            return null;
          }
          if (e.object.kind === 'Name' && e.object.name === 'proposal' && !vars.has('proposal')) {
            if (e.prop === 'kind') return { k: 'str', values: ['effect', 'send'] };
            err('PL1001', e, `proposal has no field ${e.prop} (kind)`);
            return null;
          }
          // S22: `Type.C`, a qualified constructor.
          if (e.object.kind === 'Name' && expect?.k === 'enum' && e.object.name === expect.name) {
            if (expect.members.includes(e.prop)) return expect;
            err('PL1001', e, `${e.prop} is not a constructor of ${expect.name}`);
            return null;
          }
          const o = type(e.object);
          if (!o) return null;
          if (o.k === 'machineRef') {
            const m = program.machines.get(o.machine)!;
            const f = m.fields.get(e.prop);
            if (!f) { err('PL1001', e, `${o.machine} has no field ${e.prop} a policy can read (a bool, an enum, a range, a string or a Conf)`); return null; }
            return f;
          }
          if (o.k === 'decisionRef') {
            const f = DECISION_FIELDS(program.decisions.get(o.decision)!.result)[e.prop];
            if (!f) { err('PL1001', e, `decision("${o.decision}") has no field ${e.prop} (taken, answer, conf, margin, model, calibration)`); return null; }
            return f;
          }
          if (o.k === 'record') {
            // Review C3: a claims field two claims types declare with different types has no one type to read it at.
            const claimsRead = e.object.kind === 'Member' && e.object.object.kind === 'Name' && ((e.object.object.name === 'step' && e.object.prop === 'claims') || (e.object.object.name === 'lineage' && e.object.prop === 'origin'));
            if (claimsRead && program.claimsConflicts.has(e.prop)) { err('PL1201', e, `${e.prop} is a field of the claims types ${program.claimsConflicts.get(e.prop)!.join(' and ')} with different types, so a policy cannot read it`); return null; }
            const f = o.fields[e.prop];
            if (!f) { err('PL1001', e, `no field ${e.prop} here (${Object.keys(o.fields).join(', ')})`); return null; }
            return f;
          }
          err('PL1201', e, `.${e.prop} reads a field of a value that has none`);
          return null;
        }
        case 'Call': {
          if (e.callee === 'machine' || e.callee === 'decision') {
            const a = e.args[0];
            if (e.args.length !== 1 || a.kind !== 'String') { err('PL1201', e, `${e.callee}(…) takes one string literal`); return null; }
            if (e.callee === 'machine') {
              const m = program.machines.get(a.value);
              if (!m) { err('PL1001', e, `machine("${a.value}") names no machine of the program (module.Machine)`); return null; }
              read.add(a.value);
              // S147: a read that can never be known is a finding, the policy form of a vacuous property (S113).
              if (!m.service && m.effects.length === 0) err('PL6502', e, `machine("${a.value}") is never known: it is not a service machine (a singleton) and emits no effect, so no proposal carries its snapshot (S147)`);
              return { k: 'machineRef', machine: a.value };
            }
            if (!program.decisions.has(a.value)) { err('PL1001', e, `decision("${a.value}") names no decision of the program`); return null; }
            return { k: 'decisionRef', decision: a.value };
          }
          // PS8.8, PD6.1: the age of the step's claims, in milliseconds since verifiedAt or statusAt.
          if (e.callee === 'age' || e.callee === 'statusAge') {
            const a = e.args[0];
            if (e.args.length !== 1 || a.kind !== 'Member' || a.object.kind !== 'Name' || a.object.name !== 'step' || a.prop !== 'claims') { err('PL1201', e, `${e.callee}(…) takes step.claims`); return null; }
            return { k: 'int', lo: 0, hi: 1_000_000_000_000 };
          }
          if (e.callee === 'unknown') {
            if (e.args.length !== 1) { err('PL1201', e, 'unknown(x) takes one argument'); return null; }
            type(e.args[0]);
            return { k: 'bool' };
          }
          if (e.callee === 'has') {
            const s = type(e.args[0]);
            const x = type(e.args[1]);
            if (s && s.k !== 'labels') err('PL1201', e, '`s has x` needs a set of labels on the left (effect.labels)');
            if (x && x.k !== 'str') err('PL1201', e, '`s has x` needs a string on the right');
            else if (x?.k === 'str' && x.values) for (const v of x.values) if (!LABELS.has(v)) err('PL1001', e.args[1], `${JSON.stringify(v)} is not a label of the closed vocabulary (PT6.2)`);
            return { k: 'tri' };
          }
          err('PL1001', e, `${e.callee}(…) is not a policy function (machine, decision, unknown, age, statusAge)`);
          return null;
        }
        case 'Unary': {
          const t = type(e.arg);
          if (e.op === '!') { if (t && !boolish(t)) err('PL1201', e, '! needs a condition'); return t?.k === 'bool' ? t : { k: 'tri' }; }
          if (t && t.k !== 'int') err('PL1201', e, '- needs an integer');
          return t;
        }
        case 'Binary': {
          if (e.op === '&&' || e.op === '||' || e.op === 'implies') {
            const l = type(e.left); const r = type(e.right);
            if (l && !boolish(l)) err('PL1201', e.left, `${e.op} needs a condition on the left`);
            if (r && !boolish(r)) err('PL1201', e.right, `${e.op} needs a condition on the right`);
            return l?.k === 'bool' && r?.k === 'bool' ? { k: 'bool' } : { k: 'tri' };
          }
          if (['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
            // A bare constructor takes the other side's type (S22): it is typed after the side that fixes it.
            const bare = (x: A.Expr) => x.kind === 'Name' && !vars.has(x.name) && x.name !== 'effect' && x.name !== 'proposal' && x.name !== 'send';
            let l: PType | null;
            let r: PType | null;
            // When the side that fixes it is already wrong, the constructor is not reported a second time.
            if (bare(e.left) && !bare(e.right)) { r = type(e.right); l = r ? type(e.left, r) : null; }
            else { l = type(e.left); r = l === null && bare(e.right) ? null : type(e.right, l); }
            if (l && r && !comparable(l, r, e.op)) err('PL1201', e, `${show(l)} ${e.op} ${show(r)} compares values of different types`);
            else if (l && r) known(l, r, e);
            return { k: 'tri' };
          }
          const l = type(e.left); const r = type(e.right);
          if ((l && l.k !== 'int') || (r && r.k !== 'int')) err('PL1201', e, `${e.op} needs integers`);
          return { k: 'int', lo: -1_000_000, hi: 1_000_000 };
        }
        case 'In': {
          const t = type(e.expr);
          for (const x of e.set) { const s = type(x, t); if (t && s && !comparable(t, s, '==')) err('PL1201', x, `${show(s)} is not a value of ${show(t)}`); else if (t && s) known(t, s, x); }
          return { k: 'tri' };
        }
        default:
          err('PL1201', e, `${e.kind} is not a policy expression (PT2.3)`);
          return null;
      }
    };
    // Review B6, PT8.1: a string literal compared with a field whose values the program fixes (an effect's kind or
    // class, a machine id) must be one of them, or the comparison silently matches nothing.
    const known = (a: PType, b: PType, at: A.Expr) => {
      if (a.k !== 'str' || b.k !== 'str' || !a.values || !b.values) return;
      const [lit, dom] = a.values.length === 1 && b.values.length !== 1 ? [a, b] : [b, a];
      for (const v of lit.values!) if (!dom.values!.includes(v)) err('PL1001', at, `${JSON.stringify(v)} is not one of the program's values here (${dom.values!.slice(0, 8).map((x) => JSON.stringify(x)).join(', ')}${dom.values!.length > 8 ? ', …' : ''})`);
    };
    const condition = (e: A.Expr, what: string) => {
      const t = type(e);
      if (t && !boolish(t)) err('PL1201', e, `${what} must be a condition`);
    };

    const names = new Set<string>();
    for (const it of p.items) {
      if (names.has(it.name)) err('PL1002', it, `${it.name} is declared twice in policy ${p.name}`);
      names.add(it.name);
      switch (it.kind) {
        case 'RuleObligation': {
          if (it.when) condition(it.when, 'when');
          condition(it.require, 'require');
          // PS8.8, as ruled: a rule over a claim's age denies; it never escalates or warns on age alone.
          const readsAge = (x: unknown): boolean => !!x && typeof x === 'object' && (((x as { kind?: string; callee?: string }).kind === 'Call' && ['age', 'statusAge'].includes((x as { callee: string }).callee)) || Object.values(x as object).some(readsAge));
          if (it.severity !== 'deny' && (readsAge(it.when) || readsAge(it.require))) err('PL1201', it, `obligation ${it.name} reads a claim's age and is ${it.severity}: a rule over an age denies, and the host presents fresh claims again (PS8.8)`);
          break;
        }
        case 'MachineObligation': {
          const states = new Set(it.states);
          if (states.size !== it.states.length) err('PL1002', it, `obligation ${it.name} names a state twice`);
          const known = (s: string) => { if (!states.has(s)) err('PL1001', it, `obligation ${it.name} has no state ${s}`); };
          known(it.initial);
          for (const t of it.transitions) { if (t.from !== '*') t.from.forEach(known); known(t.to); condition(t.when, 'a transition\'s when'); }
          for (const g of it.guards) { g.in.forEach(known); condition(g.when, 'a guard\'s when'); }
          it.end.forEach(known);
          break;
        }
        case 'InvariantObligation':
          condition(it.expr, 'an invariant');
          break;
        case 'Never':
          condition(it.when, 'a never statement');
          break;
        case 'Recalled':
          break;
      }
    }
    reads.set(p.name, [...read].sort());
  }
  return { diagnostics, reads };
}

function comparable(a: PType, b: PType, op: string): boolean {
  const ordered = !['==', '!='].includes(op);
  if (a.k === 'int' && b.k === 'int') return true;
  if (a.k === 'conf' && b.k === 'conf') return true;
  if (ordered) return false;
  if (a.k === 'str' && b.k === 'str') return true;
  if (a.k === 'enum' && b.k === 'enum') return a.name === b.name;
  if ((a.k === 'bool' || a.k === 'tri') && (b.k === 'bool' || b.k === 'tri')) return true;
  return false;
}

function show(t: PType): string {
  switch (t.k) {
    case 'enum': return t.name;
    case 'int': return 'an integer';
    case 'str': return 'a string';
    case 'conf': return 'a Conf';
    case 'labels': return 'a set of labels';
    case 'machineRef': return `machine("${t.machine}")`;
    case 'decisionRef': return `decision("${t.decision}")`;
    case 'record': return 'a record';
    default: return 'a condition';
  }
}
