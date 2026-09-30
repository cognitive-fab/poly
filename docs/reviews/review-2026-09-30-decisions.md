# Review: model decisions proposal (PD1 to PD4)

*Peer review of `docs/proposals/pd-model-decisions.md`, written in the manner of TypeSafe's founders at the author's request: one reviewer who trained language models and cares about what a probability means, and one who ships production AI systems and cares about what happens at 3 a.m. It is not written by them. 30 September 2026.*

## Verdict

**Accept PD1 and PD2 after the fixes below. Revise PD3, which claims more than it proves. Defer PD4 until PD2 exists.**

The central move is right, and it is the move a decision model is built for. A model that returns a value from a supplied schema has a finite output, and a finite output can be treated as an input to a program that was checked for every value. The proposal does not ask the model to be correct. It asks the program to be correct for every answer the model can give. That is the correct division of labour, and we have not seen it stated this cleanly elsewhere.

The problems are in three places. The proposal treats confidence as a number with a fixed meaning, and it does not have one. It puts a writer outside the kernel into a ledger that has one writer. And it models one question per call, where the engine is built to answer many questions about one state at once.

## Part one: what the numbers mean

### 1. Confidence is a property of a population, not of an answer

PD1 quantises confidence into `0..10` and lets handlers and policies branch on it (`conf >= 8`). The checker then explores all eleven values, which is fine. The problem is what `8` means.

Calibration is a statement about groups of predictions: of the answers given at confidence 0.8, about 80% are right. It says nothing about any single answer, and it holds only for the distribution the model was calibrated on. So `conf >= 8` in the source is not "at least 80% likely to be right". It is "the engine said 0.8 or more", and that is only as good as the engine's calibration on this traffic, this month.

That matters in two ways:

- **The constant in the program has no stable meaning across models.** Two models can both be well calibrated overall and differ badly on refunds. The threshold that was reasonable for one is wrong for the other. PD3 says a model swap leaves every verdict valid. The verdicts stay valid, but the program no longer means what its author meant.
- **Calibration drifts.** Traffic changes, and the model does not. A floor chosen at launch quietly changes its meaning.

**Fix.** Separate the threshold from the raw score with a declared **calibration map**. The adapter maps the engine's raw confidence through a monotone map fitted on adjudicated outcomes for this decision (isotonic regression is enough), and delivers the mapped value. The map is versioned. Its digest is recorded in every `decision` event (PD2) and listed in the certificate's `decisions` section, marked as runtime configuration. Then `conf >= 8` means "at least 0.8 on this decision's own measured calibration", and a model swap requires a new map, fitted before the swap. The certificate still does not bind the model; the policy's meaning is preserved by the map.

### 2. Most of the confidence buckets are wasted

`confidence 0..10` makes the author choose a resolution, and the checker pays for it: eleven values per decision, multiplied across decisions and instances. But the program only ever compares confidence with a few constants. In the router, only `>= 8` matters, so there are two distinguishable values, not eleven.

**Fix.** Drop the declared resolution. Let the checker compute the partition of `[0, 1]` induced by the constants the program and its policies compare against (for the router: `[0, 0.8)` and `[0.8, 1]`), and explore one representative per interval. This is exact, not an approximation: no handler or rule can tell two values in the same interval apart. It removes a modelling decision from the author, and it keeps the state space small when several decisions are chained. A constant added to a policy changes the partition, so policies must be admitted before the check, as PT8 already requires.

### 3. One call, many questions

A decision engine evaluates several typed questions against one state in a single call, and the answers come back together. PD1 has one result per decision. Real uses ask for a branch, a sentiment score and a fraud flag about the same message. Splitting them into three decisions triples the calls and the latency, and loses the fact that they were answered about the same state.

**Fix.** Allow a record result type (S25): `decision triage(text: string) -> { branch: Branch, angry: Tri, fraud: Tri }`, with one confidence per field. The domain is the product of the fields, which the interval partition of point 2 keeps small. One call, one `decision` event, one completion.

### 4. The distribution is information, and the proposal throws it away

PD2 records the distribution and then says properties cannot use it. The single most useful signal in a routing decision is often not the top confidence but the **margin**: how far the first answer is ahead of the second. A refund at 0.55 with the runner-up at 0.44 is a different situation from a refund at 0.55 with the runner-up at 0.05.

**Fix.** Deliver the margin as a second bounded quantity beside confidence, partitioned the same way, and let requires and policies read it. Open question 2 then has an answer that does not multiply the domain.

### 5. Evaluation needs labels, and the ledger already has them

PD3.3 says quality is measured by replaying recorded questions against a candidate model and comparing with "adjudicated outcomes". It does not say where those come from. They are already in the ledger: a refund that was later reversed, a ticket routed to `status` that came back as a complaint, a human who overrode an escalation. Those are labels.

**Fix.** Define an `outcome` link: a later step on the same run can declare that it adjudicates an earlier decision (`adjudicates route as Wrong`), and the ledger records the link. Evaluation, calibration fitting (point 1) and drift monitoring all read the same links. This is what closes the loop the paper calls learning from outcomes, and it keeps the loop outside every verdict.

## Part two: what happens in production

### 6. The adapter cannot write to the ledger

