// SamPolicyEngine — loads the proven SAM machine and steps it with the SAME
// semantics as scripts/sam-adapter.cjs (reset-then-merge; a
// lastStep().classification === 'rejected' is the veto), PLUS it surfaces the
// contract-anchored reject REASON that sam-adapter.cjs discards — polyman needs
// it to return `reject(reason)` to the agent.
//
// The machine is loaded through polyman's OWN self-contained loader
// (load-machine.ts), which require-patches '@cognitive-fab/sam-pattern' to the
// vendored v2 bundle — so polyman installs standalone AND the runtime engine
// drives byte-identical SAM to the design-time checker (golden-parity test).
import { loadMachine } from './load-machine.ts';
import type { PolicyEngine, SamState, StepResult } from './types.ts';

interface SamAccessor {
  lastStep(): { classification?: string; rejections?: Array<{ reason?: string }> };
  state?: () => { clearError?: () => void } | null;
}
interface SamModule {
  instance: (cfg: Record<string, unknown>) => SamAccessor;
  init: () => void;
  actions: Record<string, (data?: unknown) => void>;
  getState: () => SamState;
  setState: (s: SamState) => void;
}

export function loadEngine(machinePath: string): PolicyEngine {
  const spec = loadMachine(machinePath) as unknown as SamModule;
  for (const k of ['instance', 'init', 'actions', 'getState', 'setState'] as const) {
    if (spec[k] == null) throw new Error(`machine '${machinePath}' is not a SAM v2 module (missing ${k})`);
  }
  return makeEngine(spec);
}

/** Build a PolicyEngine over an already-loaded SAM module (test seam). */
export function makeEngine(spec: SamModule): PolicyEngine {
  const snapshot = (): SamState => JSON.parse(JSON.stringify(spec.getState()));

  // Clear the model's error slot between steps (as sam-adapter.cjs does).
  // Without it, a machine using the v1 `__error` rejection idiom carries a stale
  // error across steps: `beginStep` captures it as `stepErrorBefore`, so a
  // consecutive reject with the SAME reason is not seen as a change and is
  // misclassified as non-rejected. Guarded — v2 strict instances may lack it.
  const clearError = (): void => {
    try {
      const model = spec.instance({}).state?.();
      if (model && typeof model.clearError === 'function') model.clearError();
    } catch { /* pre-v2 accessor without state()/clearError — nothing to clear */ }
  };

  const init = (): SamState => {
    spec.init();
    return snapshot();
  };

  const step = (state: SamState, action: string, data: Record<string, unknown> = {}): StepResult => {
    const handler = spec.actions[action];
    if (typeof handler !== 'function') {
      throw new Error(`unknown policy intent '${action}' — not exported by the machine`);
    }
    // Reset-then-merge (sam-adapter.cjs): without init() the library's
    // merge-only setState leaks state between transitions. clearError() drops
    // any stale error slot before the snapshot is merged on top.
    spec.init();
    clearError();
    spec.setState(state);
    const entry = JSON.stringify(snapshot());
    try {
      handler(data);
    } catch (e) {
      // A strict-profile throw (bad shape / schema) is a machine fault; fail
      // CLOSED — treat as a reject with a readable reason, never an allow.
      return { post: state, rejected: true, reason: `engine-error: ${(e as Error).message}` };
    }
    const ls = spec.instance({}).lastStep();
    if (ls && ls.classification === 'rejected') {
      const reason = (ls.rejections && ls.rejections[0] && ls.rejections[0].reason) || 'rejected';
      // A rejection that OBSERVABLY mutated first is a defect, not a no-op
      // (mirrors sam-adapter.cjs) — surface it rather than trust the state.
      if (JSON.stringify(snapshot()) !== entry) {
        throw new Error(`acceptor for '${action}' mutated the observable model and then rejected — a rejection must be an observable no-op`);
      }
      return { post: state, rejected: true, reason };
    }
    return { post: snapshot(), rejected: false, reason: null };
  };

  return { init, step };
}
