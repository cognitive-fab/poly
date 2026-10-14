# poly · Plan for the refund demo

*Cognitive Fab · October 2026 · written before any code · on branch `demo` in the worktree `poly-demo`, cut from main at v1.2.0 (4303fe33) · from `proposals/demo-refund.md` (PS23, K17, PT33, DB, DF, DS, DAC; S572 to S583), `plan-e3.md` and `e3/e3-9-plan.md` (the method and the paid-run precedent), `decisions-m7.md` (S526, S527, the inbox defect) and the standing rules in `CLAUDE.md`*

Status: for the reviewer's ruling and the owner's approvals. Nothing is built, no test is written, nothing was run, and nothing that costs money was started. The worktree holds the spec and this plan.

## 1. What this plan covers

A six-minute demo in three acts on `examples/concierge`. Act 1 needs a check that does not exist (S526, specified as PS23, PT33 and K17 in the spec), so most of the plan is that check and what it changes. The rest is the baseline protocol, the front end and the rehearsal.

Reading the code and records for the spec found four things that shape the plan:

1. **The rule reaches the standard library, and so the demo itself.** The concierge uses the `whatsapp` and `slack` channels, whose sends are irreversible on the default retry. With `refund` fixed, the concierge is still `FINDINGS` until the channel sends are ruled on (Q1).
2. **A class can be left out.** An undeclared class lowers to `none`, so a rule that keys on `irreversible` is dodged by omission. The spec adds a class floor (Q2). It also changes one line of the harness.
3. **Act 1's drama is a pre-registered gamble.** The TypeScript build may refund once (an SDK that keys its own retries), and the poly build may be clean at the first check. The spec reports both as results and has a second script for them. The plan keeps the owner from discovering this on stage.
4. **Act 2 is a live model run.** Free text from a room has no recorded answer, so it calls a model and costs money in the owner's terminal. The concierge has no live provider yet.

## 2. Common rules

- **Rule 7a.** Spec text first, committed alone. Then the failing tests, written by a separate writer that has read only the spec text and not the code. Then the code. A test that cannot fail first is a labelled control.
- **Standing rules of `CLAUDE.md`** hold throughout: poly-ref shares no code with the compiler; no model call on any check or decision path; every new artefact has its read-back and broken variants; engines are vendored and not forked (this plan changes none: the capability and the worker are poly-runtime, and `OutboxIntent` gains no transition); no silent clean.
- **Secrets.** I do not read, write, echo or set any key or secret. `ANTHROPIC_API_KEY` is not set in this environment. Every paid run is in the owner's terminal with the owner's credentials. No record holds an environment value.
- **Synthetic data only.** Customers, numbers, orders and charges are made up and listed in `demo/PROVENANCE.md`.
- **One heavy job at a time.** A full suite, the concierge check (91 to 176 s, up to 2.3 GB), the inbox check (up to 8 GB) and anything over 4 GB run alone. Before each, I check that no `node --test` runs from another worktree. The concierge and inbox end-to-end tests are in the serial group and run one file at a time.
- **Style.** No em dashes, none of the banned words, short declarative sentences, no statement of how long work took. Documents end with a conclusion.
- **Commits.** One change, one commit, with a message that says why, as `kizo-core`. Nothing is pushed.
- **Records.** `docs/decisions-demo.md`, one entry per step, with the figures measured and the label of each (synthetic, recorded, live).

## 3. Steps, in order

