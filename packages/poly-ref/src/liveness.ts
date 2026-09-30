// Liveness under weak fairness (PS5.5, PS6), decided on the graph the explorer already builds.
//
// PS6.4: `eventually P` fails iff a strongly connected component C of the states a behaviour can reach while
// P has not yet held (1) holds no P-state, (2) has at least one edge, rejected and unhandled stutters
// included, and (3) is fair: every listed group is either taken on an edge of C or disabled in some state
// of C. `P leads to Q` is the same test on the states reachable from a state where P holds and Q does not,
// through states where Q does not hold. The counterexample is a lasso: the path to C, then a cycle through
// C that takes the edge or visits the state each group's condition names.
//
// The prefix must avoid the goal as well as the component: a behaviour that meets P on its way to C
// satisfies `eventually P`. So the components are those of the pending part of the graph, reached from the
// initial state (or from a P-and-not-Q state) through goal-free states.
import type { Edge, Graph } from './explore.js';

/** A fairness group (PS6.1): which edges take it, and in which states it is enabled. */
export interface FairGroup {
  name: string;
  /** Whether an edge is an accepted step of the group. */
  takes(e: Edge<unknown>): boolean;
}

export interface Lasso {
  /** The path from the initial state to the component's first state. */
  prefix: Edge<unknown>[];
  /** A cycle from that state back to it, through the component. */
  cycle: Edge<unknown>[];
  /** The component's states. */
  component: number[];
}

export interface LivenessQuery {
  /** The goal: P for `eventually P`, Q for `P leads to Q`. */
  goal: (state: number) => boolean;
  /** For `leads to`, where the obligation starts (P); null for `eventually`. */
  from: ((state: number) => boolean) | null;
  groups: FairGroup[];
}

/** Every fair component of the pending part of g, each with its lasso, in the order the components are reached. */
export function fairCycles<S>(g: Graph<S>, q: LivenessQuery, max = 16): Lasso[] {
  const n = g.states.length;
  const goal = Array.from({ length: n }, (_, i) => q.goal(i));
  // The pending part: reached through goal-free states from where the obligation starts.
  const starts = q.from === null ? (goal[0] ? [] : [0]) : Array.from({ length: n }, (_, i) => i).filter((i) => q.from!(i) && !goal[i]);
  const pending = new Uint8Array(n);
  const parent = new Map<number, Edge<S> | null>();
  const queue: number[] = [];
  for (const s of starts) { pending[s] = 1; parent.set(s, null); queue.push(s); }
  for (let h = 0; h < queue.length; h++) {
    for (const k of g.out[queue[h]]) {
      const e = g.edges[k];
      if (e.to === null || goal[e.to] || pending[e.to]) continue;
      pending[e.to] = 1;
      parent.set(e.to, e);
      queue.push(e.to);
    }
  }
  const inner = (e: Edge<S>) => e.to !== null && pending[e.from] === 1 && pending[e.to] === 1;

  // Tarjan's algorithm over the pending part, iterative (the graphs are small, the stacks need not be).
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const comps: number[][] = [];
  let counter = 0;
  for (const root of queue) {
    if (index[root] >= 0) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root); onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const outs = g.out[top.v];
      if (top.i < outs.length) {
        const e = g.edges[outs[top.i++]];
        if (!inner(e)) continue;
        const w = e.to!;
        if (index[w] < 0) { index[w] = low[w] = counter++; stack.push(w); onStack[w] = 1; work.push({ v: w, i: 0 }); }
        else if (onStack[w]) low[top.v] = Math.min(low[top.v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) low[work[work.length - 1].v] = Math.min(low[work[work.length - 1].v], low[top.v]);
      if (low[top.v] === index[top.v]) {
        const c: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; c.push(w); } while (w !== top.v);
        comps.push(c);
      }
    }
  }

  const order = new Map(queue.map((s, i) => [s, i]));
  const out: Lasso[] = [];
  for (const c of comps.sort((a, b) => Math.min(...a.map((s) => order.get(s)!)) - Math.min(...b.map((s) => order.get(s)!)))) {
    const inC = new Set(c);
    const edges = c.flatMap((s) => g.out[s].map((k) => g.edges[k])).filter((e) => e.to !== null && inC.has(e.to));
    if (!edges.length) continue; // (2)
    // (3): each group taken inside C, or disabled in some state of C.
    const targets: ({ edge: Edge<S> } | { state: number })[] = [];
    let fair = true;
    for (const grp of q.groups) {
      const taken = edges.find((e) => grp.takes(e));
      if (taken) { targets.push({ edge: taken }); continue; }
      const disabled = c.find((s) => !g.out[s].some((k) => grp.takes(g.edges[k])));
      if (disabled === undefined) { fair = false; break; }
      targets.push({ state: disabled });
    }
    if (!fair) continue;
    const entry = c.reduce((a, b) => (order.get(a)! <= order.get(b)! ? a : b));
    const prefix: Edge<S>[] = [];
    for (let at = parent.get(entry); at; at = parent.get(at.from)) prefix.unshift(at);
    // For `leads to`, the obligation starts somewhere reachable: prepend the path to that start.
    const start = prefix.length ? prefix[0].from : entry;
    if (q.from !== null) prefix.unshift(...pathTo(g, start));
    out.push({ prefix, cycle: cycleThrough(g, inC, entry, targets), component: [...c].sort((a, b) => a - b) });
    if (out.length >= max) break;
  }
  return out as Lasso[];
}

/** The edges from the initial state to state i along the explorer's BFS tree. */
function pathTo<S>(g: Graph<S>, i: number): Edge<S>[] {
  const path: Edge<S>[] = [];
  for (let k = i; g.parent[k] !== null; k = g.edges[g.parent[k]!].from) path.unshift(g.edges[g.parent[k]!]);
  return path;
}

/** A cycle from entry back to entry inside C that takes each target edge and visits each target state; never empty. */
function cycleThrough<S>(g: Graph<S>, inC: Set<number>, entry: number, targets: ({ edge: Edge<S> } | { state: number })[]): Edge<S>[] {
  const walk: Edge<S>[] = [];
  let at = entry;
  const within = (a: number, b: number): Edge<S>[] => {
    if (a === b) return [];
    const prev = new Map<number, Edge<S>>();
    const q = [a];
    const seen = new Set([a]);
    for (let h = 0; h < q.length; h++) {
      for (const k of g.out[q[h]]) {
        const e = g.edges[k];
        if (e.to === null || !inC.has(e.to) || seen.has(e.to)) continue;
        seen.add(e.to); prev.set(e.to, e); q.push(e.to);
        if (e.to === b) { const p: Edge<S>[] = []; for (let x = b; x !== a; x = prev.get(x)!.from) p.unshift(prev.get(x)!); return p; }
      }
    }
    throw new Error('poly-ref: no path inside a strongly connected component');
  };
  for (const t of targets) {
    if ('edge' in t) { walk.push(...within(at, t.edge.from), t.edge); at = t.edge.to!; }
    else { walk.push(...within(at, t.state)); at = t.state; }
  }
  walk.push(...within(at, entry));
  if (!walk.length) {
    // No target: any edge of C out of entry, then back.
    const e = g.out[entry].map((k) => g.edges[k]).find((x) => x.to !== null && inC.has(x.to))!;
    walk.push(e, ...within(e.to!, entry));
  }
  return walk;
}
