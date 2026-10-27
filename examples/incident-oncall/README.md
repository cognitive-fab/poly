# Incident on-call

An incident report arrives as text. A typed decision gives its severity. A confident high severity pages the on-call engineer, once, through an irreversible, keyed page, and starts a five-minute timer. If nobody acknowledges the page before the timer fires, the incident escalates, once, to the manager. A page can be snoozed twice. Everything here runs on recorded answers: no model is called and nothing leaves the machine. The spec is `docs/examples/incident-oncall.md`.

## What it shows

- **A liveness property under fairness.** `page-is-answered`: a page is acknowledged or escalated, assuming the timers and the effects' completions are taken (`under fair { Timeout, Wake, PageSent, PageFailed, Escalated, EscalateFailed }`). The humans' actions (`Ack`, `Snooze`, `Classify`, `Resolve`) are not fair: nobody is assumed to act.
- **Timers.** `ack` (5 minutes) is armed when the page is sent and cancelled by an acknowledgement or a snooze. `wake` (15 minutes) is armed by a snooze. The end-to-end test moves the clock.
- **Paging at most once.** The path properties `page-at-most-once` and `escalate-at-most-once` hold, and the page carries the intent's idempotency key.
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
| Program with its policy | `CLEAN`; `Incident` over 25 states, 2 content representatives; the liveness stage ran under weak fairness; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3301 LIVENESS_LASSO` (`page-is-answered`), a witness of 7 steps: `Report`, `Triaged(High, 800, 0)`, `PageSent`, then the cycle `Snooze`, `Wake`, `Snooze`, `Wake`; 12 states |
| Host handlers | compile under `poly check --host`; a wrong payload field is `PL6836` |
| End to end | 8 tests: main path, a timeout that escalates, a low severity logged and a third snooze refused, an unsure report sent to a person, a snooze that cancels the escalation and wakes, a refused page that escalates, and a journal that replays (3 runs, 18 rows, 1 gate session, no divergence) |

## What is not checked

- **Time.** The check does not compare durations: 5 minutes and 15 minutes are only "a timer that may fire". That the escalation comes five minutes after the page is the end-to-end test's, on a clock it moves.
- **The bound on snoozes is 2.** `snoozes` is `0..2`, so `CLEAN` is a statement about at most two snoozes. The defect shows what an unbounded one does. No other domain was reduced.
- **Liveness assumes the completions.** The property assumes every completion of the program's own page and escalation is accepted (S126). The handlers of those completions reject only when the status is wrong, which the program's own steps cannot reach.
- **Nobody acts.** `Ack` is not assumed, which is why the escalation exists; a person who never classifies a `Review` incident leaves it there, and the property is about pages, not reviews.
- **The pager.** The recorded services answer by status; the real pager's dedupe by key is its own.

## Conclusion

Liveness is the property a person cannot see by reading: every action is individually fine, and the starvation is in the cycle between two of them. The check finds it as a lasso of seven steps, and the bound on snoozes is the whole fix. The check is fast here (25 states); the cost of the example was in the decision, which may not page unless it is sure.

## Glossary

- **Weak fairness:** an action that stays enabled is eventually taken; here the timers and completions.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Snooze:** a person's postponement of an escalation.
- **Review:** the state of an incident whose severity the model was not sure of, waiting for a person.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
