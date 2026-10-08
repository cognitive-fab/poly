# poly · Plan for milestone M11, routing and budgets

*Cognitive Fab · October 2026 · plan, written before any M11 code, while M9 is built · on branch `m4` in the worktree `poly-m4` · from PT27.3's M11 row and PT24 of `proposals/v1-technical-spec.md` (v0.2), PF14 and AC25 and AC26 of `proposals/v1-functional-spec.md`, and the brief `handoff-m11.md` · spec issues S350 to S399, new codes PL6843 to PL6849 (`decisions-m9.md`, how M9 to M11 run)*

This plan covers milestone M11 of the v1 proposal: routing and budgets. Its scope, as PT27.3 sets it:

- `route` and `budget`;
- the standard library machines `std.routing.Route` and `std.routing.Budget`;
- reservations, taken before a model call and settled after it;
- `poly cost`, from the ledger alone;
- the tier swap rule (`PL6842`).

The gate is AC25 and AC26, with every provider call recorded. M11 is built after M9 closes, in its own worktree and session, in parallel with M10. Section 6 lists every change it makes to `04-semantics.md` and to shared packages, so that it can be ruled together with M10's plan.

Nothing is built before the plan is ruled.

## 1. What was read, and what was found before planning

**Documents read:** `handoff-m11.md`; PF14 and AC25 and AC26; PT20.3 (intervals), PT24, PT25.1 (the fields `route` and `budget`), PT27; PD1 (decisions, PD1.6 calibration), PD2 (decision records), PD3.2 (a model change); `plan-m9.md` and its ruling (S199: the runtime reads a keyed machine itself).

| Finding | Where | Consequence |
|---|---|---|
| A decision calls one provider, registered with `rt.provide`, and its completion carries the provider's answer, `conf` and `margin`. | PD1, `poly-runtime` | A route is an ordered list of providers with thresholds over the same values; each tier's call is its own intent (S351). |
| `poly journal fit` already fits a monotone calibration map from decision events and outcomes (PD1.6, S132), and writes to no chain. | `poly-check/src/journal.ts` | A tier's calibration map is that command's output, bound by digest (S355). |
| `poly deploy` is not built (PF8.7, "not scheduled"). | `commands.ts` | PT24.5 refuses a model change at `poly deploy`; with no deploy, the refusal moves to admission, as PF14.6 already says (S355). |
| The boundary refuses a model SDK in every package. | `scripts/check-boundaries.mjs` | Live providers stay host code, bound by `rt.provide`; poly ships only the recorded provider (S356). |
| The gate reads a keyed machine only through the runtime's own read (S199, E11 not needed). | `decisions-m9.md` | `Budget` instances are read and written by poly-runtime the same way (S353). |
| A decision event records the provider's answer by digest (PD2), not its usage or cost. | `poly-runtime` | The event gains tier, model, usage, cost, reservation and the price table's digest (S358). |

Nothing was measured while planning.

## 2. Engine changes

- **E11 (consult-by-message): proposed not needed** for `Budget` and `Route` (S353), as for grants in M9: poly-runtime reads and writes the instances itself, settled by test, fail closed.
- No other engine change. One found while building gets the next free id, recorded the same day.

## 3. Packages and what changes in each

