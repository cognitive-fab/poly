// The computed worst case (availability spec BL-1/BL-2): how many evaluation
// steps one call can cost, derived from the plan at admission, never measured
// at runtime. Published per policy beside the measured percentiles (`bench`)
// and stored in the admission report; a declared `budget.steps` that the bound
// exceeds is an admission finding naming the obligation that costs the most.
//
// The unit is a PX evaluation step: `evaluate()` charges one per AST node it
// visits and throws past its budget, so a static node count is an exact upper
// bound for a closed expression. The only cost that grows with anything but the
// policy is a quantifier over `history`, whose body runs once per window entry:
// it is charged `historyWindow` times (the window is bounded by configuration,
// so the bound stays a constant of the deployment). A quantifier over a list
// literal is charged the literal's length; over any other list, the window.
//
// Per action the interpreter evaluates every rule (when + require), every
// machine's guards and transitions (selector and route), every lifted counter's
// predicate, and per patch every invariant. A call carries at most MAX_ACTIONS
// canonical actions (core/action.mjs), so perCall = MAX_ACTIONS × perAction.
// Kernel overhead outside PX (reset-then-merge, labeling) is a measured constant
// and is reported by `bench`, not here.

const QUANTIFIERS = new Set(['count', 'any', 'all', 'none', 'first', 'last']);
export const MAX_ACTIONS = 64;

/** Steps to evaluate one AST. */
export function exprCost(ast, window) {
  if (!Array.isArray(ast) || typeof ast[0] !== 'string') return 0;
  if (ast[0] === 'call' && QUANTIFIERS.has(ast[1])) {
    const [, , list, fn] = ast;
    const n = Array.isArray(list) && list[0] === 'list' ? list.length - 1 : window;
    return 1 + exprCost(list, window) + n * exprCost(fn, window);
  }
  let c = 1;
  for (let i = 1; i < ast.length; i++) c += exprCost(ast[i], window);
  return c;
}

/**
 * @param {object} plan
 * @param {object} [opts] { historyWindow?: number, budget?: number|null }
 * @returns {{ unit, historyWindow, perAction, perPatch, perCall, maxActions, byObligation, budget, exceeded, worst }}
 */
export function computeBound(plan, opts = {}) {
  const W = Math.max(1, opts.historyWindow ?? 500);
  const by = {};
  const add = (id, n) => { by[id] = (by[id] ?? 0) + n; };
  for (const r of plan.rules ?? []) {
    add(r.id, exprCost(r.when, W) + exprCost(r.require, W));
    for (const l of r.lifted ?? []) add(r.id, exprCost(l.pred, W) + 2);
  }
  for (const m of plan.machines ?? []) {
    let n = 1; // the state read
    for (const g of m.guards ?? []) n += exprCost(g.when, W) + exprCost(g.holds, W) + 1;
    for (const t of m.transitions ?? []) n += exprCost(t.when, W) + exprCost(t.route, W) + Object.values(t.set ?? {}).reduce((a, e) => a + exprCost(e, W), 0) + 1;
    add(m.id, n);
  }
  let perPatch = 0;
  for (const inv of plan.invariants ?? []) { const n = exprCost(inv.ast, W); add(inv.id, n); perPatch += n; }
  const perAction = Object.entries(by).reduce((a, [id, n]) => a + ((plan.invariants ?? []).some((i) => i.id === id) ? 0 : n), 0) + (plan.keys?.length ?? 0);
  const perCall = MAX_ACTIONS * perAction + perPatch;
  const worst = Object.entries(by).sort((a, b) => b[1] - a[1])[0] ?? null;
  const budget = Number.isInteger(opts.budget) ? opts.budget : null;
  return {
    unit: 'px-eval-steps',
    historyWindow: W,
    openHistory: (plan.rules ?? []).some((r) => r.open),
    maxActions: MAX_ACTIONS,
    perAction,
    perPatch,
    perCall,
    byObligation: by,
    worst: worst ? { obligation: worst[0], steps: worst[1] } : null,
    budget,
    exceeded: budget !== null && perCall > budget,
  };
}
