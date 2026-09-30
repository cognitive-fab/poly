# Response to the review of the model decisions proposal

*Cognitive Fab · September 2026 · answers [`review-2026-09-30-decisions.md`](review-2026-09-30-decisions.md) · to produce proposal v0.2*

All twelve points are accepted. Two are accepted with a narrower rule than the review asked for (points 2 and 8), and one adds a restriction the review did not state but its argument needs (point 2). The table says what v0.2 will change. The sections after it give the reasoning where the change is not obvious.

| # | Point | Response | Change in v0.2 | Where |
|---|---|---|---|---|
| 1 | Confidence is a property of a population | **Accepted.** Each decision gets a calibration map: monotone, fitted on adjudicated outcomes (point 5), versioned, applied by the adapter. Its digest is in every `decision` event and in the certificate's `decisions` section as runtime configuration. Until a map is fitted, the map is the identity and is marked `uncalibrated`; a policy may refuse uncalibrated decisions for irreversible effects. | New PD1.6 | PD1, PD3, PD4 |
| 2 | Most confidence buckets are wasted | **Accepted, with a restriction.** `confidence 0..n` is removed. Confidence gets its own type, `Conf`, delivered at runtime as a fixed-point value in `0..1000`. The checker explores one representative per interval induced by the constants the program and its admitted policies compare it with. This is exact only if confidence is **only compared with constants**, so any other use (arithmetic, comparison with a variable, storing it in a field that is later compared) is refused with `PL1205 CONFIDENCE_NOT_COMPARED`. | PD1.2b, PD1.4 rewritten | PD1 |
| 3 | One call, many questions | **Accepted.** A decision's result type may be a record (S25). Each field has its own confidence, reached as `conf.field`. One call, one `decision` event, one completion. | PD1.2a | PD1 |
| 4 | The margin | **Accepted.** `margin` is a second `Conf` value, the difference between the first and second answers' probabilities, explored by intervals like confidence. Open question 2 is closed. | PD1.2, section 6 | PD1 |
| 5 | Evaluation needs labels | **Accepted.** A handler may adjudicate an earlier decision on the same run: `adjudicate route as Wrong`. It lowers to an `outcome` intent, and the kernel writes an `outcome` event linked to the `decision` event. Evaluation, calibration fitting and drift monitoring read these links. Adjudication across runs is left as an open question. | New PD2.4 | PD2, PD3.3 |
| 6 | The adapter cannot write to the ledger | **Accepted in full.** This was a defect: it broke K2. The adapter returns the decision record as the effect's result. The kernel writes the `decision` event and the completion `step` in one transaction (K1). Only the dispatched attempt of a retried effect is recorded in the chain; the others stay in the outbox attempt log. | PD2.2 rewritten | PD2 |
| 7 | Engines are not deterministic | **Accepted.** New assumption **K10: a decision's answer is fixed by its recorded event, not by its request.** Replay, retries and evaluation cite it. | PD2.3 | PD2 |
| 8 | Failure is the common case | **Accepted, one part as guidance.** `timeout` is required in every decision, and a timeout is a `failed`. A decision with no `failed` completion is a compile error, `PL6202 DECISION_WITHOUT_FAILURE`. A second model as fallback stays legal, because it is just another decision with its own calibration map; the proposal recommends a person or a default branch instead, and says why. | PD1.2, PD1.5 | PD1 |
| 9 | Cost and latency | **Accepted.** The `decision` event records cost units when the provider reports them. The example bounds calls with `count("decision.route") <= 1`. | PD1.5, PD2.2 | PD1, PD2 |
| 10 | `PL6201` can be satisfied vacuously | **Accepted.** A decision is gated iff, for some answer and some confidence interval, the completion step and its cascade cannot reach the compensable or irreversible effect. poly-ref decides it on the graph it already builds. A vacuous `require` no longer counts. | PD1.4d | PD1 |
| 11 | PD3 claims too much | **Accepted.** PD3 is split: verdict independence (a corollary of PS4.1b, proved) and meaning preservation (only through a refitted calibration map). A swap is allowed by policy only after the new map is fitted and recorded. The title and the conclusion are rewritten to match. | PD3 rewritten | PD3 |
| 12 | PD4 depends on things that do not exist yet | **Accepted.** Rules name their decision, `decision("route").conf`. PD4 moves after PD2 and the calibration map, and the milestone table says so. | PD4.3, section 0 | PD4 |

## On point 2: why the restriction is needed

The interval abstraction is exact because two confidence values in the same interval cannot be told apart by any `require`, `if` or rule. That holds only if confidence is compared with constants and nothing else. `conf * 2 >= 13`, `conf >= threshold` with `threshold` a field, or storing `conf` and comparing it later with another decision's confidence would all distinguish values inside one interval, and the abstraction would silently lose paths. `PL1205` refuses those forms instead of approximating them. Comparing two decisions' confidences is a real need, and it is left as an open question: the partition over pairs is computable, but it is not small.

## On point 6: why this one was a defect

The first draft let a process outside the kernel append to a chain that PT16 defines as having one writer per run. Everything else in the review improves the proposal. This one would have made `poly verify` refuse correct runs after an ordinary crash, and let a retried effect leave two answers for one step. It is the first change made in v0.2.

## On point 8: why a second model stays legal

Forbidding it would need a rule about providers, and the language does not know providers apart. A fallback decision is checked like any other: its answers are inputs, its confidence has its own map, and its failure has its own completion. The cost is the one the review names, a second calibration to maintain, and the proposal states it.

## New codes and assumptions in v0.2

| Id | Meaning |
|---|---|
| `PL1205 CONFIDENCE_NOT_COMPARED` | A `Conf` value is used other than by comparison with a constant. |
| `PL6202 DECISION_WITHOUT_FAILURE` | A decision declares no `failed` completion. |
| `PL6201 UNGATED_DECISION` | Redefined by reachability over answers and confidence intervals (point 10). |
| K10 | A decision's answer is fixed by its recorded event, not by its request. |

## Conclusion

The review confirms the core of the proposal and corrects what surrounds it. v0.2 keeps the decision as a checked input, and it adds what makes the numbers trustworthy: a calibration map fitted on outcomes the ledger already records, confidence explored exactly by the intervals the program uses, and a ledger written only by the kernel. PD3 now claims what it proves, and PD4 waits for the pieces it reads. The one defect, a second writer in the ledger, is fixed first.
