# Example spec: claim-intake

Batch 4, example 1. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

An insurer receives a claim as free text and a fraud flag from a rules screen. A routed decision classifies the claim (auto, home, medical, other): a small model first, a large one when the calibrated answer is unsure. A claim the models are sure of goes to the matching adjuster queue by itself. A claim they are not sure of goes to a person. A claim that the fraud screen flagged is assigned only after a person approves it. The point of the example is the **confidence**: it is calibrated, it is compared with a constant before anything irreversible happens, and a program that does arithmetic with it is refused.

## Files

All paths are under `examples/claim-intake/`. The names are fixed.

| File | Content |
|---|---|
| `claim-intake.poly` | module `claims`, first line `// expected: CLEAN` |
| `claim-intake.policy.poly` | module `claims_policy`, policy `intake`, scope `"claims"` |
| `claim-intake-defect.poly` | the program that adds a confidence to a margin, first line `// expected: REFUSED PL1205` |
| `claim-intake-defect.policy.poly` | the defect's policy beside it; the same text as the program's |
| `claim-intake-ignored.poly` | the program whose confidence is never compared, first line `// expected: FINDING PL3002 PL6201` |
| `claim-intake-ignored.policy.poly` | its policy beside it; the same text |
| `maps/classify-small.json`, `maps/classify-large.json` | the calibration maps of the two tiers |
| `prices/small.json`, `prices/large.json` | the price tables of the two tiers |
| `host/handlers.ts` | the certified handler file; exports `assign` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/claim-intake` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedClaims(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded claims and the recorded answers of the two tiers |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-claim-intake.test.mjs` (light) and `test/after/ex-claim-intake-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`. For a route with tiers read `test/after/ex-concierge-e2e.test.mjs` (`provideTier`) and `examples/concierge/host/recorded.mjs`.

**The expected-verdict line.** `REFUSED <code>` joins `CLEAN`, `FINDING` and `INCONCLUSIVE` in `test/examples-expected.mjs` and in `examples/README.md`: a program the type stage refuses (`PL1205` is an error, not a finding) has the verdict `REFUSED`, with no witness. The sweep compares the verdict and the codes.

## Machine

Module `claims`, `audience { public < claimant < adjuster }` (the runtime keeps a taint record for the stored description only when the program has an audience). One `machine Claim` per claim. Enums: `Category { Auto, Home, Medical, Other }` and `Status { Received, Classifying, Review, Assigning, Assigned, Failed }`. State: `status` (`Received`), `flagged : bool` (false), `sure : bool` (false). `terminal status in { Assigned, Failed }`.

- `File(description: Content, fraud: bool)`: `"filed"` unless `Received`. Records `flagged` from `fraud`, goes to `Classifying`, issues `decide classify(description: description)`.
- `Classified(category, conf: Conf, margin: Conf)`: `"not-classifying"` unless `Classifying`. When `conf >= 0.8`: sets `sure`, goes to `Assigning` and emits `assign(category: category, flagged: flagged)`. Otherwise goes to `Review`.
- `Unclassified()`: the route failed. `"not-classifying"` unless `Classifying`. Goes to `Review`.
- `Decide(category)`: a person's decision. `"not-review"` unless `Review`. Goes to `Assigning` and emits `assign(category: category, flagged: flagged)`.
- `Assigned()`: `"not-assigning"` unless `Assigning`; goes to `Assigned`. `AssignFailed()`: same guard, goes to `Failed`.

## Decision, route and budget

`decision classify(description: Content) -> Category`: `route classify`, labels `egress:external` and `read:private`, timeout 2s; `ok(r)` dispatches `Classified(category: r.answer, conf: r.conf, margin: r.margin)`, `failed` dispatches `Unclassified`.

```
route classify {
  tier small provider "small" prices "prices/small.json" calibration "maps/classify-small.json" max input tokens 4000 max tokens 20
  tier large provider "large" prices "prices/large.json" calibration "maps/classify-large.json" max input tokens 4000 max tokens 20
  escalate when conf < 0.8 or failed
  budget monthly
}
budget monthly { cap usd 20 per month }
```