| Step | What | Done when | Costs money |
|---|---|---|---|
| **0 Rulings** | The reviewer rules Q1 to Q16 (section 7). Nothing below Step 1 starts before Q1, Q2 and Q3, which change what the migration is. | A ruling note in `decisions-demo.md` | no |
| **1 Spec text** | PS23, K17 and K18 into `04-semantics.md`; PT33 and the diagnostics into `03-technical-spec.md` (the code table, PT12.2, and the grammar); the scope table of `02-architecture.md` §2a; the record of S526 corrected (the manifest default is 5); S572 to S583 into `decisions-demo.md`. Committed alone, with no test and no code. | `git diff` shows only `docs/`; each id cited by a later test exists | no |
| **2 Scan** | A read-only script, `scripts/scan-retry-safe.mjs`, lists for every `.poly` file (and the embedded `.ts` sources and the inline sources of tests) each irreversible effect with its bound, its guarantee, and each effect with an `egress` label and no class, plus which standard modules each project pulls in. The output is `docs/demo/impact-s526.md`. It replaces the counts in the spec's section 2.5. | The list equals the table's families; a count that differs from `decisions-m7.md` (30 and 25) is explained | no |
| **3 Tests first** | A separate writer, given only the spec text, writes the failing tests for DAC1 to DAC7: the rule on every form (default, `attempts 1`, keyed, accepted), with and without any declared property; the witness (prefix and delivery parts, and its exported test fails on the unfixed program); the class floor; the window and its lapse; the capability (header attached, replaced and audited, second write refused); load refusal `PL6411`; the bound-1 creation; the three broken lowerings and the two seeded runtime faults; the read-back; the import boundary. Each fails for the right reason before any code. | Every test fails on the unmodified tree, and the failure is the missing feature | no |
| **4 Core** | Grammar and embedded builder (`idempotent …`), lowering of the manifest field, the front end's `PL1xxx` for the new syntax, `PL6304`; in `poly-ref`, the rule computed from the read-back manifest, the witness, and the `artefacts.ts` read-back; the three broken lowerings in `test/toolchain-faults.mjs`; the typed fixes; `idempotent by nature`, `PL4005` and the pinned identity of the library's modules. | The tests of Step 3 that belong to the core pass; `test/tv.test.mjs` catches the three faults; the evidence scripts still reproduce their numbers (the outbox models are untouched) | no |
| **5 Runtime** | `capabilitiesFor` attaches the key; load re-derives the rule; the worker creates a bound-1 intent for an unguarded irreversible entry and ends a keyed intent whose window has lapsed (the transition per Q4); the two seeded runtime faults. | The tests of Step 3 that belong to the runtime pass; `PL2401` does not fire; the worker conformance runs at bounds 1 to 10 as before | no |
| **6 Migration** | One commit per family, each with its verdict diff: `std/credentials` and `std/channels` (as ruled in Q1 and Q3), `examples/oms`, `examples/orders`, `examples/concierge` (the `refund` declaration; the handler's conditional header removed), `examples/harness` (`fetch`'s class), `conformance/` by directory, `test/fixtures/` by directory, the inline sources of the four tests, and `conformance/m2/embed/orders.ts`. The new baseline `docs/demo/verdicts-after-s526.json`. The old baselines stay. | `Step 2`'s list is empty of findings except the teaching variants; every changed verdict is in the new baseline with its reason; the serial group and `test/examples-expected.test.mjs` pass, each heavy file alone | no |
| **7 Teaching variants and example text** | `examples/retry/` (three forms of the refund, and the 40-line `draft-unguarded.poly`, the inbox's pre-fix draft reduced), each with its expected line; the concierge README's check section and glossary; `examples/README.md`. | The variants check in seconds, each to its expected line | no |
| **8 Stand-in, driver, controls** | `demo/stand-in/stripe` (the documented refund and idempotency behaviour, the request log, the fault script), the container setup (name mapping, a throwaway authority made at run time, no route to the real Stripe), the replay driver and its report of the five numbers. Tests with three doubles of the baseline (refunds twice, keys, cannot start) and a mutant stand-in that ignores the key. | DAC8 and DAC9; the driver reports O1, O2 and O3 correctly on the doubles; the control fails first where it should | no |
| **9 Front end and live providers** | The room page and server (personas, signing, per-persona replies, limits, kill switch), the verifier adapter, the transport, the staff panel feed; `demo/host/live-providers.mjs` on the inbox seam, with the extension for the `amount` record; the demo copy of the concierge and its printed diff; the launcher with the test-prefix guard; the secret scan. All tested on recorded providers and the stand-in. | DAC10, DAC11 on a recorded run, DAC13; the demo copy is `CLEAN` with its instance printed | no |
| **10 Baseline production** | The owner's terminal. (a) The pre-registration commit: `demo/baseline/PROMPT.md` and its hash, the pilot count (Q8), the model and agent version. (b) The pilots, if any, in both arms, saved. (c) The kept TypeScript run and the kept poly run, each committed verbatim before anything is run against it. (d) The driver's report on each, with controls. I draft the launch scripts and the commit procedure; I do not run the agents. | DAC8; the outcomes O1 to O4 and P1 to P4 recorded as they fall | **yes** |
| **11 Act 3 assets** | `demo/act3/`: the inbox figures with the record each comes from; the pre-fix draft; the recorded `PL4001` witness of the count rule. If the witness is not in a committed record, regenerating it is the 22-minute `test/after/ex-inbox-loop.test.mjs`, which is heavy and waits for the owner's slot. | DAC12 | no (the loop test calls polyx on recorded and synthetic data, no model; confirmed from its record before it runs) |
| **12 Rehearsal** | Dry runs on recorded providers (free), then one live rehearsal of Act 2 with a few volunteers or the owner alone, on the stand-in; timing of every live command, including the check of the agent-built draft, against the limits of the script (a command that exceeds its limit becomes a recorded segment, labelled). The presenter's runbook. | A rehearsal record; the script's times are measured, not assumed | **yes** |
| **13 Gate and record** | The full suite (one heavy job), `test/after` one file at a time, `npm run test:e3` one file at a time (the harness changed by one line), `scripts/measure-verdicts.mjs` against the new baseline; `docs/decisions-demo.md`; the release note draft. | All of the DAC met or listed as not met with the reason; no verdict changes unlisted | no |

Steps 8 and 9 do not depend on the core and can run in parallel with 4 to 7 on different tests, never in parallel with a heavy job.

## 4. Assumptions

Each says how it is tested.

- **A1** The manifest default is `{ 5, 500, 30000 }` (read in `lower.ts:510`; `test/retry-default.test.mjs`). Tested by Step 1's correction of the record.
- **A2** `runtime<m>.OutboxIntent` exists and is checked for every bound from 1 to 10 (PT9.7, PT19). The bound-1 creation relies on it. Tested in Step 5.
- **A3** `poly witness --test` can drive the runtime through the delivery part of a witness (PT12.4, S139). If it cannot express "the first answer is lost", Step 4 adds the fault to the exported test; if that needs a runtime hook, I stop and bring it.
- **A4** The stand-in's behaviour is the behaviour the provider documents. The documentation is read and dated by the owner. It is an assumption of the demo, not of poly (K17).
- **A5** Whether the TypeScript build's SDK keys its own retries is read from the SDK's source in the kept tree's dependencies (read-only), after the run, and reported. I do not assume either answer.
- **A6** A Node build trusts the throwaway authority through `NODE_EXTRA_CA_CERTS`. If a build pins certificates or ignores the variable, outcome O3 applies, and the fallback is a base-URL line in the fixed paragraph of the prompt, which the owner must approve and which changes the hash.
- **A7** The agent-built poly program checks in the time the script allows. Unknown: the concierge takes 91 to 176 s, the small variants seconds. Measured in Step 12; the script falls back to a recorded verdict, labelled.
- **A8** Docker Desktop is available as in E3.9 (installed and stopped on 2026-10-12). Starting it is the owner's.
- **A9** The coding-agent CLI offers a per-session spend limit. If the owner's version does not, the owner sets one at the account. Checked by the owner in Step 10.
- **A10** The price tables of E3.9 (read 2026-10-12) are a reference. The demo's tables are read again from the vendor's page on the day they are written.
- **A11** `rt.receive` with the certified `whatsapp` adapter accepts a webhook signed by the demo (PT10b). Tested in Step 9 on the real adapter.
- **A12** An accepted finding lets `poly admit` succeed and leaves the report's verdict `FINDINGS` (read in `packages/poly-check/src/admit.ts`; confirmed by a Step 3 test), which is why G3 is not used for the library (Q3).
- **A12a** The toolchain can pin the standard library's modules by digest, as it pins the `runtime` models (S143). The mechanism is built in Step 4; if the digest of a vendored module is unstable (line endings on Windows), I stop and bring it.
- **A13** The demo person key can be anchored in the presenter's per-user configuration without touching the repository (PT12.5). Tested in Step 9 with the test-anchor API, then done once by the owner.
- **A14** The room's network lets phones reach the presenter's laptop (a hotspot or the venue's LAN). If it cannot, the presenter types the messages (Q15).
- **A15** The recorded `PL4001` witness exists in a committed record. If not, Step 11 says so and the owner decides on the regeneration.
- **A16** The inbox's mining story is told as it happened: the recorded run proposed nothing, and the rule came from a synthetic amplification (`decisions-m7.md`). The demo labels it so on screen.

## 5. What costs money, and how much at most

Everything below is a ceiling that the owner, the host or the CLI enforces. None is a prediction. I have no measurement of a from-scratch build by a coding agent. The only measured reference is E3.9: 4.31 USD for 40 live trials of one stage-sized task each, about 0.11 USD a trial, which is not the same work.

| Line | What | Ceiling (USD) | How it is held |
|---|---|---|---|
| Steps 0 to 9, 11, 13 | recorded providers, fakes, the stand-in; no model, no network, no Stripe | 0 | the tests refuse a live provider |
| 10b | TypeScript arm, 1 pilot (Q8) | 15 | per-session spend limit (A9) |
| 10c | TypeScript arm, the kept run | 15 | same |
| 10b | poly arm, 1 pilot (Q8) | 25 | same; its `poly check` loop is free, the cost is the agent's tokens. `poly_new` and any model-calling explanation command are off the arm's tool list (DB3), so no second model spends outside the cap; if the owner keeps `poly_new`, its provider spend is added to this line and to the kept run's |
| 10c | poly arm, the kept run | 25 | same |
| 12 | one live rehearsal of Act 2 | 5 | the demo copy's budget caps (PS18.4) and the host's stop at the owner's figure |
| Show | Act 2 live | 5 | same |
| Test-mode Stripe | refunds and charges in the owner's test account | 0 | test mode moves no money; the host refuses a live-prefix key |
| Act 3 | replay of records | 0 | no model |
| **Total ceiling** | | **90** | A further run of anything is a new approval and a new line |

The per-message cost of Act 2 is not estimated here. Step 9 computes the demo copy's reservations by PS18.3's formula from the day's price tables (`PL6845` refuses a tier whose reservation is above a cap) and reports the figure per message as a computed reservation, not a measurement. The measured figure comes from `poly cost` after the rehearsal.

## 6. What needs the owner's approval before it runs

- The wording of the fixed paragraph in `PROMPT.md` (DB2), and the pre-registration commit; the number of pilots; the model and agent version for both arms.
- Each paid run: the two kept runs, the pilots, the rehearsal, the show. Each in the owner's terminal, with the ceiling above.
- Docker Desktop started for the replay (A8).
- Test mode: the owner's Stripe test-mode key and a Connect test platform (Q10), the charges the setup script creates in the owner's test account, and the first run with the prefix guard on.
- The demo person key and its anchor in the presenter's per-user configuration (A13).
- The migration: bulk edits of `std/`, two examples, about 45 fixtures and four tests (Step 6), and the new verdict baseline.
- A change to a shared standard-library module (Q1, Q3).
- The heavy slots: the loop test (Step 11, only if A15 fails), and the full suite at Step 13.
- Anything pushed: nothing is.

## 7. Open questions for the reviewer

Each has my recommendation. The spec cites the same numbers.

- **Q1** **The channel sends.** `whatsapp`, `slack`, `sms` and `email` are irreversible on the default retry; `webhook` is at 10. Under the rule the concierge is `FINDINGS` through them, and I make no claim that any provider honours a key. *Recommendation:* apply the rule to `std`. The four sends take `retry { attempts 1 }` (an ambiguous end already goes to `exhausted -> SendFailed`), at the stated cost that a transient send failure is no longer retried by the outbox and the conversation sees `SendFailed`. `webhook` is read in Step 2: if the adapter sends a stable id the receiver can deduplicate on (the Standard Webhooks protocol defines one), it is keyed; otherwise at most once. The owner confirms the provider facts.
- **Q2** **The class floor** (`PL6304`). *Recommendation:* in this release. Without it, Act 1's claim has a hole an agent finds by omission. Cost: `examples/harness` `fetch` gains a class.
- **Q3** **`credential.revoke`.** Every project that declares a credential includes it (the concierge's Stripe grant, the inbox's two grants), and it is irreversible on the default retry. It is idempotent by its RFC (the earlier ruling), and an at-most-once revoke would be worse than a retried one (a lost revoke is not repeated). A person's acceptance (G3) lifts admission only: `poly check` keeps printing `FINDINGS` (`admit.ts` admits a `FINDINGS` program whose findings are all accepted), so the concierge and the inbox would lose `// expected: CLEAN` and Act 1 could not end `CLEAN`. *Recommendation:* G4, `idempotent by nature "RFC 7009"`, declared in the library, allowed in no other module (`PL4005`), with K18 listed in the certificate and the toolchain pinning which modules are the library. The alternative is to change the verdict fold so that an accepted finding prints `CLEAN` with the acceptance listed; I do not recommend it, because it changes what `CLEAN` means.
- **Q4** **Which transition ends a keyed intent whose window has lapsed.** *Recommendation:* `HandlerFailedPermanent` (`Running` to `Dead`), delivering the `exhausted` completion, with an observation `window-lapsed`. No model change. If the reviewer prefers a model change, S120 applies and Step 5 waits.
- **Q5** **One write per keyed attempt.** *Recommendation:* accept (a second `post` is refused `PL6406`). Stripe is documented to reject a key reused with other parameters, so a second write would fail anyway.
- **Q6** **Should G1 require a distinct `exhausted` action?** *Recommendation:* not in this release. It is coarse for the channels (both completions are `SendFailed`), and a path-based form is S527. L3 says so.
- **Q7** **Is a re-emitted effect (L1) in this release?** *Recommendation:* no (S527). The demo says so on screen.
- **Q8** **Pilots.** *Recommendation:* one pilot per arm, reported with the kept run, so the pipelines are known before the run of record and neither arm has more tries than the other. If the owner wants none, the kept runs are the first runs and any failure of the pipeline costs a new pre-registration.
- **Q9** **Act 1 recorded or live.** *Recommendation:* recorded sessions, labelled and dated, with the check, the fix check and the replay live. A build is too long and too variable for a six-minute slot.
- **Q10** **Test mode needs a Connect test platform** (the concierge's credential is a Connect grant). *Recommendation:* rehearse on the stand-in; use test mode only if the owner has the platform ready, and say on screen which one ran.
- **Q11** **A copy of the concierge or a configurable example** (DF8). *Recommendation:* a generated copy with its printed diff. The example stays as released.
- **Q12** **Class `compensable`** joins the rule later.
- **Q13** **The coding agent's model.** *Recommendation:* the model the audience would use today, named in the pre-registration commit; Opus 5.5 is the E3.9 precedent and its prices are on file. The owner chooses.
- **Q14** **Migration style for fixtures.** *Recommendation:* `retry { attempts 1 }` for every fixture that needs an irreversible effect for some other purpose, one commit per directory, each fixture's purpose kept; fixtures about retry are edited individually. The owner approves the bulk edit.
- **Q15** **The venue.** If phones cannot reach the laptop, the presenter types the room's messages from a list collected before. *Recommendation:* a phone hotspot owned by the presenter, with the typed list as the fallback, shown as such.
- **Q16** **The correction of the record.** `decisions-m7.md` says "3 attempts by default". The manifest value is 5. *Recommendation:* amend the record in Step 1 with a dated note, not an edit in place.

## Conclusion

The demo's first act cannot rest on the concierge as it stands, because the concierge is safe by a convention in host code that no check reads. The plan therefore starts with the rule, specified in the spec and built under rule 7a, and spends most of its steps on what the rule changes: the standard library, two examples, about forty fixtures and one harness line, each listed by a scan before it is touched. The comparison with the TypeScript build is fixed before any run and reports every outcome, including the one where the TypeScript build is fine. The room is a real run of the real program with the two network edges replaced and named, and it costs real money in the owner's terminal under ceilings that sum to 90 USD. Sixteen questions are the reviewer's. The first three decide whether the concierge is clean again after the migration, and nothing past Step 1 starts without them.
