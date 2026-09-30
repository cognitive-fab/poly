// poly-ref: poly's model checker, a reference interpreter written from
// docs/04-semantics.md. It shares no code with the compiler (PS9.3); the
// import boundary is checked by scripts/check-boundaries.mjs.
export { buildMachine, valuesOf, dataDomain, inType, inCheckDomain, monitorStart, monitorStep, type RMachine, type RType, type RPathProperty, type PathClause } from './model.js';
export { evaluate, type Env, type Verdict, type GlobalView } from './eval.js';
export { transition, runHandler, initialState, isTerminal, type Step, type Intent } from './step.js';
export { explore, machineSystem, pathTo, type System, type Graph, type Edge, type Label, type Outcome } from './explore.js';
export { checkMachine, pathViolation, instanceOf, alphabetSize, ENGINE, type MachineReport, type InstanceLine } from './check.js';
export { keyOf, stateKey, statePlain, toPlain, type Value, type State, type UnionValue, type MapValue } from './values.js';
export { alpha, flatten, flattenData, flatValue } from './alpha.js';
export { translationValidate, type TvResult } from './tv.js';
export { loadLoweredModule } from './load.js';
export { confirmWitness, confirmEffectsWitness, stateDigestOf, type Confirmation, type WitnessToConfirm, type FlatStep } from './confirm.js';
export { checkJoint, jointStep, stimuliAt, jointKey, jointPlain, MAX_CASCADE_DEPTH, type Joint, type JointReport, type Stimulus, type CascadeStep } from './joint.js';
export { checkConfiguration, buildConfiguration, configurationSystem, globalPlain, globalView, type ConfigReport, type ConfigInstance, type GlobalState, type GlobalLabel, type Message } from './config.js';
