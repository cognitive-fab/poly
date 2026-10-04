// The engine's side of a lowered policy, stepped one proposal at a time: Polyaxion's own plan interpreter
// (`routeAction`, `stepPlan`), the function its generated module requires, so what is compared is what the kernel
// runs. Shared by translation validation (poly-check) and the gate host (PT9).
//
// S158: Polyaxion evaluates every rule before any machine guard and reports its first refusal, so an escalate rule
// can hide a guard's deny, where PS8.3 says deny. Until the engine combines refusals itself, the host asks the same
// pure interpreter whether a deny stands behind an escalation, by lifting the escalations (an approval lifts only
// those, Polyaxion 02 §2.6), and decides deny when one does.

export type EngineDecision = 'allow' | 'deny' | 'escalate';

/** The canonical action a proposal is to the engine: a `custom.poly.*` kind with the proposal's fields. */
export function actionOf(proposal: Record<string, any>): Record<string, any> {
  return { kind: proposal.proposal === 'send' ? 'custom.poly.send' : 'custom.poly.effect', ...proposal };
}

export function decisionOfReject(reject: string | null): EngineDecision {
  if (!reject) return 'allow';
  return /:escalate$/.test(reject) ? 'escalate' : 'deny';
}

/**
 * Steps a compiled plan: the decision on a proposal from a model, and the model after it. `px` is the Polyaxion
 * package (its `core` namespace holds the interpreter); `plan` is `compileToTriple(doc).plan`.
 */
export function policyEngine(px: any, plan: any) {
  const core = px.core;
  const run = { id: 'poly', scope: plan.policy?.scope ?? '', step: 0 };
  const initial = () => Object.fromEntries(plan.keys.map((k: { key: string; initial: unknown }) => [k.key, k.initial]));
  // `approved`: the proposal carries a person's approval (PT12.5), as the gate passes it to the engine.
  const step = (model: any, proposal: Record<string, any>, opts: { approved?: boolean } = {}) => {
    const canonical = core.normalizeAction(actionOf(proposal));
    const act = core.routeAction(plan, canonical);
    if (opts.approved) {
      const a = core.stepPlan(plan, model, act, { action: canonical, history: [], run, approved: { by: 'person', ref: 'approval' } });
      const decision = decisionOfReject(a.reject);
      return { decision, reason: a.reject as string | null, next: decision === 'allow' ? { ...model, ...a.next } : model };
    }
    let r = core.stepPlan(plan, model, act, { action: canonical, history: [], run });
    let decision = decisionOfReject(r.reject);
    if (decision === 'escalate') {
      // S158: a deny behind the escalation decides (PS8.3).
      const behind = core.stepPlan(plan, model, act, { action: canonical, history: [], run, approved: { by: 'poly', ref: 'precedence' } });
      if (decisionOfReject(behind.reject) === 'deny') { decision = 'deny'; r = behind; }
    }
    return { decision, reason: r.reject as string | null, next: decision === 'allow' ? { ...model, ...r.next } : model };
  };
  return { initial, step };
}
