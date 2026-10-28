# poly v1.4 · Release notes (the ten examples, on v1.3.1)

Not tagged. This document is the draft for the owner's approval; the tag and the push wait for it.

## What v1.4 is

v1.3.1 shipped the language and the runtime with two large examples, the concierge and the inbox, and the retry-safety rule (PS23, `PL4003`). v1.4 adds **ten smaller examples**, each written to show one property the check proves and one defect it finds, and the language findings that writing them produced. Every example follows the same order of work (rule 7a): a one-page spec committed alone, then failing tests from a separate writer who had read only the spec, then the code. Every one has a program and its policy checked `CLEAN`, host code in TypeScript against the generated types, a recorded provider (or recorded services, or a recorded device), a seeded defect in a copy with its own policy beside it and a test of the finding and its witness, a recorded end-to-end test whose journal replays with no divergence, and a README.

**How it was built.** The examples were written on a branch (`archlens`) cut from v1.1.0, which never had v1.2 or v1.3. v1.4 is that work brought onto v1.3.1 (`origin/main`, `2095b24d`) without force: the branch `v1.4` was created there and the 23 commits of the work (`48befd54` to `f5327687`) were cherry-picked with `-x`, the PT14 heap commit and its revert kept. Two files conflicted. `docs/proposals/v2.0.md` existed on both sides with different numbers: main's 1 to 15 stay, and the examples' P1 to P12 are now 16 to 27, every citation with them. `test/serial-sources.mjs` and its test keep main's serial group (the examples' branch added support-drafts and removed it again). Then everything was measured again on v1.4, and v1.3's rules found what the examples' branch could not have: the retry-safety rule caught five of the ten examples and one fixture (finding 31). The owner's audit of the stage verdicts before the tag found three more stages reading `CLEAN` beside an error (finding 30). Both are fixed under rule 7a.

## The ten examples

Each row's spec is `docs/examples/<name>.md`, its README is `examples/<name>/README.md`. Every number is the one the check printed on v1.4.

