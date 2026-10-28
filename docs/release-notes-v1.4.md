# poly v1.4 · Release notes (the ten examples)

Not tagged. This document is the draft for the owner's approval; the tag waits for it.

## What v1.4 is

v1.3 shipped the language and the runtime with two large examples, the concierge and the inbox. v1.4 adds **ten smaller examples**, each written to show one property the check proves and one defect it finds, and the language findings that writing them produced. Every example follows the same order of work (rule 7a): a one-page spec committed alone, then failing tests from a separate writer who had read only the spec, then the code. Every one has a program and its policy checked `CLEAN`, host code in TypeScript against the generated types, a recorded provider (or recorded services, or a recorded device), a seeded defect in a copy with its own policy beside it and a test of the finding and its witness, a recorded end-to-end test whose journal replays with no divergence, and a README.

Writing them found one defect of the toolchain that is fixed here (a policy scope that governs nothing checked clean), two more the full test run found in the examples' own machinery, and a longer list of places where the language is awkward. The awkward places are logged, not fixed, and some are proposed for v2.0.

## The ten examples

Each row's spec is `docs/examples/<name>.md`, its README is `examples/<name>/README.md`.

| Example | What it shows | The key property | The seeded defect and its finding | Instance |
|---|---|---|---|---|
| `appointment-booker` | A typed date and time decision, an irreversible keyed calendar write | No slot is booked twice (step property) | The overlap check removed: `PL3002`, witness of 6 steps | 380 states |
| `expense-approval` | A strict amount, verified claims, a payment a person approves above a threshold | The approver is never the submitter (invariant) | The same principal approves: `PL3001`, 3 steps | 1,231 states |
| `incident-oncall` | Liveness under fair timers, paging once, an unsure report sent to a person | A page is acknowledged or escalated (liveness) | An unbounded snooze starves the escalation: `PL3301`, a lasso of 9 steps | 35 states |
| `order-fulfilment` | A reserve, charge and ship saga with compensations, a configuration of two orders and one stock | A cancelled order holds nothing; the stock is never oversold | The compensation after a failed shipment skipped: `PL3001`, 4 steps (the configuration stays `CLEAN`) | 17 states, configuration 126 global states |
| `pr-reviewer` | A workflow mapping an agent's tools to effects, a policy and a budget per review and month | The program never merges (path property); the policy denies it | The merge made reachable: `PL4001`, 5 steps | 31 states |
| `support-drafts` | Customer messages and private notes at two audiences, drafts escalated to the owner | The notes never reach the external model (a `never` statement) | The notes sent to it, the rule left out of the policy: `PL6503` and `PL7001`, 1 step each (`CLEAN` beside the program's own policy: the gate refuses it at run time) | 1,705 states |
| `claim-intake` | A calibrated, routed classification; a person below 0.8 and on a fraud flag | A claim is assigned by itself only at a calibrated confidence of 0.8 or more | A confidence added to a margin: `REFUSED`, `PL1205`, no witness; a confidence never compared: `PL3002` and `PL6201`, 2 steps each | 17 states |
| `research-agents` | A planner and two workers checked together; answers that cite; one shared budget | Every worker that reports has cited (configuration invariant) | A worker that can guess: `PL5401`, 6 global steps | configuration 699 global states |
| `subscription-cancel` | Liveness that a request ends, an offer at most once, a keyed cancellation | A request to cancel always ends; the offer is made once | A decline that offers again: `PL3301`, a lasso of 5 steps, and `PL4001`, 3 steps | 7 states |
| `flash-controller` | A pure state machine: erase, program, verify, a retry limit | A block is never programmed unless it is erased | The erase check removed: `PL3002`, 2 steps | 76 states |

Every witness length above is the one the check printed, compared in a test with the length the spec predicted before the code was written. Two predictions were wrong and are recorded in their specs: the incident lasso is 9 steps, not 7 (once a late page answer was accepted in every status, weak fairness holds it in the cycle too), and the expense amount had to shrink from `0..500` to units of 50 euros (below).

The examples carry 143 tests (light and end to end). `examples/README.md` has the table above with the older examples, a conclusion and a glossary.

## PL6504, PL6505 and PL6001

- **`PL6504 POLICY_SCOPE_UNMATCHED` (language finding 20).** A policy whose scope matches no module, no machine id of the program (a channel's conversation, a route and a budget are modules of their own) and no configuration instance's `scope` governs nothing, and used to check `CLEAN` with every region "unreachable". In a project that holds a machine it is now an error: verdict `REFUSED`, at the policy's scope line, and the policy's later stages are not run. PT8.4 says it; `test/policy-scope-unmatched.test.mjs` holds it.
- **`PL6505 POLICY_SCOPE_GLOB` (finding 24).** A scope with `*` was matched by the region check and then failed lowering with the engine's schema message (verdict `ERROR`). It is refused with its own code and a message that says a glob is not a scope. Glob scopes are proposed for v2.0 (P12).
- **`PL6001` and the stage verdict.** When Polyaxion did not serve a scope only because of its m2 check, the `policy-admission` stage read `CLEAN` beside the `PL6001` diagnostic. A stage reads `CLEAN` only when it holds no error diagnostic: the stage is now `REFUSED` in that case too.

## What the full run found

The examples' own tests all passed. The whole parallel suite then found three things in the shared machinery, all fixed:

- A source whose first line expects `REFUSED` (claim-intake's `PL1205` defect, an error and not a finding) broke every sweep that loads each example. `polyFiles` skips it, as it skips an `errors/` source, and the examples' own sweep asks for it. The expected-verdict line gained `REFUSED <code>`.
- The embedded surface's declaration of a workflow lacked the `budget` key the printer always wrote (and typed the amount as a string), so `pr-reviewer` printed as TypeScript failed `tsc`. The declaration is fixed.
- The recorded vacuity table lists `order-fulfilment-defect.poly`.

Two shared helpers changed for the new examples: `checkExample` names its project directory per file (two files in parallel had collided), and `admitExample` copies `host/handlers.ts` only when it exists. `test/ex-kit.mjs` has `acceptFindings`, which signs an acceptance with the tests' in-memory person key so the seeded defects can run; `test/ex-accept-findings.test.mjs` holds that it is reached from no package, no script and no command, and that admission refuses its acceptance in a process that is not a test process.

## Language findings

`docs/examples/language-findings.md` is the log: 29 entries, each with the symptom, the example where it appeared, the workaround and a proposed fix. In summary:

- **Checks that did not say enough.** A private-text decision is `PL7001` even with no credential, cured by a rule written only to name it (1). A decision over a stored body fails closed, silently, without an audience declaration (2). The static check does not follow a source into a decision's inputs, nor a decision's provider or audience (17; the exact boundary is a section of the log, with a test for each claim). A policy scope that matched nothing said `CLEAN` (20, fixed).
- **Cost.** A stored range is not cut at its comparison constants, so `0..500` exhausted memory (3). Admission is slow and per test (7).
- **Surprises in the surface.** A range type and a check clause refuse an out-of-domain value differently (4, settled by a test). A parameter named after a field is a warning that will be an error (5). A handler may not do nothing, so a late completion cannot be ignored (13). `PL1205` is not "never compared" (22). A failed offer, a terminal reason, a wiring action for a `Ref` (9, 10, 23).
- **Spending.** A work order spends its order cap whatever it reports (15). A usage key the price table does not name is charged at the highest price and silently denies later calls (21).
- **The test API.** Intermediate states a run never rests in, completions a test may not dispatch (11, 25): every independent writer did it, in every batch.
- **Retracted.** The claim that the heap makes a check ten times slower (16) was contention; re-measured, it is 10 s against 12 s.
- **Found by the full run.** 26, 27 and 28 above.

## Proposals added

`docs/proposals/v2.0.md`, each a request for a ruling and none a change:

- **P1** a way to declare a decision gated; **P2** a check-time diagnostic when a decision lacks an audience; **P3** the cut-point reduction for stored values compared with constants.
- **P4** the fail-safe direction of an effect ("page when unsure"); **P5** one confidence scale; **P6** a step-by-step settle in the test API; **P7** an ignored completion.
- **P8** a static check that a workflow's orders fit its run cap; **P9** an audience ceiling on a decision; **P10** the static flow from a source into a decision's inputs, against that ceiling.
- **P11** an unknown usage key is a failed call, not a charge at the highest price; **P12** glob scopes for a policy.

## Known limits

- **The domains were reduced where the check could not finish.** The expense amount is in units of 50 euros, `0..10`: a stored `0..500` compared with two thresholds exhausted the default 4 GB heap (3.3 GB in use, no verdict). Whether 8 GB would have finished it was not tried. The booker has 4 slots, the order configuration one unit of stock and two orders, the research configuration two workers and a transit bound of 4. Each README says so under what is not checked, and none of the others came near a memory limit.
- **A larger heap is advice, not a feature.** A re-execution of `poly check` with 8 GB was specified, built and reverted: it would make the command line start a process, which the import-boundary check forbids on a check path. No exception was made; the READMEs of the larger examples mention `NODE_OPTIONS=--max-old-space-size=8192`.
- **The static check stops at data leaving.** It follows a taint to an effect's recipient, a message and a region; it does not follow a source into a decision, and a seeded defect that does (the support-drafts one) is `CLEAN` beside the program's own policy, held at run time by the gate. P9 and P10 propose the fix.
- **A finding runs only with a signed acceptance.** The defect copies are admitted in the end-to-end tests as an owner who accepted the finding would run them.
- **No example calls a model or the network.** Every provider is recorded; a live run is the owner's.
- **Seven tests fail on this checkout and failed at the commit before the work.** They are environmental: the experiment tree guard, a model-account test and `ANTHROPIC_API_KEY` in the environment, two freeze tests that need `experiments/m3` (now a submodule), a polyrun tombstone test waiting on E1 (reported as a pending test), and a test about being on `main`. They were run at `20779b15` and failed there too. The parallel suite on this release is 3,021 tests with 3,010 passing, five failing and one pending (the polyrun test); `test/examples-expected.test.mjs` passes 42 of 42; the serial after-suite ran 90 tests with one failure, the model-account test, before the last two fixes of this release (PL6505 and the PL6001 stage verdict), which touch the policy front end only and were checked by the parallel suite.
- **A glob scope, a policy for a machine with nothing to govern, and a configuration scope** are as the findings say: refused, a `recalled` item only, and matched by name.

## Conclusion

The examples show one thing from ten sides: the check finds a defect that sits in a comparison, a cycle or a missing line, and names it with a path, whether the path is two steps or a lasso of nine. What it cannot find lies outside the program: whether a model is right, whether a service does what it said, whether the person who approves is the right person. The end-to-end tests show those on recorded traffic, and each README says what is not checked. The edges of the check are findings of their own; where one was a defect of the toolchain it is fixed under the rule, and where it is a gap in the language it is a proposal. The tag waits for the owner.

## Glossary

- **Seeded defect:** the one change a defect copy makes to its program, so that the check's finding, its code and the length of its witness, can be seen and tested.
- **Witness:** the shortest sequence of steps that violates a property; a liveness witness is a lasso, a prefix and a cycle repeated for ever.
- **Refused:** the verdict of a program the type stage rejects (`REFUSED`); an error, not a finding, and it has no witness.
- **Scope (of a policy):** the module, or the configuration's assigned scope, that a policy governs; a scope that governs nothing is `PL6504`.
- **Acceptance:** a person's signed record that a finding is accepted; a program with findings runs only with one for each (PT12.5).
- **Recorded traffic:** the answers of a provider, a service or a device written down in advance, so a run needs none of them.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
- **Proposal (P1 to P12):** a request for a ruling on a change to the language or the toolchain, written down and not built.
