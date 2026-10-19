# The calibration maps, for the release

## The state today

The route `triage` has two tiers, and each tier has a calibration map (`demo/concierge/maps/small.json` and `large.json`). A map turns the raw share of votes into a calibrated confidence, and the route escalates from the small tier to the large one when `conf < 0.8 or margin < 0.1`. The committed maps are the example's. They are stand-ins: they were written for the tests' own models (`fittedFor` names another model), not fitted to the models in the room.

The checker refuses a tier whose map is fitted for another model than its price table's `model` (`PL6842`). For the rehearsal, the owner relabelled `fittedFor` to `claude-haiku-5-5` and `claude-opus-5-5` and recomputed the digests (the digest is over `decision`, `version`, `fittedFor` and `points`). Those files, and the price tables, are changed locally under `demo/concierge/` and must not be committed.

A relabelled map is still a stand-in. Its points say how confident to be in the example's model, and they say nothing about the model in the room. On stage this matters in one place: the line between "answer it with the small tier" and "ask the large tier".

## Two ways to the release

### A. One calibration run, then `poly journal fit`

1. Write a set of labelled messages for the decision `classify`: at least 50, with the branch each should get (`Refund`, `Status`, `Other`), in the shapes the room will see, with the attacks among them.
2. Run the concierge on them in a launch that keeps its store (the launcher removes its folder at `quit`, so this needs a launcher option that keeps it, or a script that assembles the demo with a folder it keeps), live, with a cap. A set of 50 messages is about 500 asks (5 for the small tier, 5 more when it escalates).
3. Write the outcome of each message into the store as the program does for its own journal (`outcome` events), or sign a verdict on each recorded answer (`poly verdict`).
4. For each tier, fit: `poly journal fit --db <store> --decision classify --model <the tier's model id> --out demo/concierge/maps/<tier>.json`. With signed verdicts the command is `poly refit`, which refuses below its floor of 50 verdicts (PS22.3).
5. Check that each map's `fittedFor` is the tier's model, commit the maps, and make the copy script carry them (today it copies the example's maps byte for byte, and a test says so).

What it gives: a claim the stage can make without a caveat, "the confidence is calibrated to this model on these messages". What it costs: one run of a few hundred asks (well under a dollar at the small tier's price, a few dollars if many messages escalate), the labels, and a launcher option or script that keeps the store. The map is then true for one model version only. A new model version means a new run.

### B. Stand-ins, named as such on the stage

1. Keep the example's maps, with `fittedFor` set to the models in use and the digests recomputed. Do it in the copy script from the price tables' `model`, so that nobody edits a map by hand.
2. Say it on the stage and in the diff the launcher prints: "the calibration maps are stand-ins; the confidence is not calibrated to this model". The printed diff then shows the relabelling.
3. Do not claim a calibrated confidence. Claim only what the checker proves: the maps are well formed and monotone, and their digests match their contents. Do not claim that a map was fitted for the model: under B the script wrote the `fittedFor` label itself, so the check (`PL6842`) agrees with a label and says nothing about the fit.

What it gives: no extra run and no labels. What it costs: a caveat on stage, and a threshold (`conf < 0.8`) that is indicative and not tuned.

## Recommendation

Use B for the rehearsal and for any show that is not the release. For the release, use A for the `classify` decision, because it is the only decision whose confidence decides what happens (which tier answers, and whether the refund path starts), and the claim "calibrated" is worth one run. If the release has no time for the run, ship B with the caveat on stage, and do not ship the relabelled maps as if they were fitted.

Either way the committed tree holds no relabelled map made by hand: the maps of the release come from the copy script or from `poly journal fit`, and each carries the digest the checker verifies.

## Conclusion

The maps are stand-ins today, and the relabelling that lets the rehearsal run is a local edit. The release should either fit them from one labelled run with `poly journal fit`, or keep them as named stand-ins with the copy script doing the relabelling. The first is the better claim and costs one run. The second is free and needs a sentence on stage.

## Glossary

- **Calibration map:** a monotone map from the raw share of votes to a calibrated confidence, fitted for one model of one decision.
- **`fittedFor`:** the model a map was fitted for. The checker refuses a tier whose map is fitted for another model (`PL6842`).
- **Digest:** the hash over a map's decision, version, `fittedFor` and points. It changes when any of them changes.
- **Escalation:** the route's step from the small tier to the large one when the confidence or the margin is low or the call failed.
- **Stand-in:** a map that is well formed but was not fitted to the model in use.
- **Outcome event:** a record in the store of what a decision's answer turned out to be, which `poly journal fit` reads.
