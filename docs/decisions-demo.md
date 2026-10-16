# poly · Decisions for v1.3, the refund demo

Steps, results and rulings of the branch `demo` (the spec `proposals/demo-refund.md` and the plan `plan-demo.md`), in the order they happen. Each entry names who ruled.

## Rulings on the plan (reviewer, with the owner's decisions marked; 2026-10-14)

The spec and plan (dffe1153, a70ed1d2, e19c6fa8) are accepted. The work is v1.3.

- **Q1, accepted.** `whatsapp`, `slack`, `sms` and `email` take `retry { attempts 1 }`. `webhook` is decided from the adapter in Step 2. No claim is made about any provider's idempotency.
- **Q2, accepted.** The class floor (`PL6304`) is in this release.
- **Q3, accepted.** G4 (`idempotent by nature`, library only, `PL4005`) is used for `credential.revoke`. What `CLEAN` means does not change.
- **Q4, accepted.** `WindowLapsed` is added to `OutboxIntent` under S120. The evidence scripts and the checks at bounds 1 to 10 are re-run. That is a heavy job and runs alone.
- **Q5, accepted.** One write per keyed attempt.
- **Q6 and Q7, not in this release.** The demo shows L1 (S527) on screen.
- **Q8.** One pilot per arm, reported with the kept run.
- **Q9.** The builds are recorded. The check, the fix check and the replay are live.
- **Q10 (owner decision).** Only the local Stripe stand-in, at every stage, the show included. No real Stripe connection and no test mode. On screen it is labelled a mock-up of Stripe. Nothing reads a Stripe key. The test-mode lines were removed from the plan and the spec (6fa4749d).
- **Q11.** A generated copy of the concierge, with its printed diff. The released example stays as it is.
- **Q12.** `compensable` is later.
- **Q13.** Opus 5.5 for both arms, named in the pre-registration commit.
- **Q14, accepted as proposed.** The owner approves the bulk edit at Step 6, from the list Step 2 produces.
- **Q15.** The presenter's phone hotspot, with the typed list as a fallback, shown as such.
- **Q16.** A dated note in `decisions-m7.md`, not an edit in place (made in Step 1).
- **Money (owner decision).** Section 5 of the plan stands. The total ceiling is 90 USD on the API. Each paid run needs the owner's approval and runs in the owner's own terminal.
- **Scope of this stretch.** Step 1 (spec text only, committed alone), then Step 2 (the read-only scan). Stop after Step 2 and bring the commits and `docs/demo/impact-s526.md`. No test is written before the owner has reviewed both.

## Step 1 · the spec text

Written into the specifications, with no test and no code:

- **`04-semantics.md`:** PS23 (PS23.1 to PS23.9), and K17 and K18 in the kernel assumptions table.
- **`03-technical-spec.md`:** PT33 (PT33.1 to PT33.11, with PT33.5a), the `idempotent` production in the grammar of `EffectItem`, and the codes `PL4003`, `PL4004`, `PL4005`, `PL6304` and `PL6411` in the table of PT12.2.
- **`02-architecture.md`:** one row in the scope table of section 2a.
- **`decisions-m7.md`:** a dated note that corrects the record of S526 (Q16).

**One deliberate gap.** The block of PT9.7 (the `OutboxIntent` model) is not edited here. `test/outbox-intent.test.mjs` holds that block word for word against the model source, so editing it now would break a test with no code to match it. PT33.5a states the new transition, and Step 5 changes the PT9.7 block, the model source, the lowered builds and the worker's observation pairing in one step.

### Spec issues raised (S572 to S583)

Numbered from S572 so that they do not meet S570, which is unused.

