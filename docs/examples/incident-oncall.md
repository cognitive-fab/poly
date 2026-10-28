# Example spec: incident-oncall

Batch 2, example 1. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

An incident report arrives as text. A typed decision gives its severity. A high severity pages the on-call engineer, once, through an irreversible, keyed page, and starts a five-minute timer. If nobody acknowledges the page before the timer fires, the incident escalates, once, to the manager. A page can be snoozed twice, and a snooze stops the timer and starts a wake-up timer. The point of the example is the **liveness property**: a page is always acknowledged or escalated, assuming the timers fire. The seeded defect is an escalation path that can starve.

## Files

All paths are under `examples/incident-oncall/`. The names are fixed.

| File | Content |
|---|---|
| `incident-oncall.poly` | module `oncall`, first line `// expected: CLEAN` |
| `incident-oncall.policy.poly` | module `oncall_policy`, policy `paging`, scope `"oncall"` |
| `incident-oncall-defect.poly` | the program with the snooze bound removed, first line `// expected: FINDING PL3301` |
| `host/handlers.ts` | the certified handler file; exports `page` and `escalate` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/incident-oncall` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedIncidents(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded answers of the decision |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-incident-oncall.test.mjs` (light) and `test/after/ex-incident-oncall-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`.

## Machine

One `machine Incident` in module `oncall`, one instance per incident. It declares `audience { public < team }` (the runtime keeps a taint record for a stored report only if the program has an audience). Enums: `Severity { Low, High }` and `Status { Reported, Triaging, Review, Logged, Paging, Paged, Unconfirmed, Snoozed, Escalating, Escalated, EscalationUnconfirmed, Unreached, Acked, Resolved }`.

State: `status` (`Reported`), `snoozes : 0..2` (0). `terminal status in { Logged, Unreached, Resolved }`.

Actions and handlers (a `require` that fails rejects with the quoted reason):

