# poly v1 · The release plan

Status: written by the owner's reviewer (2026-10-08), for the owner's go. m4 carries M9, M10 and M11 (2e7f69c0 and its record). This plan takes m4 to the v1 release. M7 follows the release.

Two sessions work in parallel, on two branches that share no layer: the **release session** changes the core, the **examples session** builds applications on top of it. The lessons of the M10 and M11 merge apply (docs/paper and the SDLC document): the examples branch rebases on the release branch after every commit that changes PS or PT text, not at the end, and only one full suite runs on the machine at a time.

## V0. Set-up

- Release session: worktree `poly-v1` on branch `v1`, from m4. Handoff: `handoff-v1-release.md`.
- Examples session: worktree `poly-ex` on branch `ex`, from m4. Handoff: `handoff-v1-examples.md`.
- Suites: one queue. A session that wants a full suite checks that no other suite runs, as before. The release session's gate runs alone.
- Records: the release session writes `decisions-v1.md`; the examples session writes `decisions-ex.md`.

## The release branch (v1)

Each language step: PS and PT text first, committed alone (rule 7a). Then the failing tests, written by a subagent that has read only the PS and PT text and not the code (the test writer is not the builder, as in Agentic Development's Make stage). Then the code. Then the full suite and the measured verdicts.

| Step | What | Acceptance |
|---|---|---|
| V1 | **S400, strict by default** (`proposals/experiment-strict-rerun.md`, SR1) | The 160 measured verdicts compared before and after; any change listed with its cause. A change caused only by S400 does not stop the run; any other does. Manual paragraph added. |
| V2 | **S401, an approved effect reads the state at approval** (`decisions-v1.md`) | The three tests of the ruling: approval after `Cancel` denied `stale-approval` and replayed; approval before `Cancel` allowed; a control without the rule allows both. The checker's policy stage covers the later states. |
| V3 | **S402, routed decisions over Content and Items** (`decisions-v1.md`) | The concierge's classification runs as a routed decision over the message body; each tier call is proposed with the decision's taint; a policy denying by `effect.taint.class` stops a tier; PL6839 still refuses a Content result and cites; the canary test of S310 passes over a routed run. |
| V4 | **Replaying a credential's grant** (`std.credentials` in the build's records) | `poly journal replay` of a concierge run with a delegated refund reproduces every state and decision, the grant included (AC27). |
| V5 | **Workflows under poly's gate** | Measure first: list what polyflow's runtime does that poly's gate does not, and bring it as a proposal. If it fits in v1, a workflow's effects cross the gate and its certificate no longer says `ungated`. If not, the release notes state the limit. Owner's call (Q-V3). |
| V6 | **The m3-isolation test** moved to the serial after-suite group | Passes in three consecutive full suites. |
| V7 | **The strict-default experiment, part 1** (SR2, no model call) | Report as SR-AC2 asks. |
| V8 | **The strict-default experiment, part 2** (SR3, 20 runs on the subscription) | Report as SR-AC3 asks, with its Fisher test. Runs only when no suite runs. |
| V9 | **Release notes and manual** | Every stated limit of M8 to M11 and V1 to V5, the journal format changes, and the new codes, in `docs/release-notes.md`. |
| V10 | **The v1 gate** | See below. |

## The examples branch (ex)

| Step | What | Acceptance |
|---|---|---|
| E1 | **The concierge** completed as the release example (AC27, AC30), after V3 lands on `ex` by rebase | AC15, AC18, AC22, AC27 and AC30 pass with recorded providers and fake adapters. |
| E2 | **The inbox assistant** (`proposals/example-inbox.md`, Q-I1 to Q-I5 ruled) | Gmail through the history API by polling, with the Google provider profile of M9 and drafts only (no send scope); SES through SQS and S3; one audience per inbox; the digest on the local page. IAC1 to IAC9 pass on recorded traffic; no test calls a live account. |
| E3 | **The checked harness** (`proposals/example-harness.md`) | Only if the owner rules it into v1 (Q-H3). Recommended: after the release. |

Adapters for Gmail and SES are host code in the examples branch. If an adapter needs a change in the core, the examples session stops and brings it to the reviewer; it does not change the core on its own.

## V10. The v1 gate

From a clean build, on a quiet machine, after both branches are merged into m4 (release first, examples rebased on it):

1. The full suite and the after-suite: no failure.
2. check-memory passes.
3. The measured programs: every verdict identical to the one recorded after V1, or changed with a ruled cause.
4. Every example checked `CLEAN` and its journal replayed.
5. Per-file times compared with `docs/m11/gate2-file-times.json`.
6. The release notes complete.
7. A record in `decisions-v1.md`.

Then the owner decides the release (Q-V1).

## Stop list (unchanged)

A session stops only for a change of semantics or security, a change of verdict not ruled in advance, an engine change, or a choice this plan does not cover. Everything else it decides, records and carries on.

## Order

```
release:  V1 ─ V2 ─ V3 ─ V4 ─ V5 ─ V6 ─ V9 ─┐
              └─ V7 (after V1) ─ V8           ├─ merge ─ V10 gate ─ release
examples:      E1 (after V3) ─ E2 ────────────┘
```

E2 can start at once on the adapters and machines that do not depend on V1 to V3, and rebases as each lands.

## Questions for the owner

1. **Q-V1.** What is the release: a tag `v1.0.0` on main, local only, with the push yours to make; or also a package published to npm under `@cognitive-fab`? Recommended: the tag, then you push and publish.
2. **Q-V2.** The harness example (Q-H3): after the release, as recommended?
3. **Q-V3.** Workflows under poly's gate: in v1 if V5's measurement shows it fits, otherwise a stated limit. Agreed?

## Conclusion

v1 is three language rulings, two gate items, one experiment and two examples away. The core changes go through one branch in a fixed order, with tests written by a session that has not seen the code; the examples follow on their own branch and rebase as each core change lands, so the two never meet for the first time at the end.

## Glossary

- **Release session:** the builder session for the `v1` branch, which changes the core.
- **Examples session:** the builder session for the `ex` branch, which builds the concierge and the inbox assistant.
- **Test writer:** a subagent that writes failing tests from the PS and PT text alone, before the builder writes the code.
- **v1 gate:** the closing check of the release, from a clean build, with every example checked and replayed.
