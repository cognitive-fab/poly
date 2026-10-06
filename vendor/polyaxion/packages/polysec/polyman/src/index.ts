// polyman — the man-in-the-middle of the PolySec family. Public surface.
export { createPolyman } from './kernel.ts';
export { loadEngine, makeEngine } from './engine.ts';
export { loadSecurity } from './config.ts';
export { makeLabeler, isPresent } from './labeler.ts';
export { memoryStore } from './session-store.ts';
export { memoryJournal, fileJournal } from './journal.ts';
export { compileRegion } from './region.ts';
export { runGuard } from './guard.ts';
export type { GuardSensor, GuardOptions, GuardResult, GuardEntry } from './guard.ts';
export { loadMachine } from './load-machine.ts';
export { defaultPolicyMachine, defaultSecurityPath, defaultContractPath } from './defaults.ts';
export type {
  Polyman, PolymanOptions, Decision, ToolCall, AbstractAction,
  JournalEntry, Journal, SessionStore, PolicyEngine, SamState, Labeler,
} from './types.ts';
export type { SecurityManifest, ToolLabel } from './config.ts';
