# Decisions: PD5 (identity and lineage)

*Cognitive Fab · September 2026 · rulings on `docs/reviews/review-pd5.md` (commit f58a765) · PD5 becomes v0.2*

## S100 confirmed

The toolchain part is in the freeze (b25ea36): 86 files, digest `246ec34e…`, commit 04c62e8 recorded. Walking all of `vendor/`, including `vendor/sam-pattern/dist/SAM.js`, is correct: that file is the engine, not build output. The `--json` directory was a test accident and its removal is accepted. JJ's step 4 (FROZEN) no longer waits on S100.

## Rulings

| Issue | Ruling |
|---|---|
| **S101** `claims-unverified` is not PS3.2 row 2 | **Accepted.** Claims are part of the label: `(a, d, c, v)`. PD5 adds a row after row 2: claims missing, malformed or outside their domains give `rejected("claims-unverified")`, applied by the runtime before the module, like row 2. **Runtime reasons are reserved.** A `reject` whose reason is `terminal`, `outside-check-domain` or `claims-unverified` is `PL1207 RESERVED_REJECT_REASON`. The reservation of the two existing reasons is amended into the spec now (PS3.2, PT12.2). It is enforced from M4, since `packages/` is frozen. |
| **S102** PS4.1b does not cover claims or principals | **Accepted.** PD5 states the lemma it needs (renaming invariance, PD5.1.3) and PS4.1b's extension. Until the lemma's proof gives a tighter bound, the number of principal representatives is the number of `Principal` fields plus one, and never below 2. The verdict prints it in its instance. The tighter bound from the evidence (the most principals one guard, property or input relates) enters only with the proof. |
| **S103** `Tri` claims | **Accepted.** `PL1203 TRI_WHERE_BOOL_EXPECTED` already refuses it. Claim fields are enums, integer ranges and `Principal`. Attestation is an enum: `Attest { Verified, Failed, Absent }`. |
| **S104** Policies cannot read claims | **Accepted.** The gate proposal (PT9.1) gains `claims`, the claims of the emitting step, and `origin` (S105). Policies read `step.claims.f` and `lineage.origin.f`. PT9.3 is unchanged: the snapshot is still the post-state; the claims belong to the label and travel beside it. |
| **S105** Lineage breaks the message multiset and the finite state | **Accepted.** In **check**, lineage is abstracted to its **origin class**: the origin's claims and the intent. The hop chain and its digests exist only at runtime, like ids and `seq`. A message in the multiset carries its origin class, which is finite. The abstraction is exact because no expression can name a hop: policies and properties read only `lineage.origin` and `lineage.intent`. |
| **S106** Wrong citations and `mode(…)` | **Accepted, all three.** PD5.3.3a is polycheck's region check at admission (PT8). PD5.3.3b is a possibility property, as PD4.4b. A mode is read with `machine("…")`. |
| **S107** The `Trust` example and person signatures | **Accepted.** The example is rewritten in valid poly. **One mechanism:** a person signature (PT12.5, PD4.2a) is verified by the person-key adapter, whose output is a claim `{ kind: Person, assurance: 3, principal: <key owner> }`. PD4.2a stays as written and is restated as this adapter when both land in M5. |
| **S108** Certificates and non-ed25519 signatures | **Accepted, without the engine change.** The certificate is written by `poly admit` (PT14) and verified at load (PT15); the ledger is PT16. Heads and certificates stay ed25519, signed as today. A workload-identity signature is an **additional countersignature** over the head's hash, in its own record, made and verified by the host's verifier adapter. Polyaxion's four checks and polysec are unchanged. |
| **S109** `PL6702` belongs in PL1xxx | **Accepted.** It is `PL1206 PRINCIPAL_NOT_OPAQUE`. |
| **S110** K11 assumes K10 | **Accepted.** K10 enters PS10 with PD2 in M4. K11 enters after it, with PD5. PD5 is not ruled into the spec before PD2 is. |
| **S111** PL6401 overstated | **Accepted.** PD5 says exactly what it does: a lint over handler files that refuses ambient-authority imports. The sentence about sandboxing is removed. |
| **S112** PD5.4 in M4 | **Accepted.** All of PD5 is M5. |
| **S113** Vacuous verdicts (raised by the evidence for open question 1) | **Ruled, for all properties.** A property whose antecedent is never true in the explored states (the left side of an implication, of `leads to`, or the trigger of an "after X" property) is not `CLEAN`. It is `INCONCLUSIVE` with reason `vacuous`, and the verdict names the antecedent. No new verdict. Amended into PT12.3 now; enforced from M4. |

## Engine list

- **Lineage on outbox rows (PD5.2).** First try poly's own envelope: the lowering puts the origin class and the previous hop's digest in a reserved field of the effect or message payload, and the receiving step reads it from there. Only if polyrun cannot pass that field to the receiving step does it go on JJ's list.
- **Signatures beyond ed25519.** Removed by S108.
- **A host-supplied rejection journaled as a step.** Checked when poly-runtime is built (M4). Listed only if polyrun's existing entry cannot carry `claims-unverified`.

## Conclusion

PD5's principle survives the review: identity is verified outside poly and enters as a finite typed input. The review found where the semantics had to grow to carry it, and each gap now has a rule: claims in the label, a reserved rejection reason, renaming invariance with a safe bound, origin classes in place of hop chains, and a countersignature in place of an engine change. Two rulings reach beyond PD5 and enter the spec now: runtime rejection reasons are reserved, and a vacuous property is never reported as clean. PD5 waits on PD2 and lands in M5.
