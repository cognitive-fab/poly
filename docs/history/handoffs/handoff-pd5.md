# Handoff: the toolchain freeze (S100) and the PD5 review

Read `CLAUDE.md`, `docs/history/decisions-m3.md` (S100 at the end) and `docs/proposals/pd5-identity-lineage.md`.

M3 is waiting on JJ's steps (O1, pilots, budget, FROZEN). Do not run any of them. This handoff has two tasks that touch nothing the experiment runs.

## Task 1. Add the toolchain to the freeze (S100)

1. In `experiments/m3/freeze.mjs`, add a part `toolchain`: the sources under `packages/` (exclude build output such as `dist/` and `node_modules/`), everything under `vendor/`, and `package-lock.json`. Record `git rev-parse HEAD` in `freeze.json` alongside the digests.
2. A regression test that fails first: change one byte in a file under `packages/` in a temporary copy, and show `--check` reports the `toolchain` part as changed. Restore it.
3. Regenerate `freeze.json` and report the new part digest. Report how many files the part holds and confirm no build output is in it.
4. A file named `--json` sits at the repo root. Find what wrote it, report it, and remove it only if it is an accident.
5. From this commit until M3's runs are finished, change nothing under `packages/` or `vendor/`. If a defect there blocks M3, stop and report it as an S-number.

## Task 2. Review PD5 (no spec or code changes)

PD5 is a proposal, not ruled. Review it the way the PD review was done, and write `docs/reviews/review-pd5.md`.

1. **Consistency.** Check every reference in PD5 against `03-technical-spec.md` and `04-semantics.md`: PT9.3, PT9.9, PS3.2, PS4.1b, PS8.7, PT8.5, PT12, PL6401, PD2, PD4. Report each place where PD5 assumes something the spec does not say, as S-numbers starting at S101.
2. **Codes.** Confirm `PL6701` and `PL6702` and K11 are unused. Confirm the rejection reason `claims-unverified` does not collide with an existing reason.
3. **Open question 1 (principal symmetry).** Write an independent script, `docs/reviews/evidence/principal_symmetry.py`, sharing no code with the compiler or poly-ref. Model the PD5 refund example (request, approve by a caller with `kind`, `assurance` and `principal`, refund above a limit) and the property "no refund is emitted after an approval whose principal is the requester". Explore it with 1, 2, 3 and 4 distinct principal representatives. Report the state count and verdict for each, and the smallest count at which the verdict stops changing. Include two mutant controls: one without the self-approval `require`, which must violate with a witness, and one that compares principals by order, which the script must flag as outside the equality-only rule. A bound hit is `INCONCLUSIVE`.
4. **Feasibility.** For each of PD5.1 to PD5.4, say what in polyrun, Polyaxion and poly-ref it needs, and whether any engine needs a change. Engines are vendored and never forked: a needed change goes to JJ's list.
5. Do not edit PD5 or the spec. I rule on the S-numbers.

## Commits

Commit as kizo-core, do not push. One commit per task. Report: the toolchain part digest and file count, the `--json` finding, the S-numbers, and the script's table.
