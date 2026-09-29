# Response to the final formal review of draft v0.5

*Cognitive Fab · September 2026 · answers [`review-2026-09-29-final.md`](review-2026-09-29-final.md) · produces draft v0.6*

All nine corrections were made. The one the review called large, modelling the delivery protocol, was done first and checked.

| # | Correction | Change in v0.6 | Where |
|---|---|---|---|
| 1 | Messages need identities | A message in transit is `(id, target, action, data)`, with `id = (sender, sender's step number, position in that step)`, the model's image of the idempotency key. The explorer keeps a multiset of values and delivers the **oldest** copy of a value. This is exact for safety, because copies are indistinguishable to the receiver. With weak fairness per value it implies fairness per identified message: a copy has at most `B − 1` copies ahead of it. Fairness lists gain `A(*)`, one group per data value. | 04 PS13.2, PS13.2a, PS13.2b, PS14.2, PS6.1; 03 PT2 |
| 2 | K4 needs its horizon | Dedupe records live as long as the instance. Archiving keeps them as tombstones. A redelivery to an archived instance returns the recorded result, or `archived`, and never takes a step. | 04 PS10 K4; 03 PT9.8 rule 1 |
| 3 | The happens-before argument | A run is a partial order under the causal relation. Steps of different instances commute, so every linear extension is a path of **check**, and an invariant clean on **check** holds under every linearisation. A new section says how configuration invariants are monitored: by consistent snapshots, or offline over the ledger. | 04 PS13.7, PS13.8, PS13.9 |
| 4 | The delivery protocol has no model | The `Delivery` machine models sender, outbox worker, a lossy network (finite loss), resends, the receiver's dedupe table and archiving, and states `at-most-once`, `in-order` and `exactly-once` (liveness). It is checked in four variants; the results are below. Exactly-once is now a checked property of the model, and the runtime's conformance to the model is kernel assumption K8, checked by trace replay at M4. | 03 PT9.8; 04 PS14.3, PS10 K8; 01 PF3.3c, AC12 |
| 5 | Quantifiers and constants in comments | `g[*]` is allowed only inside `count`, `sum`, `all` and `any`. Elsewhere, `forall i in g:` or `exists i in g:` is required (`PL5403`). `init(e)` names initial values. The checkout properties are rewritten: `count(order[*] is Done) <= init(inv.onHand)` and `forall i in order: order[i] is Asked leads to order[i] is Done \| Refused`. | 04 PS13.6; 03 PT2.2, PT7a |
| 6 | Dischargeability is not a property of behaviours | It is now named a **possibility property**, checked as reachability, not with the PS5 and PS6 machinery. The conflicting subset is "a minimal subset", found in a fixed deletion order (declaration order, then promotion order) so results are reproducible. Discharge is checked over the scope's **tool alphabet**; the declared alphabet is used only when there is no tool catalogue, and the certificate records which. | 04 PS8.6; 01 PF4.5 |
| 7 | Which messages cross the gate | Sends that cross a trust scope are proposed to the gate; sends within a scope are not; effects always are. A denied send is not delivered. The sender receives `SendDenied(to, action, reason)` as an ordinary message. | 04 PS8.7; 03 PT9.9; 02 AD-14; 01 PF3.3b |
| 8 | The exception has become the rule | PA0.1 is restated: the engines check single machines, and poly has its own model checker, poly-ref, for how machines relate over time. The documents call poly-ref a model checker throughout. | 02 PA0.1, §2a; 03 PT5; README |
| 9 | Evidence scripts are witnesses, not proofs | The scripts are now acceptance tests for poly-ref. M0 requires poly-ref to reproduce the single-machine results and M1 the configuration and delivery results. A disagreement is investigated until one side is shown wrong. | 03 PT18 M0, M1; 01 AC13 |

## Evidence for item 4

The `Delivery` machine was explored by an independent script, [`evidence/delivery_check.py`](evidence/delivery_check.py), written from 04-semantics:

| Variant | Result |
|---|---|
| In-order worker, dedupe kept on archive | 1,147 states; `at-most-once` and `in-order` hold; `exactly-once` holds under the stated fairness |
| Parallel worker, dedupe kept | 2,368 states; `at-most-once` and `exactly-once` hold |
| Parallel worker, `in-order` required | violated in 4 steps: `Emit(M1), Emit(M2), Send(M2), DeliverReq(M2)` |
| In-order worker, dedupe cleared on archive | `at-most-once` violated in 10 steps: a resent `M1` is delivered and acknowledged, `M2` is delivered, the receiver is archived, and the duplicate of `M1` arrives and takes a second step |

These results fix three rules for the runtime:

- dedupe records live as long as the instance;
- `fifo` needs the in-order worker;
- delivery is unordered by default, with exactly-once holding either way.

The fourth variant is the exact scenario the review described in section 2.

## Conclusion

v0.6 closes the review's corrections, and it closes the large one with the method the review asked for: the delivery protocol is written in poly and checked, and the check both confirms the design and shows why its two rules (dedupe for the life of the instance, and the in-order worker for `fifo`) are needed. Messages have identities, the configuration theorem has its proof, quantifiers are explicit, and the one existential property is named as such. The gate sees every message that leaves a trust scope. poly-ref is called what it is, and its first tests are already written. What remains is the build, and the experiment at M3 that decides whether the language is worth it.