- `Report(summary: Content)`: `"reported"` unless `Reported`. Goes to `Triaging`, issues `decide triage(report: summary)`.
- `Triaged(sev, conf: Conf, margin: Conf)`: `"not-triaging"` unless `Triaging`. When `conf >= 0.8`: `Low` goes to `Logged`; `High` goes to `Paging`, emits `page()` and arms the timer `ack` for 5m to fire `Timeout`. When `conf < 0.8` goes to `Review`. (A decision's irreversible effect must be gated by its confidence, PL6201.)
- `Untriaged()`: the decision failed. `"not-triaging"` unless `Triaging`. Goes to `Review`.
- `Classify(sev)`: a person's classification. `"not-review"` unless `Review`. `Low` goes to `Logged`; `High` goes to `Paging`, emits `page()` and arms `ack` for 5m.
- `PageSent()`: `"not-paging"` unless `Paging`. Goes to `Paged`.
- `PageFailed()`: `"not-paging"` unless `Paging`. Goes to `Escalating`, cancels `ack`, emits `escalate()`.
- `PageUncertain()`: the one attempt of the page ended with no answer the program can trust; the engineer may have been paged. Taken in every status, like `PageSent` and `PageFailed` (see the amendments below), it sets `answered` and acts only from `Paging`: it goes to `Unconfirmed` and leaves the timer `ack` armed. Nothing pages again. The people decide from there: the engineer, if paged, acknowledges; if nobody does, the timer escalates to the next person.
- `Ack()`: `"not-waiting"` unless `Paging`, `Paged` or `Unconfirmed`. Goes to `Acked`, cancels `ack`.
- `Timeout()`: `"not-waiting"` unless `Paging`, `Paged` or `Unconfirmed`. Goes to `Escalating`, emits `escalate()`.
- `Snooze()`: `"cannot-snooze"` unless `Paged` and `snoozes < 2`. Goes to `Snoozed`, increments `snoozes`, cancels `ack`, arms timer `wake` for 15m to fire `Wake`.
- `Wake()`: `"not-snoozed"` unless `Snoozed`. Goes to `Paged` and arms `ack` for 5m.
- `Escalated()`: `"not-escalating"` unless `Escalating`. Goes to `Escalated`.
- `EscalateFailed()`: `"not-escalating"` unless `Escalating`. Goes to `Unreached` (a person must be found). It is a refusal the pager service made: nobody was paged.
- `EscalateUncertain()`: `"not-escalating"` unless `Escalating`. The one attempt of the escalation ended with no answer the program can trust. Goes to `EscalationUnconfirmed`.
- `Confirm(reached: bool)`: a person's reading of the pager service for an unconfirmed escalation. `"not-unconfirmed"` unless `EscalationUnconfirmed`. When `reached`, goes to `Escalated`; otherwise goes to `Unreached`. It emits nothing.
- `Resolve()`: `"not-answered"` unless `Acked` or `Escalated`. Goes to `Resolved`.

## Decision and effects

`decision triage(report: Content) -> Severity`, provider `"small"`, labels `egress:external` and `read:private`, timeout 2s. `ok` dispatches `Triaged` with the answer, `r.conf` and `r.margin`; `failed` dispatches `Untriaged`.

`effect page()`: kind `"pager.page"`, labels `egress:external`, target the exact URL `https://pager.example/v1/pages`, class `irreversible`, retry `attempts 1, base 200ms, timeout 10s`; `ok` to `PageSent`, `failed` to `PageFailed`, `exhausted` to `PageUncertain`.

`effect escalate()`: kind `"pager.escalate"`, target `https://pager.example/v1/escalations`, otherwise the same; `ok` to `Escalated`, `failed` to `EscalateFailed`, `exhausted` to `EscalateUncertain`.

**Attempted once (G1, PS23.4; finding 31).** The pager service documents no idempotency key, so neither call is retried: a retry whose first answer was lost could page twice, which the check reports as `PL4003 UNGUARDED_RETRY` (PS23.5). With one attempt, `failed` is a refusal the service made (nobody was paged) and `exhausted` is an end the program cannot read (somebody may have been paged), which goes to a person as above.

## Host handlers

`host/handlers.ts` exports `page(payload, caps, ctx)` and `escalate(payload, caps, ctx)`, with a type-only import from `../.poly/build/oncall.Incident/types.js`. Each posts `{ incident: ctx.instanceId }` through `caps.egress.post` to its URL with the header `idempotency-key` set to `ctx.idempotencyKey` (nothing documents that the service honours it, so the program does not rely on it). Status 200 or 201 returns `{ ok: true }`. A status from 400 to 499 other than 429 throws an error with `permanent: true`; any other status or a transport error throws an ordinary error, and since each effect has one attempt it ends `exhausted` and is not sent again.

## Recorded provider

`recorded/answers.json` is `{ "models": { "small": "<id>" }, "reports": [ { "id", "text", "answer", "distribution": [ [ severity, p ], ... ], "usage" } ] }`. `recordedIncidents(fixture)` returns `{ asked, decisions: { triage: { provider, model } } }`; the provider finds the report whose `text` is among the bodies the decision was given, records `{ decision, report: id }` in `asked`, and returns `{ answer, distribution, reported, latencyMs: 0 }`; an unknown text throws.

| id | text | answer | distribution |
|---|---|---|---|
| `db-down` | "Primary database is down, all writes are failing." | `High` | High 0.95, Low 0.05 |
| `footer-typo` | "There is a typo in the status page footer." | `Low` | Low 0.92, High 0.08 |
| `odd-latency` | "Latency looks odd in one region, maybe." | `High` | High 0.55, Low 0.45 |

## Policy

Policy `paging`, scope `"oncall"`, three rules, each `else deny` with `on unknown deny`, each for `proposal.kind == "effect"` and an `effect.kind` (the decision `triage` is proposed as the kind `decision.triage`, as any decision is), requiring the machine snapshot `machine("oncall.Incident").status` to be: `Paging` for `pager.page`; `Escalating` for `pager.escalate`; `Triaging` for `decision.triage`. Obligation names: `page-while-paging`, `escalate-while-escalating`, `triage-while-triaging`. The policy is signed as a person signs it.

## Properties

1. **Path property `page-at-most-once`**: `count("pager.page") <= 1`.
2. **Path property `escalate-at-most-once`**: `count("pager.escalate") <= 1`.
3. **Liveness `page-is-answered`**: `status == Paging leads to status == Acked || status == Escalated || status == Unreached under fair { Timeout, Wake, PageSent, PageFailed, Escalated, EscalateFailed, Confirm }`. The humans' actions (`Ack`, `Snooze`, `Classify`, `Resolve`) are not fair: nobody is assumed to act. `Confirm` is the one exception: the person who is told that an escalation is unconfirmed is assumed to look, as the timers are assumed to fire, and the fair set says so. The uncertain completions (`PageUncertain`, `EscalateUncertain`) are not fair: nothing forces an answer to be lost. From `Unconfirmed` the armed timer still escalates, so an unconfirmed page needs no new assumption.

The program and its policy check `CLEAN`, with the liveness property checked (not "not run") and deadlock freedom.

## Seeded defect

`incident-oncall-defect.poly` is the program with the snooze bound removed: `Snooze` requires only `Paged` and no longer counts. A person can snooze for ever, and the escalation timer is cancelled at each snooze, so weak fairness never forces the escalation. The check rejects it with exactly one code, `PL3301 LIVENESS_LASSO`, naming `page-is-answered`. The witness is a lasso of **7 steps**: a prefix of three (`Report`, `Triaged(High, 800, 0)`, `PageSent`) and a cycle of four (`Snooze`, `Wake`, `Snooze`, `Wake`, as the printer unrolls it). The check of the defect copy beside the same policy gives the same finding.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`, the liveness stage ran, and the instance is printed;
- the defect is `FINDINGS` with exactly `PL3301`, the property named, and a witness of 7 steps whose last two steps are `Snooze` then `Wake` or the reverse;
- `poly check --host` is `CLEAN`, and a handler with a wrong payload field is `PL6836`;
- the handlers: 201 returns ok; 409 throws with `permanent: true`; 503 throws without it; the body carries `ctx.instanceId` and the header is the context's key; the check that a missing throw fails the test (do not let an `assert.fail` sit inside the `try`);
- the recorded provider answers each report and throws on an unknown text.

End-to-end test, over recorded traffic, nothing on the network. Timers fire when the test advances the clock (`clock.advance(ms)` from `loadExample`) and settles:

- main path: `db-down` pages once, then `Ack` ends `Acked`; advancing 10 minutes sends no escalation; `Resolve` ends `Resolved`;
- timeout: `db-down`, no ack, advance 5 minutes: one escalation POST, `Escalated`; one page and one escalation in all;
- refusal: `footer-typo` ends `Logged` with no POST, and `Ack` on it is rejected `not-waiting`; on a second incident that pages (`db-down`), two snoozes each woken by the 15 minute timer are accepted and a third is rejected `cannot-snooze` (a snooze on a `Logged` incident is rejected for its status, so it proves nothing about the bound);
- escalation to a person: `odd-latency` ends `Review` with no POST; `Classify(High)` pages;
- snooze: `Snooze` cancels the escalation (advance 5 minutes: none), 15 minutes later `Wake` returns to `Paged`, and 5 minutes after that the escalation is sent;
- a refused page (409) ends `Escalating`, then `Escalated` after the escalation POST;
- one attempt, an unconfirmed page: with the page answered 503 then 201, `db-down` sends exactly one page request and ends `Unconfirmed` with no escalation; `Ack` then ends `Acked`, and advancing 10 minutes sends no escalation. On a second incident with the page answered 503, no ack, advancing 5 minutes sends one escalation POST and ends `Escalated`: one page request and one escalation request in all;
- one attempt, an unconfirmed escalation: with the page refused (409) and the escalation answered 503 then 201, exactly one escalation request is sent and the incident ends `EscalationUnconfirmed`; `Confirm(reached: true)` ends `Escalated` with no second request, and on another incident `Confirm(reached: false)` ends `Unreached`; a `Confirm` on an `Acked` incident (not terminal, and not unconfirmed) is rejected `not-unconfirmed`;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

## Amendments made when the code existed

- `Ack` on a `Logged` incident is rejected with the reason `terminal`, not `not-waiting`: the runtime refuses every action of a terminal instance before its handler (findings 9).
- A run does not rest in `Triaging` or `Escalating`: one settle carries an incident through its decision and its page, so the end-to-end tests assert end states and requests (finding 11). No test dispatches a decision's completion.
- The source comment says what the first draft did: it paged on an unsure answer and was `PL6201` (finding 8).
- The tests were corrected for these after the code existed, with the fixture path and the use of `rt.create` as in batch 1.

## Amendments made when the code existed

- `Ack` on a `Logged` incident is rejected with the reason `terminal`, not `not-waiting`: the runtime refuses every action of a terminal instance before its handler (language findings 9, settled by `test/ex-terminal-reason.test.mjs`).
- A run does not rest in `Triaging` or `Escalating`: one settle carries an incident through its decision and its page, so the end-to-end tests assert end states and requests (finding 11). No test dispatches a decision's completion.
- The source comment says what the first draft did: it paged on an unsure answer and was `PL6201` (finding 8).
- **A late completion is accepted.** `Ack` is allowed while the page is still out (`Paging`), so `PageSent` and `PageFailed` can arrive in any status. They are now taken in every status and act only from `Paging`, and a new field `answered : bool` records that the page was answered, because a handler that may do nothing is `PL2201` (finding 13). Before, a late `PageSent` was a rejected completion, which is consumed and never completes again (PS6.4, S463). An end-to-end test covers it.
- **Sizes and the witness changed.** `Incident` has 35 states (22 for the defect). The defect's lasso is **9 steps**, not 7: a prefix of three and a cycle of six, because `PageSent` and `PageFailed` are now enabled in every status and weak fairness holds them in the cycle too. The finding is still exactly `PL3301`.
- The tests were corrected for these after the code existed, with the fixture path and the use of `rt.create` as in batch 1.

## Amendment on v1.3.1 (finding 31)

v1.4 is built on v1.3.1, whose retry-safety rule (PS23.5) reports an irreversible effect that may be attempted more than once with no documented key as `PL4003`. The page and the escalation were `attempts 3`, with a key the handlers sent and no service documentation behind it, so the program and its defect copy were `FINDINGS` with `PL4003` twice beside their expected lines. The owner ruled: a target that documents an idempotency key is declared with its window; otherwise the effect is attempted once and an uncertain outcome goes to a person. The pager service documents no key, so both are `attempts 1`, and each `exhausted` now has its own completion:

- **The page.** Before, an exhausted page went to `PageFailed` and escalated at once, as if nobody had been paged. Now `PageUncertain` goes to `Unconfirmed`, with the acknowledgement timer still armed. The engineer, if paged, acknowledges; otherwise the timer escalates to the next person five minutes later. This is the program's own hand-off to people, so no new action is needed, and the liveness property holds without a new assumption.
- **The escalation.** Before, an exhausted escalation went to `Unreached`, as if nobody had been reached. Now `EscalateUncertain` goes to `EscalationUnconfirmed`, and a person's `Confirm(reached)` says which it was. `Confirm` joins the fair set of `page-is-answered`.

The defect copy changes in the same way. The expected lines and the defect's lasso (9 steps, a prefix of three and a cycle of six) do not change: the new completions are not fair, and `Confirm` is enabled only in `EscalationUnconfirmed`, which the snooze cycle never enters. The state counts change, and the README records them. When the code existed: `Incident` has 40 states (35 before), and the defect's lasso is 9 steps, as predicted.

## Conclusion

Liveness is the property a person cannot see by reading: every action is individually fine, and the starvation is in the cycle between two of them. The check finds it as a lasso of nine steps, and the bound on snoozes is the whole fix.

## Glossary

- **Weak fairness:** an action that stays enabled is eventually taken; here the timers.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Snooze:** a person's postponement of an escalation.
- **Unconfirmed:** a page or an escalation whose one attempt ended with no answer the program can trust; a person, not a retry, settles it.
