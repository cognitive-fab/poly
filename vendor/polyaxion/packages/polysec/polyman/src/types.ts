// polyman core types (docs/polyman-spec.md §8).

export type SamState = Record<string, unknown>;

export interface ToolCall {
  tool: string;
  args?: unknown;
}

/** An abstract policy action dispatched to the SAM engine. */
export interface AbstractAction {
  action: string;
  data: Record<string, unknown>;
}

export type Decision =
  | { ok: true; actions: AbstractAction[]; post: SamState; record?: 'degraded' }
  | {
      ok: false; reason: string; region?: string; actions: AbstractAction[]; post: SamState;
      /** SS-5: `unavailable` marks a deny we could NOT decide (a decision-path
       *  input was unreachable). It must never be counted as a policy deny. */
      class?: 'unavailable';
      /** SS-3: the decision stood, but its evidence write failed and was spilled. */
      record?: 'degraded';
    };

export interface JournalEntry {
  session: string;
  ts: number;
  pre: SamState;
  action: string[];
  data: Record<string, unknown>;
  post: SamState;
  // 'allow'/'reject' are the policy DECISIONS (what guard/audit consume);
  // 'settle' is post-phase bookkeeping (observed-taint updates and skips).
  decision: 'allow' | 'reject' | 'settle';
  reason?: string;
  region?: string;
  note?: string;
  /** SS-5: set on a reject that denies for OUR unavailability, never theirs. */
  class?: 'unavailable';
  /** SS-8: set when this entry was re-emitted from the spill buffer late. */
  spilled?: true;
}

export interface Journal {
  append(e: JournalEntry): void | Promise<void>;
  read(): JournalEntry[] | Promise<JournalEntry[]>;
}

export interface SessionStore {
  get(id: string): SamState | Promise<SamState>;
  set(id: string, s: SamState): void | Promise<void>;
}

export interface StepResult {
  post: SamState;
  rejected: boolean;
  reason: string | null;
}

/** The proven SAM machine, driven with sam-adapter.cjs semantics + the reason. */
export interface PolicyEngine {
  init(): SamState;
  step(state: SamState, action: string, data?: Record<string, unknown>): StepResult;
}

export interface Labeler {
  hasTool(tool: string): boolean;
  pre(call: ToolCall): AbstractAction[];
  post(call: ToolCall, result: unknown): AbstractAction[];
  readonly unknownToolPolicy: 'reject';
}

export interface Polyman {
  gate(session: string, call: ToolCall): Promise<Decision>;
  settle(session: string, call: ToolCall, result: unknown): Promise<void>;
  mediate(session: string, call: ToolCall, run: () => Promise<unknown>): Promise<unknown>;
  /** True when the policy has a label for `tool` — an unlabeled tool is default-denied. */
  mediates(tool: string): boolean;
  readonly journal: Journal;
  readonly stateKeys: string[];
}

export interface PolymanOptions {
  /** Path to the proven SAM machine. Defaults to the shipped lethal-trifecta. */
  machine?: string;
  /** Path to security.json. Defaults to the shipped lethal-trifecta manifest. */
  security?: string;
  /** Injectable engine (tests / a pre-loaded machine). Overrides `machine`. */
  engine?: PolicyEngine;
  store?: SessionStore;
  journal?: Journal;
  /** Injectable labeler (tool call → abstract actions). Defaults to the security.json tools map. */
  labeler?: Labeler;
  onAlarm?: (a: unknown) => void;
}
