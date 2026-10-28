# Incident on-call

An incident report arrives as text. A typed decision gives its severity. A confident high severity pages the on-call engineer, once, through an irreversible page attempted once, and starts a five-minute timer. If nobody acknowledges the page before the timer fires, the incident escalates, once, to the manager. A page can be snoozed twice. Everything here runs on recorded answers: no model is called and nothing leaves the machine. The spec is `docs/examples/incident-oncall.md`.

## What it shows

- **A liveness property under fairness.** `page-is-answered`: a page is acknowledged or escalated, assuming the timers and the effects' completions are taken (`under fair { Timeout, Wake, PageSent, PageFailed, Escalated, EscalateFailed, Confirm }`). The humans' actions (`Ack`, `Snooze`, `Classify`, `Resolve`) are not fair: nobody is assumed to act. `Confirm` is the exception: the person told that an escalation is unconfirmed is assumed to look, as the timers are assumed to fire.
- **Timers.** `ack` (5 minutes) is armed when the page is sent and cancelled by an acknowledgement or a snooze. `wake` (15 minutes) is armed by a snooze. The end-to-end test moves the clock.
- **Paging at most once, each call attempted once.** The path properties `page-at-most-once` and `escalate-at-most-once` hold. The pager documents no idempotency key, so the page and the escalation are `retry { attempts 1 }`: a retry whose first answer was lost could page twice, which v1.3's retry-safety rule reports as `PL4003` (finding 31). A page the program cannot read goes to `Unconfirmed` with the ack timer still armed, so the engineer acknowledges or the timer escalates to the next person. An escalation it cannot read goes to `EscalationUnconfirmed`, and a person's `Confirm(reached)` says which.
- **An escalation to a person.** A decision pages only when it is confident (a decision's irreversible effect must be gated by its confidence, `PL6201`). An unsure answer, or a failed one, goes to `Review`, and a person's `Classify` decides.
- **A seeded defect.** `incident-oncall-defect.poly` has the snooze bound removed: a person can snooze for ever, and each snooze cancels the escalation timer, so weak fairness never forces the escalation.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/incident-oncall/incident-oncall.poly
node packages/poly-check/dist/src/cli.js check examples/incident-oncall/incident-oncall-defect.poly
node packages/poly-check/dist/src/cli.js check examples/incident-oncall/incident-oncall.poly --root examples/incident-oncall --host examples/incident-oncall/host/tsconfig.json
node --test test/ex-incident-oncall.test.mjs
node --test test/after/ex-incident-oncall-e2e.test.mjs
```

The tests check the program with its policy beside it, as a project.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Incident` over 40 states, 2 content representatives; the liveness stage ran under weak fairness; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3301 LIVENESS_LASSO` (`page-is-answered`), a witness of 9 steps: `Report`, `Triaged(High, 800, 0)`, `PageSent`, then a cycle of six that holds `Snooze` and `Wake` (and the late `PageSent` and `PageFailed`, which weak fairness also holds in it); 25 states |
| Host handlers | compile under `poly check --host`; a wrong payload field is `PL6836` |
| End to end | 14 tests: admission, main path, a timeout that escalates, a low severity logged and a third snooze refused, an unsure report sent to a person, a snooze that cancels the escalation and wakes, a refused page that escalates, an acknowledgement that arrives before the page is answered, an unconfirmed page acknowledged and one escalated by the timer, an unconfirmed escalation confirmed either way, a `Confirm` refused on an incident that is not unconfirmed, and a journal that replays (3 runs, 18 rows, 1 gate session, no divergence) |

## What is not checked

- **Time.** The check does not compare durations: 5 minutes and 15 minutes are only "a timer that may fire". That the escalation comes five minutes after the page is the end-to-end test's, on a clock it moves.
- **The bound on snoozes is 2.** `snoozes` is `0..2`, so `CLEAN` is a statement about at most two snoozes. The defect shows what an unbounded one does. No other domain was reduced.
- **Liveness assumes the completions.** The property assumes every completion of the program's own page and escalation is accepted (S126). Since an `Ack` can arrive while the page is out, `PageSent` and `PageFailed` are taken in every status and act only from `Paging`, so the handlers of the program's own completions never reject; a test covers the late one.
- **Nobody acts.** `Ack` is not assumed, which is why the escalation exists; a person who never classifies a `Review` incident leaves it there, and the property is about pages, not reviews.
- **The pager.** The recorded services answer by status. Whether the real pager dedupes on a key is not documented, which is why nothing is retried.

## Conclusion

Liveness is the property a person cannot see by reading: every action is individually fine, and the starvation is in the cycle between two of them. The check finds it as a lasso of nine steps, and the bound on snoozes is the whole fix. The check is fast here (35 states); the cost of the example was in the decision, which may not page unless it is sure.

## Glossary

- **Weak fairness:** an action that stays enabled is eventually taken; here the timers and completions.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Snooze:** a person's postponement of an escalation.
- **Review:** the state of an incident whose severity the model was not sure of, waiting for a person.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
