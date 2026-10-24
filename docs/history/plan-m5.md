# poly · Plan for milestone M5, governance

*Cognitive Fab · October 2026 · plan, written before any M5 code · on branch `m4` in the worktree `poly-m4` (M4-0) · from `handoff-m5.md`, after the merge of `main` at a07d62c*

This plan covers milestone M5 of PT18 as amended at M4's close: the policy language and its lowering, the gate with emitting-step snapshots (PT9.3), the polycheck stage, obligation consistency (PT8.5), escalation with a timeout, person-key signatures (PT12.5), cross-scope sends with `SendDenied` (PS8.7, PT9.9), operating modes (PD4) and PD3-A2, identity and lineage (PD5), and the items M4 carried: session replay in `sseq` order (S118), bound capabilities (S134), instances started from a configuration's initial values (S141), hashed handler dependencies (S142) and the opt-in OpenShell sandbox (PT6.5). It fixes the packages touched, the order of work, how each gate item is tested, which outages the outage test injects, PD5's acceptance criteria, whether M5 is split, the engine changes, and the spec issues found, numbered from S144. Nothing is built until the plan is ruled.

## 1. What was read, and what was found before planning

The documents were read in the handoff's order: `CLAUDE.md`; `decisions-m4.md` from M4-0 to "M4 closed"; PD3 and PD4 of `proposals/pd-model-decisions.md`; `proposals/pd5-identity-lineage.md` (v0.2) with `decisions-pd5.md`; PS8.4 to PS8.7, PS10 and PS11; PT6.5, PT8, PT9.1 to PT9.9, PT12.5, PT14, PT16 and PT18; the closing section of `plan-m4.md`. The engines were read at their sources: Polyaxion at `C:\Users\jjdub\code\polyaxion` (c37c60e), polycheck at `C:\Users\jjdub\code\polycheck` (678b120, 0.7.0), and `polyaxion-openshell`. The evidence script `principal_symmetry.py` was run.

What the reading found, each item checked against the source:

| Finding | Where | Consequence |
|---|---|---|
| poly has no policy front end. The parser skips a `policy` block with `PL0901`; `obligation`, `recalled`, `var` and `scope` are not in the lexer or the AST. The Kleene logic of PS8.1 and the rule table of PS8.2 exist (`truth.ts`) and are used only by a unit test. | `poly-lang/src/parser.ts` `LATER_TOP_LEVEL`; `poly-core/src/truth.ts` | M5 starts with a grammar, a checker and a lowering for `.policy.poly`. |
| Polyaxion has no `unknownWhen`. An unknown `when` always applies (fail closed); an unknown `require` refuses as `indeterminate`. `FUNCS` has `coalesce` and `isNull`. | `polyaxion/src/core/step.mjs` `evalRules`, `expr.mjs` `FUNCS` | PT8.2's fallback works without an engine change: `on unknown skip` lowers `when W` to `coalesce(W, false)`, and an `on unknown` outcome that differs from the rule's severity lowers to a second rule `when isNull(W) require false` with that severity. |
| Polyaxion has no `sseq`. Its per-session `step` advances only on allowed proposals; its window `seq` is global. Every verdict carries `state_before` and `state_after`, canonical digests of Σ. `replay(runId)` re-steps a session's windows. | `src/engine.mjs`, `src/runtime/evidence.mjs` | PS11.1 needs a sequence on every proposal and settle. poly-runtime's gate host can assign it, since it already serialises each session (S146). |
| Polyaxion's PX cannot read program state. Its roots are `action`, `state` (its own vars), `patch`, `history`, `run`, `machine` (the obligation's own machine) and `observed`. Extra fields of an action pass through and are readable as `action.x`. | `src/core/expr.mjs`, `normalizeAction` | `machine("m.M").f`, `decision("d").f`, `step.claims.f` and `lineage.origin.f` can lower to reserved action fields that the gate host fills from the proposal. 02 §2a's "polyaxion: an `effect` proposal kind that carries the snapshot" is then not needed (section 2). |
| PT8.3 reads the snapshot of the instance that emitted the effect, and is unknown for any other machine. PD4.3 reads `machine("ops.OpsMode").mode` and PD5.3 reads `machine("security.Trust").level` from a refund emitted by a `Ticket`. | PT8.3, PS8.5, PD4.3, PD5.3.2 | Under PT8.3 as written, every mode rule is unknown. Reading another machine needs a rule (S147). |
| Polyaxion's mandate check (m2) returns up to three trapped states per machine with their paths. It does not return a minimal conflicting subset, and nothing in Polyaxion checks obligations for mutual consistency. | `src/compile/discharge.mjs` `checkDischarge` | PT8.5's minimal subset must be computed by poly, by deletion over repeated `checkDischarge` calls (S148). |
| polycheck is a separate engine whose model is a set of tool actions with coarse effect flags (`untrusted`, `sensitive`, `egress`, `proprietary`) and monotone regions over those flags. It has no notion of program state. | `polycheck/src/check.mjs` `modelCheck` | PT8.4's region check over effect labels fits it. PD5.3.3a ("in `Halted` no compensable or irreversible effect is admitted") is state-dependent and does not (S149). |
| Polyaxion approvals are unsigned: `approved: { by, ref }` with `ref` equal to the escalated window's `tool_use_id`, or `wrong-participant:polyaxion:approval-unmatched`. An approval lifts escalations only. There are no escalation timeouts. Its only ed25519 signatures are notary receipts. | `src/runtime/gate.mjs`; `polysec-core/src/polysec-notary.mjs` | Person-key signatures are poly's (PT12.5). The escalation timeout stays in `OutboxIntent` (PT9.7), which already has it. AC4's "signed receipt" is Polyaxion's notary receipt. |
| No `people` or `agents` keyring, no `poly approve` or `poly accept`. `rt.approve` records `{ by, ref, signed: false }`. | `poly-core/src/manifest.ts`; `poly-runtime/src/worker.ts` | PT12.5 is built from nothing except the ed25519 helpers of `certificate.ts`, whose message prefix is the certificate's own (S150). |
| Polyaxion, polyman and polysec-core are BUSL-1.1. poly's `package.json` says Apache-2.0, and 02 section 13 leaves poly's licence open. M4 vendored nothing BUSL. | the three `package.json` files; `02-architecture.md` §13 | Vendoring the gate engine into poly needs a licence ruling first (S145). |
| polysec-core needs polygraph (`^8.2.0`, or `POLYGRAPH_DIR`, or a sibling checkout); Polyaxion needs Node 22.18 or later. | `polysec-core/package.json`, `src/runtime/deps.mjs` | The vendored copy resolves polygraph to `vendor/polygraph`; Node 24 is in use. |
| `polyaxion-openshell` judges egress requests at OpenShell's supervisor; it does not generate a sandbox policy from labels or targets, and its end-to-end run needs the OpenShell gateway, Docker or Podman and Linux 6.2 or later. | `nvidia/openshell/polyaxion-openshell` | PT6.5's generated sandbox is new work, and its enforcement cannot be observed on this Windows machine (S152). |
| Effects have no `targets` in the grammar; handlers receive an empty frozen object (S134). | `poly-core/src/ast.ts` `EffectItem`; `worker.ts` `NO_CAPABILITIES` | Capabilities need the grammar, the manifest and a host-supplied transport, since `poly-runtime` may import no network module (S151). |
| polyrun's `create(machineId, instanceId, creation)` starts every instance at the contract's initial state. | `vendor/polygraph/polyrun/src/kernel.mjs` | S141 needs an engine change (E5). |
| `principal_symmetry.py` reproduces: reference CLEAN from n = 2 (7, 13, 21 states for n = 2, 3, 4; vacuous at n = 1); the self-approval mutant VIOLATED from n = 1; the order-comparison mutant flagged. It still names the refusal `PL6702`, which S109 renamed `PL1206`. | `docs/reviews/evidence/principal_symmetry.py` | These numbers are PD5-A3's. The script's stale code name is noted, not changed: evidence scripts are not edited by the build. |

