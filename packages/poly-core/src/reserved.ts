// S143: the runtime's own machine ids. poly-runtime hosts PT9.7's OutboxIntent at each retry bound m from 1 to 10
// as runtime<m>.OutboxIntent (runtime.OutboxIntent at 3), so a program machine in a module named runtime or
// runtime<m> is refused by the checker under PL1208, whatever bounds a build declares or intents a store holds.
// The one module the checker takes under those names is PT9.7's model at a bound, identified by its module digest
// (digest(module), PT15). test/reserved-runtime.test.mjs recomputes these from the model's text, so a change to
// PT9.7 that is not pinned here fails there, never silently.

export const RESERVED_MODULE = /^runtime\d*$/;

export const RUNTIME_MODEL_DIGESTS: ReadonlySet<string> = new Set([
  'sha256:743c5f6dc7b72a5b0bfc180362ffbfc69464de3de1b43a0a1bd1f123e2c6a1e1',
  'sha256:3f95540b90bd991e93c9032c75703fbea38741de4e383b2970d718dfe81ef184',
  'sha256:c993321e8adc493f581cd0e01a3d54893c471a87acfdc4cf91e71b8f196aa846',
  'sha256:b074381880b69f4803976ee39df0bdf73f4e187895d59de1dd794051799c2a22',
  'sha256:437a3f9e2dacdd3acb5068241ebf3b404d2d5ca6a972014e0eb10831d8ef90d8',
  'sha256:b6d14f58c83b9398c0675db659811753ae8a155b7a4a10c6fdde51a8c59ea65d',
  'sha256:835b46a84ebd14ce55684a245eb63ad253e12dcc16001c103ee3169c817fb03e',
  'sha256:444e54a69193dfab5863264e6136677bb4621790c5ca1bead50ef3ade405f7c7',
  'sha256:5371c77c357a04d00f30f86ee9c2ec08dfa12a1d04a99dbf43a157b57807c0f1',
  'sha256:7c21cdf64cf01b03e40a4e1af4c22094e4e1a18b1d575a2b1e0c27f3bd1d0ad8',
]);