| Id | Issue | Status |
|---|---|---|
| S572 | The rule of PS23.5 and the guarantees G1 to G4 | ruled (Q1, Q3) |
| S573 | The class floor, PS23.6 (`PL6304`) | ruled (Q2) |
| S574 | `idempotent header … window …`, the manifest field and its read-back (PT33.1, PT33.2) | ruled |
| S575 | K17 as a kernel assumption | ruled |
| S576 | The runtime's three enforcement points and the bound-1 creation (PT33.5) | ruled |
| S577 | One write request per keyed attempt (PT33.4) | ruled (Q5) |
| S578 | The window lapse and the `WindowLapsed` transition (PS23.7, PT33.5a) | ruled (Q4) |
| S579 | The standard library under the rule | ruled (Q1, Q3) |
| S580 | The record of S526 corrected: the manifest default is 5 | ruled (Q16) |
| S581 | The demo copy of the concierge (DF8) | ruled (Q11) |
| S582 | The live provider seam for a record result (DF6) | ruled |
| S583 | G4, K18, `PL4005`, and the pinned identity of a standard-library module | ruled (Q3) |

## Conclusion

The rulings fix what Step 1 writes: the rule with four guarantees, the class floor, one new transition in the outbox model, and a Stripe that is a mock-up everywhere. Step 1 puts that text in the specifications and changes nothing that runs. The `OutboxIntent` block waits for the step that changes the model, so that no test is broken before its code exists. Step 2 follows, and nothing after it starts before the owner has reviewed it.

## Rulings on Step 2 (reviewer, 2026-10-14; `docs/demo/impact-s526.md`, ec40fb4b)

- **The class floor, accepted at its full size.** About 60 one-line class edits in Step 6. Each fixture gets the class that matches what its effect does to the world: an effect that moves money or sends a message outside is `irreversible`. Where a fixture gets `reversible` or any class that avoids the rule, its commit says why in one line. The owner's approval of the bulk edit at Step 6 still stands.
- **`examples/orders/orders.poly`.** Its expected line becomes `FINDING PL3102 PL4001 PL4002 PL4003`. The finding is real (`charge` is unguarded) and the example teaches findings. `charge` is not migrated. The mention in `examples/README.md` names the new code (the example has no README of its own).
- **Webhook.** `retry { attempts 1 }` is confirmed. The receiver-side `webhook-id` stays recorded as a fact for a later release (section 8 of the impact file).

### Corrections to the scan after review of ec40fb4b

Four defects in `scripts/scan-retry-safe.mjs` were confirmed by review and fixed. No table of the impact file changed except the lines noted.
- The count sentence said "reproduced" while finding 24, not 25, on the default. It now says that the 30 is reproduced, that 24 is found, and that 24 + 1 = 25 once the inbox's `createDraft` is counted as it was recorded; it checks that the effect is `createDraft`.
- Section 7 pointed at a section 8 that the script did not emit, and section 2 at "section 5". The hand-written sections now live in `docs/demo/impact-s526.tail.md` and the script appends them, so a rerun keeps them.
- The map of standard-library effects kept one effect per file; it now keeps all of them.
- Comments were stripped without regard to strings; a `//` inside a string no longer cuts a line.

## Rulings on Step 3 (reviewer, 2026-10-14; ac198686, 5a877c34)

- **Building an unsafe artefact.** No production path: no `--witness`, no `allowWitness`. A helper under `test/fixtures/` writes a certificate directly, signed with the test trust key, over a manifest without the guarantee, bypassing the checker (an existing certificate-writing pattern is reused: `certificateDigest` and `signDigest`, as `test/channels-adapter-pin.test.mjs` does). Load must refuse it with `PL6411` although the signature is valid. The bound-1 clamp test uses the same helper. The import-boundary test is extended so that nothing under `packages/` can reach the helper. The `todo` becomes a real failing test. Text: PT33.5b.
- **The fault name, split in two.** `unkeyed-retry-admitted-at-load` disables the load check and `unkeyed-retry-unclamped` disables the worker clamp; each is caught by its own test. Text: PT33.5 (seeded runtime faults), and `S526_RUNTIME_FAULTS` in `test/toolchain-faults.mjs`. (`unkeyed-retry-allowed` is retired.)
- **Field names.** Fixed in PT33.12: the witness's delivery part, `reach`, the class and the `retry-safe` lines, in the JSON and in the report text. The tests assert those exact fields.
- **PT33.3 at unit level.** Covered by the load tests and the `PL2501` read-back. No public entry is added for tests.
- **`PL4005`.** A check-time finding. Confirmed.
- **The `caps.api` path.** Required, not optional: the concierge's refund goes through it. The tests use the vault fixture the concierge's own tests use and are added to `s526-capability`.
- **Process.** A second reader, given only the spec text and the test files, answers for each failing test whether it would pass on a wrong implementation. `tv.test.mjs` and `standing.test.mjs` are run alone, one at a time. Agents commit nothing; only the lead commits.

