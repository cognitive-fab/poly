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

### M7.1 spec text (PS19, PT29)

Committed alone, before any test or code (rule 7a).

- **A correction of the inventory, affecting S503.** The M7.0 inventory said it was open whether a poly effect declares reversibility. It does: an effect's `class` is `none | reversible | compensable | irreversible` (grammar `Class`, PT6.1, the manifest, the gate). The ruling for S503 asked for an optional `consequence` declaration with those four words. Adding a second declaration of the same thing would be a duplicate, so the spec text makes the consequence of an effect its `class`, and an effect with no `class` exports as `unknown` (PT29.6). This is the ruling's intent with no grammar change. Reviewer to confirm.
- **A correction affecting S504.** The certificate's `domains` are text (`field ∈ 0..3`), not a form a program can read. The check domain of a parameter is read from the certified sources, which the certificate binds by digest and `replay` already reads (PT29.3). No runtime change, as ruled.
- **Run ids are tokenised.** An instance id can be built from a message id or a key, so the episode id is a salted token (PS19.1, PS19.4). No time of day is exported.
- **Command shape.** `poly export traces` takes `--db --build --certificate --trust --out`, refuses an existing file, and is not served over MCP (PT29.1).
- **Accepted by the owner's reviewer, 2026-10-11:** S503 corrected (the consequence is the effect's existing class, and no class exports as unknown), S504 corrected (the domain is read from the certified sources), tokenised run ids with no time of day, and the command shape.

### M7.1 built (PS19, PT29)

**Order of work (rule 7a), and what went wrong in it.**
- Spec text first (5398a7cd). Then three independent writers, none of whom read the implementation, wrote tests from the text. Their first files were not usable: they asserted that the command fails (so they would have failed once it existed), or only that a key exists, and a rewrite dropped the hard cases (canary, disclosed values, erasure, advice) as untestable. I wrote the implementation while the last of them ran, so the code was not written after the final tests settled, as the reviewer noted.
- The substantive tests for the cases the writers dropped are `test/trace-export-substance.test.mjs` and the three examples in `test/after/ex-trace-export.test.mjs`. **I wrote these after the implementation existed**, so they are not independent in the sense of rule 7a. What stands in for independence is (a) the fail-first run below and (b) mutation checks: with the built export changed in one place each, the substance tests failed as follows. Raw values instead of tokens: 4 of 6 failed (tiers, canary, tokens, episode id). A constant salt: the cross-export token test failed. Erased steps kept: the erasure test failed. Strict parameters counted as outside: tiers and canary failed. Advice not counted: the advice test failed. Each change was reverted.
- The independent writers' files that remain are `test/trace-export.test.mjs` (11 tests; four of them were vacuous or passed without the command, and I rewrote them: `--out` required, existing file, tampered build, `--run`) and `test/trace-export-privacy.test.mjs` (14 tests, 7 of them controls; the weakest of the files, kept for its controls and for its gate, heads, replay and MCP checks).

**Fail-first, recorded.** The final test files were run against a build without the export code (the `packages` and `schemas` changes stashed, `tsc -b` run, the stale compiled `traces.js` removed). Each failed for its own reason:
- `test/trace-export.test.mjs`: 11 of 11 failed. Seven at the export (exit 64, the command unknown, where 0 was expected), `--out` required at the missing message `poly: export traces needs --out`, existing file at its first export (a real one), tampered build at the missing `refused at load` message, `--run` at its first export.
- `test/trace-export-privacy.test.mjs`: the 7 mains failed (exit 64 where 0 was expected, and `registry has export command`); the 7 controls passed, as they should.
- `test/trace-export-substance.test.mjs`: 7 of 7 failed at exit 64 where 0 was expected.
- `test/after/ex-trace-export.test.mjs`: 3 of 3 failed at the export (exit 64 where 0 was expected), after each example's own recorded sequence had run (the concierge's AC27, the inbox's IAC9 and IAC8).

No test that asserts only a refusal counted as a fail-first: the refusal tests above fail without the code because they assert the message, or a real first export.

**With the code:** the three fast files and the three after tests pass. The suite as a whole runs at M7.7.

**What the export measured on the two examples' recorded runs.**
- Concierge (AC27): 13 episodes, 90 steps (of 231 journal rows; the rest belong to runtime-hosted runs), 42 effects (none 16, unknown 19, irreversible 7), the gate said `allowed`, 26 runtime runs omitted, 39 runs in the store.
- Inbox (IAC9, with a canary in a message body): 25 episodes, 126 steps of 369 rows, 40 effects (none 39, irreversible 1), 42 runtime runs omitted, 67 runs in the store.
- Inbox after the IAC8 forget of the work account: 25 episodes, 8 erased steps left out, 1 gapped run, 0 erased runs, 24 whole runs. The expectation was computed from the journal and the runtime's erased set, not from the export.
- In neither export do the canary, a message text, an answer text or an erased digest appear, in five encodings; every string is a declared name, a fixed word or a token.

**Defects the tests found in the code, fixed.**
- The worker records a second gate verdict when it settles an effect (outcome `settled`), which hid the gate's decision; only the five decisions of the gate count (PT29.2).
- The manifest writes class `none` for an effect that declares none, so `unknown` could not be told from `none`; the export reads the declaration from the certified module (S503, PT29.6).
- The command line did not treat the values of `--build`, `--certificate`, `--trust` or a repeated `--run` as non-positional; it does now.

