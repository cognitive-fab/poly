// plan-e3.md E3.5 follow-up (owner, 2026-10-11): the host's transports for a run, and the mechanisms setting.
//
// The four switches (Q-E3-2) are the host's alone. A handler reads them through the secrets capability, which has no write,
// and no effect of the module declares a store table named mechanisms, so no model-driven effect or tool can change them
// (test/e3/e3-loop.test.mjs holds both). The host sets them once, before the trial begins: a second set is refused. If a trial
// could flip its own mechanisms the comparison table of the base and the full harness would mean nothing.
import { MemoryStore } from './store.mjs';

/**
 * @param {{ known?: string[] }} options the secrets the vault knows, which the scan looks for
 */
export function makeHost({ known = [] } = {}) {
  const store = new MemoryStore();
  let mechanisms = null;
  return {
    store,
    transports: {
      store,
      secrets: (name) => {
        if (name === 'known-secrets') return JSON.stringify(known);
        if (name === 'mechanisms') return mechanisms === null ? undefined : JSON.stringify(mechanisms);
        return undefined;
      },
    },
    /** Sets the four switches, once. */
    setMechanisms(cfg) {
      if (mechanisms !== null) throw new Error('the mechanisms are set once, by the host, before the trial begins');
      mechanisms = Object.freeze({ fusion: cfg.fusion === true, compaction: cfg.compaction === true, pack: cfg.pack === true, reducer: cfg.reducer === true });
    },
    get mechanisms() {
      return mechanisms;
    },
  };
}
