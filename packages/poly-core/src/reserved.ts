// S143: the runtime's own machine ids. poly-runtime hosts PT9.7's OutboxIntent at each retry bound m from 1 to 10
// as runtime<m>.OutboxIntent (runtime.OutboxIntent at 3), so a program machine in a module named runtime or
// runtime<m> is refused by the checker under PL1208, whatever bounds a build declares or intents a store holds.
// The one module the checker takes under those names is PT9.7's model at a bound, identified by its module digest
// (digest(module), PT15). test/reserved-runtime.test.mjs recomputes these from the model's text, so a change to
// PT9.7 that is not pinned here fails there, never silently.

export const RESERVED_MODULE = /^runtime\d*$/;

export const RUNTIME_MODEL_DIGESTS: ReadonlySet<string> = new Set([
  'sha256:2a89718dd3335bb9f887f6b7391ca72999d1796e92b4c8b9c543bd59be5ca959',
  'sha256:f016b90c92bb83def657637fd8485e38d878396163f6811a0d84159b5e8e334c',
  'sha256:ce9343afb65e545a0daf00ea13478d9c073addf190c19fb4d17eee8ecf6ab971',
  'sha256:04c4d33bf0691763eea4d3ce7c61e1ba4e85a24d1181626ac8a83373119a3f16',
  'sha256:bcdcb966024f9ab3d67c0413752a3d9ade9e027525da417c64f40a27bfe28c1f',
  'sha256:29cc2257158eaf774d1794303d5a6f34c1887af8e889d6d422f2da654eb5e7fb',
  'sha256:7fac31a046201353192949065f4b766e26136b3e298d34110466a8f1b7ef6087',
  'sha256:618eb8f5df9e003a9890b2d966eddc182c5fc7c0c0c54b623fde44a4b5206a7a',
  'sha256:556febca9bdefbfcff5996e2b7b614547b9e77d06dad488c1ab3e051890c4cf8',
  'sha256:f8ffc77b3361f052e0c70e69d4448cd31c29b65957cf01415a4f71ee4068dd6f',
]);
