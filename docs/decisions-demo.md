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
