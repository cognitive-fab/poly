# std.routing: provenance

The rules of `std/routing/routing.poly` are poly's own (PT24, PS18, S351, S352). No provider documents how a program should escalate between models or hold a budget, so no rule here encodes a provider's text. What a provider does document, its prices, enters through price tables: each names the URL it was read from and the date it was read (`source`, `readOn`), and a table without them is `PL6843 PRICE_UNSOURCED` (S350). No price is written in this module.

## poly's own rules

| Rule in the module | Why |
|---|---|
| `ready-at-the-first-tier` (invariant) | A route starts at its first tier, the cheapest by the author's order (PF14.1). |
| `one-tier-up` (step property) | A route moves up one tier at a time, never back and never past one (PT24.2). |
| `calls-only-while-trying` (step property) | A tier's call is emitted only while the route is trying, so an answered or exhausted route calls no provider (PT24.2). |
| `answered-meets-thresholds` (step property) | An answer is taken only when it meets every threshold of the escalation condition (PF14.2). |
| `below-thresholds-escalates` (step property) | An answer below a threshold is never taken: the route escalates or is exhausted (PF14.2). |
| `exhausted-after-the-last` (step property) | A route is exhausted only after its last tier (PT24.2). |
| `route-ends` (liveness, under fairness of `Answer` or `Fail`) | AC25: every path reaches `Answered` or `Exhausted` when each provider call eventually completes; the number of tiers bounds the escalation (PF14.2). |
| `within-cap` (invariant) | AC26, S352 as ruled: spent plus reserved never exceeds the cap, except by an overrun, which is a provider reporting more than the limit it was given (K15). |
| `spent-is-final` (invariant) | A budget is spent only when nothing is reserved and no reservation can fit, so its terminal state refuses nothing it could have taken. |
| `reserve-fits` (step property) | PT24.3, step 1: a reservation is taken only when it fits the remainder. |
| `cap-fixed` (step property) | A cap is opened once; the period or scope it covers is its address, so a new period is a new instance (PS18.4). |
| `settle-charges-actual` (step property) | PT24.3, step 2: settlement replaces the reservation with the actual cost. |
| `overrun-recorded` (step property) | PT24.3, step 3, and S352 as ruled: an overrun is counted, never hidden, and the next reservation sees it. |
| `spent-only-by-settle` (step property) | Only a settled call is spent; a release returns its reservation and charges nothing. |

## Constants

| Constant | Source |
|---|---|
| two tiers (`0..1`) and the condition `conf < 0.8 \|\| margin < 0.1` | poly's own, for the check alone: each route replaces them with its own tiers and condition (PS18.1). |
| the check domains of `Budget` (`cap` in `0..3`, a reservation in `1..3`, a cost in `0..6`) | poly's own, for the check alone: small enough to explore, and wide enough to put a reservation below, at and above the remainder and a cost below, at and above its reservation. At run time amounts are micro-units beyond them, accepted and disclosed (PT3.4, PS18.4). |
| `retry { attempts 1, base 500ms, timeout 30s }` on `call` | poly's own: a failed tier is escalated by the route rather than retried, so the outbox tries each call once. `500ms` and `30s` are the outbox's defaults (S137); each route takes its decision's timeout (PS18.1). |

## Not checked

The quality of an answer, the calibration of a map on traffic it was not fitted on (PD1.6), and whether a provider's usage report is what it bills (K15) are outside the module. `poly cost` can be reconciled against invoices as a measure.

## Conclusion

The module encodes a route as a bounded climb through tiers that ends in an answer or exhaustion, and a budget as reservations that cannot pass a cap except by a recorded overrun. Every rule is poly's own and listed here, and each has a seeded mutant in `test/std-routing.test.mjs`.
