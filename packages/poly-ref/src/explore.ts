// Exploration of the checked instance (PS4).
//
// The explorer is generic over a System: an initial state, the labelled
// successors of a state, and a key. A single machine is one System (below).
// A configuration of machines (PS13, M1) is another, over global states
// (σ, μ), and liveness (PS6.4, M2) is a pass over the Graph this returns:
// every edge is kept with its label and verdict, rejected and unhandled
// stutters included (PS3.3), because the fairness test counts them as edges.
import type { RMachine } from './model.js';
import { dataDomain, inCheckDomain, inType } from './model.js';
import { transition, initialState } from './step.js';
import type { Verdict } from './eval.js';
import { stateKey, type State, type Value } from './values.js';

export interface Label {
  action: string;
  data: Record<string, Value>;
  verdict: Verdict;
}

/**
 * Where a transition from a state of Reach(I) goes (PS4.2a):
 *   - `state`: a state in the instance, explored;
 *   - `escape`: a value outside a field's declared type, not a state at all (PL3102);
 *   - `bound`: a legal state outside a check domain, not explored (PL3901).
 */
export type Outcome<S> =
  | { kind: 'state'; state: S }
  | { kind: 'escape'; state: S; field: string; value: Value }
  | { kind: 'bound'; state: S; field: string; value: Value };

export interface System<S> {
  initial(): S;
  successors(s: S): { label: Label; outcome: Outcome<S> }[];
  key(s: S): string;
}

export interface Edge<S> {
  from: number;
  label: Label;
  /** The target state's index, or null when the outcome left the instance. */
  to: number | null;
  outcome: Outcome<S>;
}

export interface Graph<S> {
  states: S[];
  index: Map<string, number>;
  edges: Edge<S>[];
  /** Outgoing edge indices per state. */
  out: number[][];
  /** The edge that first discovered each state (null for the initial state): shortest paths. */
  parent: (number | null)[];
  /** Exploration stopped at `maxStates` with states left unexpanded (PT19, PL3901). */
  capHit: boolean;
}

export function explore<S>(sys: System<S>, maxStates = 1_000_000): Graph<S> {
  const init = sys.initial();
  const g: Graph<S> = { states: [init], index: new Map([[sys.key(init), 0]]), edges: [], out: [[]], parent: [null], capHit: false };
  for (let head = 0; head < g.states.length; head++) {
    const s = g.states[head];
    for (const { label, outcome } of sys.successors(s)) {
      let to: number | null = null;
      if (outcome.kind === 'state') {
        const k = sys.key(outcome.state);
        const known = g.index.get(k);
        if (known !== undefined) to = known;
        else if (g.states.length < maxStates) {
          to = g.states.length;
          g.index.set(k, to);
          g.states.push(outcome.state);
          g.out.push([]);
          g.parent.push(g.edges.length);
        } else {
          g.capHit = true;
        }
      }
      g.out[head].push(g.edges.length);
      g.edges.push({ from: head, label, to, outcome });
    }
  }
  return g;
}

/** The edges from the initial state to state i, along the BFS tree: a shortest path. */
export function pathTo<S>(g: Graph<S>, i: number): Edge<S>[] {
  const path: Edge<S>[] = [];
  for (let k = i; g.parent[k] !== null; k = g.edges[g.parent[k]!].from) path.push(g.edges[g.parent[k]!]);
  return path.reverse();
}

/** A single machine as a System over the checked instance I (PS4.2, PS4.2a). */
export function machineSystem(M: RMachine): System<State> {
  const domains = M.actions.map((a) => ({ a, ds: dataDomain(a, M) }));
  return {
    initial: () => initialState(M),
    key: (s) => stateKey(s, M.fieldNames),
    successors: (s) => {
      const out: { label: Label; outcome: Outcome<State> }[] = [];
      for (const { a, ds } of domains) {
        for (const d of ds) {
          const st = transition(M, s, a.name, d);
          const label: Label = { action: a.name, data: d, verdict: st.verdict };
          out.push({ label, outcome: classify(M, st.next) });
        }
      }
      return out;
    },
  };
}

function classify(M: RMachine, s: State): Outcome<State> {
  for (const f of M.fields) {
    if (!inType(s[f.name], f.type, M)) return { kind: 'escape', state: s, field: f.name, value: s[f.name] };
  }
  for (const f of M.fields) {
    if (!inCheckDomain(s[f.name], f, M)) return { kind: 'bound', state: s, field: f.name, value: s[f.name] };
  }
  return { kind: 'state', state: s };
}
