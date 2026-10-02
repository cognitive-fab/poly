# Decisions: M4 (runtime)

*Cognitive Fab · October 2026 · rulings on starting M4 and M5 before M3's runs are finished*

## M4-0 M4 and M5 are built in parallel with M3's runs, on a separate worktree

PT18 places M4 after the M3 experiment, and PT13's rules decide what follows it. The owner has decided to build M4, then M5, while M3's runs are prepared and executed. Two constraints from M3 still bind:

- **S100: nothing under `packages/` or `vendor/` changes in the experiment's working tree** until M3's runs are finished. The runner copies the toolchain from that tree, and the freeze digests it.
- **PT13's decision rules still apply.** If M3 ends on the stop rule, the M4 and M5 work is reviewed against the result before it is merged.

**Ruling.**

1. M4 and M5 are built in a separate git worktree, `C:\Users\jjdub\code\poly-m4`, on branch `m4`, created from `main` at the current commit. Claude Code works there for M4 and M5. The experiment's tree, `C:\Users\jjdub\code\poly` on `main`, is used only for M3.
2. `m4` is merged into `main` only after M3's runs are finished and their results are recorded. Until then, `main` takes only M3 work and documentation.
3. Changes to the spec made during M4 are made on `m4`. Rulings stay in `docs/decisions-m4.md` on `main` as well, so both trees read the same rulings. A ruling written on `main` is brought into `m4` by merging `main` into `m4`, never the reverse.
4. Engines are vendored and never forked, on `m4` as everywhere. An engine change M4 needs goes on the owner's list and is re-vendored on `m4` only.
5. `freeze.mjs --check`, run in the experiment's tree, must keep reporting no change throughout. A change it reports is a defect of this ruling.
6. One milestone at a time: M4 is planned, built, reviewed and closed before M5 is planned.

Spec issues found during M4 continue at **S118**.

## Rulings on `docs/plan-m4.md` (S118 to S136)

The plan is accepted with the rulings below. Its reading of the engines is the basis of these rulings: K4 not met after an archive, three worker transitions outside `OutboxIntent`, the effect result dropped, the ledger writable inside the step's transaction, the polyflow ledger's fixed kinds.

**Merging `main` into `m4`.** M4-0 rule 3 is clarified: Claude Code merges `main` into `m4` whenever `main` gains rulings, starting now (9d8d7ba and this commit). It never merges `m4` into `main`.

| Issue | Ruling |
|---|---|
| **S118** The gate in M4 | **Accepted.** M4 builds the gate interface, an allow-all default and scripted test gates; each decision is a `verdict` event. Session replay in `sseq` order moves to M5, and PT18's M4a row says so. Approvals in M4 are recorded API calls without a person-key signature; the instance line states the limit until PT12.5 lands in M5. |
| **S119** Who hosts the outbox intent | **Accepted: `poly-runtime` hosts its own effect worker**, every worker transition an action on the lowered `OutboxIntent`, a rejected action a runtime fault that stops the worker on that intent. A crash or lease expiry while `Running` is `HandlerFailed` and counts an attempt; the idempotency key (PT15) is what keeps a re-run of an effect that did execute from repeating it. `Dead` is terminal. An operator who wants to retry creates a new intent through a governed action, never by resurrecting a dead one. `02` §2a is amended; E3 is dropped. |
| **S120** The attempt bound | **Accepted.** The machine is checked once per distinct `maxAttempts` in the build, and `load` refuses a manifest without one. A `maxAttempts` above 5 is refused at admission, so the state space stays small; the limit is listed in PT19. |
| **S121** The ledger in the step's transaction | **Accepted.** `LedgerStore` subclasses polyrun's `Store`; K1 extends to the ledger; the decision record is held from the provider's return to the completion's commit and written in that transaction. E4 is dropped. |
| **S122** The ledger format | **Accepted**, including `at` in milliseconds (PT16 corrected), closure at archive, a poisoning as an `observation`, and no event for a K9 refusal. |
| **S123** Signed heads and the anchor | **Accepted.** The verifier reports a live run as `open-and-signed` through a stated `seq`, never as fully signed. |
| **S124** K4 | **Accepted: E1 goes on the owner's list.** The host-side fallback is not built. Until E1 is re-vendored on `m4`, PS10 states that polyrun 8.3.2 drops the dedupe keys at archive, and the M4c archive traces are a failing test listed as waiting on E1, never skipped silently. |
| **S125** Which `Delivery` machine | **Accepted:** the parallel variant; `fifo` refused at `load` with its own code until an in-order worker exists; the abstraction function written down in the test. |
| **S126** The certificate | **Accepted**, with one addition: **no private key is ever committed.** Test keys are generated at test time; `poly.json` names the admission key by id and location, and `load` reads only public keys. Only `CLEAN` programs are admitted in M4. |
| **S127** Reserved reasons | **Accepted:** `terminal`, `outside-check-domain`, `poisoned`, `archived`, `claims-unverified`. |
| **S128** Vacuity per property kind | **Accepted.** "After" properties are removed from PT12.3. |
| **S129** `adjudicate` | **Accepted, with its own code.** `PL1201` is a type mismatch and is not reused for a path finding. An accepted adjudication reachable without a preceding accepted `ok` completion of its decision is **`PL6203 ADJUDICATION_WITHOUT_DECISION`**, a finding with its witness path. The runtime reason `no-decision-to-adjudicate` is dropped. |
| **S130** Outside dispatch of a decision's completion | **Accepted.** Refused before any step, like K9, with an audit row. K10's row in PS10 says so. |
| **S131** PD3-A2 and the replay codes | **Accepted:** PD3-A2 moves to M5 with PD4; `PL9002 LEDGER_BROKEN` and `PL9003 DECISION_PROVENANCE` are added beside `PL9001`. |
| **S132** `poly journal eval` and `fit` | **Accepted.** Neither writes to any chain. Both run on recorded providers in tests. |
| **S133** Regenerations | **Accepted.** Witness tests regenerate in M4; the M3 adapter regenerates after the merge, as a separate change. |
| **S134** Capabilities | **Accepted.** An empty, frozen capability object, and the instance line says capabilities are not bound until M5. |
| **S135** The store | **Accepted:** SQLite only; Postgres listed as not built. |
| **S136** Which M3 references | **Accepted, with timing.** The re-check reads the references at the commit FROZEN records, through `git show`. FROZEN does not exist yet: until it does, that half of M4f is listed as not run, and the rest of M4f proceeds. |

