// The standing rule's one exception, written out (decisions-m0.md, after the review): the only
// programs allowed to reach PL2501 or PL2001 are the deliberately broken lowerings, and they are
// named here one by one. No path pattern, directory or file name exempts anything. A fault added
// to poly-lower without being listed here fails the standing test, and so does a listed fault
// that poly-lower no longer has.
//
// Each fault runs over the smallest sources that exercise its construct, listed beside it, and must
// be caught on every one of them (decisions-m1.md, "the test suite's length"; plan-m2.md step 1).
// The full sweep over every source is translation validation of the unbroken lowering (tv.test.mjs).
export const FAULT_SOURCES = {
  'drop-frame': ['conformance/m0/if-frames.poly'],
  'swap-reason': ['examples/hello/hello.poly'],
  'off-by-one': ['examples/hello/hello.poly'],
  'invert-require': ['examples/hello/hello.poly'],
  'skip-guard': ['conformance/m0/guard-terminal.poly'],
  'skip-terminal': ['conformance/m0/guard-terminal.poly'],
  'drop-property': ['examples/hello/hello.poly'],
  'drop-auto-invariant': ['examples/hello/hello.poly'],
  'drop-effect': ['conformance/m1/effects.poly'],
  'reorder-effects': ['conformance/m1/effects.poly'],
  'unnamed-reject': ['examples/hello/hello.poly'],
  'poison-step': ['examples/hello/hello.poly'],
  // The standing rule after the M1 review: every artefact the runtime reads has a broken variant, caught by the read-back.
  'manifest-data': ['conformance/m2/completions.poly'],
  'drop-terminal-state': ['conformance/m0/guard-terminal.poly'],
  'contract-domain': ['conformance/m0/strict-param.poly'],
  'contract-init': ['examples/hello/hello.poly'],
  'path-invariant': ['conformance/m1/effects.poly'],
  'compose-invariant': ['conformance/m1/children.poly'],
  'liveness-goal': ['examples/evidence/outbox-union.poly'],
};

export const DELIBERATELY_BROKEN_LOWERINGS = Object.keys(FAULT_SOURCES);

/** The toolchain-fault diagnostics among a list (S20: addressed to the toolchain, never to the author). */
export function toolchainFaults(diagnostics) {
  return diagnostics.filter((d) => d.code === 'PL2501' || d.code === 'PL2001');
}
