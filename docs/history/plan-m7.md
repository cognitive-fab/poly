# M7 · Feedback: plan

Status: written by the owner's reviewer (2026-10-11). The owner ruled on section 8 the same day. Main is at v1.0.1 (02ad6d4f). M7 starts from main on a new branch, `m7`, in a worktree `poly-m7`.

## 1. Goal

M7 closes the loop from a running program back to its checked source (PF10). A run's journal becomes evidence, the evidence becomes candidate rules and workflows, a person adjudicates them, and what is adjudicated enters the program only through the same pipeline as any other source: check, admission, certificate.

The two acceptance criteria of PT18 are the measure:

- **M7-AC1.** A Polyx rule adjudicated `real` round-trips to an admitted obligation.
- **M7-AC2.** A polyness proposal arrives as poly source and is admitted or refused by the pipeline.

## 2. What exists today

To be confirmed by step M7.0. From the code and the specs at v1.0.1:

- `poly export`, `poly mine` and `poly propose` are listed in `NOT_BUILT` (commands.ts), marked M7.
- `poly journal export` exists (PD3.3), with `verify`, `replay`, `eval` and `fit`. M7.1 builds on it; it does not start over.
- The ledger kind `advice` exists (POLY_KINDS) and the runtime can append an advice event. Serving Polyx advice at a work order or a gate decision (architecture section 9) is not claimed by any gate record.
- polyx mines obligations in the four polyness patterns plus eligibility (rev. 12: do X only while the thing X acts on is in state A). Its only port is `jev`. It has no poly port.
- polyness writes a proposal as a contract, the mined rules and an effect surface (the six-file polyflow format). It does not write poly source.
- The obligation consistency check (PS8.6, `PL6501 UNDISCHARGEABLE_MANDATE`) exists and already names a promoted Polyx rule as a source.
- On the "After v1" list and parked for M7: work orders with budgets (S359, PT24.6), and adjudications for a calibration refit (no host collects them).

## 3. Scope

In M7:

1. `poly export traces` (PF10.1).
2. `poly mine` and the promotion path (PF10.2, PF4.4, PF4.5).
3. `poly propose` (PF10.3).
4. Adjudications and the calibration refit (After v1 item), if the owner rules it in (Q-M7-3).
5. Work orders with budgets (S359), if the owner rules it in (Q-M7-4).

Not in M7:

- `poly twin` and worlds (PF10.4, v2).
- E3, the checked harness example (Q-V2). It runs as its own session (Q-M7-5).
- Any change to a gate decision or a transition from advice. Advice stays advisory (N4).

## 4. Rules that hold throughout

- Spec text first, tests written from the text alone by a separate writer, then the code (rule 7a). Each new test is seen failing first.
- One heavy job on the machine at a time. One full suite at a time.
- The 160 measured programs keep their verdicts, and the two release examples stay `CLEAN` with their policies.
- Commit as kizo-core. Never push. No keys, tokens or environment values in any record. Synthetic fixtures only.
- **Privacy of the evidence.** A journal holds people's mail and messages. An exported trace carries labels, states, outcomes and digests, never a `Content` body. A forgotten subject is not exported. Mining and proposing run on the owner's machine; nothing leaves it.

## 5. Steps

### M7.0 Inventory (light)

Read `poly journal export`, the advice path, polyx's ports and output format, and polyness's proposal format. Write `docs/m7/inventory.md`: what each command needs, what exists, what is missing, and every spec gap, each as a proposed S-number (S500 onward). The reviewer rules on the gaps before M7.1.

### M7.1 `poly export traces` (PF10.1)

- **Spec text:** the trace corpus format. One episode per run of an instance. Each step gives the action, its label and consequence, the pre and post states (as declared values, not data), the gate decision, and the outcome. Disclosed-domain windows carry `outsideCheckDomain` (PT3.4), as domain-drift evidence. Bodies appear only as digests. An erased subject's steps are left out, and the export says how many.
- **Tests:** an export of the concierge's AC27 journal and the inbox's IAC9 journal. A canary in a body appears nowhere in the export. A forgotten owner's steps are absent. The export replays: each episode folds to the same post-states as the journal.
- **Acceptance:** the export of both release examples' recorded runs, with the canary and erasure tests passing.