**Engine list for the owner:** E1 (polyrun: tombstones at archive, K4) and E2 (polyflow kernel and verifier: the kinds `step`, `advice`, `decision`, `outcome`). E3 and E4 are dropped.

**Order.** The plan's order stands. The first commit on `m4` is the tree guard; the plan is committed next; then the spec text from these rulings, before any code that depends on it.

## Rulings at the end of the M4 build (S137 to S140)

The build is accepted as reported: M4a to M4f pass, with three tests waiting on E1, E2 and FROZEN, each printed with its reason. The three failing tests belong to M3 and are fixed there (see below). The three defects found and fixed during the build are accepted: message lease recovery in the runtime, the claim fencing every worker transition, and `poly check` no longer loading `poly-runtime`.

| Issue | Ruling |
|---|---|
| **S137** Effects with no retry clause, and the bound | **Accepted, with the cap raised.** An effect with no retry clause gets polyrun's default of 5 attempts, written into its manifest. The cap of 5 set in S120 was a guess, and it refuses the oms example (6). The cap becomes **10**: the runtime's CI checks `OutboxIntent` at every bound from 1 to 10 and records the state count of each. A bound above 10 is refused at admission, and PT19 lists the limit. |
| **S138** Permanent failure | **Add it to the machine now.** A handler can report a permanent error (a declined card is not retried). `OutboxIntent` gains `HandlerFailedPermanent`, from `Running` to `Dead`, which dispatches the effect's `failed` completion and counts no further attempt. PT9.7 is amended first; the machine is re-checked at every bound, `settles` included; the worker conforms by trace replay with the new path in its corpus; a worker that retries a permanent error is a `PL2401` drift. |
| **S139** Witness tests through the runtime | **No unchecked loader.** A loader that skips the certificate would break the standing rule that every artefact the runtime reads is checked. Instead, `poly admit --witness` issues a **witness certificate**: same format, `purpose: "witness"`, the findings listed, signed with a test key. `load` refuses a witness certificate unless the caller passes `allowWitness: true`, and that option is refused when `NODE_ENV` is `production`. Exported witness tests load through it and drive the runtime API. A test shows a witness certificate refused by default. Step 11 is built this way. |
| **S140** Input outside an action's type | **Refused before any step.** PS3.2 defines steps only for `d ∈ T(a)`. An input outside the type ("Invalid proposal…") is refused by `dispatch` with an error and an audit row, and no journal row, like K9. Replay no longer meets such a row. PS3.2 says so. |

**The M4f re-check result is accepted.** Three step properties are vacuous: two copies of `cancel-is-final` in orders, and `shutdown-is-a-true-terminal-state` in raft. They restate what `terminal` already guarantees, so they test nothing, and `INCONCLUSIVE` is the right verdict. The sources are not edited to hide it. The record lists the three, explains why, and notes that raft moves from `CLEAN` to `INCONCLUSIVE` while no M0 to M2 gate number changes. In new code, terminality is stated with `terminal`, not restated as a property.

**For M3, on `main`, not for the M4 session:** the control 4 test that still expects O1 to be absent is stale and is updated by the M3 session; the environment failures clear once the CLI is pinned and the freeze regenerated (M3-10).

**Merging.** M3 work commits on `main` may come into `m4` with the next merge of `main`; that is harmless. `m4` still never goes into `main` before M3's runs are recorded.

**Next.** Build S137 to S140 and step 11, each with a test that fails first. Then M4's code review, as for earlier milestones, before M4 is closed. M5 is planned only after that.

## Conclusion

Building M4 and M5 alongside M3 saves calendar time without touching the experiment. The worktree keeps the frozen toolchain where the runner reads it, the merge waits for M3's result, and the stop rule keeps its force over everything built in the meantime. The M4 plan is ruled: the runtime hosts the checked outbox machine itself, writes the ledger inside each step's transaction, and needs two engine changes, tombstones in polyrun and four ledger kinds in polyflow.
