# Handoff prompt: build poly, milestone M2

*Paste the text below into Claude Code, started in `C:\Users\jjdub\code\poly`.*

---

M1 is closed: its gate passes, its code review is fixed, and every spec issue through S67 is ruled. Your job in this session is **milestone M2** of PT18: diagnostics and the second surface, liveness, detached children, and typed decisions. Nothing beyond it.

## Read first, in this order

1. `CLAUDE.md`: the standing rules. Add the new rule from `decisions-m1.md` ("Every artefact the runtime reads is checked") to its table, with the test that enforces it, in your first commit.
2. `docs/decisions-m1.md`, the last two sections: the rulings at M1's close (S56 to S65) and after the review (S66, S67, the standing rule).
3. `docs/proposals/pd-model-decisions.md` (v0.2, ruled), with its review and response in `docs/reviews/`. PD1 is in M2. PD2 to PD4 are not; do not build toward them.
4. `docs/04-semantics.md`: PS6 (liveness, fairness, `A(*)`, the lasso check of PS6.4), PS13.2b and PS14.2 (fairness in configurations), PS1.6 and PS13.3 (addresses and spawning, with S57 and S60).
5. `docs/03-technical-spec.md`:
   - PT2.5 (the embedded surface) and PT6.5 (capabilities and the handler lint);
   - PT12.1 to PT12.4 (diagnostics, fixes with preconditions, verdicts, witness export);
   - PT14 (the command surface);
   - PT18, M2's row as amended.
6. `docs/plan-m1.md` §12 or its closing summary: what M2 needs, including the PD1 toolchain list, which is your plan input for typed decisions.
7. `docs/reviews/evidence/`: `delivery_check.py`, `outbox_check.py` and `outbox_sum_check.py` print the liveness results M2 must reproduce.

Then write `docs/plan-m2.md` (packages touched, order of work, how each gate item is tested, and the spec issues you find, continuing at S68). Stop and show me the plan.

## M2 scope

1. **Liveness** (PS6). `leads to` and `eventually` under weak fairness, with `A(*)` groups, decided by the SCC check of PS6.4 on the graph poly-ref already builds, with lasso witnesses (a prefix and a cycle). In machines, and in configurations with the S56 form and delivery fairness per value (PS13.2b, PS14.2). Liveness properties stop being listed as not run.
2. **Diagnostics and fixes** (PT12.1 to PT12.4).
   - Node-addressed fixes with preconditions. A fix whose preconditions no longer hold is refused (`PL0201 STALE_FIX`).
   - `poly fix` applies a fix.
   - Witness export: `poly witness <id> --trace` and `--test`. The exported host test drives the runtime API through the witness and asserts the violated predicate.
3. **The embedded surface** (PT2.5). A `poly-embed` front end that reads TypeScript with the compiler API, accepts only the PT2.2 subset inside handler and property bodies (`PL0301` otherwise), and produces **the same AST** as the standalone syntax. The M3 experiment depends on it.
4. **The handler lint** (PT6.5): `poly lint handlers`, `PL6401`.
5. **`spawn detached`** (S60): the address rule, the group, `instances n` with `PL5302`. The polyrun `createInstance` intent is not yet available, so stage 3 of such a module is poly-ref's alone and says so, as for `send` (S58).
6. **Typed decisions** (PD1 of the proposal): `decision`, `decide`, `ok(r)` bindings (also for ordinary effects, PD1.2g), decimal literals, the `Conf` type, `Tri` inside machines, the interval partition (PD1.4b), `PL1205`, `PL6201` by reachability, `PL6202`, the lowering to an effect of kind `decision.<name>` with `$.result.*` completion maps, and a strict range check for `Conf` at dispatch. Tests use a recorded provider adapter; no test calls a model, and the import-boundary check keeps the adapter off every check path.
7. **The test suite.** Each deliberately broken lowering runs only over the smallest sources that exercise its construct, listed beside it in `test/toolchain-faults.mjs`. One full sweep over every source stays in `npm test`.

## The M2 gate (all must pass)

- **AC3.** For every seeded defect in the conformance suite, the diagnostic has a witness, and the exported host test fails on the unfixed program and passes on the fixed one. Build the seeded set first, one per diagnostic kind that has a witness (invariant, step property, reject property, path property, deadlock, domain escape, configuration invariant, stuck, liveness), and record it in the plan.
- **Fixes.** Applying every offered fix in a random order never misapplies one: each either applies with its preconditions true, or is refused as stale. Use at least 100 random orders with a recorded seed.
- **Liveness evidence**, matching the scripts:
  - `exactly-once` holds under the stated fairness for the two `Delivery` variants that keep dedupe records;
  - `settles` holds for the v0.3 and union forms of `OutboxIntent`, and fails for the v0.2 form with a fair cycle at each of its two deadlocked states;
  - the checkout configuration's `settle` holds for the waiting order.
- **The embedded surface.** Every conformance case and example written in both surfaces produces the same AST digest (PT1.4), and the same verdict. Cover at least the turnstile, the orders example, and one machine with effects, timers and children.
- **Typed decisions:** PD1-A1 to PD1-A4 of the proposal.
- **The standing rule.** Every artefact the runtime reads has a round-trip check, and each has a broken variant in the explicit list.
- **No regressions.** Every M0 and M1 gate number is unchanged.

## Constraints

- **Everything in the M0 and M1 handoffs still holds.** In particular:
  - poly-ref is written from 04-semantics and imports nothing from the compiler packages; `poly-embed` joins the compiler side of that boundary;
  - no model call on any check path;
  - engines are vendored, never forked;
  - every defect gets a regression test that fails first;
  - commits are made as `kizo-core`, and nothing is pushed.
- **Engine changes.** They wait for me. The ones already on my list (polyrun: `sendTo`, the K9 refusal, `createInstance`; the OMS example's `onExhausted` data; the probe for polyflow and Polyaxion) are not on M2's path. If any M2 item needs one of them, say so in the plan.
- **Spec issues** continue at S68 in `plan-m2.md`. Raise them before building on them.
- **A disagreement with an evidence script** is investigated until one side is shown wrong, and reported to me before either changes.

## Done means

- `npm test` passes the whole M2 gate in one command.
- `docs/plan-m2.md` records what was built, every spec issue and its resolution, and the measured numbers for each gate item.
- **Stop for the code review.** Tell me the commit range.
- A short summary: what passed, what surprised you, and what the M3 experiment needs that M2 does not provide.

## Conclusion

M2 completes the toolchain the experiment needs. Liveness closes the last property kind, fixes and witness tests turn a finding into a change an agent can make and verify, and the embedded surface lets M3 compare the two ways of writing poly on equal terms. Typed decisions arrive on the same checked foundation: a model's answer becomes one more input, explored for every value it can take.
