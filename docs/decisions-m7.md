# Decisions · M7

Rulings are by the owner's reviewer. Results and decisions of each step follow the rulings.

## Rulings on the M7.0 inventory (owner's reviewer, 2026-10-11)

- **S507.** poly calls polyx and polyness as separately installed tools, by path. They are not vendored. Every candidate records each tool's name, version, commit and manifest hash. No BUSL or private code enters poly.
- **S503.** Consequence comes from an optional effect declaration, `consequence none | reversible | compensable | irreversible`. It is additive: an effect with no declaration exports as `unknown`. Spec text first.
- **S504.** `outsideCheckDomain` is computed at export from the certificate's `domains`. No runtime change.
- **S501.** Accepted as proposed. Digests are salted per export and the salt is never exported, so two exports cannot be linked. The canary test covers every exported field.
- **S502.** Accepted. Gapped runs are marked. Counts are reported, never digests.
- **S500, S505, S506.** Accepted as proposed. Advice events and runtime runs are omitted and counted. The export goes to a file and never over MCP. An interaction is a run.
- **S508.** Accepted. If polyx's `synthetic` adapter cannot carry state events, stop and report. The lens is not changed.
- **S509, S510.** Accepted. A rule over a pure machine action is promotable in M7, as an invariant over the machine. Unmapped patterns are listed "not promotable in M7". Eligibility with an unknown state escalates.
- **S511 to S513.** Accepted. `narrowed` is refused as a verdict in M7.
- **S514.** A corpus made for the purpose may serve the acceptance runs, labelled `synthetic` in the candidate and the certificate. A promotion from a synthetic corpus is allowed only in a test certificate.
- **S515.** Accepted, with strict screening: no prompt, argument, path or project name reaches a proposal or poly source.
- **S516.** Accepted, a deterministic linear derivation. It counts for M7-AC2. The record and the release notes state that the emitter is poly's and that polyness writes no poly source in M7.
- **S517, S518.** Accepted. polyness is pinned by commit, with a shape test.
- **S519 to S521.** Accepted. Only signed adjudications count. Below the refit floor, fitting is refused and listed as not run.
- **S522.** A work-order budget is written on the workflow. Its unit is currency micro-units from a price table the participant declares. The reservation is the cap.
- **S523, S524.** Accepted as proposed.

## M7.1 · `poly export traces`

(open)