The calibration maps have the shape `poly journal fit` writes (`decision`, `version` 1, `fittedFor`, `points` as `[raw, calibrated]` in thousandths, and a `digest` that is `digest({ decision, version, fittedFor, points })` of `@poly/core`): `classify-small.json`, fitted for `flash-2026-09`, points `[0,0] [1,1] [100,60] [300,220] [500,400] [800,700] [950,880]`; `classify-large.json`, fitted for `opus-2026-08`, points `[0,0] [1,1] [100,90] [300,290] [500,500] [800,820] [950,960]`. The prices are those of `examples/inbox/prices/small.json` and `large.json`.

## Effect and handler

`effect assign(category: Category, flagged: bool)`: kind `"claims.assign"`, labels `egress:external`, target the exact URL `https://claims.example/v1/queues`, class `compensable`, retry `attempts 3, base 200ms, timeout 10s`; `ok` to `Assigned`, `failed` and `exhausted` to `AssignFailed`.

`host/handlers.ts` exports `assign(payload, caps, ctx)`, with a type-only import from `../.poly/build/claims.Claim/types.js`. It posts `{ queue: <lower-case category>, flagged: <boolean>, claim: ctx.instanceId }` through `caps.egress.post` to the URL with the header `idempotency-key` set to `ctx.idempotencyKey`. Status 200 or 201 returns `{ ok: true }`; a status from 400 to 499 other than 429 throws an error with `permanent: true`; any other status or a transport error throws an ordinary error and is retried.

## Recorded models

`recorded/answers.json` is `{ "models": { "small": "<id>", "large": "<id>" }, "claims": [ { "id", "text", "classify": [ { "tier", "answer", "p", "usage" } ] } ] }`. `recordedClaims(fixture)` returns `{ asked, tiers: { small, large } }`, each tier a provider `(q, materials)` that finds the claim whose `text` is among the bodies it was given and answers `{ answer, distribution: [[answer, p], [other, 1 - p]], usage, reported: <the tier's model>, latencyMs: 0 }`, recording `{ decision, tier, claim: id }` in `asked`. A claim with no entry for the tier throws. `provideRecorded(rt, recorded)` calls `rt.provideTier(name, provider)` for each tier.

| id | text | small | large |
|---|---|---|---|
| `rear-ended` | "Another car hit me from behind at the light." | Auto 0.97 | not asked |
| `pipe-burst` | "A pipe burst in the kitchen overnight." | Home 0.60 | Home 0.90 |
| `vague-loss` | "Something was damaged, I am not sure what." | Other 0.50 | Other 0.55 |
| `staged` | "Rear-ended again, the same car as last month." | Auto 0.97 | not asked |

## Policy

Policy `intake`, scope `"claims"`:

- `fraud-flag-needs-person`: for `proposal.kind == "effect" && effect.kind == "claims.assign" && machine("claims.Claim").flagged`, `require false else escalate`, `on unknown escalate`;
- `classify-while-classifying`: for `effect.kind == "decision.classify"`, requires `machine("claims.Claim").status == Classifying`, `else deny`, `on unknown deny` (without a rule that names the decision polycheck reports `PL7001`).

## Properties

1. **Step property `confident-or-person`**: `(action == Classified && post.status == Assigning) implies conf >= 0.8`. A claim leaves `Classified` for an assignment only on a calibrated confidence of at least 0.8.
2. **Path property `assign-at-most-once`**: `count("claims.assign") <= 1`.

The program and its policy check `CLEAN`.

## Seeded defects

`claim-intake-defect.poly` replaces `if conf >= 0.8` with `if conf + margin >= 1`. A `Conf` may be compared with a constant and nothing else (PD1.3b), so the check refuses the program with exactly **`PL1205 CONFIDENCE_NOT_COMPARED`** and the verdict `REFUSED`. A refusal is a type error and has no witness; the test asserts the code, the verdict, the line and the absence of a witness. No stage after the types runs.

