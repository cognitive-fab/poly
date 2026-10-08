// Taint and the flow rule (PS17, M10, S300, S301), written from 04-semantics.
//
// Every Content and Items value carries a taint, a ghost no handler reads (PS17.1). A retrieval's and a decision's
// intents add their taint to the instance's pending taints, and the step that completes one takes a pending taint, which
// every Content and Items of its data carries (PS17.2). The flow rule is a step property over those taints: every effect
// intent other than a retrieval, a decision or a remember goes to a recipient that may read the taint of each Content of
// its payload (PS17.3); a remember may not widen its content's audience (PS17.5).
//
// The ghost adds no behaviour: this system's transitions are the machine's, with the taints carried beside the values,
// so its states project onto the states of the machine's own graph. It is explored apart, only for a machine whose
// program declares a source, and its size is reported as the flow rule's own.
import type { RMachine, RMemory } from './model.js';
import { dataDomain, inCheckDomain, inType } from './model.js';
import { transition, initialState, type Intent } from './step.js';
import type { Edge, Graph, Label, Outcome, System } from './explore.js';
import { BOTTOM, bare, isTainted, join, stateKey, taintOf, taintsKey, taintText, withTaint, type State, type Taint, type Value } from './values.js';

/** PS17.2: more pending taints than this for one effect or decision of one instance is a bound hit. */
export const PENDING_BOUND = 3;

/** One pending taint: the kind of the intent and its taint. */
export interface Pending { kind: string; t: Taint }
export interface TaintState { s: State; pending: Pending[] }

const pendingKey = (p: Pending) => `${p.kind}=${taintText(p.t)}`;
const sortPending = (ps: Pending[]) => [...ps].sort((a, b) => (pendingKey(a) < pendingKey(b) ? -1 : pendingKey(a) > pendingKey(b) ? 1 : 0));

/** The key of a state with its ghost: the state, the taints its values carry, and the pending taints. */
export function taintStateKey(M: RMachine, x: TaintState): string {
  return `${stateKey(x.s, M.fieldNames)}#${M.fieldNames.map((f) => taintsKey(x.s[f])).join('|')}#${x.pending.map(pendingKey).join(';')}`;
}

/** PS17.2: the data of a completion that takes the pending taint t: each Content and Items of it carries t. */
export function taintData(M: RMachine, action: string, d: Record<string, Value>, t: Taint): Record<string, Value> {
  const a = M.actions.find((x) => x.name === action)!;
  const out = { ...d };
  for (const p of a.params) {
    if (p.type.k === 'content') out[p.name] = withTaint(d[p.name], t, 'content');
    if (p.type.k === 'items') out[p.name] = withTaint(d[p.name], t, 'items');
  }
  return out;
}

/** PS17.2: the taint of an intent that taints its completion, or null for any other intent. */
export function intentTaint(mem: RMemory, i: Intent, representatives: string[]): Taint | null {
  if (i.type !== 'effect') return null;
  const r = mem.retrievals.get(i.kind);
  if (r) {
    if (!r.owned) return { c: r.cls, o: [] };
    if (r.owner === null) return { c: r.cls, o: [...representatives].sort() };
    const v = bare(i.payload[r.owner] ?? null);
    return { c: r.cls, o: typeof v === 'string' ? [v] : [] };
  }
  if (mem.decisions.has(i.kind)) return Object.values(i.payload).reduce<Taint>((t, v) => join(t, taintOf(v)), BOTTOM);
  return null;
}

/** PS17.3: whether a recipient of class c and principal p may read the taint t. */
export function mayRead(c: number, p: string | null, t: Taint): boolean {
  return c > t.c || (c >= t.c && t.o.length === 0) || (t.o.length === 1 && p !== null && t.o[0] === p);
}

/** A broken flow rule at one intent, in words. */
export interface FlowBreak { code: 'PL6831' | 'PL6832'; text: string }

/**
 * PS17.3, PS17.5: the flow rule over one accepted step's intents. `claims` is the class in the step's claims, and the
 * claimant's principal, when the action's claims carry them; the class is the recipient's only when the recipient is the
 * claimant (S324).
 * the action's claims carry one; `channelClass` gives a channel's provider effect its declared class.
 */
