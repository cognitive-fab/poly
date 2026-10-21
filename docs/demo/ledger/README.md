# The double refund on v1.3.0: the records

Two records of the defect that v1.3.1 fixes (DF19), both made on the program of the tag `v1.3.0`.

## The witness of the check (`v1.3.0-witness.check.txt`)

The program is `examples/concierge/concierge.poly` of `v1.3.0` with one ghost field and one property added: `issued : bool = false`, `issued' = true` where the Desk emits the refund (in `Amounted`), and `never one-refund: emit refund while issued`. The check answers `FINDINGS`, `PL3002 STEP_PROPERTY one-refund`, with a witness of 10 steps:

1. `Got`: the Desk is `Idle` and takes a message, `emits decision.classify`.
2. `Classified(Refund)`: `emits source.orders.retrieve`.
3. `Found`: `emits decision.amount`.
4. `Amounted`: the first `payments.refund` is emitted.
5. `Refunded()`: the refund is told `Refunded`, `emits decision.reply`.
6. `Answered`: the reply is sent and the Desk is `Idle` again.
7. `Got`: the guest asks again, `emits decision.classify`.
8. `Classified(Refund)`.
9. `Found`.
10. `Amounted`: a second `payments.refund` is emitted, with a new intent and a new key.

The same path exists after an ambiguous end: `RefundFailed()` in place of `Refunded()` at step 5, because the refund declared no `exhausted` completion.

**What this witness is not.** It is a witness of the checker's model. At steps 3 and 4 the retrieval gives an item set of count 0 and the amount cites a set of count 1, a pair that PS17.6 refuses at run time (a citation is a subset of what the decision was given). So it shows that the text of the Desk allows the path, not that a run can take it. The model imprecision is proposal 14 of `docs/proposals/v2.0.md`.

## The replay in the room (`repro-v1.3.0.mjs`, `repro-v1.3.0.out.txt`)

The same defect as a run. The demo is assembled over the demo copy of the tag `v1.3.0` and the recorded answers, and two requests for 40 are sent by guest 1 (the chairs, paid 120.00) and two by guest 3 (the synthetic order of the live room, paid 120.00). The stand-in ends with 4 refund objects and 8000 refunded on each of the two charges of 12000, and all four requests are answered `on its way`. This is the evidence that a second request refunds twice; the fix is checked by `test/after/demo-ledger-e2e.test.mjs`, where the second request is answered `Already` and the stand-in sees nothing.

## Conclusion

The witness says the path is in the program, and the replay says the path is taken. Both are needed, and neither alone is enough: the first has a step that cannot happen, and the second shows one run.

## Glossary

- **Ghost field:** a field added to a program only so that a property can read it.
- **Witness:** the steps by which the checker's model breaks a property.
