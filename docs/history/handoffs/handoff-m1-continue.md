# Handoff prompt: continue milestone M1 from step 7

*Paste the text below into Claude Code, started in `C:\Users\jjdub\code\poly`.*

---

Continue milestone M1 from where you stopped: step 7 is under way, with records, child families and bounded loops built. `docs/history/handoffs/handoff-m1.md` and `CLAUDE.md` still govern everything. This prompt only adds the new rulings and the path to M1's close.

## Rulings to apply first

Read `docs/history/decisions-m1.md`, section "Rulings on S54 and S55, and when the model-decisions proposal enters".

- **S54: accepted as you proposed.** Write the two copies of the `charging` entry (`chargeCard` and `chargeTimeout`) in `FRAUD_PASSED` and `AMEND`, with `totalCents` as `AMEND`'s payload. Add no construct. Record "entry effects" in `plan-m1.md` as a candidate to decide from the M3 data.
- **S55: accepted, with a static rule.** Entry writes to one map on one path combine only when their keys are distinct constants after unrolling (literals, constructors, or the index of different loop copies). Two entry writes with the same constant key, a whole write together with an entry write, or an entry write whose key is a field or parameter sharing a path with another entry write to that map: all `PL2102`. Check what you built against that rule. If it accepts a non-constant key, fix it, with a regression test that fails first. Put the spec text in PS2.2 and PS2.4 in one commit that cites S55.

## The rest of step 7, in this order

1. **The two OMS corpora (S24).**
   - Copy the 16 hand-written trace files into `conformance/field-studies/order/` with `PROVENANCE.md`.
   - Record the second corpus with polyrun's kernel from the sixteen scenarios. Check the scenario script in, and have `PROVENANCE.md` say that this corpus was generated from the hand-written artefacts.
2. **The hand-written compose invariants (S27)**, in their own commit, before any poly OMS source exists.
3. **The poly OMS**: the order and the shipment family.
4. **The three AC1 comparisons.**
   - Window-by-window identity with the hand-written module on the copied corpus, 53/81 each.
   - 100% replay on the kernel-recorded corpus.
   - The same `check-effects` and `check-product` results, with machine ids mapped (S28). Timers are compared as S26 rules: a `cancelTimer` is ignored only for a key that is not armed on that path.

   Any difference is a finding to investigate, never a tolerance to add.
5. **Measure and record** the OMS joint state count in `plan-m1.md`.

## Then steps 8 to 11 of `plan-m1.md`

- **Step 8: configurations**, with the checkout evidence: the six-step witness, and 44 states clean.
- **Step 9: the four `Delivery` variants, safety only.** The results must match `delivery_check.py`: 1,147 and 2,368 states, the 4-step `in-order` witness, and the 10-step `at-most-once` witness. `exactly-once` is listed as not run.
- **Step 10: what M0 refused.**
- **Step 11: the record.** Put the measured numbers for every gate item in `plan-m1.md`, then **stop for the code review** and tell me the commit range.

## Standing instructions

- **Spec issues.** New ones continue at S56 in `plan-m1.md`. Raise them before building on them. Build a proposal provisionally only when it does not block, and mark it so.
- **Regression tests.** Every defect found, by you, by polywatch or by the review, gets a regression test that fails first.
- **Engines.** They stay vendored. A change an engine needs is made in its own repository at my approval, then copied in again with its provenance updated.
- **Changes for me.** Keep the list current in `plan-m1.md`: the K9 dispatch refusal in polyrun, and the probe for polyflow and Polyaxion.
- **The model-decisions proposal** (`docs/proposals/pd-model-decisions.md`) is not part of M1. Do not build toward it. At M1's close, and only then, read it to add one list to your closing summary: what M2 would need from the toolchain for PD1. I rule on it after the M1 code review.
- **Commits.** Commit as `kizo-core`, in the house style. Nothing is pushed.

## Done means

- `npm test` passes the whole M1 gate in one command.
- `plan-m1.md` records every spec issue with its resolution, and every measured number.
- You have stopped for the code review, with a short summary:
  - what passed;
  - what surprised you;
  - what M2 needs, including the PD1 list above.

## Conclusion

The language work of M1 is nearly complete. What remains proves it against the hand-written artefacts and the independent evidence: the OMS comparison, the checkout configuration and the delivery protocol. Rule S55 statically, let AC1 hold S54's copies together, and stop at the code review.