export function flowBreaks(mem: RMemory, intents: Intent[], claims: StepClaims | null, channelClass: (kind: string) => number | null): FlowBreak[] {
  const out: FlowBreak[] = [];
  const name = (c: number) => mem.classes[c] ?? String(c);
  const owners = (t: Taint) => (t.o.length ? `{${t.o.join(', ')}}` : '{}');
  for (const i of intents) {
    if (i.type !== 'effect' || i.kind.startsWith('outcome.') || mem.retrievals.has(i.kind) || mem.decisions.has(i.kind)) continue;
    const w = mem.remembers.get(i.kind);
    if (w) {
      // PS17.5: every recipient that may read the item may read its content, over every class and principal.
      const subject = bare(i.payload[w.about] ?? null);
      const item: Taint = { c: w.cls, o: w.owned && typeof subject === 'string' ? [subject] : [] };
      const readers: (string | null)[] = [typeof subject === 'string' ? subject : null, '$other', null];
      for (const [f, v] of Object.entries(i.payload)) {
        // A Content with no taint record here carries ⊥, which no item widens.
        if (!isTainted(v)) continue;
        const t = taintOf(v);
        const wider = mem.classes.some((_, c) => readers.some((p) => mayRead(c, p, item) && !mayRead(c, p, t)));
        if (wider) out.push({ code: 'PL6832', text: `${i.kind} writes ${f}, tainted (${name(t.c)}, ${owners(t)}), as an item of ${w.source} readable by (${name(item.c)}, ${owners(item)}), a wider audience (PS17.5)` });
      }
      continue;
    }
    const rec = mem.recipients.get(i.kind);
    const p = rec?.to ? bare(i.payload[rec.to] ?? null) : null;
    const claimant = claims && claims.cls !== null && (!rec?.to || (typeof p === 'string' && p === claims.principal)) ? claims.cls : null;
    const c = claimant ?? rec?.cls ?? channelClass(i.kind) ?? 0;
    for (const [f, v] of Object.entries(i.payload)) {
      // PS17.3: the Content values of the payload; an untainted one carries ⊥, which every recipient reads.
      if (!isTainted(v)) continue;
      const t = taintOf(v);
      if (mayRead(c, typeof p === 'string' ? p : null, t)) continue;
      out.push({ code: 'PL6831', text: `${i.kind} sends ${f}, tainted (${name(t.c)}, ${owners(t)}), to a recipient of class ${name(c)}${typeof p === 'string' ? ` and principal ${p}` : ' and no principal'}, who may not read it (PS17.3)` });
    }
  }
  return out;
}

/** PS17.3, S324: a step's claims as the flow rule reads them: its class, and the claimant's principal. */
export interface StepClaims { cls: number | null; principal: string | null }

/**
 * PS17.3: the class in a step's claims, when the action's claims type has exactly one field of type Audience, and the
 * claimant's principal, when it has exactly one field of type Principal (S324).
 */
export function claimsClass(M: RMachine, action: string, d: Record<string, Value>): StepClaims | null {
  const a = M.actions.find((x) => x.name === action);
  const mem = M.memory;
  if (!a?.claims || !mem || a.claims.type.k !== 'record') return null;
  const fields = M.records.get(a.claims.type.name)!.fields;
  const fs = fields.filter((f) => f.type.k === 'union' && f.type.name === 'Audience');
  const ps = fields.filter((f) => f.type.k === 'principal');
  const c = d.$claims;
  const rec = c && typeof c === 'object' && 'fields' in c ? c.fields : null;
  const v = fs.length === 1 && rec ? rec[fs[0].name] : null;
  const who = ps.length === 1 && rec ? bare(rec[ps[0].name] ?? null) : null;
  return { cls: v && typeof v === 'object' && 'ctor' in v ? mem.classes.indexOf(v.ctor) : null, principal: typeof who === 'string' ? who : null };
}