`claim-intake-ignored.poly` is the same program with the comparison on the confidence replaced by a test of the category (`if category == Auto`): the confidence is never compared. The check finds it with exactly two codes, **`PL3002 STEP_PROPERTY`** (`confident-or-person`) and **`PL6201 UNGATED_DECISION`** (`classify`), each with a witness of **2 steps**: `File`, `Classified(Auto, 0, 0)`, the second reaching `Assigning` and emitting `claims.assign`. This is what "a confidence that is never compared" produces; `PL1205` is the code for a confidence compared with something that is not a constant.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the instance is printed for `Claim`, the route and the budget;
- the maps: each parses, its digest is right (`mapProblem` of `@poly/core` returns null), and its points are those above;
- `claim-intake-defect.poly` is `REFUSED` with exactly `PL1205`, at the line of the comparison, with no witness;
- `claim-intake-ignored.poly` is `FINDINGS` with exactly `PL3002` and `PL6201`, each with a witness of 2 steps whose second step is `Classified`;
- `poly check --host` is `CLEAN`, and a handler with a wrong field is `PL6836`;
- the handler: 201 ok; 422 permanent; 503 not permanent; header and body as above; a missing throw fails the test (a flag after the catch, not `assert.fail` inside the `try`);
- the recorded tiers answer as the table says, record no text, and throw for a claim without an entry.

End-to-end test, over recorded traffic, nothing on the network (the route's tiers are registered with `rt.provideTier`, as the concierge's test does):

- main path: `rear-ended` is classified by the small tier alone, `Assigned` with one POST carrying a key and the queue `auto`; `asked` shows the tier `small` only;
- calibration and escalation of the route: `pipe-burst`'s small answer (raw 0.60) calibrates below 0.8 and the large tier is asked, whose answer (raw 0.90) calibrates above 0.8: `asked` shows `small` then `large`, the claim is `Assigned` to `home`, and the journal's decision event records the calibrated confidence, which is not the raw one;
- escalation to a person on low confidence: `vague-loss` is unsure on both tiers and ends `Review` with no POST; `Decide('Other')` assigns it;
- escalation on a fraud flag: `staged`, filed with `fraud: true`, is classified and its assignment is **escalated** by the gate, with no POST; a person's signed approval (`approvalFor`, `rt.approve`) releases it, then one POST with `flagged: true`;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`), the route's tier choices among them.

## Amendments made when the code existed

- **The recorded usage is `{ input, output }`**, the keys of the price table, not `inputTokens` and `outputTokens`. The route is priced, so the keys matter (language findings 21).
- **A route records one decision event**, for the tier that answered (`route`, `tier`, `tierIndex`, `raw`, `conf`, `calibration`). The small tier's call is in `asked`. For `pipe-burst` the large tier's raw 0.90 is recorded with the calibrated confidence **820**, which is the value of the map's largest point not above 0.90: the calibration reads a step of the map, not an interpolation. The test asserts the tier, the raw value, that the calibrated one is at least 800 and is not the raw one, and the map's `fittedFor`.
- **A route and a budget are machines in the report** (`classify.Route` 6 states, `monthly.Budget` 96), not configurations. A refusal's diagnostic is in the report's own `diagnostics`. The tests were corrected for these after the code existed.
- **`REFUSED <code>` joins the expected-verdict line** (`test/examples-expected.mjs`, `examples/README.md`), because `PL1205` is an error and its verdict is `REFUSED`.
- **What "never compared" produces.** The task named `PL1205` for it. `PL1205` is a confidence compared with a non-constant; a confidence never compared is `PL3002` and `PL6201`, which is the second defect file (language findings 22).

## Conclusion

The confidence is the one number in the program that a model writes, so the language lets it be compared and nothing else, and refuses the arithmetic. What the check cannot say is whether the calibration is right; the example shows the calibrated number the program saw, and the two seeded defects show the two ways of not using it.

## Glossary

- **Calibration:** a map from a model's raw confidence to the probability that its answer is right, fitted on outcomes.
- **Route:** a decision's tiers: a small model first, a larger one when the calibrated answer is unsure.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Refused:** the verdict of a program the type stage rejects; there is no witness.
