# poly · Decisions before M3

*Cognitive Fab · September 2026 · the first experiment (PT13)*

M2 is closed. These rulings settle what the experiment needs before any run. PT13 is amended in the same commit.

| Id | Question | Ruling | Spec change |
|---|---|---|---|
| **M3-1** | PT13 has the primary oracle (O1) written by a person who has read the brief and not seen any reference machine. Who writes it? | **An independent agent session.** A separate Claude session receives only the ten briefs and their host interfaces, with no access to the poly repository, the reference machines, O2, O3 or any arm's output, and writes the O1 scenario suites. Its prompt and its inputs are kept with the results. The report states that O1 was written by an agent of the same model family as the arms, as a limitation. | PT13 (Oracles) |
| **M3-2** | Three tasks must involve machines that talk, and a poly module that sends cannot run under polyrun. | **The `sendTo` change lands first.** It is made in polygraph (polyrun), approved here: the `sendTo` intent; the `{ "$ref": "self" }` marker resolved to the sender's instance id; child addresses resolved at commit (S78). The K9 refusal of an outside dispatch of a child's completion is made in the same change. `createInstance` is made only if a task uses detached children; the task set says so. Then polygraph is re-vendored with its provenance, as for S36. | PT18 M3 row (prerequisite) |
| **M3-3** | Typed fixes exist only on the standalone surface (S70), which would favour arm 3 over arm 4. | **Fixes on the embedded surface first.** The six fixes of S70 apply to embedded modules too, with the same preconditions and the same random-order test. Both poly arms then get the same help, and the surface decision compares the surfaces, not the tooling. | PT12.1 |
| **M3-4** | PT13's poly arms implement the host interface "with a thin generated adapter over the runtime API", which arrives in M4. | **An adapter over polyrun's kernel.** For M3, the generated adapter drives polyrun's kernel directly, as the S68 harness does, and the report says so. M4 regenerates it over the runtime API. | PT13 (Tasks) |
| **M3-5** | When is the experiment fixed? | **Before any run, by digest.** The briefs, host interfaces, reference machines, O1 to O3, the controls, the runner, the prompts, the budgets and the analysis script are committed, and their digests are recorded in `docs/plan-m3.md`. Any change after that is reported as a deviation. No arm runs until I have approved the frozen set and the budget. | PT13 (Analysis) |

## Conclusion

The experiment runs on equal terms: both poly arms have the same tooling, the multi-machine tasks really run on polyrun, and the primary oracle is written without seeing any answer. Everything is frozen by digest before the first run, and the runs start only after the frozen set and the budget are approved.