| Package | Change |
|---|---|
| `poly-lang`, `poly-embed` | `route r { tier … escalate when … budget b }`, `budget b { cap … on exhausted … }`, and `route r` in a decision; both surfaces. |
| `poly-core` | Money in decimal lowered to integer micro-units; `PL6841`, `PL6842`, and new codes from `PL6843`; `route-exhausted` among PL1207's reserved reasons. |
| `poly-lower` | Each route's descriptor `routes/<name>.json` (tiers, providers, price table and map digests, thresholds, budget) and each budget's `budgets/<name>.json`, with their read-backs and broken variants. |
| `poly-ref` | The `Route` and `Budget` machines checked as programs; the confidence intervals the thresholds cut; the reservation invariant. |
| `poly-runtime` | One intent per tier; reservations before each tier's call, settled after it, recovered after a crash (S352); the fields `route` and `budget`; the extended decision event; replay of every tier choice with no model call. |
| `poly-check` | Admission binds price tables and calibration maps by digest, refuses `PL6841` and `PL6842`; `poly cost`. |
| `std/` | `std.routing`, with `Route` and `Budget` and their `PROVENANCE.md` (poly's own rules; each price table names its source and date). |

## 4. Order of work

Each step ends with the full suite and a commit; every defect gets a test that fails first; the 147 measured files are compared at every step.

1. **PS text.** The semantics changes of section 6, written into `04-semantics.md` before any code.
2. **Money and price tables** (S350): micro-units, the price table format with its source and date, `PL6843`.
3. **`std.routing.Route`** (S351), checked: every path reaches `Answered` or `Exhausted` under the fairness of provider completion; each rule's seeded mutant.
4. **`std.routing.Budget` and the reservation property** (S352): the invariant checked over the intervals the caps cut.
5. **`route` and `budget`** on both surfaces, the descriptors, their read-backs and broken variants, `PL6841`.
6. **Runtime: one intent per tier, reservations, settlement, crash recovery** (S352, S353); AC26 with 64 concurrent runs and an injected overrun.
7. **Records, replay and `poly cost`** (S358); AC25's replay half.
8. **Calibration maps and the tier swap rule** (S355), `PL6842` at admission.
9. **The M11 record, the review, and the gate** from a clean build on a quiet machine, compared file by file with M9's.

## 5. How each gate item is tested

| Gate item | Test | Fails first because |
|---|---|---|
| AC25 | `test/routing.test.mjs`. A recorded low-confidence answer from the first tier escalates to the second; the route reaches `Answered` or `Exhausted` on every path (`poly check`, with a seeded mutant that loops); replay reproduces every tier choice from the ledger with no provider registered. | No routes. |
| AC26 | `test/budget.test.mjs`. 64 concurrent runs in one scope, each reserving before its recorded call: spent plus reserved never exceeds the cap at any step of the journal. A recorded usage above its reservation is recorded as an overrun in the `verdict` event and the `Budget` instance, and the next reservation sees the corrected remainder. A crash between reservation and settlement leaves the reservation held until the intent settles or dies, and none is lost or double-counted. | No budgets. |
| Tier swap | `test/routing-swap.test.mjs`. A tier whose model changed with its map unchanged is refused `PL6842` at admission; a map refitted for the new model is admitted. | No rule. |
| Read-backs | `test/tv.test.mjs` and `test/toolchain-faults.mjs`: the route and budget descriptors' broken variants (a threshold changed, a tier dropped, a cap raised, a price table digest stale). | No descriptors. |
| `poly cost` | `test/cost.test.mjs`. Cost per run, scope and period from the ledger alone, equal to the sum of the recorded costs, recomputed under another price table version by its digest. | No command. |

Every provider call in every test is recorded and replayed. No test calls a live provider and no test spends money; nothing in M11 runs against the owner's API account.

## 6. Changes to `04-semantics.md` and shared packages, to rule with M10's plan

- **`04-semantics.md`:** a decision's `route` (PD1's single provider generalised to tiers, PS for decisions); `route-exhausted` in PS3.2's reserved reasons; the reservation as a message to the `Budget` instance before an effect is proposed (PS13, as a runtime-generated input); money as integers.
- **`poly-core`:** the grammar and checks of section 3; the reserved reason `route-exhausted` in PL1207's list.
- **`poly-ref`:** the confidence intervals of a route's thresholds; the reservation invariant.
- **`poly-runtime`:** the decision path's tiers and reservations, the proposal fields `route` and `budget`, the decision event's new fields, replay of tier choices.
- **Shared with M10:** the decision clause grammar (`route` here, `cites` in M10), PL1207's reserved reasons, the decision completion path, and PT25.1's proposal fields. Proposal, as in M10's plan: each milestone adds its own clause, reason and field in its own function or file, the completion path keeps one ordered list of checks each appends to, and M10 merges first where both touch the same lines.

## 7. Spec issues

Numbered S350 to S399. Each has a proposal and waits for the owner's ruling.

- **S350. Money and price tables.** Money is written in decimal and lowered to integer micro-units. A price table is a JSON file `{ v, provider, model, currency, perMillionTokens: { input, output, … } in micro-units, source, readOn }`; a table without its source URL and the date it was read is `PL6843 PRICE_UNSOURCED`. Its digest enters the certificate; a price change is a new table.
- **S351. The `Route` machine.** PT24.2's states; each tier's call is its own intent and crosses the gate; an answer moves to `Answered` when it meets the thresholds, otherwise to the next tier; after the last, `Exhausted`, and the decision's `failed` path runs with `route-exhausted`. Liveness: every path reaches `Answered` or `Exhausted`, under the fairness of provider completion.
- **S352. Reservations, and the property proved.**
  - *Proposal:* before a tier's intent is proposed, poly-runtime sends `Reserve(r)` to the `Budget` instance, `r` being the tier's `max tokens` at its highest price; the reservation and the intent's proposal commit in one transaction. After the call, `Settle(r, actual)`. A dead intent (exhausted, denied, or refused) releases its reservation with `Release(r)`. **The property checked:** `spent + reserved ≤ cap + overrun` in every reachable state of `Budget`, over the intervals the caps cut. **The crash case tested:** a runtime stopped between the reservation's commit and the call's completion restarts with the reservation held, and the worker settles or releases it exactly once.
