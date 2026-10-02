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
  'outcome-entry': ['conformance/m4/router.poly'],
  // S151: the targets the runtime binds a handler's capabilities to.
  'widen-target': ['conformance/m5/capabilities.poly'],
  // PD5.1.2c: PS3.2's claims row, which the runtime applies before the module.
  'skip-claims': ['conformance/m5/refund.poly'],
  // S152: the generated sandbox policy, an artefact the sandbox reads.
  'widen-sandbox': ['conformance/m5/capabilities.poly'],
};

export const DELIBERATELY_BROKEN_LOWERINGS = Object.keys(FAULT_SOURCES);

// PT8.2 and the standing rule: the lowered policy is an artefact the runtime's gate reads, so each broken policy
// lowering is listed here with the source that exercises it, and translation validation must catch it with PL2501.
export const POLICY_FAULT_SOURCES = {
  'drop-unknown-rule': ['conformance/m5/policy-faults.poly'],
  'deny-as-warn': ['conformance/m5/policy-faults.poly'],
  'drop-guard': ['conformance/m5/policy-faults.poly'],
};

/** The toolchain-fault diagnostics among a list (S20: addressed to the toolchain, never to the author). */
export function toolchainFaults(diagnostics) {
  return diagnostics.filter((d) => d.code === 'PL2501' || d.code === 'PL2001');
}

// S126 and the standing rule: the certificate is an artefact the runtime reads, so each broken certificate writer
// is listed here and must be caught by poly admit's read-back (test/certificate.test.mjs).
export const CERTIFICATE_FAULT_LIST = ['omit-artefact', 'stale-artefact-digest', 'digest-before-limits', 'sign-wrong-message', 'stale-handler-digest', 'omit-handler-file', 'stale-policy-digest', 'omit-policy', 'omit-package-file'];
// The faults that need a project with policies to act on (PT8).
export const POLICY_CERTIFICATE_FAULTS = ['stale-policy-digest', 'omit-policy'];
// Review of M5b, D: the faults that need a handler importing an installed package (S154).
export const PACKAGE_CERTIFICATE_FAULTS = ['omit-package-file'];