/** A machine with its ghost, as a System (PS17.2): the machine's steps, each completion taking a pending taint. */
export function taintSystem(M: RMachine): System<TaintState> {
  const mem = M.memory!;
  const reps = Array.from({ length: M.principals }, (_, i) => `p${i + 1}`);
  const domains = M.actions.map((a) => ({ a, ds: dataDomain(a, M) }));
  return {
    initial: () => ({ s: initialState(M), pending: [] }),
    key: (x) => taintStateKey(M, x),
    successors: (x) => {
      const out: { label: Label; outcome: Outcome<TaintState> }[] = [];
      for (const { a, ds } of domains) {
        const kinds = mem.completes.get(a.name) ?? [];
        // PS17.2: one choice per distinct pending taint of a kind this action completes; ⊥ when none is pending. S322:
        // an armed timer whose data carried a taint is pending as `timer <key> <action>`, and its firing takes it.
        const takes = (k: string) => kinds.includes(k) || (k.startsWith('timer ') && k.endsWith(` ${a.name}`));
        const seen = new Set<string>();
        const choices: (number | null)[] = [];
        x.pending.forEach((p, j) => { if (takes(p.kind) && !seen.has(pendingKey(p))) { seen.add(pendingKey(p)); choices.push(j); } });
        if (!choices.length) choices.push(null);
        for (const d of ds) {
          for (const j of choices) {
            const data = j === null ? d : taintData(M, a.name, d, x.pending[j].t);
            const rest = j === null ? x.pending : x.pending.filter((_, k) => k !== j);
            const st = transition(M, x.s, a.name, data);
            const added = st.verdict.kind === 'accepted' ? st.effects.flatMap((i) => { const t = intentTaint(mem, i, reps); return t ? [{ kind: i.kind, t }] : []; }) : [];
            // S322: setting a timer's key again replaces its pending taint, cancelling it removes it.
            let kept = rest;
            if (st.verdict.kind === 'accepted') for (const i of st.effects) {
              if (i.type !== 'timer' && i.type !== 'cancel') continue;
              kept = kept.filter((p) => !p.kind.startsWith(`timer ${i.key} `));
              if (i.type === 'timer') { const tt = Object.values(i.data).reduce<Taint>((acc, v) => join(acc, taintOf(v)), BOTTOM); if (tt.c !== 0 || tt.o.length) added.push({ kind: `timer ${i.key} ${i.action}`, t: tt }); }
            }
            const pending = sortPending([...kept, ...added]);
            const label: Label = { action: a.name, data, verdict: st.verdict, effects: st.effects };
            const next: TaintState = { s: st.next, pending };
            const over = [...new Set(pending.map((p) => p.kind))].find((k) => pending.filter((p) => p.kind === k).length > PENDING_BOUND);
            out.push({ label, outcome: over ? { kind: 'bound', state: next, field: `pending ${over}`, value: PENDING_BOUND + 1 } : classify(M, next) });
          }
        }
      }
      return out;
    },
  };
}

function classify(M: RMachine, x: TaintState): Outcome<TaintState> {
  for (const f of M.fields) if (!inType(x.s[f.name], f.type, M)) return { kind: 'escape', state: x, field: f.name, value: x.s[f.name] };
  for (const f of M.fields) if (!inCheckDomain(x.s[f.name], f, M)) return { kind: 'bound', state: x, field: f.name, value: x.s[f.name] };
  return { kind: 'state', state: x };
}

/** The first edge of each code, in BFS order, that breaks the flow rule: the shortest witnesses. */
export function firstBreaks(M: RMachine, g: Graph<TaintState>, channelClass: (kind: string) => number | null = () => null): { edge: Edge<TaintState>; brk: FlowBreak }[] {
  const out: { edge: Edge<TaintState>; brk: FlowBreak }[] = [];
  const found = new Set<string>();
  for (const e of g.edges) {
    if (e.label.verdict.kind !== 'accepted') continue;
    for (const brk of flowBreaks(M.memory!, e.label.effects, claimsClass(M, e.label.action, e.label.data), channelClass)) {
      if (found.has(brk.code)) continue;
      found.add(brk.code);
      out.push({ edge: e, brk });
    }
  }
  return out;
}