## Rulings on Step 3 (reviewer, 2026-10-14; accepted through c1f3f940, on conditions)

Step 3 is accepted on these conditions, all met before Step 4:

- **The failures of `s526-capability`, `s526-manifest-faults` and `s526-impact` were read, as for the others.** Each is the missing feature. `s526-capability`: all 12 failing tests stop at the first admission, `PT33.1: the idempotent clause is not accepted yet` (the keyed fixtures are refused as unknown syntax), so the runtime tests will move to their own failure only once Step 4 parses the clause. `s526-manifest-faults`: five fail on the same refusal and `idempotency-invented` fails because the lowering does not have the fault (`must change the manifest`). `s526-impact`: the seven failures are the library, the verdict baseline and the migration, which are Step 6, and `PL4003` on `orders.poly`, which is Step 4.
- **Three tests the second reader found missing were added, failing first** (`ef8d99b6` and the commit after this record): the manifest class lowering against `effectClasses` (`s526-class-floor`, two tests); K17 and K18 in the output, as kernel assumptions of the verdict and in the certificate of an admitted keyed program (`s526-guarantees`, three tests); and the exported witness test passing on the fixed program (`s526-rule`, one test), which fails today and stays red until the witness export of PT33.9 is built.
- **The `unsettled` outcome (PS23.1) is untested.** A test cannot induce an attempt whose handler returned and whose settle did not commit: the settle is the worker's own transaction, and no seam of the runtime lets a test fail it. The witness lists it under `alsoBy` and a test checks that text, but no run exercises it. `permanent` stays covered by the S138 tests.
- **The second reader's result is recorded as unverified.** It reported 76 of 83 tests tight, 5 loose and 1 vacuous, without a per-test table, so the counts could not be checked test by test. Its loose findings were fixed (c1f3f940 and before); its list of requirements with no test is what the three added tests and the `unsettled` entry above answer; the rest (the manifest class of an `exec` effect, `PL4003` on a fixed program's export) stay as listed in the Step 3 report.
- **Step 4 is the core. No test is changed during it.** If a test looks wrong, work stops and it is brought to the reviewer with the reasoning. A test is never edited to make code pass.


## Step 9: the front end and the live providers (2026-10-15)