**Not covered, said plainly.** `omitted.erasedRuns` is 0 in every test (a run's `$create` row names no body, so no run loses every step; the arithmetic is asserted). `omitted.archivedRuns` has no test (no fixture archives a run). A gate `denied` or `escalated` as the last word is in no recorded run, so only `allowed` is asserted against a real gate; the other words are checked as members of the set. No consumer reads the corpus yet (polyvers, polyx): that is M7.2's port. The privacy file has editor warnings for unused declarations.

**M7.1 accepted by the owner's reviewer (2026-10-11), with conditions.** The mutation evidence is good and the two files I wrote stay. A separate writer audits them (see the audit below). The earlier writer's claim that the canary, erasure and advice cases were untestable is rejected: the substance file shows it was wrong.

**Open items, to close before the M7 gate (M7.7), with synthetic fixtures.** Status after the audit:
1. Audit by a separate writer of the two files I wrote, given PS19, PT29 and the two files, not the code. **Done, partly.** The auditor (`docs/m7/export-audit.md`, `test/trace-export-audit.test.mjs`) tabulated 23 clauses, found no disagreement between spec and implementation, and added exact-key-set tests for the header, episode, step and effect (7 tests). It reported four clauses as untestable (archived runs "awaiting K4", gate denied and escalated "fixtures prepared", whole-run erasure "counting only"). That report was wrong on all four, as the earlier writer's was on canary and erasure; the implementer's addendum in the audit file says so. Fail-first for the audit's tests and for those below: all fail without the code (exit 64, or `registry has the export command`), recorded in this session's run of the stashed (pre-code) build.
2. `omitted.erasedRuns`: **closed, with a question for the reviewer.** `test/trace-export-gaps.test.mjs` erases a whole run and the export counts it and leaves it out. But no run the runtime makes can lose every step: its `$create` row (a step, as PS19.5 reads it) names no body, since a `Content` field starts at `none`. The fixture is therefore synthetic: after the run is made, every journal row of one run is given a field that names a body, and that body is erased. As written, PS19.5's "a run that has lost all its steps" is met only by an altered store. Question: should the creation row not count as a step for this purpose (so that a run whose every other step is erased is erased)? Not changed without a ruling.
3. `omitted.archivedRuns`: **closed.** An instance archived after its terminal state (`rt.archive`) is counted and is no episode; every run is accounted for exactly.
4. A gate `denied` and `escalated` as the last word: **closed.** Denied: the orders policy (`charge-before-reserve`), beside an allowed reserve. Escalated: the shop's escalating policy, then `allowed` after a person's approval. Mutation checks: counting the worker's `settled` verdict as a decision, or a gate that is always null, fail both; leaving erased runs or archived runs uncounted fails the matching test; an export that appends an advice event fails the head check.
5. The editor warnings in `test/trace-export-privacy.test.mjs`: **closed by removing the file.** Its mains could not fail: the fixture (`effects.poly`) has no `Content` field, so its canary never entered the journal, and its heads test never compared heads. The checks worth keeping (heads unchanged, not served over MCP) are in `test/trace-export-chain.test.mjs`; the rest is in the substance, gaps and audit files. The audit file still has a few unused variables.
6. The full suite before M7.2 starts, with JJ's confirmation that E3 runs no heavy job at the same time: **open**, asked of JJ.

**Repository.** `schemas/grant-revoke.input.json` was stale on main (the registry had gained `credential` and `db`), so `PF9.2` failed there. It is regenerated with `scripts/publish-schemas.mjs` as its own commit. `certifiedProgram` was lifted out of `replayRuntime` so the export and replay read the same modules.

### Full suite before M7.2 (45888243)

`scripts/suite-summary.mjs --run m71`, alone on the machine (JJ confirmed E3 idle): run 1, 2543 tests, 2537 passed, 0 failed, 2 skipped, 4 waiting; run 2 (the after group), 16 tests, 16 passed; check-memory passed. Log: `.poly/logs/45888243-2026-10-11T20-18-08-561Z-m71.log`.

### M7.2 · the S508 check (read-only, before anything is built)

polyx's `synthetic` adapter (`@cognitive-fab/polyx-lens` 0.3.0, `src/ingest/synthetic.ts`) reads `{corpus, interactions:[{id, operator, team, agent, startedAt, outcome, turns:[{speaker, intent|button|event, slots, result}]}]}`. A turn with `speaker: system` and an `event` is a state event: the alphabet (`alphabet.synthetic-state.yaml`) gives its type `identity` and `state` slots, and `no-X-unless-state` reads the latest state event whose identity slot equals X's. The adapter carries `result` (`ok | failed | refused`) and an `outcome`. It reads slots as scalars. So it can carry what a poly trace has: **S508 passes, nothing is stopped, and the lens is not changed.** Limits found, to be written into the port text: slots are scalars only (a value or a token is one; a union with a payload is not, so the port flattens it as the journal does); one interaction is one episode (`expected_episodes: 1`), which is S506's "an interaction is a run"; `consequence` is declared per type in the alphabet, not per event, so the port gives each action one consequence from the effects it emits (or `unknown`).
