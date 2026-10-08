# Handoff · the v1 release session

You are the builder of poly's v1 release. The owner's reviewer (a Cowork session) writes the specs and rules; you build, test and record. The owner relays messages and holds every key.

## Start

1. Create the worktree: `git worktree add ../poly-v1 -b v1 m4` from the main repository, and work only there.
2. Read, in this order: `docs/plan-v1.md` (your plan, steps V1 to V10), `docs/decisions-v1.md` (S400, S401, S402 and the gate list), `docs/proposals/experiment-strict-rerun.md` (S400 and the SR experiment), `docs/04-semantics.md` and `docs/03-technical-spec.md` (the PS and PT you will amend), `docs/release-notes.md`.
3. Record every step, result and decision in `docs/decisions-v1.md`.

## How to work

- **Spec first (rule 7a).** For each language step, commit the PS and PT text alone before any code.
- **Tests from the spec.** Then have a subagent that has read only the new PS and PT text, not the code, write the failing tests. Run them: they must fail on the code before your change. A test that cannot fail first is labelled a confirmation test.
- **Then the code,** then the full suite with `scripts/suite-summary.mjs` (summary in the session, full log in `.poly/logs`), then the measured verdicts.
- **One suite at a time** on the machine. Check that no other session (the examples session in `poly-ex`) runs a suite before you start one. The SR experiment's live runs (V8) also run only when no suite runs.
- **Polywatch findings:** mark each real or false in the decisions file, with the reason. Fix real ones with a failing test first.
- **At the end of V5:** have two probe reviewers read the changes of V1 to V5 and run probes, each in its own folder, without touching the source.

## Stop list

Stop and report only for: a change of semantics or security not ruled in decisions-v1.md; a change of verdict among the measured programs not caused by S400 (V1); an engine change; a choice the plan does not cover. Bring each with a proposal. Everything else: decide under the plan's rules, record, carry on.

## Rules that do not change

- Commit as kizo-core. Never push. Never read, write or echo a key or a secret; the owner sets keys.
- No environment values in any record.
- After each commit that changes PS or PT text, tell the owner in your report, so the examples session can rebase.
- When V1 to V9 are done: report. The merge into m4 and the v1 gate (V10) follow the reviewer's go.

## Report format

What was committed (hashes), the suite line (tests, passed, failed, skipped, waiting, log path), the measured verdicts (identical or the list of changes with causes), findings with their verdicts, and what is next. No more than that.