- **Caps of the demo copy.** The example's two cap lines are the tests' own (0.5 per run, 20 per day per scope). The demo copy sets 0.25 per run and 10 per day per scope. They are proposals for the owner to confirm: the plan's ceiling of $90 is for the baseline's pilots and runs, and the room's own bill is not yet priced.
- **Price tables are placeholders.** The release gives no vendor price for the models a live room would use, and nothing here may read a vendor's page. The copy keeps the example's tables (source example.com), so the diff against the example is the two cap lines alone; a live launch is refused while any table names a placeholder source, as the harness's live run is (E3.9). The owner reads the vendor's page, writes the tables, and the gate then passes.
- **Admission under a throwaway anchor.** The demo's keys (admission, the presenter's person key that signs the policy, the grant request and each approval, and an agent's) are made at start; the anchor is a file in the run's temporary folder named in an anchors folder of the run's own, so the owner's per-user configuration is untouched. Approvals at the presenter's prompt (`approve <intent>`) sign with that in-memory key; `poly approve` with a key in the per-user configuration remains the production path.
- **Recorded mode** answers every model call from the recorded fixture of seven messages; a message it does not hold fails the call, as a provider with no answer does. The recorded run of the tests gives two guests the fixture customers' orders so that the recorded answers apply.
- **The handler's conditional header is removed** (`examples/concierge/host/refund.mjs`): the refund is declared keyed, so the runtime sends the intent id on the write and on each retry. The header name is written in lower case (header names are case-insensitive), as the transports index it. Two fixtures that stand for the concierge in `test/ex-concierge-refund.test.mjs` are keyed the same way.
- **Order of work.** The unit tests were written before the code (commit 74513724). The recorded run (`test/after/demo-concierge-e2e.test.mjs`) was written after the assembly it drives, because it needs the pieces to exist; it failed for faults of its own (a baseline count, a filter) before it passed.
- **Not covered by the standing rule.** `demo/concierge/` is a copy of an example, and `test/standing.test.mjs` does not list `demo/`; the copy's check is run by the recorded run (CLEAN, the example's instance counts).

## Step 10: rulings on the baseline (reviewer and owner, 2026-10-15)

- **One text beyond the prompt, per arm.** `demo/baseline/arm-ts.md` and `arm-poly.md` are appended to the system prompt (`--append-system-prompt`). They are the only instruction an arm gets besides `PROMPT.md`: the workspaces hold no CLAUDE.md, and the arms run with CLAUDE.md files off. Both are committed, marked `-text`, and hashed in the pre-registration with the prompt. They differ only in the language and the tools that language needs.
- **Equal terms.** The same cap for both arms (25 USD a run) and the same turn limit (`--max-turns 200`). The caps of 15 and 25 are withdrawn. The turn limit of 200 is the draft's figure for the owner to confirm before the pre-registration commit.
- **Subscription.** Both arms run on the owner's subscription. No API key is in either environment, and the runner refuses to start if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set. The pre-registration records "subscription". The baseline is not on the API ceiling of the plan: the 90 USD ceiling is withdrawn, the API ceiling is 10 USD (rehearsal and show), and the baseline's limit is its four caps (100 USD in all).
- **Interface.** The poly arm reaches poly through `npm run poly` in Bash, as the M3 arms did. No MCP server, skill or plugin.
- **Network.** Neither arm runs in a container. The pre-registration records that both had ordinary network access and no keys.
- **Reference of the poly arm (2026-10-15).** The arm's `tools/poly/` is 13 files built by `poly-reference.mjs`: the README, the two specifications and the `hello`, `delivery` and `evidence` examples. The double-charge walkthrough and every refund example are removed, and the specifications' running example is a shipping order (Pay is Ship, charge is dispatch, payments.Payment is shipping.Shipment). The language's features (retry, class, idempotent) stay. Both arms have `node`, `npm test` and `npm install`; the TypeScript arm also has `npx tsc`, the poly arm the five `npm run poly` commands.
- **Approval (owner, 2026-10-15, on commit 07416749).** The owner approves `PROMPT.md`, `arm-ts.md` and `arm-poly.md` as they are, the turn limit of 200, and the two tool lists. The hashes approved:
  - `demo/baseline/PROMPT.md` sha256:949bb0611273f24e9d66e557c868924eea6b380612a213a0af7a5d4ec6bd10ec
  - `demo/baseline/arm-ts.md` sha256:091890e187fc3699a4563e7721c9b182a97abe2ff7f04b34bdc043b59e8326fc
  - `demo/baseline/arm-poly.md` sha256:f0f5ebedc8d73d2bf5ccb3fe3278128d178adf1124ef9ed38b8a9df18a2c93e6

  The owner makes the pre-registration commit and runs the pilots. No agent does.
