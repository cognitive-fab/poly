// poly-ref: poly's model checker, a reference interpreter written from
// docs/04-semantics.md. It shares no code with the compiler (PS9.3); the
// import boundary is checked by scripts/check-boundaries.mjs.
export { buildMachine, valuesOf, dataDomain, inType, inCheckDomain, type RMachine, type RType } from './model.js';
export { evaluate, type Env, type Verdict } from './eval.js';
export { transition, runHandler, initialState, isTerminal, type Step } from './step.js';
export { explore, machineSystem, pathTo, type System, type Graph, type Edge, type Label, type Outcome } from './explore.js';
export { checkMachine, instanceOf, alphabetSize, ENGINE, type MachineReport, type InstanceLine } from './check.js';
export { keyOf, stateKey, statePlain, toPlain, type Value, type State, type UnionValue, type MapValue } from './values.js';
export { alpha, flatten, flattenData } from './alpha.js';
export { translationValidate, type TvResult } from './tv.js';
export { confirmWitness, stateDigestOf, type Confirmation, type WitnessToConfirm, type FlatStep } from './confirm.js';