- **S353. Reading `Budget` and `Route` (E11).** poly-runtime reads and writes the keyed instances itself, as S199 does for grants: a reservation the `Budget` instance rejects denies (or escalates, as `on exhausted` says) before the policy runs, and a missing or unreadable instance refuses the call, fail closed. The proposal carries `route` and `budget` so policies may add rules. E11 is settled by test.
- **S354. Concurrency.** A `Budget` instance is one actor, so its steps are serialized (K1, K2); 64 concurrent runs in one scope reserve through it one at a time. AC26 checks the journal's every step against the cap.
- **S355. Calibration maps and the tier swap.** A tier's map is the output of `poly journal fit`, a file naming the model it was fitted for, bound by digest in the certificate with the tier's provider and model id. Admission refuses a tier whose model is not the map's (`PL6842`), since `poly deploy` is not built; `PL6841` for a route whose `escalate` reads `conf` or `margin` on a tier with no map.
- **S356. Providers.** Live providers stay host code, registered with `rt.provide` per tier and certified by name; poly ships only the recorded provider, which replays answers and usage from fixtures. No model SDK enters poly.
- **S357. Usage and overruns (K15).** The provider's usage report is the cost; the adapter passes `max tokens` as the provider's own output limit, so an overrun is a provider reporting more than it was asked to allow. It is recorded, never hidden, and the next reservation sees it.
- **S358. Records and `poly cost`.** The `decision` event gains `tier`, `model`, `usage`, `cost`, `reservation` and the price table's digest. `poly cost [--run] [--scope] [--period]` sums them from the ledger alone, and recomputes under another table version by its digest. No prompt, completion body or key enters the journal, the ledger or a certificate: bodies are `Content` digests.
- **S359. Work orders with budgets (PT24.6)** are not in M11: PT27.3's scope does not list them, and self-reported usage is weaker evidence. They wait for M7 (feedback), where workflows are revisited.

## 8. Risks

1. **The reservation under a crash.** The property holds only if the reservation and the proposal commit together, and settlement or release happens exactly once; the crash test covers the window between them.
2. **Calibration drift.** A map holds on the traffic it was fitted on (PD1.6); the tier swap rule catches a model change, not a drift in traffic.
3. **Merge with M10.** Section 6 lists every shared change, to be ruled with M10's plan.

## 9. Record of M11

| Step | What | Commits |
|---|---|---|
| 1 | PS18, routes and budgets, written into the semantics before the code | f579138 |
| 2 | Money in integer micro-units, price tables with their source and date (S350, `PL6843`) | 71647d3 |
| 3, 4 | `std.routing`: `Route` and `Budget`, each rule poly's own with a seeded mutant (S351, S352) | 07402d3 |
| 5 | `route` and `budget` on both surfaces, `m.r` and `m.b`, the descriptors and their read-backs, `PL6841`, `PL6844`, `PL6845` | 3ce25fb |
| 6 | Tiers as intents of their own; reservations before the policy, settled and released, crash recovery; AC26 (S351 to S354, S356) | 268a44a |
| 7 | Records, `poly cost` from the ledger alone, replay of every tier choice; AC25's replay half (S358) | 023fddf |
| 8 | The tier swap, `PL6842` (S355) | 7f5e37c |
| 9 | The review: its findings fixed, each with a test that failed first; S360 and S361 raised; the gate | 514528a |

**The closing gate of M11, from a clean build.** It ran at 514528a from 18:45:03 to 19:16:59 on 7 October 2026 (local time), after `npm run clean`, as `npm test` through `scripts/suite-summary.mjs` (build, boundary check, the suite, then `test/after/`). Before it started, no test run of either session was on the machine. A watcher listed every minute, 32 times, each node or python process started after the gate began whose command line did not name this worktree. Apart from the gate's own (the test runner and its files, named by relative path, the M3 frozen runner, its fake agent and a sleeping fixture), it saw the M10 session's own work for its first minutes: `.poly/m10/measure-flow.mjs` in six listings from 18:46 and `poly check` of an M10 fixture in five; no test run of M10. So the machine was quiet of test runs, not of all work. The machine is the one of M9's gate.

