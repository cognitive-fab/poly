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
  // S455: an exact egress target written as a prefix, so a draft URL would admit the send under it.
  'exact-widened': ['test/fixtures/exact-target/drafts.poly'],
  // PD5.1.2c: PS3.2's claims row, which the runtime applies before the module.
  'skip-claims': ['conformance/m5/refund.poly'],
  // PS3.2, S180: the content row, which rejects a step whose Content names no body before the module.
  'skip-content': ['conformance/m8/content/notes.poly'],
  // PS3.2's first row order (S180 ruling): the content row lowered for an action with no handler.
  'content-before-unhandled': ['conformance/m8/content/unhandled.poly'],
  // Review C-F3: the content row fired only on none, which the runtime never marks.
  'content-row-on-none': ['conformance/m8/content/notes.poly'],
  // S190: a member dropped from the domain of another module's enum.
  'foreign-enum-member': ['conformance/m8/enums/chat.poly'],
  // PS15: the channel's expansion. The test kind std.channels.test is found under test/fixtures/std (the test-only std).
  'channel-drop-spawn': ['test/fixtures/channels/concierge.poly'],
  'channel-swap-rename': ['test/fixtures/channels/concierge.poly'],
  'channel-inbound-to-app': ['test/fixtures/channels/concierge.poly'],
  // PS15.3, as ruled after step 7: the acknowledgement of a receipt dropped from the application's handler.
  'channel-drop-ack': ['test/fixtures/channels/concierge.poly'],
  // Review A-F1 (M8b): the descriptor's thread key, which the runtime routes an inbound message by.
  'channel-thread': ['test/fixtures/channels/concierge.poly'],
  // PS5.2a, S178: a machine's never statement, lowered to a step property over the step's intents.
  'drop-never': ['conformance/m8/never/window.poly'],
  'invert-never-while': ['conformance/m8/never/window.poly'],
  'drop-never-filter': ['conformance/m8/never/window.poly'],
  'never-post-state': ['conformance/m8/never/window.poly'],
  // S162: the actions timers start, which the runtime refuses from outside in a scope that requires attribution.
  'drop-timer-target': ['conformance/m5/lineage-timer.poly'],
  // PT10, S165: the workflow descriptor polyflow reads: a tool mapped to another kind, and a key field's pattern dropped.
  'workflow-tool': ['conformance/m6/brief.poly'],
  'workflow-key': ['conformance/m6/brief.poly'],
  // S152: the generated sandbox policy, an artefact the sandbox reads.
  'widen-sandbox': ['conformance/m5/capabilities.poly'],
  // PT10e (M9): the credential's descriptor the vault adapter reads, and the manifest's uses entry the runtime checks
  // the grant by. The provider test-oauth is the tests' own, under the test-only std.
  'credential-scope-added': ['test/fixtures/m9/credentials.poly'],
  'credential-holder-dropped': ['test/fixtures/m9/credentials.poly'],
  'credential-base-widened': ['test/fixtures/m9/credentials.poly'],
  // PT28.1, PT10h (M10 step 0): the host's declarations, with a parameter widened to unknown.
  'types-widen-param': ['conformance/m4/router.poly'],
  // PT10i (M10 step 3): the memory descriptors the runtime reads, an owned source made unowned and a source's class
  // lowered, and the manifest's recipient class dropped.
  'source-unowned': ['test/fixtures/m10/concierge-memory.poly'],
  'flow-class-lowered': ['test/fixtures/m10/concierge-memory.poly'],
  'flow-recipient-dropped': ['test/fixtures/m10/concierge-memory.poly'],
  // PT10j (S451): the manifest's key predicate the runtime passes to the adapter and checks each item against, dropped.
  'source-key-dropped': ['test/fixtures/source-keys/mail-draft.poly'],
  // PT10r (M11): the route's and the budget's descriptors the runtime reads to run the tiers and hold the caps.
  'route-threshold-changed': ['test/fixtures/m11/desk.poly'],
  'route-tier-dropped': ['test/fixtures/m11/desk.poly'],
  'route-price-stale': ['test/fixtures/m11/desk.poly'],
  'budget-cap-raised': ['test/fixtures/m11/desk.poly'],
  // PS18.4a, PT10r (S454): an unrouted decision's budget in its manifest entry, which the runtime reserves on, dropped.
  'decision-budget-dropped': ['test/fixtures/decision-budget/writer.poly'],
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
export const CERTIFICATE_FAULT_LIST = ['omit-artefact', 'stale-artefact-digest', 'digest-before-limits', 'sign-wrong-message', 'stale-handler-digest', 'omit-handler-file', 'stale-policy-digest', 'omit-policy', 'omit-package-file', 'stale-adapter-digest', 'swap-adapter-kind', 'omit-adapters', 'wrong-policy-engine', 'stale-keyring-chain', 'omit-policy-signature', 'stale-policy-signature', 'omit-vaults', 'swap-vault-store', 'rename-credential', 'swap-policy-source', 'rename-source', 'stale-source-pin', 'drop-declassify', 'swap-tier-model', 'rename-route'];
// Review C7 (M11): the faults that need a project with a route to act on: a tier's model, and a route's name.
export const ROUTE_CERTIFICATE_FAULTS = ['swap-tier-model', 'rename-route'];
// PT10f: the faults that need a project with a credential and its vault to act on.
// Review D5 (M9): rename-credential writes a credential's entry under another name than its descriptor's.
export const VAULT_CERTIFICATE_FAULTS = ['omit-vaults', 'swap-vault-store', 'rename-credential'];
// PT10i (M10): the faults that need a project with a source to act on: an entry renamed, and an adapter pinned to another digest.
export const MEMORY_CERTIFICATE_FAULTS = ['rename-source', 'stale-source-pin'];
// S323, S325 (M10): the fault that needs a project with a declassification point: the certified list emptied.
export const DECLASSIFY_CERTIFICATE_FAULTS = ['drop-declassify'];
// M8 plan step 10 (S182): the faults that need a project with a channel to act on.
export const ADAPTER_CERTIFICATE_FAULTS = ['stale-adapter-digest', 'swap-adapter-kind', 'omit-adapters'];
// The faults that need a project with policies to act on (PT8).
// Review D8 (M9): swap-policy-source certifies a scope's policy as written in another source file.
export const POLICY_CERTIFICATE_FAULTS = ['stale-policy-digest', 'omit-policy', 'wrong-policy-engine', 'omit-policy-signature', 'stale-policy-signature', 'swap-policy-source'];
// Review of M5b, D: the faults that need a handler importing an installed package (S154).
export const PACKAGE_CERTIFICATE_FAULTS = ['omit-package-file'];