### M7.2 `poly mine` and promotion (PF10.2, PF4.4, PF4.5)

- **The port.** A poly port for polyx: the exported trace is the corpus, and the program's declared actions and labels are the alphabet. A typed alphabet is the thing polyx asks a reviewer to build by hand, and a poly program already has one. Where the port lives is Q-M7-1.
- **The mapping.** Each mined pattern becomes poly source:

  | Polyx pattern | poly obligation |
  |---|---|
  | `no-X-without-prior-Y` | `requires-prior` |
  | `X-implies-prior-Y` | `implies-prior` |
  | `at-most-one-X` | `at-most` |
  | `no-X-unless-state` | machine obligation guard over the declared state |
  | eligibility (rev. 12) | guard over the state of the thing X names (new text) |

- **The candidate.** Each rule comes back as a proposed obligation in poly source, with its evidence, its counter-evidence and the episodes behind both. It is not part of any program yet.
- **Adjudication.** A person signs `real`, `spurious` or `defer` (PF9.6: an agent key cannot sign). Only `real` proceeds.
- **Promotion.** A `real` rule is added to the scope's obligations and checked with all the others (PS8.6). A promotion that makes a mandate undischargeable is refused at that moment with `PL6501` and its minimal conflicting subset. Otherwise the program is checked and admitted as any program is, and its certificate names the rule and its adjudication record.
- **Acceptance (M7-AC1):** on the inbox's recorded journal, one mined rule is adjudicated `real`, promoted, checked and admitted, and the certificate cites it. A second rule that conflicts with the policy is refused with `PL6501`. A rule adjudicated `spurious` never reaches a program.

### M7.3 `poly propose` (PF10.3)

- **The input.** Agent journals: the runtime's own work-order journals, and Claude Code transcripts through polyness's reader (Q-M7-2 decides which are in scope).
- **The output.** polyness writes the proposal as poly source: a workflow machine, the mined rules as obligations, and the effect surface as labelled effects. Where that emitter lives is Q-M7-1.
- **The pipeline.** The proposal is checked like any source. A `CLEAN` proposal can be admitted by a person. A proposal with a finding is refused, with the finding and its witness.
- **Acceptance (M7-AC2):** polyness's `verified-push` example arrives as poly source and is admitted. A variant with a rule its own history does not support is refused, with the reason.

### M7.4 Adjudications and the calibration refit (if Q-M7-3 is yes)

- **Spec text:** an adjudication record for a decision's answer (right, wrong, with the correct answer when known), signed by a person, journaled against the decision.
- **The host.** The inbox's host gains `ask adjudicate`. The digest shows each decision once for a verdict.
- **The refit.** `poly journal fit` turns adjudications into a new calibration map per tier. The new map is signed and admitted. The tier swap rule (PD1.6) applies. The map is never changed in place.
- **Acceptance:** on synthetic adjudications, a refit map moves conf toward observed accuracy, raises no calibration warning, and the inbox checks `CLEAN` with it.

### M7.5 Work orders with budgets (S359, if Q-M7-4 is yes)

- **Spec text:** a work order may carry a budget (PT24.6). Usage reported by the participant is evidence of a weaker kind than a provider's, and the text says how the budget treats it.
- **Acceptance:** a workflow whose work orders exceed the budget is refused at the gate, and a reservation is released on a failed order.

### M7.6 The loop on an example

The inbox closes the loop on recorded traffic, end to end:

1. Export.
2. Mine.
3. Adjudicate.
4. Promote.
5. Check and admit.
6. If M7.4 is in, refit a map.

This is a test in the serial after group, and a section in `examples/inbox/README.md`.

### M7.7 Closing gate

From a clean build, alone on the machine:

1. The full suite, the after group and check-memory.
2. Measured verdicts identical for the 160 programs, and both examples `CLEAN`.
3. Per-file times against the V10 gate.
4. Release notes and the gate record.

