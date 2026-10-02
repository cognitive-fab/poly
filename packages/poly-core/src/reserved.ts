// S143: the runtime's own machine ids. poly-runtime hosts PT9.7's OutboxIntent at each retry bound m from 1 to 10
// as runtime<m>.OutboxIntent (runtime.OutboxIntent at 3), so a program machine in a module named runtime or
// runtime<m> is refused by the checker under PL1208, whatever bounds a build declares or intents a store holds.
// The one module the checker takes under those names is PT9.7's model at a bound, identified by its module digest
// (digest(module), PT15). test/reserved-runtime.test.mjs recomputes these from the model's text, so a change to
// PT9.7 that is not pinned here fails there, never silently.

export const RESERVED_MODULE = /^runtime\d*$/;

export const RUNTIME_MODEL_DIGESTS: ReadonlySet<string> = new Set([
  'sha256:c37c00220f4eeb55be91bb0f082d23bb50e3b0ec03739914c5b79f8abfeaa719',
  'sha256:2bc7c70241345789542c59bca8c2f0a5beec9d742adf1c9dd6d785a36f6760ac',
  'sha256:96cb9ca63c4530735e53efad9261f8d8ea223f85ddb853d0aeb69444a7dba0f4',
  'sha256:664954bd396980beec3e6012bce471070df439445eec6e55def9341d777124ab',
  'sha256:eb1aae591baf50c3752d1e593f77e6f635986712ef7360998ffedb0c8d6b7491',
  'sha256:d648651eaa32ccfa987fff6d532201c4e79208d2a0000d28fd389f4bb01dd2b1',
  'sha256:c8c8368beb2bf0ac9a18a71030992c1b05ca6b22ad84974130a62509f6014161',
  'sha256:f4e57dc72ebaaf7bd7f7aeec82714aedc4ecb5c8e4c9ff05d6e32a4b6958ed0c',
  'sha256:b02da6d8a6ecfafe51080c64f881b15aa84c4d8ca0b0f0ecfd5ca57e9d57ace4',
  'sha256:147d001a6a2df29d2fe1962b1ab248427ac7609b2024ec7b41053df3eaff69f3',
]);
