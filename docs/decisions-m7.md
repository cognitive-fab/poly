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

### M7.1 spec text (PS19, PT29)

Committed alone, before any test or code (rule 7a).

- **A correction of the inventory, affecting S503.** The M7.0 inventory said it was open whether a poly effect declares reversibility. It does: an effect's `class` is `none | reversible | compensable | irreversible` (grammar `Class`, PT6.1, the manifest, the gate). The ruling for S503 asked for an optional `consequence` declaration with those four words. Adding a second declaration of the same thing would be a duplicate, so the spec text makes the consequence of an effect its `class`, and an effect with no `class` exports as `unknown` (PT29.6). This is the ruling's intent with no grammar change. Reviewer to confirm.
- **A correction affecting S504.** The certificate's `domains` are text (`field ∈ 0..3`), not a form a program can read. The check domain of a parameter is read from the certified sources, which the certificate binds by digest and `replay` already reads (PT29.3). No runtime change, as ruled.
- **Run ids are tokenised.** An instance id can be built from a message id or a key, so the episode id is a salted token (PS19.1, PS19.4). No time of day is exported.
- **Command shape.** `poly export traces` takes `--db --build --certificate --trust --out`, refuses an existing file, and is not served over MCP (PT29.1).