| Example | What it shows | The key property | The seeded defect and its finding | States (program; defect) |
|---|---|---|---|---|
| `appointment-booker` | A typed date and time decision, an irreversible calendar write attempted once | No slot is booked twice (step property) | The overlap check removed: `PL3002`, a witness of 6 steps | 380; 320 |
| `expense-approval` | A strict amount, verified claims, a payment a person approves above a threshold, a held payment a person resolves | The approver is never the submitter (invariant) | The same principal approves: `PL3001`, 3 steps | 1,231; 1,711 |
| `incident-oncall` | Liveness under fair timers, paging once, an unsure report and an unconfirmed escalation sent to a person | A page is acknowledged or escalated (liveness) | An unbounded snooze starves the escalation: `PL3301`, a lasso of 9 steps | 40; 25 |
| `order-fulfilment` | A reserve, charge and ship saga with compensations, an unknown shipment or refund resolved by a person, a configuration of two orders and one stock | A cancelled order holds nothing; the stock is never oversold | The compensation after a failed shipment skipped: `PL3001`, 4 steps (the configuration stays `CLEAN`) | `Order` 21, configuration 180 global; 23 and 196 |
| `pr-reviewer` | A workflow mapping an agent's tools to effects, a policy and a budget per review and month | The program never merges (path property); the policy denies it | The merge made reachable: `PL4001`, 5 steps | 31; 34 |
| `support-drafts` | Customer messages and private notes at two audiences, drafts escalated to the owner | The notes never reach the external model (a `never` statement) | The notes sent to it, the rule left out of the policy: `PL6503` and `PL7001`, 1 step each (`CLEAN` beside the program's own policy: the gate refuses it at run time) | 1,705; 1,705 |
| `claim-intake` | A calibrated, routed classification; a person below 0.8 and on a fraud flag | A claim is assigned by itself only at a calibrated confidence of 0.8 or more | A confidence added to a margin: `REFUSED`, `PL1205`, no witness; a confidence never compared: `PL3002` and `PL6201`, 2 steps each | 17; 17 |
| `research-agents` | A planner and two workers checked together; answers that cite; one shared budget | Every worker that reports has cited (configuration invariant) | A worker that can guess: `PL5401`, 6 global steps | configuration 699 global; 1,545 |
| `subscription-cancel` | Liveness that a request ends, an offer at most once, an offer and a cancellation attempted once | A request to cancel always ends; the offer is made once | A decline that offers again: `PL3301`, a lasso of 6 steps, and `PL4001`, 3 steps | 9; 9 |
| `flash-controller` | A pure state machine: erase, program, verify, a retry limit | A block is never programmed unless it is erased | The erase check removed: `PL3002`, 2 steps | 76; 76 |

All twenty-one example sources have the verdict their first line states. Every witness length is compared in a test with the length the spec predicted before the code was written. Three predictions were wrong and each is recorded in its spec: the incident lasso is 9 steps, not 7 (a late page answer accepted in every status is held in the cycle by weak fairness); the expense amount had to shrink from `0..500` to units of 50 euros; and on v1.4 the subscription lasso is 6 steps, not 5 (the check reaches a cycle through an offer whose answer is lost, which the defect also has).

## Finding 31: the v1.3 retry-safety rule caught five of the ten examples

On v1.3.1, ten of the examples' twenty-one sources were no longer what their first line said: the program and the defect of appointment-booker, expense-approval, incident-oncall, order-fulfilment and subscription-cancel each gained `PL4003 UNGUARDED_RETRY` (PS23.5), once per effect. Eight irreversible effects declared three attempts and no `idempotent` declaration. Their handlers sent the intent's key and the specs called them keyed, but no target documents that it honours a key, and none of the recorded services reads the header: K17's assumption with nothing behind it, which is what v1.3.0's double refund cost.

The owner ruled effect by effect: a target that documents an idempotency key is declared with its window; otherwise the effect is attempted once and an uncertain outcome goes to a person. Every target is a made-up `*.example` service and no spec names a documented window, so all eight are `retry { attempts 1 }`. Writing a documented key into a spec to reach G2 would have invented K17's evidence. With one attempt, `failed` is a refusal the target made and `exhausted` is an end the program cannot read, and each `exhausted` now has its own path to a person:

| Example | Effect | Before, on `exhausted` | After |
|---|---|---|---|
| appointment-booker | `write` | `Uncertain`, a person's `Resolve(found)` | the same (only `attempts 1`) |
| expense-approval | `pay` | `Held`, terminal: nobody could act | `Held`, left by a person's `Resolve(paid)` with an approver's claims, never the submitter's |
| incident-oncall | `page` | escalated at once, as if nobody had been paged | `Unconfirmed`, the ack timer still armed: the engineer acknowledges or the timer escalates to the next person |
| incident-oncall | `escalate` | `Unreached`, as if nobody had been reached | `EscalationUnconfirmed`, a person's `Confirm(reached)` |
| order-fulfilment | `ship` | the compensations ran, refunding an order that may have shipped | `ShipUnknown`, a person's `Resolve(done)` |
| order-fulfilment | `refund` | `Stuck`, as if no refund had been made | `RefundUnknown`, a person's `Resolve(done)` |
| subscription-cancel | `offer` | cancelled as if no offer had been made | `OfferUnknown`, a person's `Resolve(done)` |
| subscription-cancel | `cancel` | `Stuck`, as if billing had refused | `CancelUnknown`, a person's `Resolve(done)` |

The rule's finding was about a second attempt; fixing it showed the first attempt's uncertainty. In three programs an `exhausted` went to the same handler as a refusal, and in a fourth it ended in a state nobody could leave. Where a person settles an outcome inside a liveness property, the person's action joins the fair set, printed with the property as the timers are. The full suite found a sixth source, `test/fixtures/flow-boundary/leak.poly`, a fixture of finding 17 with an irreversible send on the default retry; it sends once now. order-fulfilment's charge is `compensable`, which the rule does not cover, and keeps three attempts (below, under the limits).

Order of work: the five specs first (`2a43c138`); then the tests, by five separate writers, each sent back once for a test that could not fail or tested the wrong rule (`b0b4d8ff`); then the code (`21c3d62a`). Because every test failed first at admission (a `FINDINGS` program is not admitted without signed acceptances), the new assertions' own fail-first was shown after the code by two mutations of each program, reverted after the run: retries with a declared key, and each `exhausted` sent back to the refusal handler. Each mutation fails every new one-attempt test and nothing else (appointment-booker 1 of 6, expense-approval 1 of 9, incident-oncall 4 of 14, order-fulfilment 4 of 13, subscription-cancel 2 of 11).

## Finding 30: the audit of the stage verdicts

Finding 29 was the policy-admission stage reading `CLEAN` beside its own `PL6001`. Before the tag the owner asked for every stage that computes a verdict to be audited for the same fault. Nineteen do: twelve for a machine or a configuration (`parse-type`, `lower`, `validate`, `translation-validation`, `model-check`, `deadlock`, `flow`, `liveness`, `effects`, `decisions`, `composition`, `configuration`) and seven for a policy scope (`policy-types`, `policy-lower`, `consistency`, `policy-admission`, `policy-tv`, `regions`, `never`). A run on the v1.4 branch showed three that read `CLEAN` beside an error, each now fixed:

- **policy-lower** read `CLEAN` beside `PL1201` for a scope whose policies hold only `never` statements. It now records `PL1201` and is `REFUSED`.
- **policy-admission** read `CLEAN` beside `PL6302` (an unlabelled effect in a scope whose obligations read labels, "refused at admission") when Polyaxion admitted the document. It is now `REFUSED` with it.
- **parse-type** stayed `CLEAN` on a file the project check refused afterwards with `PL1002` (two modules of one name). The project's re-fold now reads the stage again.

Of the other sixteen, eight fold exactly the diagnostics they record, and eight can record no error at all. Five error paths are reached by no source: `validate`'s `PL2001`, `translation-validation`'s and `policy-tv`'s `PL2501` (a deliberately broken lowering, tested outside the pipeline) and `PL2501` from an engine disagreement in `model-check`, `effects` and `composition`. PT12.3 now states the rule for every stage, with the table of the nineteen and what each test shows (`00ca898f`); `test/stage-verdicts.test.mjs`, by a separate writer, has one test per stage and failed first on exactly the three (`4d3276e4`, 16 of 19); the code (`74cbf5cb`) brings it to 19 of 19. `PL6701`, a finding, stays with the scope, and the handler lint and the host check are not stages of a file.

## PL6504, PL6505 and PL6001

- **`PL6504 POLICY_SCOPE_UNMATCHED` (language finding 20).** A policy whose scope matches no module, no machine id of the program (a channel's conversation, a route and a budget are modules of their own) and no configuration instance's `scope` governs nothing, and used to check `CLEAN` with every region "unreachable". In a project that holds a machine it is now an error: verdict `REFUSED`, at the policy's scope line, and the policy's later stages are not run.
- **`PL6505 POLICY_SCOPE_GLOB` (finding 24).** A scope with `*` was matched by the region check and then failed lowering with the engine's schema message (verdict `ERROR`). It is refused with its own code. Glob scopes are proposal 27.
- **`PL6001` and the stage verdict (finding 29).** When Polyaxion did not serve a scope only because of its m2 check, the `policy-admission` stage read `CLEAN` beside `PL6001`. It is `REFUSED`; finding 30 is the audit that followed.

## What the examples' own runs found

On the examples' branch the whole parallel suite found three things in the shared machinery, all fixed and carried into v1.4: a source whose first line expects `REFUSED` broke every sweep that loads each example (the expected-verdict line gained `REFUSED <code>`); the embedded surface's declaration of a workflow lacked the `budget` key; and the recorded vacuity table listed `order-fulfilment-defect.poly`, which on v1.4 emits a refund through `Resolve` and leaves the table. On v1.4 the sweep and an example's light test checked one file at once under one project directory and one removed the other's project; `checkExample` now names the directory by the process (`d596aaf9`).

## Language findings

`docs/examples/language-findings.md` is the log: 31 entries, each with the symptom, the example where it appeared, the workaround and a proposed fix. In summary:

- **Checks that did not say enough.** A private-text decision is `PL7001` even with no credential, cured by a rule written only to name it (1). A decision over a stored body fails closed, silently, without an audience declaration (2). The static check does not follow a source into a decision's inputs (17; the exact boundary is a section of the log, with a test for each claim). A policy scope that matched nothing said `CLEAN` (20, fixed). Four stages read `CLEAN` beside an error (29 and 30, fixed).
- **Cost.** A stored range is not cut at its comparison constants, so `0..500` exhausted memory (3). Admission is slow and per test (7).
- **Surprises in the surface.** A range type and a check clause refuse an out-of-domain value differently (4). A parameter named after a field is a warning that will be an error (5). A handler may not do nothing, so a late completion cannot be ignored (13). `PL1205` is not "never compared" (22). A terminal reason, a wiring action for a `Ref` (9, 10, 23).
- **Spending.** A work order spends its order cap whatever it reports (15). A usage key the price table does not name is charged at the highest price (21).
- **The test API.** Intermediate states a run never rests in, completions a test may not dispatch (11, 25): every independent writer did it, in every batch, and the writers of v1.4's tests were sent back for it too.
- **v1.3's rules.** The retry-safety rule caught five examples and a fixture (31).
- **Retracted.** The claim that the heap makes a check ten times slower (16) was contention.

## Proposals added

`docs/proposals/v2.0.md` now holds 27 proposals, each a request for a ruling and none a change. The examples' twelve, numbered P1 to P12 while they were written:

- **16** a way to declare a decision gated; **17** a check-time diagnostic when a decision lacks an audience; **18** the cut-point reduction for stored values compared with constants.
- **19** the fail-safe direction of an effect ("page when unsure"); **20** one confidence scale; **21** a step-by-step settle in the test API; **22** an ignored completion.
- **23** a static check that a workflow's orders fit its run cap; **24** an audience ceiling on a decision; **25** the static flow from a source into a decision's inputs, against that ceiling (24 and 25 cover the same ground as 12, taint per recipient).
- **26** an unknown usage key is a failed call, not a charge at the highest price; **27** glob scopes for a policy.

## The test runs on v1.4

- **S116 alone** (`test/m3-environment.test.mjs`), with no `ANTHROPIC_API_KEY` in the environment: 5 of 5 pass.
- **The parallel part of `npm test`** at `d596aaf9`: 4,203 tests, 4,191 pass, 6 fail, 2 skipped, 4 to-do (`M4c` and its siblings, waiting on E1). The six failures:
  - two from finding 31's sixth source, `claim 1, followed` (`test/ex-flow-boundary.test.mjs`) and `DAC7(a)` (`test/s526-impact.test.mjs`), fixed in `b233bc36`; both files pass after it, 15 of 15;
  - three Docker replay cases, `(c1)` to `(c3)` of `test/demo-driver-hygiene.test.mjs`, under the suite's load, as in v1.3.1; the file passes alone, 15 of 15 (proposal 15);
  - `DB16.3` (`test/demo-baseline-runtime.test.mjs`), which is not environmental: below.
- **The sweep** (`test/examples-expected.test.mjs`): every file in `examples/` has the verdict its first line states, 46 of 46.
- **The stage verdicts** (`test/stage-verdicts.test.mjs`): 19 of 19.
- **The serial after-suite** (`test/after`, one file at a time), once, on `b233bc36`, the last commit that changes code or tests: **not completed**. The run was stopped by the session's two-hour limit on a background command. By then 26 tests had passed and none had failed, the last two being the demo room's `DF11.5a` cases (each check of the concierge takes six to thirteen minutes). It was not restarted, and the remaining tests of the 28 files are listed as not run. A run outside that limit is the owner's.

Because the parallel part failed, `npm test` stopped before its serial part; the serial part was run alone with the command the script uses.

## Known limits

- **`DB16.3` fails, and it is the owner's to rule on.** The test builds the demo baseline's poly workspace from the repository's built packages and compares its digest with the scaffold preregistered in amendment 1 (`1b9493fc`). v1.4 changes `poly-check` (PL6504, PL6505, PL6001 and finding 30), so the copied `dist` differs and the digest cannot match. It passed on v1.3.1. Either the test pins the toolchain of the preregistered experiment and should run against that toolchain, or the preregistration is amended; neither was done here, and the test was not weakened.
- **order-fulfilment's charge.** It is `compensable` and keeps three attempts with an undocumented key, so a lost answer can still charge twice, and an exhausted charge still cancels the order as if nothing was taken. PS23.5 covers irreversible effects only; extending it is a question for proposal 3.
- **Liveness assumes the person.** In incident-oncall and subscription-cancel, the person who settles an uncertain outcome is in the fair set: the property holds if that person acts, as it holds if the timers fire.
- **The domains were reduced where the check could not finish.** The expense amount is in units of 50 euros, `0..10`. The booker has 4 slots, the order configuration one unit of stock and two orders, the research configuration two workers and a transit bound of 4. Each README says so.
- **A larger heap is advice, not a feature.** A re-execution of `poly check` with 8 GB was specified, built and reverted: it would make the command line start a process, which the import-boundary check forbids on a check path.
- **The static check stops at data leaving.** It does not follow a source into a decision; the support-drafts defect is `CLEAN` beside the program's own policy and held at run time by the gate. Proposals 24 and 25.
- **A finding runs only with a signed acceptance.** The defect copies are admitted in the end-to-end tests as an owner who accepted the finding would run them.
- **No example calls a model or the network.** Every provider and service is recorded, and none documents an idempotency key, which is why every irreversible effect is attempted once.

## Conclusion

The examples show one thing from ten sides: the check finds a defect that sits in a comparison, a cycle or a missing line, and names it with a path. Brought onto v1.3.1, they also show the toolchain checking itself: a rule written for the concierge's double refund found eight effects in five examples that trusted a key nobody documents, and an audit asked for before the tag found three stages that could read `CLEAN` beside an error. Both were fixed in the same order as everything else, spec, then tests by someone else, then code, and the numbers above are the ones measured afterwards. What remains open is listed: one test that pins the demo's preregistered toolchain, one compensable charge, and the proposals. The tag waits for the owner.

## Glossary

- **Seeded defect:** the one change a defect copy makes to its program, so that the check's finding, its code and the length of its witness, can be seen and tested.
- **Witness:** the shortest sequence of steps the check found that violates a property; a liveness witness is a lasso, a prefix and a cycle repeated for ever.
- **Attempted once:** an effect with `retry { attempts 1 }`; an end the program cannot read is delivered as `exhausted` and never followed by a second request (G1, PS23.4).
- **Stage verdict:** the verdict a stage of the check records; it is never `CLEAN` beside an error that stage records (PT12.3).
- **Refused:** the verdict of a program or a scope a stage rejects with an error (`REFUSED`); it has no witness.
- **Scope (of a policy):** the module, or the configuration's assigned scope, that a policy governs; a scope that governs nothing is `PL6504`.
- **Acceptance:** a person's signed record that a finding is accepted; a program with findings runs only with one for each (PT12.5).
- **Recorded traffic:** the answers of a provider, a service or a device written down in advance, so a run needs none of them.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
- **Proposal (16 to 27 in `docs/proposals/v2.0.md`):** a request for a ruling on a change to the language or the toolchain, written down and not built.
