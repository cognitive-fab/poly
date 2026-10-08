# Experiment proposal: the M3 tasks as stage environments

Status: proposed, for the owner's ruling. Ids: `SE`. No model call is needed for parts 1 to 3.

VERA (NVIDIA, arXiv 2610.05923) builds environments that restart at any stage and score each stage from evidence, and spends most of its cost building them. The M3 runs already hold what such environments need: every task is a base version and three changes delivered in sequence, every run kept a snapshot before each change and a delivery after it, and the poly arms kept a journal. This experiment turns the 200 recorded runs into stage environments and shows that the failing stage is read from the record, not guessed.

## SE1. What is built

- **SE1.1 Stages.** A task has four stages: v0 (the base) and changes 1 to 3. Stage k starts from the snapshot taken before change k and ends at delivery k.
- **SE1.2 One environment per task, stage and arm.** 10 tasks, 4 stages, 4 arms: 160 environments. Each holds the starting snapshot, the brief of stage k, the scoring kit for stage k (O1 tests, O2 invariants, O3 traces) and, for arms 3 and 4, the journal slice of that stage.
- **SE1.3 Admission.** An environment is admitted only if its starting snapshot builds, the recorded delivery k scores to the same result as in `docs/m3/analysis.json`, and a seeded fault in the delivery is caught by the stage's kit. Environments that fail admission are listed with the reason, not repaired by hand.

## SE2. What is measured

1. **Stage scores.** For every run, a score per stage: the share of that stage's checks that pass.
2. **The failing stage.** For every escaped defect of M3 (all are in T3 and T7), the first stage whose checks fail. For arms 3 and 4 it is also read from the journal: the state where the first failed check is journaled. The two readings must agree.
3. **Restart.** Each environment is restarted from its snapshot, and its recorded delivery scored again: the result must be byte for byte the same as the first scoring.
4. **Optional, with model calls.** Only the failing stages of T3 and T7 are rerun live, the four arms paired, five runs each, on the subscription as in M3 (S116). This tests whether a stage started from a clean snapshot still fails, which separates a stage's own difficulty from damage carried in from earlier stages.

## SE3. Acceptance

| Id | Criterion |
|---|---|
| SE-AC1 | All 160 environments are built, and each is admitted or listed with the reason it failed. |
| SE-AC2 | Every escaped defect of M3 is placed in exactly one stage, and for arms 3 and 4 the journal places it in the same stage. |
| SE-AC3 | Every admitted environment restarts and scores again to identical bytes. |
| SE-AC4 | The analysis is a script beside the M3 analysis, reads only `experiments/m3/`, and changes no M3 file or verdict. |

## SE4. What it does not do

It does not reopen M3's verdict, train a model, or change the harness. It is a demonstration that a poly record is a stage environment, and a resource for the next experiment.

## SE5. Open questions for the owner

1. **Q-SE1.** Run part 4 (live reruns of the failing stages), or stop at parts 1 to 3?
2. **Q-SE2.** Release the 160 environments with the research article, or keep them internal?

## Conclusion

The M3 record already has VERA's ingredients: stages, starting states, scoring kits and, for poly, a journal. Built from it, the stage environments cost no model call, place each defect in its stage from the record, and restart to identical bytes.

## Glossary

- **Admission (of an environment):** the check that an environment builds, scores its recorded delivery as before, and catches a seeded fault.
- **Stage:** one delivery of a task: the base or one change.
- **Stage environment:** a starting snapshot, a brief and a scoring kit for one stage, restartable on its own.
- **Stage score:** the share of a stage's checks that pass.