| Gate | Commit | Tests (suite and `test/after/`) | Passed | Failed | Skipped | Waiting | Total |
|---|---|---|---|---|---|---|---|
| M9 closing, from a clean build | c0cfff1 | 1,925 | 1,919 | 0 | 2 | 4 | 33 min 40 s |
| **M11 closing, from a clean build** | 514528a | 1,996 | 1,990 | 0 | 2 | 4 | 31 min 56 s |

AC25 ran in `routing` (escalation, an answer on the small tier, a failure escalated, exhaustion with `route-exhausted`, a policy over the call's tier), `std-routing` (`route-ends` and the looping mutant) and `cost` (replay of every tier choice with no provider); AC26 in `budget` (64 concurrent runs within the cap at every step, the overrun recorded and the next reservation refused, the crash between reservation and completion); the tier swap in `routing-swap`; the read-backs in `tv` (four broken lowerings) and `certificate` (two broken writers); `poly cost` in `cost`; the review in `review-m11`. All passed. **Not run, by name:** E1's one, E2's one and E5's two, as at M9's close. The two skipped are S152's OpenShell enforcement and `creation-unavailable`'s, as at M9's close. `check-memory` passed. The 159 measured files are identical to M9's close. Every file's time is in `docs/m11/gate-file-times.json`.

**Compared file by file with M9's `gate-file-times.json`.** The suite took 1,745 s against 1,837 s, `test/after/` 148 s against 163 s, and the summed time of the 158 files in both 19,663 s against 19,427 s; 40 were faster and 18 slower by more than 20% and 5 s. The slowest are the channel files again (`channels-whatsapp` 1,348 s to 1,370 s, `channels-adapter-pin` 1,243 s to 1,298 s). The largest change is `certificate`, 486 s to 802 s, with two more faults over a project that admits a route. M11's own files take 104 s (`review-m11`, `cost`), 72 s (`std-routing`), and 22 s or less for each of the rest.

**M11 is built and gated; it closes on the owner's rulings.** Two review findings change what a reservation and a cost mean, and wait as S360 and S361 (`decisions-m11.md`, step 9); `poly try`, which Q9 placed at M11's start and this plan does not list, waits for the owner too.

**Limits M11 closes with.**
- **A reservation covers the token limit at the highest price.** A call that uses its full output limit with input tokens can cost more than its reservation, recorded as an overrun (S360).
- **A usage report poly cannot price.** None costs nothing; a fractional or negative one fails the call after its provider answered, and its reservation is released (S361). The certificate lists both.
- **A call with no answer** has no usage and its reservation is released, so what a provider bills for it is not counted (K15).
- **A route that escalates on failure alone** has two vacuous rules in `r.Route`, and checks `INCONCLUSIVE`, never `CLEAN`.
- **A channel's name** is not checked to be an identifier, as a route's, a budget's and a credential's are; outside M11.
- **Replay of a credential's `Grant`** needs `std.credentials`, which no build records; listed for the v1 gate (AC27).
- **The gate's time** depends on the machine's load, as at M9's close.

## Conclusion

M11 makes a budget a checked invariant and a route a checked machine: a reservation is taken before every model call and settled after it, so spent plus reserved never passes a cap, and every tier choice replays from the ledger with no model call. Every provider call in the tests is recorded, nothing spends money, and each change shared with M10 is listed for a joint ruling. As built, every step is done, the review's findings are fixed or raised, and the closing gate passed from a clean build with no failure and the measured verdicts unchanged; M11 closes on the owner's rulings on S360 and S361.

## Glossary

- **Route:** an ordered list of tiers a decision tries, each a provider with a price table and a calibration map.
- **Budget:** a cap per run, scope or period, held by a `Budget` instance as spent and reserved micro-units.
- **Reservation:** the worst-case cost of a call, held against a budget before the call.
- **Overrun:** a settled cost above its reservation, recorded and carried into the next reservation.
- **Micro-unit:** one millionth of a currency unit, the integer unit of all costs.
- **Calibration map:** the monotone map from a provider's reported confidence to a calibrated one, fitted by `poly journal fit`.
