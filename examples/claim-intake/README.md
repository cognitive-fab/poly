# Claim intake

An insurer receives a claim as free text and a fraud flag from a rules screen. A routed decision classifies the claim (auto, home, medical, other): a small model first, a large one when the calibrated answer is unsure. A claim the models are sure of goes to the matching adjuster queue by itself. A claim they are not sure of goes to a person. A claim that the fraud screen flagged is assigned only after a person approves it. Everything here runs on recorded answers: no model is called and nothing leaves the machine. The spec is `docs/examples/claim-intake.md`.

## What it shows

- **A classification decision with calibration.** `classify` is a route with two tiers, each with a calibration map (`maps/classify-small.json`, `maps/classify-large.json`) that turns the model's raw confidence into the probability that its answer is right. The journal records both numbers: for the pipe-burst claim the large tier's raw 0.90 is recorded beside its calibrated 0.82 and the map's digest.
- **Escalation below the confidence threshold.** The route escalates from the small tier to the large one when the calibrated confidence is below 0.8. When both are unsure, the program sends the claim to `Review`, and a person's `Decide` assigns it. The step property `confident-or-person` says a claim leaves `Classified` for an assignment only on a calibrated confidence of at least 0.8.
- **Escalation on a fraud flag.** A flagged claim is classified as any other, but its assignment is escalated by the policy: nothing is posted until a person's signed approval, and then one request is sent with `flagged: true`.
- **A confidence is compared with a constant, and nothing else.** The type stage refuses a program that does arithmetic with it.
- **Two seeded defects.** `claim-intake-defect.poly` compares `conf + margin` with 1, which is `PL1205` and a refusal (verdict `REFUSED`, no witness). `claim-intake-ignored.poly` never compares the confidence at all, which is `PL3002` and `PL6201`, each with a witness of 2 steps.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/claim-intake/claim-intake.poly
node packages/poly-check/dist/src/cli.js check examples/claim-intake/claim-intake-defect.poly
node packages/poly-check/dist/src/cli.js check examples/claim-intake/claim-intake-ignored.poly
node packages/poly-check/dist/src/cli.js check examples/claim-intake/claim-intake.poly --root examples/claim-intake --host examples/claim-intake/host/tsconfig.json
node --test test/ex-claim-intake.test.mjs
node --test test/after/ex-claim-intake-e2e.test.mjs
```

The tests check each program with its policy beside it, as a project. The first lines of the three programs state their verdicts, including `REFUSED PL1205`, which `test/examples-expected.mjs` reads.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Claim` over 17 states, the route over 6, the budget over 96; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect (`conf + margin`) | `REFUSED`, exactly `PL1205 CONFIDENCE_NOT_COMPARED`, at the line of the comparison, no witness; no later stage runs |
| Ignored confidence | `FINDINGS`, exactly `PL3002` (`confident-or-person`) and `PL6201` (`classify`), each a witness of 2 steps: `File`, `Classified(Auto, 0, 0)`, the second emitting `claims.assign` |
| Calibration maps | each has the shape `poly journal fit` writes and the right digest |
| Host handler | compiles under `poly check --host`; a wrong generated type is `PL6836` |
| End to end | 6 tests: the small tier's confident claim assigned, the route's escalation with the calibrated confidence in the journal, a person deciding an unsure claim, a flagged claim escalated and released by a person's signed approval, and a journal that replays (6 runs, 2 gate sessions, no divergence) |

## What is not checked

- **Whether the calibration is right.** The maps are the example's own, written to the shape a fit writes; the check reads their digests, not their truth. A real map is fitted on adjudicated outcomes.
- **The fraud screen.** The flag is the host's input; that it is right is the screen's.
- **The meaning of "never compared".** The task named `PL1205` for a confidence that is never compared. The code means a confidence compared with something that is not a constant, such as a margin; a confidence never compared at all is `PL3002` and `PL6201`. Both defects are here, and the difference is in `docs/examples/language-findings.md` (item 22).
- **Domains.** Four categories, one description per claim, the transit of one machine. Nothing was reduced; `CLEAN` is a statement about 17 states.
- **The queue.** That the adjuster queue accepts the assignment is the queue's; the handler sends the intent's idempotency key.

## Conclusion

The confidence is the one number in the program that a model writes, so the language lets it be compared and nothing else, and refuses the arithmetic. What the check cannot say is whether the calibration is right; the example shows the calibrated number the program saw, and the two seeded defects show the two ways of not using it.

## Glossary

- **Calibration:** a map from a model's raw confidence to the probability that its answer is right, fitted on outcomes.
- **Route:** a decision's tiers: a small model first, a larger one when the calibrated answer is unsure.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Refused:** the verdict of a program the type stage rejects; there is no witness.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
