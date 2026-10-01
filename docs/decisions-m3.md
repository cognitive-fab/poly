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

## Rulings on the M3 plan (S87 to S93)

| Issue | Ruling | Spec change |
|---|---|---|
| **S87** My uncommitted work in the polygraph checkout | **Accepted.** Make the polyrun change in a separate worktree, on a branch `m3-sendto` cut from `583b82c`. Bump the patch version there, vendor from that branch's commit, and record the branch and commit in `PROVENANCE.md`. Merging into polygraph's main is mine. My working tree is not touched. | none |
| **S88** How K9's refusal behaves | **Accepted, with an audit record.** An outside dispatch of an action wired as a child's completion is refused before any step, with no journal row, because PS7.1 does not offer that stimulus and no step exists. The refusal returns an error to the caller naming K9, and it is written to polyrun's audit log, so a refused attempt is observable without being a step. | PS10 (K9) |
| **S89** How polyrun delivers a message | **Accepted.** An outbox row keyed `<sender>:<seq>:<position>` is PS13.2's message identity, and the receiver's dedupe on it for the life of the instance is K4. There is no fixed delivery order: unordered is the default of PT9.8, and `fifo` needs the in-order worker. A send to an unknown instance goes to the dead-letter list and is journaled on the sender's run. Tests and the adapter may deliver one message at a time. | PT7a; PT9.8 |
| **S90** A `host.map.json` for the generated adapter | **Accepted, with one change: the agent writes it.** In the poly arms, `host.map.json` is part of the delivered solution: the agent decides which machine and action each host method drives, as the TypeScript arms decide how to implement the same interface. The adapter generator validates it, and a map that names a machine or action that does not exist is a failed build. Providing it to the poly arms would give them a design the TypeScript arms must make themselves. | PT13 (Tasks) |
| **S91** A network API in multi-machine host interfaces | **Accepted, for every arm.** A multi-machine task's host interface includes `inFlight()`, `deliver(id)` and `deliverAll()`, in the brief, for all four arms. O1 tests arrival orders only through it. The TypeScript arms must implement messages that can be held and delivered in any order; the poly arms' adapter implements it over polyrun's outbox (S89). Without it, the defect class the configuration check targets could not be observed in arms 1 and 2, and the comparison would be unfair to them. | PT13 (Tasks) |
| **S92** Oracles for each evolution change | **Accepted.** Each of the three changes of each task gets its own brief delta, reference machine, mutant, O2 and O3. Its O1 comes from the same independent session (M3-1), which receives the change briefs in order, never the references. | PT13 (Evolution) |
| **S93** PT18 after M3-2 | **Accepted.** PT18's M3 row lists the polyrun change (`sendTo`, address resolution at commit, the K9 refusal) as a prerequisite. The M5 row keeps what remains of `sendTo delivery in polyrun`: the gate proposing cross-scope sends and `SendDenied` (PS8.7, PT9.9). | PT18 |

Steps 1 and 2 can start. The task set starts after S90 to S92 are reflected in the task template.

## Rulings on the frozen set (S94 to S99), and the next steps

| Issue | Ruling |
|---|---|
| **S94** Multi-machine briefs name their messages and effects | **Accepted.** Every arm gets the same brief, so naming the messages helps all four equally. |
| **S95** Effects and timers | **Accepted as applied.** T1 (`payment.charge`) and T3 (`card.authorize`) have effects, through the effect port every arm shares (`pendingEffects`, `completeEffect`). Timers stay out of the task set, for the reason the plan gives; the report lists it as a limitation. |
| **S96** What a win requires | **Accepted.** Both the 30% reduction and a Holm-corrected p below 0.05 against arms 1 and 2. A reduction without significance is reported as it is, never as a win. |
| **S97** Reference traces | **Accepted.** One trace per transition in every version, and every mutant re-verified against them. |
| **S98** T9 limited to one election round | **Accepted,** as the brief states. |
| **S99** Tokens | **Accepted.** Input, output, cache-read and cache-write tokens are recorded separately; their sum is the primary measure, and cost at list price is secondary. |

**An observation for the report, not a change to the frozen set.** T10's defect (a revocation overtaking its grant, leaving a client holding an expired lease) was found by O2, not by poly. A configuration invariant cannot express it. A liveness property such as "a revoked lease leads to the client not holding it" could have, and T2's references carry liveness properties while T10's do not. The report records that poly's checks find what the properties written for them say, and this case is listed with T2 and T7 as one where checking the reference changed the design. A `quiescent` predicate for configuration invariants ("no message in transit") is a candidate for after M3.

**Order of the next steps.**

1. The O1 session (mine), then control 4. Nothing else runs until control 4 passes on all 40 versions.
2. The four pilot runs on P1 (`experiments/m3/PILOT`), one per arm. They replace the cost assumptions with measured token counts and set the per-run budget.
3. The budget decision, from the pilots' numbers: the per-run token cap, the wall-time limit and the total spend. If the total is too high, the first lever is three runs per task per arm instead of five (120 runs); the model is not changed, because the question is about the model agents use.
4. `experiments/m3/FROZEN`, after `freeze.mjs --check` reports no change.

**S100 The toolchain is not in the freeze (found on review).** `freeze.mjs` digests the tasks, the O1 kit, the controls, the adapter, the runner, the prompts and the analysis. It does not digest the poly toolchain (`packages/`), the vendored engines (`vendor/`) or `package-lock.json`. Arms 2 to 4 run that toolchain, so a change to it after the freeze would change three arms without changing any digest. **Ruling:** add a part `toolchain` covering `packages/` (sources only, no build output), `vendor/` and `package-lock.json`, and record the git commit in `freeze.json`. Until M3's runs are finished, nothing under `packages/` or `vendor/` changes. Work that does not touch them (proposals, reviews, evidence scripts under `docs/`) may continue. Step 4 above waits on this part.

## Conclusion

The experiment runs on equal terms: both poly arms have the same tooling, the multi-machine tasks really run on polyrun, and the primary oracle is written without seeing any answer. Everything is frozen by digest before the first run, and the runs start only after the frozen set and the budget are approved.