Nothing else was measured. M5's first measurements are AC4's (step 10).

## 2. Engine changes, for the owner's list

| Id | Engine | Change | Needed for | Without it |
|---|---|---|---|---|
| E1, E2 | polyrun, polyflow | As listed for M4 (tombstones; the four ledger kinds). | K4; one verification tool | Unchanged from M4. |
| **E5** | polyrun | `create(machineId, instanceId, creation, { initialState })`: an instance started at given initial values, validated against the contract's field types in the create transaction, journaled in the `$create` row's data. | S141 | A configuration's instances cannot be started by the runtime at the values its check explored; its witnesses stay on the artefacts (M4's limit). |
| E6 (not proposed) | polyaxion | An `effect` proposal kind carrying the emitting-step snapshot, as 02 §2a lists. | PT9.3 | Not needed: poly lowers every program-state read to a reserved action field and the gate host fills it (S147). Listed because the architecture names it. |

No change to polycheck, OpenShell or polyaxion-openshell is proposed. Polyaxion, polyman and polysec-core are copied unchanged into `vendor/polyaxion` from c37c60e, if S145 allows it, each pinned by hash in `PROVENANCE.md` and checked by `test/vendor.test.mjs`.

## 3. Packages and what changes in each

| Package | M5 changes |
|---|---|
| `poly-core` | AST for `policy`, `obligation` (`rule`, `machine`, `invariant`), `recalled`, `var`, `scope`; `claims` types, `Principal`, `by c: T` on handlers (M5b). Checker: PX typing (`Tri`), PS8.2's `on unknown`, `machine(…)` and `decision(…)` references, `PL1203` reachable at last, `PL1206`. Codes: `PL6501`, `PL6701`, and the new ones of S150 and S151. Signed records (S150) beside the certificate helpers. Manifest: `people`, `agents`, `scopes`. |
| `poly-lang` | Grammar and formatter for `.policy.poly`, `targets`, `claims`, `by`. |
| `poly-embed` | Nothing in M5a. Claims and `by` in the embedded surface in M5b, so both surfaces keep one AST (PT2.5). Policies stay `.policy.poly` only (PT1.1a). |
| `poly-lower` | `polyaxion.policy.json` v2, with the `on unknown` rewrite of section 1 and reserved action fields for `machine`, `decision`, `step.claims` and `lineage.origin`; `targets` into the manifest; claims and lineage carriage (S155). |
| `poly-ref` | PX and the rule table written from PS8 (not from Polyaxion), for translation validation of the lowered policy: every rule's outcome on every proposal of a finite proposal space agrees with Polyaxion's decision (the standing rule for a new artefact). The policy decision table check of S149. Claims, principal representatives and the renaming bound (PD5.1.3), origin classes (PD5.2.3), `PL6701`. |
| `poly-check` | Stage 5 (policy admission: Polyaxion `admitPolicy`, harden, coverage), stage 5a (polycheck regions), stage 5b (obligation consistency with a minimal subset, per mode, S148); `poly approve`, `poly accept`; admission of a program with signed accepted findings (PT12.5, S126's M5 half); `poly journal replay --sessions` (S146); `poly bench gate` (AC4). |
| `poly-runtime` | The policy gate host over Polyaxion in process (sessions, `sseq`, Σ digests, settle, escalation with signed approvals); cross-scope send proposals and `SendDenied`; capabilities bound from targets with host transports; the person-key verifier and the claims adapter interface (M5b); lineage; countersignature records; `createFrom(configuration)` after E5. |
| `vendor/polyaxion` (new) | Polyaxion, polyman, polysec-core, unchanged, after S145. |
| `scripts/check-boundaries.mjs` | `vendor/polyaxion` joins the runtime side; poly-ref still imports only types from the compiler; no model SDK or network module in `poly-runtime`. |
| `test/` | One file per gate item (section 5); the fault lists gain the policy artefact's broken variants. |

## 4. Proposed split, and the order of work

M5 has about three times M4's surface: two languages (policies, claims), a vendored engine, two runtime protocols (sessions, lineage), signatures, and seven carried items. **S144 proposes splitting it** into M5a, governance (steps 0 to 10), and M5b, identity and the carried host items (steps 11 to 18), each with its own gate, review and close. M5b needs M5a's gate and signatures, and nothing in M5a needs M5b.

Each step ends with a commit, and every defect gets a regression test that fails first.

**M5a: the gate and signatures first.**

0. **Vendoring.** `vendor/polyaxion` with provenance and hashes, after S145; a smoke test that `admitPolicy` and `merge` run against the vendored polygraph.
1. **Person-key signatures (PT12.5, S150).** `people` and `agents` keyrings in `poly.json`; the signed record format for approvals and acceptances; `poly approve` and `rt.approve(record)`, which refuse an unsigned record, an agent key, a key outside the keyring and a record for another escalation; the M4 limit "approvals without a person-key signature" is removed from the certificate's limits. PD4-A3's signature half is tested here.
2. **The policy front end.** Grammar, AST, checker and formatter for `.policy.poly`; lowering to `polyaxion.policy.json` v2 with the `on unknown` rewrite; poly-ref's PX and translation validation of the lowered policy; stage 5 (admission through Polyaxion) and the policy in the certificate (digest, coverage, `skippedOnUnknown`).
3. **The gate (PT9.3, S146, S147).** A `PolicyGate` that implements M4's gate interface over Polyaxion in process: the proposal becomes a Polyaxion action with the emitting-step snapshot, the read machines' snapshots and the decisions under reserved fields; one session per trust scope; `sseq` and Σ digests on every `verdict` and `settle` event; settle; escalation lifted only by a signed approval; denial reasons and witnesses as PT9.2 states. AC4's policy is the first fixture.
4. **Session replay (S118).** `poly journal replay` replays each session the runs touched, in `sseq` order, and reproduces every decision and Σ digest (AC6's second half). A changed decision or digest is `PL9001`.
5. **The outage test** (section 6).
6. **Consistency and regions (PT8.4, PT8.5, S148, S149).** Stage 5a over polycheck; stage 5b with a minimal conflicting subset; the decision-table check.
7. **Cross-scope sends (PS8.7, PT9.9).** Trust scopes from policies and configurations; `send` proposals; `SendDenied(to, action, reason)` delivered to the sender with its own idempotency key; the configuration check explores the gate's choice (PS4.4).
8. **Operating modes and PD3-A2 (PD4).** `decision("d")` reads, the mode machine, consistency and dischargeability per mode, the escalate-once rule in every mode.
9. **Capabilities (S134, S151).** `targets`; capability objects bound to declared prefixes, names and commands, over host transports.
10. **AC4 and the M5a record.** Gate latency and throughput (section 5), the code review of M5a, the gate from a clean build.

**M5b: identity and the carried host items.**

11. **Claims (PD5.1, S101 to S103, S107, S109).** `claims`, `Principal`, `by`; the `claims-unverified` row; representatives in poly-ref with the count in the instance line; the verifier adapter interface; the person-key adapter, and PD4.2a restated through it.
12. **Lineage (PD5.2, S105).** Carriage (S155), origin classes in check, `SendDenied(…, "lineage")`, `PL6701` (S156).
13. **Revocation (PD5.3, S106).** The `Trust` example, the halt check, the possibility property, `Restore`.
14. **Attributed provenance (PD5.4, S108, S110).** Claims and lineage digests in step events; countersignature records; K11 in PS10.
15. **Initial values (S141, S153).** After E5.
16. **Installed packages (S142, S154).**
17. **The sandbox (PT6.5, S152).**
18. **The M5b record**, review and the gate from a clean build.

## 5. How each gate item is tested

Each test is written first and fails on the tree before its step.

| Gate item | Test | Fails first because |
|---|---|---|
| AC4 | `test/policy-gate.test.mjs`: `orders-irreversible` (PT8.1) compiles and is admitted; the gate denies `payment.charge` on a cancelled order with reason `wrong-state:orders-irreversible`, a witness, and a notary receipt that verifies; a mutant policy without the rule allows it. | No policy front end or gate. |
| AC4, measured | `poly bench gate`: p50 and p99 for propose, settle and the whole PT9.1 to PT9.4 path, and throughput in effects per second for 1, 8 and 64 instances, and for 1, 8 and 64 runs in one session, written to `docs/m5/gate-bench.json` with the machine, Node version and policy. A measurement, reported, with no pass threshold; its harness has a test that runs it at small sizes. | No command. |
| AC6, second half (S118) | `test/session-replay.test.mjs`: two runs sharing a session, interleaved; replay in `sseq` order reproduces every decision and Σ digest; a ledger with one `sseq` swapped, or one Σ digest edited, is `PL9001`. | No `sseq`. |
| Never fails open | Section 6. | The policy gate does not exist. |
| PT12.5 | `test/person-keys.test.mjs`: keys generated per run; an approval signed by a keyring person lifts the escalation and is journaled with the key id; unsigned, agent-signed, unknown-key, wrong-escalation and replayed records are refused with an audit row and leave the intent `Escalated`. | `rt.approve` takes unsigned data. |
| PT8.5 | `test/consistency.test.mjs`: two obligations that together trap a mandate give `PL6501` naming exactly those two (minimal), with a path; each alone is clean. | No stage 5b. |
| PS8.7, PT9.9 | `test/cross-scope.test.mjs`: a send from scope A to B is proposed, denied, not delivered, and `SendDenied` reaches the sender; a send within one scope is not proposed. | No send proposals. |
| PD4-A1 to PD4-A3 | `test/modes.test.mjs`, as PD4.5 states them. | No modes. |
| PD3-A2 | `test/modes.test.mjs`: with `calibrated-for-model`, a new model's gated refund escalates until its fitted map is installed, then is allowed, and its `decision` events name the new map. | No `decision(…)` reads. |
| S134 | `test/capabilities.test.mjs`: a handler's `egress.post` to a declared prefix reaches the host transport; to any other URL it throws before the transport is called; a handler with no egress label gets no `egress`. | Empty capability object. |
| PD5-A1 to PD5-A12 | Section 7. | No claims, lineage or revocation. |
| S141 | `test/config-instances.test.mjs`: a configuration's witness walks through the runtime API from instances created at its initial values; its exported test's header says "runtime API". | E5 is not vendored. |
| S142 | `test/certified-handlers.test.mjs` (extended): a changed file inside an installed package a handler imports is `PL6403` at load. | Packages are named, not hashed. |
| PT6.5 sandbox | `test/sandbox.test.mjs`: the generated OpenShell policy for each effect kind allows exactly its declared prefixes, secrets and commands, deterministically; enforcement is listed as not run where no gateway is available (S152). | No generator. |

## 6. The outage test

`test/gate-outage.test.mjs` runs the M4 outbox corpus and AC4's orders example under the policy gate, with a seeded schedule of injected faults, and replays the whole run through the checks below. Each fault is injected at a seam the gate host owns, so the test needs no engine change.

**Outages injected.**

| # | Fault | Injected as | Expected |
|---|---|---|---|
| O1 | The engine throws on propose | `merge` throws | The intent stays `Proposed` with a backoff (M4 review C6); no handler call. |
| O2 | The engine hangs | `merge` never resolves; the host's propose timeout fires | Treated as O1; the late answer, if it comes, is discarded and journaled as late. |
| O3 | The engine answers `unavailable` | Polyaxion's own class: the store fails, or the policy is unloaded (`unavailable:policy`) | Held, as O1. Never read as allow. |
| O4 | The scope has no policy | `no-procedure:polyaxion:no-policy-in-scope` | Denied, as Polyaxion's closed scopes decide; never allowed. |
| O5 | The verdict cannot be recorded | The ledger write of the `verdict` event throws | The allow is not acted on: the transaction rolls back, the intent stays `Proposed`, and the next proposal is a new `sseq`. |
| O6 | Polyaxion's own journal degrades | `record: 'degraded'` on an allow | Held, as O1: an allow the engine could not journal is not replayable (K6). |
| O7 | A crash between the allow and the handler | The worker is killed after the `allowed` event commits | Recovery takes `HandlerFailed` and retries under the recorded allow, counting the attempt (PT9.7); no handler runs under an allow the chain does not hold. |
| O8 | Settle fails or throws | `settle` throws | Settle is `failed` (M4), the completion is the failure, and Σ is not advanced as if it had succeeded. |
| O9 | The keyring or person-key verifier is unavailable at approval | The keyring read throws | The approval is refused; the intent stays `Escalated` until approved or timed out as a deny. |
| O10 | The claims verifier is unavailable (M5b) | The adapter throws | `claims-unverified`, before the module. |

**How "never fails open" is observed.** The test records every handler call in a log the gate host cannot write, and checks four things over the whole run:

1. **No effect without a recorded allow.** Every handler call is preceded, in the run's chain, by an `allowed` `verdict` event for that intent and attempt, whose `sseq` and Σ digest replay to the same decision (section 5, S118). The count of handler calls during each outage window is 0.
2. **Nothing allowed that the healthy gate would deny.** For each intent held during an outage, the decision taken after recovery equals the decision a fault-free run makes from the same proposal and snapshot.
3. **The machine is followed.** Every intent trace replays through poly-ref against `OutboxIntent` (M4b), so no outage path takes a transition the model lacks (`PL2401`).
4. **Held work resumes.** After the last fault clears, every held intent reaches a terminal state within the backoff bound, which is `settles` observed at runtime.

The fault schedule is a seeded sequence of (fault, start, length), and the test prints the seed and the counts per fault. A failure prints the seed, so it replays.

## 7. PD5's acceptance criteria

One criterion per mechanism ruled in S101 to S113, proposed here as PD5-A1 onward. S100 (the freeze), S111 (wording) and S112 (scheduling) rule no mechanism and get none.

- **PD5-A1 (S101, claims in the label).** An action declared `by caller: Caller` and dispatched with no claims, malformed claims, or a value outside a field's domain is `rejected("claims-unverified")` before the module, journaled, with the state unchanged; a source that writes `reject "claims-unverified"` is `PL1207`.
- **PD5-A2 (S103, S109, finite and opaque).** A `claims` field of type `int`, `string` or `Tri` is `PL1101` or `PL1203`; a `Principal` compared by order, used in arithmetic or turned into a string is `PL1206`, and the same uses by equality, storage or passing are accepted.
- **PD5-A3 (S102, S113, representatives).** poly-ref reproduces `principal_symmetry.py`: the refund example is CLEAN at the default of three representatives (Principal fields plus one), with the count in the instance line, and its reachable states for n = 2, 3, 4 are 7, 13, 21; the self-approval mutant is a finding whose witness requests and approves with one principal; forcing one representative gives `INCONCLUSIVE` (`vacuous`), never CLEAN.
- **PD5-A4 (S104, policies read claims).** A gate proposal carries `claims` and `origin`; `require step.claims.kind == Person else deny` denies a refund emitted by a step with an Agent caller and allows one with a Person caller, and the `verdict` event records the claims digest.
- **PD5-A5 (S105, lineage).** A step started by a completion, a timer or a delivered message inherits its origin and appends one hop; a cross-scope send with a missing or broken chain delivers `SendDenied(to, action, "lineage")`; a configuration with cross-scope sends is checked over origin classes, and its state count is the count with hops removed.
- **PD5-A6 (S106a, the halt is checked).** With the `Trust` machine and its policy, admission proves that no compensable or irreversible effect is allowed while `Halted`; a policy without the halt rule is a finding with a witness.
- **PD5-A7 (S106b, a halt strands nothing).** From every state reachable while `Halted`, every machine can still finish, compensate or escalate; a program whose only way to finish needs an irreversible effect is `PL6501` naming `Halted`.
- **PD5-A8 (S106c, S107, one person mechanism).** The person-key adapter's output for a keyring signature is exactly `{ kind: Person, attest: Verified, assurance: 3, principal: <key owner> }`; `Restore` succeeds with it and is refused with an agent key or none; PD4-A3 passes through the same adapter.
- **PD5-A9 (S108, countersignature).** A countersignature over a head's hash, made by a host adapter, is stored in its own record and checked by `poly journal verify` through the adapter; a tampered one is `PL9002`; without an adapter it is listed as not verified (not run), never as ok; the ed25519 head verifies as before.
- **PD5-A10 (S110, K11).** K11 is in PS10 after K10; a certificate lists K11 exactly when the program declares claims, and the instance line names it.
- **PD5-A11 (PD5.4a, attributed steps).** Every `step` event carries the digest of the claims that admitted it and its lineage digest; `poly journal verify` binds them to the journal row, and replay reproduces them.
- **PD5-A12 (talking point 6, the joint test).** The refund example with a recorded verifier adapter and one injected `CredentialRevoked`: no refund handler runs after the revocation; refunds proposed while halted are denied; after a person's `Restore`, new refunds are allowed again.

## 8. Spec issues

Numbered from S144. Each has a proposal; nothing is built on an issue before it is ruled.

- **S144. Split M5.** *Proposal:* M5a, governance (steps 0 to 10: PT9.3, PT12.5, the policy language, sessions and replay, the outage test, PT8.4 and PT8.5, cross-scope sends, PD4 with PD3-A2, capabilities, AC4), and M5b, identity and the carried host items (steps 11 to 18: PD5, S141, S142, the sandbox). Each closes with its own review and clean gate. PT18's M5 row is split accordingly. *Alternative:* one milestone, one gate at the end.
- **S145. Vendoring a BUSL-1.1 engine.** Polyaxion, polyman and polysec-core are BUSL-1.1; poly's `package.json` says Apache-2.0, and 02 §13 leaves poly's licence open. *Proposal:* the owner rules poly's licence first. If poly stays Apache-2.0, the gate engine is an optional peer dependency resolved from `vendor/polyaxion` in this repository's tests only, and a check that needs it is listed as not run where it is absent (PF's rule for private engines, `01` risks table). *Alternative:* poly takes BUSL-1.1 for the runtime package.
- **S146. What a gate session is, and where `sseq` comes from.** PS11 has a session span runs, and PT9.6a shards only along sessions, but nothing says which runs share one. Polyaxion's sessions are keyed by `run_id`, and its `step` counts only allowed proposals. *Proposal:* one session per trust scope per runtime, keyed `scope:<name>`; the gate host serialises each session, assigns `sseq` on every proposal and settle, and writes `sseq` and Polyaxion's `state_before` digest into each `verdict` and settle event; session replay opens a fresh Polyaxion store and re-applies the session's events in `sseq` order. *Alternative:* a session per run, which drops cross-run policy state.
- **S147. Reading a machine other than the emitter.** PT8.3 makes `machine("m.M")` unknown unless the emitter is an `m.M`, which makes PD4.3's and PD5.3's rules always unknown. *Proposal:* `machine("m.M")` may also name a **singleton** (a configuration instance or a `service machine` with one instance in the runtime); the proposal then carries that instance's latest snapshot and its `seq` at proposal time, recorded in the `verdict` event, so replay and K6 stay exact. Reading a non-singleton machine other than the emitter stays unknown. The lowering puts each read under a reserved action field (`action.$machines["m.M"]`), so Polyaxion needs no change (E6 not needed). PS8.5 gains the singleton case.
- **S148. The minimal conflicting subset and modes.** Polyaxion's m2 check returns trapped states, not a subset. *Proposal:* stage 5b computes the minimal subset by PS8.6's deletion order, calling `checkDischarge` once per deletion, and reports the cost; for PD4.4a and PD4.4b it partially evaluates the policies for each value of each read mode field and runs the check per value.
- **S149. The halt check and the polycheck stage.** polycheck's model is tool actions over coarse effect flags, with no program state; PD5.3.3a needs "in `Halted`". *Proposal:* stage 5a runs polycheck on the regions over the admitted machines' effect labels mapped to polycheck's flags, as PT8.4 says; a separate **decision-table check** in poly-ref evaluates the lowered policies over the finite product of effect kinds and classes, the read machine fields' domains, decision partitions and claims, and proves statements such as "no compensable or irreversible effect is allowed while `Trust.level == Halted`". PD5.3.3a cites the decision-table check instead of polycheck.
- **S150. The signed record of PT12.5.** PT12.5 names the keyrings but no record. *Proposal:* `{ v: 1, kind: "approval" | "acceptance", subject, by: keyId, at, sig }`, ed25519 over `poly-record\n<digest>`, where an approval's subject is the escalated `verdict` event's hash (so a record lifts exactly one escalation, once) and an acceptance's subject is the finding's witness id with the module digest. `poly approve` and `poly accept` write records from a person key given by location (never committed, S126); `rt.approve(record)` verifies them; an accepted finding admits a FINDINGS program and is listed in the certificate's `boundAccepted`. Polyaxion receives the approval as `approved: { by: keyId, ref: intent id }` only after poly has verified it.
- **S151. Capabilities.** *Proposal:* `targets { egress: "<prefix>", …, secrets: […], exec: […] }` in effects, written to the manifest; `load(…, { transports: { egress, secrets, exec, store } })` gives the runtime host functions, and the capability object wraps them with the declared bounds (URL prefix after normalisation, exact secret names, exact commands); a call outside the bounds throws before the transport and is audited. `poly-runtime` still imports no network module.
- **S152. The OpenShell sandbox.** No generator exists, and enforcement needs the OpenShell gateway and Linux 6.2 or later, which this machine lacks. *Proposal:* M5b builds the generator (labels and targets to an OpenShell policy, deterministic, with its own read-back check as a new artefact) and tests it here; the enforcement test runs only where a gateway is configured and is listed as not run elsewhere. *Alternative:* move the sandbox to M6.
- **S153. Instances from a configuration's initial values (S141).** *Proposal:* after E5, `rt.createFrom(configuration)` creates every instance the configuration declares, with its certified initial values and ids `<configuration>.<name>[k]`, and refuses values other than the certified ones; exported configuration witnesses walk through it.
- **S154. Hashing installed packages (S142).** *Proposal:* the handler closure follows bare imports through Node's resolution into `node_modules`, hashes every file it reaches and each package's `package.json`, and certifies them under `packages`; `load` refuses a change (`PL6403`). Package files are hashed, not linted: a package may use `node:fs`, and stopping it is the sandbox's job, which the certificate's limits say.
- **S155. How claims and lineage reach the module and the journal.** The lowered module sees only `data`. *Proposal:* the runtime puts verified claims under a reserved data key `$claims`, which the lowering reads for `by` handlers and which the schema refuses from outside; lineage travels under `$lineage` in effect and message payloads (PD5.2.2d); both are hashed into the `step` event. If polyrun's data validation refuses reserved keys, this goes on the engine list.
- **S156. Where attribution is required (PL6701).** PD5.2.3 says "a labelled scope may require attribution" with no syntax. *Proposal:* `scope "support" requires attribution` in a policy.
- **S157. The evidence script's stale code.** `principal_symmetry.py` prints `PL6702`, renamed `PL1206` by S109. *Proposal:* the owner updates the script's text; PD5-A3 compares numbers and verdicts, not that name.

## 9. Risks

- **Polyaxion is a large engine to vendor**, with three packages and a polygraph dependency. If S145 keeps it out of the repository, every gate test needs the sibling checkout, and CI must say when it is absent.
- **Translation validation of policies** needs a finite proposal space. Policies over open strings (`glob(action.path, …)`) are sampled, not exhausted; such a rule is reported `runtime-only`, as Polyaxion already grades it.
- **The gate's latency** includes SQLite writes per proposal in Polyaxion and in poly's ledger. AC4 reports it; if the in-process figure is far from Polyaxion's 0.63 ms p50, the report names where the time goes.
- **PD5 grows the semantics** (the label, a PS3.2 row, a lemma, K11). It enters 04-semantics in M5b only, after M5a closes.
- **E5 is in polyrun.** Until it is vendored, S141 waits and is listed as waiting.

## 10. Record of M5a

M5a was built as ruled: S144 to S157 (730f672), with the amendments to S147 (b26a27a) and S149 (fabf8fe), PD4-A3 moved to M5b (aad1cad), S160 (e11215e) and S161 (cb26b5c). `main` was merged into `m4` before the build (0a3062c, 0d4e550) and again for S160 and S161 (e02f4b6), never the reverse. Each step has a test that failed before it.

| Step | What was built | Commits |
|---|---|---|
| 0 | Polyaxion as a pinned optional peer (S145): 65 files at c37c60e, hash-checked, listed as not run where absent | d604bee |
| 1 | Signed approvals and acceptances (PT12.5, S150): keyrings certified, `PL6405` at load, `rt.approve`, `poly approve`, `poly accept`, accepted findings in the certificate | a9bc5d6, 6251911 |
| 2 | The policy front end: grammar, typing, `PL6502`, `never` statements (S149 amended), one lowered document per scope, admission, translation validation against the engine, three broken lowerings listed | f902583, 2d95025 |
| 3 | OutboxIntent gains `Recheck` (S147 amended): 17m + 8 states, 59 at bound 3 and 178 at 10, checked at every bound; the gate in process with sessions, `sseq`, singletons and held verdicts | c9beea2, 2149c43, 56d991a |
| 4 | Session replay in `sseq` order (S118, AC6) | 128557c |
| 5 | The outage test (section 6) | 4923320 |
| 6 | Consistency with a minimal subset (S148); polycheck pinned at 678b120 and run as stage 5a (S161) | 5762119, 39cec17 |
| 7 | Trust scopes from modules and configurations; cross-scope sends proposed, `SendDenied` (S160) | f5ef52c, b9455c3 |
| 8 | Operating modes and the fitted map (PD4, PD3-A2); consistency per mode | 8049488 |
| 9 | Capabilities bound to declared targets, every redirect hop checked (S134, S151) | b931652 |
| 10 | `poly bench gate` and `docs/m5/gate-bench.json` (AC4, PT9.6) | 3db54e8 |

**The gate, item by item.**

| Item | Status | Measured |
|---|---|---|
| AC4 | **passes** | `orders-irreversible` compiles and is admitted; the gate denies `payment.charge` on a cancelled order with `wrong-state:orders-irreversible`, a witness and a notary receipt that verifies; a mutant policy without the rule allows it. |
| AC4, measured | **reported** | Propose p50 0.67 ms and p99 16.0 ms, settle p50 0.52 ms, the whole path p50 5.2 ms (146 proposals); 112 effects per second with no policy and 90 in the one session at 64 instances. Throughput is bound by the runtime's steps and SQLite writes, which the no-policy baseline shows. No threshold. |
| AC6, second half | **passes** | Two runs share a session; replay in `sseq` order reproduces every decision and Σ digest; a swapped `sseq` or an edited digest is `PL9001`; a missing `sseq`, in the middle or at the end, is listed as not run. |
| Never fails open | **passes** | The seeded schedule (seed 20261002) injects O1, O2, O3, O6 and O8 for 3, 4, 6, 5 and 5 passes over 90 handler calls; no allow is recorded in an outage pass, no handler runs without a prior allow, every order ends as in the fault-free run, every intent trace replays through OutboxIntent, and the session replays its 164 proposals (two of them late answers to O2) and 72 settles with no diagnostic. O4, O5, O7 and O9 are separate tests. O10 is M5b's. |
| PT12.5 | **passes** | An approval signed by a keyring person lifts the escalation and is journaled with the key id; unsigned, agent-signed, unknown-key, wrong-kind, other-escalation, forged, replayed, earlier-escalation and late records are refused with an audit row, and the intent stays `Escalated` or is denied at its timeout. |
| PT8.5 | **passes** | Two obligations that trap a mandate give `PL6501` naming exactly them, with a path and the number of discharge checks; each alone is clean; a trap set by another machine's guard is found; an escalation is not a deny on the way. |
| PS8.7, PT9.9 | **passes, with the M5a limit S160 states** | An injected message from scope A to B is proposed once, denied, marked dead, not delivered, and `SendDenied` reaches the sender; a retried delivery goes under its recorded allow; a send within one scope is not proposed; the configuration check explores allow, deny and escalate. |
| PD4-A1, PD4-A2 | **pass** | A refund at 0.91 is allowed in Normal and escalated in Crisis, and the verdict records the mode; a policy that traps the refund flow in Crisis is `PL6501` naming Crisis. PD4-A3 is M5b's. |
| PD3-A2 | **passes** | With a map fitted for another model the gated refund escalates; with one fitted for the reported model it is allowed, and the decision event names the new map. |
| S134 | **passes** | `egress.post` to the declared prefix reaches the transport; thirteen escapes and two redirects out of bounds throw before it with a `PL6406` audit row; a handler with no egress label gets no `egress`; `poly-runtime` imports no network module. |
| S161 | **passes** | The trifecta with no gate is `PL7001` with its path; with its egress gated it is clean; a kind named only with `!=` or in a `never` is not gated. |

**Raised during the build.**
- **S158.** Polyaxion reports an escalate rule before a guard's deny, against PS8.3. The host asks the engine's own interpreter, with the escalations lifted, whether a deny stands behind, and decides deny when one does. Engine change **E7** would let Polyaxion do it.
- **S159.** PT8.1's Claude Code vocabulary (`action.path`, `glob`, `history`) is not in M5a's surface.
- **E8** (new, for the owner's list). Polyaxion's m2 check explores one machine at a time and counts an escalation as a deny. poly's consistency stage is now poly-ref's (review B3, B9), so the findings follow PS8.6, but the engine still refuses to serve a scope whose only discharging path is escalated; the refusal is `PL6001` and says so.

**Limits, stated.** A send's escalation has no approval path in M5a, so it is denied with a reason that says so. No program makes a cross-scope send at run time before S153 (E5): the runtime path is tested with a message injected below the language, and M5b adds the end-to-end test. PD4-A3, a signed `Declare`, is M5b's. Capabilities are bound in-process; what keeps a handler from reaching around them is the lint, until the sandbox (S152), and the certificate's limits say so.

### The code review of M5a

Four reviewers read `d604bee..3db54e8` in four parts (peers, records and loading; the policy front end and its static checks; the gate at run time; sends, modes, capabilities and the bench), and each reproduced every finding with a script under `.poly/review-m5-a` to `review-m5-d`. They found 27. Polywatch found two more: a `never` over an open decision answer was proved (4eb6c2c), and a `never` whose forbidden proposal is only escalated was clean (6598736). Each finding was fixed with a test that failed first, except B13.

| Part | High | Medium | Low |
|---|---|---|---|
| A, peers, records, loading | 1 (a replayed approval lifts a later escalation of the same intent) | 2 (an installed polysec-core shadows the pinned one; a private key is certified as a keyring's public key) | 2 (an agent key listed again as a person's; the pin tests pass when the peer differs) |
| B, policy front end and checks | 4 (a `never` violated after an approved escalation is proved; a `never` over `model.id` is proved; consistency ignores other machines' guards; consistency stops at 400 table rows) | 5 (a rule over a string field passes translation validation on its unknown case; misspelt kinds, classes and labels pass; two matching transitions are a toolchain fault; `PL6302` is not built; an escalation counts as a deny in the discharge check) | 4 (a kind named with `!=` or in a `never` counts as gated; a bounded discharge check is clean; a transition reading only a var ends the stage in ERROR; comments inside an obligation body move after it) |
| C, the gate at run time | none | 3 (a timed-out engine call still decides and moves Σ, unrecorded; an approval after the escalation timeout is accepted; the replayed approval of part A) | 1 (a missing last `sseq` replays clean; settled events carry no Σ) |
| D, sends, modes, capabilities, bench | 1 (a denied cross-scope message is never marked dead and is proposed on every pass) | 1 (a retried delivery is proposed again) | 3 (a prefix with dot segments binds wider than it reads; encoded slashes and `..;` pass the prefix; the send proposal has no payload digest) |

| Findings | Fix | Commit |
|---|---|---|
| A1, C2, C3 | a record must name the intent's current escalation and not be used before; an approval at or past the escalation's deadline is refused | aee9baf |
| D1, D2, D5 | a message has one gate decision: a recorded allow delivers, a recorded deny finishes, and a deny marks the pending row dead; the proposal carries the target instance and the payload digest | 42a8702 |
| C1, C4 | a timed-out call stays the session's outstanding call, and the session takes nothing until it answers; the late answer is recorded with its own `sseq`; replay checks the session's counter and Σ after decisions and settles | a0e2184 |
| A3, A4 | keyrings certify the parsed SPKI only, refuse private keys, and refuse one key under two ids | 8ad307d |
| A2, A5 | a peer whose polysec-core package is not the pinned directory is refused; a present peer that differs fails the pin test | 96afa7a |
| D3, D4 | egress prefixes are written as parsed; encoded separators and `..;` segments are refused; a 303 drops the body's headers | 0f6bc42 |
| B1, B3, B4, B9, B11 | consistency is poly-ref's, over the policy machines together and the whole table, with approved escalations; the `never` check and translation validation follow approvals; a bounded check is listed | 3020799 |
| B2, B5 | the table takes the model ids the policies name and each field's check domain; a rule over an open value is runtime-only | 41004dc |
| B6 | strings compared with kinds, classes, machines and labels are checked | 819e65d |
| B7, B12 | transitions lowered so the engine takes the first match, each with the proposal conjunct | b308221 |
| B8, B10 | `PL6302` built; only `==` and `in` in obligations gate a kind; a scope with only `never` statements is refused with a reason | 69031c9 |
| C2 (follow-up) | the M4 race test approved past the deadline, which C2 now refuses; its approval now arrives before the deadline and commits after the pass reads, the race the model settles | 144137e |
| B13 | **not fixed.** Policy expressions are not trivia nodes, so a comment inside an obligation body prints after it. The AST is unchanged and the output is idempotent. Proposed for M5b with the embedded surface's policy form. | |

**The gate, from a clean build.** Every `dist` directory, build-info file and test build directory was removed; `npm test` built, ran the boundary check (passed) and ran 1247 tests: 1243 pass, 0 fail, and 4 are listed as waiting (the archive trace on E1, polyflow's verifier on E2, M3's references on FROZEN, and outage O10, the claims verifier, which is M5b's).

M5a is ready to close. M5b does not start before the owner closes it.

## 11. Record of M5b

The owner closed M5a at 038fe86 (bea38eb), put E8 on the engine list and moved B13 to M5b. `main` was merged into `m4` before the build (6fcd331), never the reverse. Steps 11 to 18 were built as ruled, each with a test that failed before it, except where noted below.

| Step | What was built | Commits |
|---|---|---|
| 11 | Claims (PD5.1): `claims` types, `Principal`, `by` on both surfaces, `PL1206`; the claims row of the label in poly-ref and the lowering, with the broken lowering `skip-claims` listed; principal representatives with the count in the instance line (PS4.1c); the verifier adapter at dispatch and create, the person-key adapter by default, and PD4-A3's signed `Declare` through it; `step.claims` in policies; `$claims` and `$lineage` reserved (`PL1208`) | 261649d, c82c3fd, 33faea9, 32fcc0e, d6c638d |
| 12 | Lineage (PD5.2): each step's origin, intent and hop in `poly_lineage`, inherited from the causing completion, message or timer; `SendDenied(…, "lineage")` for a missing or broken chain; `lineage.origin` and `lineage.intent` in policies; `scope "x" requires attribution` and `PL6701` (S156); configurations checked over origin classes | 696fdb3, 92d0b95, 4b0c024 |
| 13 | Revocation (PD5.3): the `Trust` fixture, the halt `never`, the possibility check, `Restore` through the person-key adapter, the joint test | d45830d |
| 14 | Attributed provenance (PD5.4): claims and lineage digests in every `step` event, bound by `poly journal verify` and replay; countersignature records through a host adapter (`--countersign`); K11 in PS10 | 5d28008 |
| 15 | Initial values (S141, S153): listed as waiting on E5, with S160's end-to-end send | 62c1ce5 |
| 16 | Installed packages (S154): the closure follows bare imports into `node_modules`; every file reached and each `package.json` certified under `packageFiles`; `PL6403` at load | cda672e |
| 17 | The sandbox (PT6.5, S152): `openshell.policies.yaml` per machine under `isolation: "openshell"`, certified and read back, with the broken generator `widen-sandbox` listed | 2344717 |
| 18 | B13, the review, and this record | bbe7ad9 and the fixes below |
| | Outage O10: a verifier that throws gives no claims, so `claims-unverified` before the module | 40f26d6 |

**Confirmation tests and their controls (de66918).** PD5-A3 and PD5-A6, A7, A8 (Restore) and A12 could not fail first: the evidence script printed A3's numbers before the build, and the others were met by machinery steps 11 and 12 and M5a had already built. They are confirmation tests, labelled so in their names. Each property is a function that the confirmation test runs on the fixture and a seeded control runs on a mutant that breaks it; the control passes only when the same assertions fail, with the message named below (89b964f).

| Test | Mutant | How the test fails on it |
|---|---|---|
| PD5-A3 | the refund example's self-approval require replaced by `caller.kind == Person`, so the approver may be the requester | the default check is not CLEAN: `PL3001` on `not-self-approved` |
| PD5-A6 | the halt rule stops effects in `Restricted` instead of `Halted` (the `never` statement unchanged) | the halt is not proved: `PL6503` |
| PD5-A7 | the way out is `compensable`, so the halt stops it too | the halt strands the mandate: `PL6501` in mode `Halted` |
| PD5-A8 (Restore) | `Restore` takes no claims (`by op: Caller` and its requires removed) | a `Restore` with no credentials is accepted, not `claims-unverified` |
| PD5-A12 | `CredentialRevoked` sets `Restricted` instead of `Halted` | the refund handler runs again after the revocation |

**The gate, item by item.**

| Item | Status | Measured |
|---|---|---|
| PD5-A1 | **passes** | No claims, malformed claims, or a value outside a field's domain is `rejected("claims-unverified")` before the module, journaled, state unchanged; `reject "claims-unverified"` in a source is `PL1207`. |
| PD5-A2 | **passes** | `int` or `string` claims fields are `PL1101`, `Tri` is `PL1203`, bool, record, map, payload union and nested claims are `PL1201`; ordering, arithmetic, string comparison and a map key over `Principal` are `PL1206`; equality, storage and passing are accepted. |
| PD5-A3 | **passes** | The refund example is CLEAN at 3 representatives, named in the instance line; 7, 13 and 21 states at 2, 3 and 4, as `principal_symmetry.py` prints; the self-approval mutant is a finding with one principal; one representative is `INCONCLUSIVE` (`vacuous`). |
| PD5-A4 | **passes** | `require step.claims.kind == Person else deny` denies an Agent caller's refund and allows a Person's; the `verdict` event records the claims digest. |
| PD5-A5 | **passes** | Completions, timers and delivered messages inherit origin and append a hop; an outside dispatch never inherits; a broken or missing chain on a cross-scope send gives `SendDenied(…, "lineage")`; a configuration is checked over origin classes. |
| PD5-A6, A7 | **pass** | No compensable or irreversible effect is allowed while `Halted`; a policy without the halt rule is a finding with a witness; a program that needs an irreversible effect to finish is `PL6501` naming `Halted`. |
| PD5-A8 | **passes** | The adapter's output for a keyring signature is exactly `{ kind: Person, attest: Verified, assurance: 3, principal }`; `Restore` succeeds with it and is refused with an agent key or none; PD4-A3 passes through the same adapter. |
| PD5-A9 | **passes** | A countersignature over a head is stored in its own record and checked through the adapter; a tampered one is `PL9002`; with no adapter it is listed as not verified. |
| PD5-A10 | **passes** | K11 follows K10 in PS10; a certificate lists it exactly when actions take claims, and the composition stage keeps it. |
| PD5-A11 | **passes** | Every `step` event carries the claims and lineage digests; `poly journal verify` and `rt.verifyRun` bind them, and replay reproduces them. |
| PD5-A12 | **passes** | With a recorded verifier composed with the person-key adapter and one `CredentialRevoked`: no refund handler runs after the revocation, refunds while halted are denied, and after a person's `Restore` new refunds are allowed. |
| PD4-A3 | **passes** | A signed `Declare` (`by op: Caller`) changes the mode; an agent key or none is `claims-unverified`. |
| S154 | **passes** | A changed file in an installed package is `PL6403` at load; a test traces every file Node loads and requires each to be certified. |
| S152 | **passes, enforcement not run** | The policy per effect kind allows exactly its declared prefixes and secrets, deterministically, and gives a kind with no egress label no network; enforcement is listed as not run (no `POLY_OPENSHELL_GATEWAY`). |
| O10 | **passes** | A verifier that throws gives no claims: `claims-unverified`, before the module, and no effect. |
| S141, S153 | **waiting on E5** | Listed as `todo`, with S160's end-to-end send. |

**Limits, stated.**
- A configuration's completion given as a declared input has no origin class. No verdict reads it today.
- A child created in a cascade starts its own chain, so it does not inherit its creator's origin (PT2.4d).
- The sandbox policy is generated, certified and read back, and not enforced by this runtime; the certificate's limits say so. OpenShell has no per-command allowlist, so `exec` targets stay bound in process.
- **No embedded policy form** (de66918). PT1.1a stands: policies live in `.policy.poly` files only, and B13 is fixed in the standalone formatter.

### The code review of M5b

Four reviewers read `261649d..2344717` in four parts (claims and representatives; lineage, provenance and K11; policies over identity; packages, the sandbox and B13), and each reproduced every finding with a script under `.poly/review-m5b-a` to `review-m5b-d`. They found 22, and an inspection note. Each was fixed with a test that failed first, except the two recorded as limits above.

| Findings | What was wrong | Fix | Commit |
|---|---|---|---|
| B1 | `rt.create` with a creation action skipped dispatch's checks, so its `$claims` and origin were the caller's | a creation is an outside dispatch: claims from the verifier, `$claims` and `$lineage` refused | be1ea3b |
| B2 (= A-F1) | an exported witness with claims passed `$claims` as data, was refused, and read that as the path being gone | the walk hands the witness's claims to its verifier | be1ea3b |
| B3, B4 | the composition stage dropped K11; `verifyLineage` did not check inheritance from the previous hop | K11 kept; a hop that does not inherit is a broken chain; `rt.verifyRun` binds the lineage digest | be1ea3b |
| A-F2 | sam-pattern runs the handler's acceptor after the first rejects, so a body matching on claims ran on none | the handler's acceptor applies the claims row first | f219d4d |
| A-F3, A-F4 | a map of principals counted once, and a label with two principals counted one, so CLEAN on reachable violations | one position per key, plus the most principals one label carries | f219d4d |
| A-F5 to A-F7 | bool, record, map, payload-union and nested claims fields crashed the lowering; poly-ref's row was looser than the lowered one; a binder could be `pre` or `self` | refused as `PL1201`; one strict row; translation validation probes past ranges, null and wrong forms | f219d4d |
| C2 | a whole-record read of `step.claims` or `lineage.origin` gave a table without them, so a violated `never` was proved | such a read reads every field | cb39299 |
| C3 | a claims field declared with two types was typed by declaration order | reading it is `PL1201` naming both | cb39299 |
| C4 | the attribution rule took its examples from an author's obligation named `attribution` | its source is `$attribution` | cb39299 |
| C1 | `PL6701` missed an outside dispatch of a completion or a timer's target | S162, ruled in e60a24b: in a scope that requires attribution the runtime refuses it before any step, with an audit row, as K9 and K10 refuse theirs; the manifest names timer targets, read back, with the fault `drop-timer-target` | 75772cd |
| C5 | a configuration's completion input has no origin class | a limit, accepted in e60a24b | cb39299 |
| D-F3 | the package closure missed conditions, subpath patterns, the imports map, `.json` and a directory's main, and dropped unresolved imports | each followed; unresolved imports listed in the limits | 109a521 |
| D-F4 | the runtime imports the handlers' copy, so a bare import could resolve to an uncertified package | certified package files are copied beside it and re-checked | 109a521 |
| D-F5 | a certificate with sandbox policies implied they were enforced | its limits say they are not (not run) | 109a521 |
| D-F1 | a composed child was lowered again without isolation and lost its policy; TV checked the policy only when present | the child keeps it; under isolation a missing policy is a mismatch | 51b4a62, f145696 |
| D-F2 | a glob character in an egress target became a pattern in the sandbox | `PL1201` | 51b4a62, f145696 |
| D-F6 | B13 left comments on `on unknown`, `states`, `initial` and `end` lines misplaced | those lines are anchors too | af1f7b3 |
| D, inspection | the certificate read-back compared handler files but not package files | read back, with the listed fault `omit-package-file` | 525f993 |

**Polywatch on the M5b fixes.** Ten findings across its two reviews of M5b, each checked against the code (outcomes recorded):

| Finding | Verdict | Resolution |
|---|---|---|
| a package Node resolves from above the project ran from the original file | real | copied under a deeper copy root and re-checked before import (cbfd2c2) |
| a handler's `#…` specifier was refused as a missing package | real | refused with its reason: the imports map resolves to the originals, not the copy (cbfd2c2) |
| comments on claims fields moved below the declaration | real | fields are comment anchors (c2c4abd) |
| a claims field named `constructor` was a conflict with a type named undefined | real | the table has no prototype (6cfb5f4) |
| a `by` binder named `$claims` passed check on the embedded surface | real | `PL1208` (6cfb5f4) |
| the embedded reader cannot read `claims` or `by` | false | it reads both; `refund.poly` round-trips |
| package files not copied; claims field with two types; subpath patterns | real | already fixed by the review (109a521, cb39299) |
| a cascade child starts its own chain | real | a stated limit, accepted in e60a24b |

**B13.** Comments inside an obligation body now keep their place: the parser anchors them to each body line, and the formatter prints them there and keeps the output idempotent (bbe7ad9, af1f7b3).

**Found by the gate.** The first clean run failed one test: after A-F2 put the claims row in the handler's acceptor too, the broken lowering `skip-claims` removed only the first copy and changed nothing on `refund.poly`. The fault now drops both (ec19eae), and translation validation catches it again.

**The gate, from a clean build.** At 09a7042: 1322 tests, 1317 pass, 0 fail, 1 skipped (sandbox enforcement, no gateway), 4 waiting (S141 and S153 on E5, S160's end-to-end send on E5, the archive trace on E1, polyflow's verifier on E2). Rerun once at 89b964f, after `main` was merged in (9c6fbef), S162, the controls and the polywatch fixes: every `dist` directory, build-info file and test build directory was removed; `npm test` built, ran the boundary check (passed) and ran 1379 tests: 1373 pass, 1 fail, 1 skipped (the same), 4 waiting (the same). The failure is `test/m3-runner.test.mjs`, "a real run is refused until the freeze is approved", which came in with `main`: it spawns the M3 runner and expects the freeze gate to refuse, but the runner's isolation check refuses first, because the isolated account `~/.poly-m3/claude` now holds `plugins` and `skills` directories (created 2026-10-02 at 14:25, outside this build). The test depends on the machine's M3 account, not on M5b's code; nothing here touches it, and the account is the owner's to clean.

**The M3 account, taken out of the gate.** The M3 session removed the folders (f80952e), and `main` was merged again (a71b412). The gate now gives the same answer whatever the account holds: `test/m3-runner.test.mjs` loads the runner with a home folder it creates (`test/m3-home.mjs`), and `test/account-independence.test.mjs` runs every test file that loads the runner against a refused stand-in account and against none. Each failed first (de4d137, 92b50c4). Polywatch's four findings on these tests were real and are fixed: a hung run had no timeout, and now is killed after ten minutes (92b50c4); the kill ended only the test runner, and now ends every process it started (a7a7c76); a run's exit status was ignored, and now must be 0 (92b50c4); and the runner test itself ran under the owner's home, and now uses the stand-in (92b50c4).

**S163, the M3 run programs.** The merge brought 1,130 programs the arms wrote, 712 distinct, under `experiments/m3/runs/`, and the standing test then checked 1,438 sources. A first rerun was stopped after 30 minutes with that test unfinished. It was not a stall: checked one after another in one process on an otherwise idle machine, the 1,130 run programs take about 2,012 s (about 33 minutes) and the other sources about 3 minutes. S163 rules the run programs outside the standing tests as frozen experiment evidence; `test/standing.test.mjs` names `experiments/m3/runs/` as its only exception, and a test that failed first requires the list to be exactly that path and every other `.poly` file to stay covered (1d1de30). An earlier figure of "about 7 minutes" for one program was a misreading of build-folder timestamps and did not reproduce.

**Open findings for M6, not fixed in M5b.**
- *Checker performance.* Over the 712 distinct run programs, measured: mean 1.4 s, median 0.19 s; 31 programs over 10 s; the slowest, `experiments/m3/runs/T9-arm3-run4/deliveries/v3/src/system.poly` (5,645 bytes, 120 lines), took 53 s.
- *Memory.* In the stopped gate, the one process that checked 1,438 files in a row grew to 2.9 GB. It may be a leak per file checked. It is unexplained, and M6 measures it.

**Gate times.** Before `main` was merged, the whole gate took 385 s. The standing test now runs alone in 185 s (310 tests).

**The gate, from a clean build, at f56ca18.** Every `dist` directory, build-info file and test build directory was removed; `npm test` built, ran the boundary check (passed) and ran 1376 tests: 1371 pass, 0 fail, 1 skipped (sandbox enforcement, no gateway), 4 waiting (S141 and S153 on E5, S160's end-to-end send on E5, the archive trace on E1, polyflow's verifier on E2). The run took 10 min 28 s from start to end (the test runner's own figure, 604 s).

M5b is closed: S162 is built, the controls are shown to fail their tests, polywatch's findings are resolved, and the gate is green from a clean build. With it, M5 is closed.

## Conclusion

M5 turns M4's gate interface into a governed gate. Policies get a front end and a checked lowering. Polyaxion decides in process, with a session sequence and state digests that make every decision replayable, and approvals are signed by people. The outage test shows by its log, not by assertion, that no effect runs without a recorded allow. Polyaxion needs no change if program-state reads are carried as reserved action fields, and polyrun needs one, for instances started at given values. Identity follows in M5b, on top of the gate and the signatures, with twelve acceptance criteria drawn from the PD5 rulings. Fourteen issues need rulings before the build, and the first two decide its shape: whether M5 is split (S144), and whether a BUSL engine can be vendored (S145). M5a is built as ruled, reviewed, clean from a clean build, and closed (section 10). M5b is built as ruled except S141 and S153, which wait on E5, with S162 built and each confirmation test controlled by a mutant it catches (section 11). M5b and M5 are closed.
