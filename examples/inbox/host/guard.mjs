// plan-ex.md E2, "Run it yourself": the read-only first run. The program lets the owner's page ask for a draft
// (WriteDraft), edit it (Edit) and propose it (Propose), and a proposal reaches the effect gmail.createDraft once a
// person approves it. A read-only host cannot reach that effect, because it does none of the four things that would:
//
//   - it never dispatches WriteDraft, Edit or Propose, so no Todo leaves Open for Reading, Drafting or Proposed;
//   - it never connects the compose credential's vault, so no compose grant can be requested or taken;
//   - it never registers the createDraft handler, so even an intent that existed would have nothing to run;
//   - it refuses a command to draft, with the reason, rather than ignoring it.
//
// The host reaches the runtime only through this object, so each refusal is in one place and a test can hold a fake
// runtime to it. It holds no rule of the program: the gate and the policy still decide every proposal in a draft run.

/** The actions of a Todo that lead to a draft. */
export const DRAFT_ACTIONS = new Set(['WriteDraft', 'Edit', 'Propose']);

/** The credential a draft is created under. */
export const COMPOSE = 'gmail_draft';

export class ReadOnlyRefusal extends Error {
  constructor(what) {
    super(`read-only: ${what} is refused; start the host with --drafts to allow drafts`);
    this.name = 'ReadOnlyRefusal';
  }
}

/** What the host may do to the runtime, in read-only mode or not. */
export function guarded(rt, { drafts }) {
  return {
    drafts,
    rt,
    /** A dispatch; in read-only mode, never one of the actions that lead to a draft. */
    async dispatch(id, action, data, opts) {
      if (!drafts && DRAFT_ACTIONS.has(action)) throw new ReadOnlyRefusal(`${action} of ${id}`);
      return rt.dispatch(id, action, data, opts);
    },
    /** A grant request; in read-only mode, never for the compose credential. */
    async requestGrant(credential, holder) {
      if (!drafts && credential === COMPOSE) throw new ReadOnlyRefusal(`a grant of ${credential}`);
      return rt.requestGrant(credential, holder);
    },
    /** The vault of a credential; in read-only mode, the compose credential has none. */
    connectVault(credential, vault) {
      if (!drafts && credential === COMPOSE) return false;
      rt.connectVault(credential, vault);
      return true;
    },
    /** The handler that creates a draft; in read-only mode, none is registered. */
    registerDraftHandler(kind, handler) {
      if (!drafts) return false;
      rt.handle(kind, handler);
      return true;
    },
  };
}