PD2.2 has the provider adapter write the `decision` event, then dispatch the completion. PT16 chains the ledger per run and follows polyrun's single writer per instance (K2). The adapter is a second writer. Two failures follow:

- the adapter writes the event and crashes before the dispatch: the run has a decision with no step, and `poly verify` refuses a run that did nothing wrong;
- the effect is retried (PT6.1 retry), and the engine answers differently the second time: two `decision` events for one intent, and nothing says which one the step used.

**Fix.** The adapter does not write to the ledger. It returns the whole decision record as the effect's result. The kernel writes the `decision` event and the completion `step` in the same transaction (K1), so they exist together or not at all. On a retry, only the attempt whose result is dispatched is recorded; the others appear in the outbox attempt log, not in the chain. PD2.2c's refusal then catches only tampering, which is its purpose.

### 7. Engines are not deterministic, and the proposal should say so

The same question can get a different answer on a second call, even from the same model version. The proposal handles this correctly for replay (PD2.3 uses the recorded answer), but it should state it as an assumption, in the same form as K1 to K9: **a decision's answer is fixed by its recorded event, not by its request.** Retries, caches and evaluation all depend on it.

### 8. Failure is the common case, and the language should make it cheap to handle

The engine will time out, rate-limit and be down. PD1 gives `failed -> RouteFailed()`, which is right, but three things are missing:

- **A deadline, in the decision.** Routing at 3 seconds is worse than a person at 1 second. `timeout 800ms` belongs in the declaration, and a timeout is a `failed`.
- **A fallback without a second model in the checked core.** The natural fallback for a decision is a person or a default branch, both of which PD1 can already express. Say so, and discourage a second model as fallback: it doubles the calibration problem of point 1.
- **Every decision should have a `failed` completion.** A decision without one is a machine that can wait forever on a dead provider. That should be a compile error, not a finding.

### 9. Cost and latency belong in the record

A decision is fast and cheap only if the program does not call it in a loop. Record `latencyMs` (the proposal does) and the provider's reported cost units in the `decision` event, and let a path property bound decisions like any other effect: `count("decision.route") <= 1`. The checker already decides that; the proposal only needs to show it in the example.

### 10. `PL6201` will be satisfied by `require conf >= 0`

A lint that looks for "a `require` on the way" is satisfied by a require that tests nothing. With the interval partition of point 2, the checker can do better: a decision is gated only if some reachable path from its completion to the irreversible effect is **not** taken for some interval of confidence or some answer. That is a reachability question on the graph poly-ref already builds, and it cannot be fooled by a vacuous require.

## Part three: the claims

### 11. PD3 proves less than it says

PD3.1a is correct as written: the certificate binds nothing about the model, so the verdicts survive a swap. The section title and the conclusion say more: that the model "can be replaced without re-checking". The program can. Its behaviour cannot be assumed unchanged, for the reasons in points 1, 4 and 5. Rewrite PD3 as two statements: the **verdicts** are model-independent (proved), and the **policy's meaning** is preserved only through the calibration map (point 1), which must be refitted and recorded before a swap. PD3-A1 stays. PD3-A2 should require a fitted map before the swap is allowed.

### 12. PD4 depends on things that do not exist yet

Operating modes are sound as a policy pattern, and checking dischargeability per mode (PD4.4b) is a good idea. But the rules read `decision.conf`, which needs PD2's event and point 1's map to mean anything, and "the most recent decision on the path" (PD4.3a) is ambiguous as soon as a machine makes two decisions. Name the decision in the rule (`decision("route").conf`), and move PD4 after PD2 and the calibration map.

## Summary of requested changes

| # | Change | Item |
|---|---|---|
| 1 | Calibration map per decision, versioned, digest in the event and the certificate | PD1, PD3 |
| 2 | Confidence explored by the intervals the program's constants induce, no declared resolution | PD1.2b, PD1.4 |
| 3 | Record result types: several questions in one call | PD1.2a |
| 4 | Margin as a second bounded quantity | PD1, open question 2 |
| 5 | Outcome links in the ledger, used by evaluation and calibration | PD2, PD3.3 |
| 6 | The kernel writes the `decision` event with the completion step, in one transaction | PD2.2 |
| 7 | State the answer-is-fixed-by-its-record assumption | PD2.3 |
| 8 | `timeout` in the declaration; a missing `failed` completion is an error | PD1.2 |
| 9 | Cost in the event; bound decisions with a path property in the example | PD1.5, PD2.2 |
| 10 | `PL6201` by reachability over intervals, not by syntax | PD1.4d |
| 11 | Split PD3 into verdict independence and meaning preservation | PD3 |
| 12 | Name the decision in policy rules; sequence PD4 after PD2 | PD4.3 |

## Conclusion

The proposal gets the hard part right. A model with a closed output is an input to a checked program, and the program can be made safe for every answer without trusting the model at all. What it gets wrong is the easy-to-miss part: the numbers a decision engine returns only mean something relative to measured outcomes, so the thresholds written in a program need the same care as the program. With a calibration map, confidence explored by the intervals that matter, the ledger written by the kernel, and outcomes linked back to decisions, this becomes the missing piece between a decision engine and a system that can be audited: every answer is checked before it happens, explained after it happens, and measured over time without touching a verdict.