Then main is fast-forwarded and tagged v1.1.0 locally.

## 6. Sessions

- **m7 (one session).** It does M7.0 to M7.7 in order, in `poly-m7`.
- **The other repositories.** If Q-M7-1 puts the port or the emitter in polyx or polyness, that work is a separate session in that repository, with its own tests, and m7 depends on its version.
- **E3.** E3 can run beside M7 in its own session, sharing the one-heavy-job rule (Q-M7-5).

## 7. Risks

1. **Thin evidence.** polyx's own-evidence floor is five instances. The recorded runs of two examples may support few rules, so M7-AC1 may need a synthetic corpus made for the purpose, labelled as such.
2. **Privacy.** An export that leaks one body defeats the inbox's whole claim. The canary test is the guard, and it must cover every exported field.
3. **The eligibility pattern.** It is new in polyx (rev. 12) and has no poly form yet. Its mapping is new spec text.
4. **Two other repositories.** A change in polyx or polyness moves on its own release cycle. A poly-side port avoids that, at the cost of tracking their formats.

## 8. Open questions for the owner

- **Q-M7-1. Where the port and the emitter live.**
  - (a) In poly, reading polyx's and polyness's existing outputs. No change in those repositories.
  - (b) In polyx and polyness, as the architecture planned (section 12).
  - Recommended: (a) for M7, so poly does not wait on two other releases. (b) later, if their formats move.
- **Q-M7-2. What `poly propose` reads.**
  - (a) Poly's own work-order journals only.
  - (b) Those and Claude Code transcripts through polyness's reader.
  - Recommended: (b), since polyness's evidence today is Claude Code transcripts, and `verified-push` is built on them.
- **Q-M7-3. Adjudications and the calibration refit in M7?** Recommended: yes. It is feedback, it is what the inbox needs for its confidence to mean anything, and `poly journal fit` already exists.
- **Q-M7-4. Work orders with budgets (S359) in M7?** Recommended: yes, as M7.5, since M11 parked it here.
- **Q-M7-5. E3 beside M7, or after it?** Recommended: beside it, in its own session, since the two touch different code.
- **Q-M7-6. Serving Polyx advice at run time** (architecture section 9: advice on a work order and on a gate decision, never changing either). Recommended: out of M7. The ACs need the promotion path only, and serving advice belongs with the harness work.

### Owner's rulings (2026-10-11)

- **Q-M7-1:** (a), in poly. No change in polyx or polyness for M7.
- **Q-M7-2:** (b), poly's work-order journals and Claude Code transcripts through polyness's reader.
- **Q-M7-3:** yes, M7.4 is in.
- **Q-M7-4:** yes, M7.5 is in.
- **Q-M7-5:** E3 runs beside M7, in its own session.
- **Q-M7-6:** out of M7.

## 9. Conclusion

M7 adds three commands and one path. The path is the important part: a rule learned from runs enters a program only as source that a person adjudicated and the checker admitted. The poly side is mostly translation, since a poly program already has the typed alphabet and the obligation forms the miners need. The new spec text is the trace format, the eligibility mapping and, if ruled in, adjudications and work-order budgets. The size of M7 will show in the inventory of M7.0 and the S-numbers it proposes.

## 10. Glossary

- **Adjudication.** A person's signed verdict on a candidate rule (`real`, `spurious`, `defer`) or on a decision's answer (right or wrong).
- **Alphabet.** The typed set of actions miners read. polyx asks a reviewer to build one; a poly program declares one.
- **Candidate rule.** A rule mined from traces, with its evidence and counter-evidence, not yet part of any program.
- **Eligibility.** polyx's pattern for "do X only while the thing X acts on is in state A".
- **Episode.** One run of an instance in an exported trace.
- **Own-evidence floor.** The least number of instances a rule needs in the user's own history before it is proposed (five).
- **Port.** The code that turns one system's records into a miner's corpus.
- **Promotion.** Adding an adjudicated rule to a program's obligations, through the check and admission.
- **Trace corpus.** The exported form of journals: labels, states, outcomes and digests, never bodies.
