# poly · Decisions for milestone M8

*Cognitive Fab · October 2026 · the owner's rulings on `plan-m8.md`, given on 2026-10-05 and recorded on branch `m4`*

## The plan's issues, S173 to S187

Each ruling is copied exactly as written under its issue in `plan-m8.md` section 7.

| Issue | Ruling |
|---|---|
| **S173** How a work order runs on `poly-runtime` | Accepted, with two additions. (1) PF8.5a holds: once the gate allows a work order, a retry re-issues the same order id and is never proposed again; a report against a superseded attempt is refused and audited, so an agent is never credited twice. (2) A work order's completion actions are delivered by the runtime only (K9): `workflow_signal` cannot dispatch them, and an attempt is refused and audited. |
| **S174** Who serves the workflow tools | Accepted, with conditions. `poly run --mcp` takes the ledger key only from the configured signer, never from a tool argument or the environment. It serves no approve or accept tool (PT12.5). It never logs or records the environment. |
| **S175** What is left of polyflow | Accepted. `PL6804` stays, for the reason given. E9 is withdrawn. |
| **S176** `use` | Accepted, in general: a project's own modules plus `std.*`. Imports across projects stay out of v1 (PT1.3). After the change, every conformance case, example and evidence script is checked again and must give the same verdicts and state counts. |
| **S177** Linking an application instance and its conversation | Accepted. The child key is fixed by the compiler, never built from an ingress string. If `channel:<name>` is not a key the checker already accepts, use a form it does accept and say which. |
| **S178** Conversation rules as checked properties | Accepted, semantics first: the PS5.2 extension is written into `04-semantics.md` and ruled before any code. Each `never` statement has a seeded control that must fail, and translation validation covers the lowering. |
| **S179** Reply on rejection (Q1) | Accepted. Q1 is closed. |
| **S180** `Content` | Accepted, with the PS section written and ruled before poly-ref's code. |
| **S181** The taint class before M10 | The alternative is taken: no taint in M8. Taint and audiences arrive together in M10. In M8 the proposal carries the `channel` field only, and AC14 to AC17 need no taint. |
| **S182** Runtime adapters, and where network code lives | Accepted. In addition, `poly-io` imports no check package; it may import `poly-runtime`'s runtime adapter interface only. The boundary check enforces both directions. |
| **S183** Reference providers (Q5), and recorded traffic | Accepted, with this provider list. Only recorded traffic enters the tests; test secrets are generated inside each test and never written to disk. A live run on a real account is the owner's demonstration. No test or gate sends a real message. |
| **S184** Keyed send counters | Accepted. E11 is not needed in M8. |
| **S185** Policies over the new proposal fields | Accepted without `effect.taint` (S181): the policy front end types `effect.channel.*` only in M8. |
| **S186** The embedded form of a channel | Accepted. |
| **S187** Split M8 | Accepted. M8a closes (review, record, and a clean gate on a quiet machine, compared file by file with M6's closing gate) before M8b starts. |

## S173 amended: an order id per attempt

**Ruled after step 1 (2026-10-05).** Addition (1) of the S173 ruling is amended. Where it said a retry re-issues "the same order id", read "the same intent, under a new order id per attempt".

- The gate's decision stays bound to the intent, once (PF8.5a), and a retry is never proposed again.
- Each issued attempt gets its own order id, derived from the intent and the attempt number. Agents treat it as opaque.
- `workflow_report` keeps polyflow's schema and names only `order_id`. The order id identifies the attempt, so a report from an agent working on an attempt that has since been replaced is refused and audited by its order id.

Neither option of the question raised at step 1 is taken: a report does not carry an attempt, and a report without one is not taken as the open attempt's.

## S188 and S189, raised at step 2

**Step 2, part one, and the polywatch fix: accepted.** The fifth seeded fault (a second start creating the run again) is reasoned correctly, and the added check that attaching takes no step closes it.

**S188 accepted, with three conditions.** `poly.json` gains a `run` field with the certificate path, the store, trust as admission public keys only, and an optional ledger signer.

- **Signer location.** The signer is `file:` only, and its path must resolve outside the project directory. A key file inside the repository is refused at load, because a key inside the tree is one `git add` away from being committed. That refusal is tested first.
- **Never echoed.** The signer's path may appear in errors. Its contents never appear in output, logs or the journal.
- **Schema.** `run` gets a published schema, and a `poly.json` with an unknown field under `run` is refused, as PT1.2 intends.

**S189 accepted, as a drop folder, with five conditions.**

- **Location.** The folder is set in the `run` field. By default it lives outside `.poly/`, so `npm run clean` can never delete a pending approval.
- **Signature and match.** Each record is verified against the certified keyring and must match an open escalation (intent and sseq), as PT9.2 requires. An agent can drop a file but cannot sign one with a person key (PF9.6).
- **Single use.** A record applied once is refused if it appears again, even under a new file name. A record that arrives after its escalation timed out is refused with the reason `expired`.
- **Order and journal.** Records are taken in a fixed order (by file name) at a fixed interval, not through filesystem events. Every application and every refusal is journaled, so replay reproduces them.
- **Outcome.** Each record is moved to `applied/`, or to `refused/` with the reason in a sidecar file.

Tests come first for the replay, expired, unmatched and wrong-key cases, and a seeded fault that skips the single-use check must be caught. Then step 2 is finished: the command, its `install.json` entry and the boundary allowlist.

## Step 2 accepted, and the stale store lock

**Step 2 accepted (2026-10-05).** A server that crashes leaves its lock file behind, so the case is handled explicitly: a lock held by a running process is refused, as before; one whose process is not running is taken over, and the takeover is journaled with the old process id. Process ids are reused on Windows, so a matching id with a different start time is stale.

**Ruled on the mechanism.** Reading another process's start time on Windows needs a subprocess, which boundary rule 4 bars outside poly-new. The owner chose an OS-held lock, with three additions:

- The decision always comes from the OS lock (an exclusive SQLite lock on `<store>.lock.db`, held for the owner's life and released by the OS when its process ends), never from the lock file. The lock file is information only: it records the process id and start time for the journal and the error text.
- A takeover is journaled with the old process id and start time.
- OS file locks are unreliable on network shares, so "the store must be on a local disk" is a limit in the record.

Tests first: a live lock, a stale lock and a reused id. Seeded faults: one that takes over a live lock, and one that decides from the lock file instead of the OS lock, which the reused-id test must catch.

## S176 in detail, ruled

**Ruled (2026-10-05).** PS1.0 is written into `04-semantics.md` as proposed.

- **Semantics (PS1.0): accepted.** `use` only makes names available and adds no behaviour. A test must show that adding an unused `use` changes no verdict and no state count.
- **Qualified names only: accepted.** Agents get one spelling per machine, with no alias to resolve.
- **Attached spawns across modules** stay `PL0901`.
- **Types across modules: accepted for M8a, with a recorded gap.** M8b will need enums declared in a std module to cross the boundary: PT21.3's conversation takes `name: Template`, and channel kinds are enums. This is the next S issue (S190), with a proposal to allow payload-free enums from a used module, resolved before M8b's step 6, not now.
- **Finding modules: accepted, with two clarifications.**
  - *A search path only.* For a lone file, its directory is only searched. Only the modules named by `use` are read, and every other file in the directory is ignored. Tested with a directory holding an unrelated broken file: the result must not change.
  - *Duplicate modules.* If two files declare the same module name, the check is refused with a named code, never resolved by picking one. Cycles are allowed.

**S190, open: enums across modules.** Raised at this ruling, with its proposal in `plan-m8.md` section 7: a payload-free enum declared in a used module (a std module's `Template`, a channel kind) may be named and carried across the boundary. To be resolved before M8b's step 6, not in M8a.

Then step 3 is built, the 143 files and the evidence tests are measured again, and any difference goes to the owner before the commit.

**Polywatch on the store lock (4cdd00e).** Four findings, all real: a lock file that could not be written, an approvals path that is a file, and a failing takeover entry each left the OS lock held; a load that failed after finding a stale lock lost the stale owner's record. Each is fixed, two with tests that failed first.

## S180 in detail, ruled

**Accepted (2026-10-05).** The text is written into `04-semantics.md` first (PS1.4a, the `content-missing` row of PS3.2, PS4.1f), with three precisions:

- **Representatives.** PD5's rule for `Principal`, applied to `Content` separately: the number of `Content` positions and parameters in scope plus one, never fewer than two, plus `none`. With two `Content` values compared for equality, two representatives are needed to show all the cases. The verdict prints both counts in its instance.
- **No literals.** The only constant of type `Content` is `none`. A digest written in source is `PL1209`. A body enters only at run time, through ingress or the store.
- **Missing body.** A `Content` that names no body in the store is rejected before the module with a reserved reason, `content-missing`, added to `PL1207`'s list and to PS3.2's table beside `claims-unverified`. The step is journaled and the state is unchanged.

Out of M8a, as proposed: taint, channels, and any decision that reads a body. Tests first, then the code, with seeded faults for: a digest literal accepted; arithmetic or ordering on `Content` accepted; a missing body reaching the module; one representative used where two `Content` values are compared.

The lemma is written as PS4.1f, since PS4.1d already names the unconstrained environment (and PS4.1c is used twice, by the principals' lemma and by Polytrion worlds; that earlier clash is left as it is, for the owner).

## Step 4 accepted: the row order of PS3.2, and a test defect under parallel load

**Ruled (2026-10-05).** The `content-missing` row moves after `a ∉ dom(H)`: an action with no handler is `unhandled` whatever its data, so the text, poly-ref and polyrun agree. The change to PS3.2 is written into `04-semantics.md` first (52179de). The claims row had the same place and moves in the same edit. It could never apply to an unhandled action, since claims are bound by a handler's `by c: C`, so its move changes no step.

**The blind spot.** Translation validation probed the content row only on handled actions, and check never offers a missing body, so a difference between R_M and the runtime on an unhandled action with a missing body was seen nowhere. The probe now covers every action that carries a Content. The claims probe already covered every action with claims, all of them handled. A seeded broken lowering of the old order, `content-before-unhandled`, is in the explicit list of toolchain faults, and the extended check catches it. It does not fail first against the old validation, and cannot: a lowering can answer a missing body only by putting the action in the module's surface, and then the ordinary transition comparison sees the module accept what R_M answers `unhandled` (measured: 5 mismatches with the extended probe, 4 with the old one). What failed first is poly-ref's old order under the extended probe: `conformance/m8/content/unhandled.poly` gave `PL2501` ("the lowered module gives unhandled, R_M gives rejected(content-missing)"), and the old probe let it pass. The runtime already answered `unhandled`, since it marks a missing body only for an action its contract lists.

**A test defect under parallel load.** `test/m3-isolation.test.mjs`, "markers in the owner's own CLAUDE.md, settings and skills never reach the arm", failed once in the full suite (1,534 tests) with `EPERM` when deleting its temporary home, and passed alone. Reproduced: a folder that a running child process has as its working folder cannot be deleted on Windows (`EPERM`). The fix follows the runner's cleanup (37beede): the folder is deleted with bounded retries (20, 250 ms apart, by the promise form of `rm`, since `rmSync`'s retries block the event loop and all failed in the reproduction), and the test fails only if the folder is still there afterwards. It is a defect of the test, not of the runner, which stays frozen. Two other M3 tests failed once each in one later full run and passed alone (12 of 12): `test/m3-environment.test.mjs` ended with exit code 3221226505 (0xC0000409, a native crash of the test process), and the dry run in `test/m3-runner.test.mjs` hit `ENOTEMPTY` deleting the shared run-0 workspace inside the frozen runner's `makeWorkspace`. Neither is touched by this change, and neither is fixed here: the second is in the frozen runner. Both are listed for the owner. The final full run had no failure (1,541 tests: 1,536 passed, 1 skipped, 4 waiting).

## Step 4 follow-up accepted, and the two M3 failures under load

**Ruled (2026-10-05).** The row order, the extended probe, the guard defect and the m3-isolation fix are accepted. The two M3 failures seen under load are not fixed now, since the runner is frozen: the crash of `test/m3-environment.test.mjs` (exit code 3221226505, 0xC0000409) and `ENOTEMPTY` in the frozen runner's `makeWorkspace` during the dry run of `test/m3-runner.test.mjs`. Every occurrence is counted in each full run until M8a closes, and the count is brought to the owner then.

**How a run is counted.** A full run is the whole suite (`packages/*/dist/test/*.test.js`, `test/*.test.mjs`, `test/after/*.test.mjs`) in one `node --test`. In its TAP output, a crash is a `not ok` line naming `m3-environment` and a dry-run failure is a `not ok` line naming "the dry run" whose error is `ENOTEMPTY`. A run that excludes the M3 tests is not counted.

| Full run | Tests | m3-environment crash | dry run ENOTEMPTY |
|---|---|---|---|
| step 4, first (before 239b9e3) | 1,534 | 0 | 0 |
| step 4 follow-up, second | 1,535 | 1 | 1 |
| step 4 follow-up, final (b8f02ff) | 1,541 | 0 | 0 |
| step 5, S178 | 1,553 | 1 | 0 |
| the M8a review's fixes | 1,584 | 0 | 0 |
| M8a closing gate (d923503) | 1,584 | 0 | 0 |
| **Total at M8a's close, 6 runs** | | **2** | **1** |

## S178 in detail, ruled

**Accepted (2026-10-05).** PS5.2 and PS5.2a as proposed, with all five choices: `while` reads the pre-state; a never takes a name; `emits` names effects only; a filter compares a field with a constant; the lowering reads the step's intents through the effects mapper. The text is written into `04-semantics.md` first (f5df1f1). Three test requirements:

- **Choice 1 both ways.** A step from an open window that writes it open and sends is allowed; a step that sends from a closed pre-state, even if it opens the window in the same step, is a finding. (The proposal's wording, "a step that opens the window and sends is allowed", read as a step from a closed window; the ruling's two cases are the ones tested, and PS5.2a's text says the rule directly.)
- **Unconstrained witnesses, both outcomes.** One confirmed by the configuration check, and one ruled out by it, which then does not count as a finding.
- **Out-of-scope kinds.** `emits` on a send, a timer or a spawn is `PL1001`, with a test for each.

Seeded faults: a never dropped, its `while` inverted, a field filter dropped, and `while` evaluated on the post-state. After step 5, M8a's steps are done: the M8a record, the review, and the closing gate on a quiet machine, with the failure-count totals.

## M8a accepted, and the two questions of the review

**Ruled (2026-10-05).** M8a is accepted.

- **B-F6.** `use m.M` admits `m.M` only, as ruled for S176. The resolver and PT's as-built text are fixed. `m`'s own machines still name each other in `m`'s source; the using module names only `M`. Tested first: naming `m.N` after `use m.M` is refused (`PL1001`); `M`'s spawn of `m.N` still works when the using module composes `M`; two `use` clauses admit both. The review table lists it as fixed.
- **PS5.2.** `k` is the effect's name (PT2.2), and PS5.2 and PS5.2a now say so. The `PL1201` refusal of a name whose effect shares its kind with another stays.

**Limits added.** `emits` cannot tell apart two effects of one kind: an intent, a witness and the journal show only the kind, so `emits` on either effect is `PL1201`. An author who needs the distinction gives the two effects different kinds.

## S190 ruled: enums across modules

**Accepted (2026-10-05), with five clarifications.**

- An enum is identified by `m.E`. Two enums with the same members in different modules are different types (`PL1201`).
- `use m` admits `m`'s enums, and `use m.E` admits only that one, as B-F6 rules for machines.
- A bare member is allowed only where the expected type fixes the enum. Otherwise `m.E.C` is written, and an ambiguous member is refused.
- `==`, `!=` and `match` work on a field from another module, and a match covers every member. This lifts the is-only limit of B-F4, which leaves the limits list.
- A module's lowered artefacts and certificate record the digest of each module whose types they use. A mismatch at load is refused, with a test where a member added to a std enum makes a stale build fail.

Records, unions with payloads and maps of another module's types stay `PL0901`. Per rule 7a the PS1.0 text was written before the code (5561a0c), then the tests, which failed first. poly-ref reads the declaring module's source. The seeded fault `foreign-enum-member` drops a member from a foreign enum's domain, and translation validation catches it.

**As built.** The digests are the AST digests (PT1.4) of the modules whose enums a machine names, recorded in its `contract.json` under `typeModules`; the certificate records each such module with its file's path and the SHA-256 of its bytes. Load compares the bytes of each file and the digest of each contract with the certificate, and refuses a difference with `PL6407 TYPE_MODULE_CHANGED`, a new runtime code. A test may point the checker at a directory of its own for `std.*` (`std` in the options of `checkFile` and `admit`), since the repository has no `std/` yet.

**The 147 files measured again** are identical in verdict, diagnostic codes and every state and transition count. One difference appeared while building, before the commit: `conformance/m1/records.poly` gave ERROR, because poly-ref's first reading of `m.E.C` took `post.box.count` for a member chain. That was a defect of the change itself, fixed before the measurement that counts; nothing differs in the committed tree.

## S190 accepted, and two checks before M8b

**Ruled (2026-10-05).** S190 is accepted, with two checks made in one commit before M8b's step 1.

- **Relative paths.** The certificate records each type module's file relative to the project root, or as `std:<path>` relative to the std root; never absolute. Only the hash decides at load. Tested: an admitted project copied to another folder loads with no `PL6407`, and a change to the copy's own type module is still refused. A module outside both roots is not admitted. The copy sits at the same depth, since the certified lockfile (S154) is also named by its path relative to the project.
- **The std option is for tests.** `std` on `checkFile`, `checkProject`, `admit` and `load` is an API option for tests only: no command-line flag and no `poly.json` field carries it, until the repository has `std/`.

## PS15 ruled: the channel

**Accepted (2026-10-05)** as proposed, with all four choices and five conditions.

- **Peer by renaming.** The binding is total (every Peer action mapped), one-to-one (two Peer actions never map to one application action) and type-checked against the application's actions. Each failure gets its own code and test: `PL6813 CHANNEL_BINDING_INCOMPLETE`, `PL6814 CHANNEL_BINDING_NOT_ONE_TO_ONE`, `PL6815 CHANNEL_BINDING_MISTYPED`.
- **Child key c**, address `p/c`; a clash is `PL1002`.
- **Inbound goes to the conversation first.** Creating the application on inbound is declared on the channel (`starts A.S on inbound`). Without it, an inbound message for an unknown thread is refused and journaled with a reserved reason (`unknown-thread`). With it, the order is fixed: creation, the starts step with its spawn, then delivery of the inbound message, each journaled. A refused starts refuses the inbound message (`thread-not-started`). The thread key is a checked string, used only as a key.
- **One generated configuration per channel**, named in the report so findings can be traced. Any declared configuration that includes the application also gets its conversation.
- **An application-level `never emit c.reply` is `PL1001`**, with a message pointing to the conversation, since after the rewrite it is a send (S178).

poly-ref expands the channel itself from the PS15 text and is not given the compiler's expansion. Three seeded faults: a starts with its spawn dropped, a renaming that swaps two actions, and inbound delivered to the application instead of the conversation; translation validation catches all three. The kind `channel.c.send` is per channel. `std.channels.test` stays under the test-only std option and never ships in `std/`. PS15 was written into `04-semantics.md` first (c77875f).

**Two precisions made while building, for the owner's notice.**
- *The key c in every handler.* PS15.3 has `c` read the address of the conversation spawned under the key `c`; S78 binds a child's key only in the block that spawns it. As PS15.2 and PS15.3 say, `c` names `p/c` in every handler of the application, as the kernel's child marker, so no field is added.
- *A refused starts.* polyrun's creation persists the instance and its rejected creation step, both journaled, as the ruling's order says. PS15.4 now says so: an `unknown-thread` refusal creates no instance; a `thread-not-started` one leaves the application in its initial state with no conversation, and each later message on its thread is refused the same way. The first wording ("a refusal changes no instance") was wider than the ruling.

## ENOTEMPTY under load: a defect of the test setup

**Ruled after M8b step 1 (2026-10-05).** The `ENOTEMPTY` on the frozen runner's workspace came first from the dry run (`test/m3-runner.test.mjs`) and then from `test/m3-environment.test.mjs`, so it is a defect of the test setup, not a fluke: the runner's workspace is `poly-m3-ws/T1-arm<a>-run<n>`, and three files ran arm 1 of T1 as run 0 (the dry run, which is frozen, `m3-environment` and `m3-after`) while `node --test` runs the files at once. Each test file now has run numbers of its own (`m3-environment` 910, `m3-after` 920 and 921, beside `m3-cleanup`'s 901 to 905 and `m3-runner`'s 9); the dry run keeps run 0. The runner is unchanged.

## M8b step 1 accepted

**Ruled (2026-10-05).** Step 1 is accepted, with both changes to PS15 (the key `c` in every handler, and the reworded refusal of a thread whose `starts` was refused).

- **Until E13 lands**, `rt.inbound` on an unknown thread with creation declared is refused with the new reserved reason `creation-unavailable`, journaled on `runtime:ingress`, and never reaches the kernel's create. The todo test for the real path stays; a test for this refusal is added. The test of a refused `starts` waits on E13 too, since a creation no longer reaches `starts` before it; a thread created by the host with no `starts` shows the same refusal today.
- **`c` before `starts` has run** names no instance: a send to it is refused as one to an address that names no instance (dead-lettered and journaled on the sender's run, S89; `PL5404` in a configuration). Tested both ways.
- **E13 is approved**; the owner takes it in polyrun, from its specification in `plan-m8.md`.

**Limits added.**
- *A thread whose `starts` was refused stays dead:* the application exists with no conversation, and every later message on its thread is refused `thread-not-started`.
- *Until E13*, no channel thread is created at run time (`creation-unavailable`).

## M8b step 2: the conversation machines, for the owner's notice

**Choices made while writing them (2026-10-05).**

- **A conversation is a `service`.** A thread has no end, so a conversation is never terminal; read otherwise, the generated configuration calls it stuck (`PL5402`) once the application closes. PS5.6 does not run on a service (PS1.7), so the tests check the same machine read without `service`: no reachable state is a deadlock.
- **poly's own bounds.** One send in flight, so a receipt names the send it settles; at most two messages waiting for an answer, a third refused with the reason `backlog` and journaled. `pending` counts both (`0..3`), so the transit bound of the generated configuration is three: two waiting messages and one receipt.
- **A template is `Template(body: Content)`.** The body names the template and its values. A template's name would be an application's type, which a std module cannot know.
- **Numbers the sources do not give.** Gmail's "multiple bounced messages" is read as two; Standard Webhooks' "fail consistently" as three failed deliveries in a row, each after its ten attempts. Each is listed in `PROVENANCE.md` as poly's choice.
- **Durations are constants.** poly checks no time: `24h` (WhatsApp) and `1s` (Slack) are recorded with their sources, and what is checked is the order (the window closes only on its timer; a post waits for its timer).

**For a ruling: unacknowledged receipts.** The receipts a conversation sends (`Delivered`, `Rejected`, `Failed`) are never acknowledged, so an application that answers every message can leave receipts in transit without bound. Its generated configuration reaches the transit bound and is `INCONCLUSIVE` with `PL5301` and the witness, never `CLEAN` (PS13.5); a test records it. An application that answers finitely often (one ticket per thread, as in the tests) is `CLEAN`. Three ways out, none taken: (a) a budget on the environment's `Inbound` in a generated configuration, stated in its report; (b) an acknowledgement action on `Peer`, which the application must send; (c) leave it, and say in the report of every generated configuration that hits the bound that the receipts are the cause. (a) changes PS15.5, (b) changes PS15.0 and every binding.

**Limits added.**
- *A provider rule a module does not encode is not checked.* Each `PROVENANCE.md` lists what is, and what is not.
- *A thread holds at most two unanswered messages*; a third is refused `backlog`.

## Step 7 accepted: receipts are acknowledged

**Ruled (2026-10-05).** Step 7 is accepted. The unacknowledged receipts are settled by option (b), with the acknowledgement generated:

- Each std conversation gains the action `Ack()` and holds its slot until `Ack` arrives, so `pending` counts the receipt as well. The five modules and their `PROVENANCE.md` files list it as poly's own rule.
- PS15.3 is extended (72d4bda, before the code): the expansion appends `send c <- Ack()` to every handler of the application bound to a receipt (`Delivered`, `Rejected`, `Failed`). Authors never write or bind `Ack`, and it is outside `PL6813` to `PL6815`. poly-ref appends it from the PS text on its own.
- A kind whose conversation declares no `Ack()` with a handler is `PL6811`.
- The seeded fault `channel-drop-ack` drops the acknowledgement from the lowered application, and translation validation catches it (`PL2501`).

**Reading of the ruling.** "Ack on Peer" is read as the peer's acknowledgement: `Ack` is an action of the conversation, which the application (the peer) sends, since `send c <- Ack` addresses the conversation. `Peer` keeps only the messages the conversation sends.

**What the slot changes.** A message refused while the slot is held is a rejected step, `busy`, journaled on the conversation; it no longer becomes `Rejected("busy")`, which was itself a receipt that needed a slot. The reasons `Rejected` carries are now the providers' rules only. The two limits recorded here at first (a rejected receipt holds the slot; a reply refused `busy` is not reported) are findings since the ruling on step 8, below.

## check-memory under load: an existing failure, counted

**Ruled (2026-10-05).** `test/check-memory.test.mjs` failing under the parallel load of a full run is an existing failure. It is not fixed in M8b's step 2 follow-up. Measured before the ruling: the collected heap grew 0.4 MB over checks 10 to 60 in one full run (its bound is 0.3 MB), and the same growth (about 97 `UncompiledData` objects per check) is in the d923503 tree, where the test alone grows 0.2 to 0.3 MB; it is not a regression of M8. From now on each full run reports it with its own count, beside the suite's totals. **The count so far: 1 failure in 16 full runs** (the run before 1d2108d failed; every run since has passed: two of step 7, one of its follow-up, four of plan step 8, three of plan step 9, five of plan step 10).

## Plan step 8: choices for the owner's notice

- **Mailgun for inbound mail.** S183 names an inbound-mail webhook. Mailgun's route webhook is used because it is signed. Its signature covers the timestamp and a token, not the body, so the adapter takes each token once (the cache Mailgun recommends) and refuses an old timestamp.
- **Receipts through `verify`.** A provider's receipt is a webhook, so `verify` returns receipts beside messages. Ingress records each receipt on `runtime:ingress`. A status a rule reads is a provider event since the ruling below; any other (WhatsApp's and Twilio's statuses, a Mailgun delivery) is recorded only.
- **Sender claims (K11).** WhatsApp, Slack and a signed webhook source give a verified claim; an SMS number and an email address give an unverified one. Ingress records the claims of every message. Carrying them in the step label, so that a program reads `verified` (AC14), is plan step 10.
- **Sends through the outbox.** `rt.connectChannel(channel, adapter, transports)` makes the adapter the handler of `channel.<c>.send`, run by the outbox worker after the gate allows. The adapter is runtime configuration, as a decision's provider is; certifying it by digest, and AC17, are plan step 10's.

## Step 8 not accepted until its item 3: the rulings, and what was built

**Ruled (2026-10-05).** The reading of "Ack on Peer" is accepted. Step 8 waits for these:

- **A receipt handler that can be rejected** is a finding: in a configuration with a channel, a reachable delivery of a receipt that the application rejects is `PL5406 RECEIPT_REJECTED`, with its witness (PS15.5, d2e41d3).
- **Replies refused `busy`.** A reply that answers a waiting message is queued in the conversation (at most two, within `pending`); a reply or a template that can still be refused `busy` is `PL5407 REPLY_REFUSED` in the configuration, with its witness (PS15.5). The five modules hold the queue (`queued`, `queue1`, `queue2`, the invariant `queue-while-held`); `Ack` gives the slot to the first queued reply under the rules as they stand then. `one-send-at-a-time` now reads `while slot is Sending`: a queued reply leaves on the step that acknowledges the previous receipt.
- **Provider events** (PS15.4). A status a rule reads reaches the conversation: Mailgun's permanent failure is the event `Bounce` on the recipient's thread (a new `Event` of `std.channels.email`); Slack's `is_archived` answer to a post is the event `Archived`, delivered by the runtime before the send's failure completes; a failed webhook delivery is the send's `Undelivered` completion. Each rule has an end-to-end test from recorded traffic to the refused send (`test/channels-events.test.mjs`). Until E13 those tests create the conversation beside its application, as the spawn of `starts` would.
- **Mailgun's token cache** is in the store: the adapter names the token as the webhook's nonce, ingress claims it with `rt.claimNonce` (table `poly_ingress_nonce`), and a replay after a restart is refused `token-replayed`.
- **The seeded controls are permanent**: `ADAPTER_FAULTS` (`signature-always-matches`, `timestamp-never-stale`), taken by an adapter from its configuration, and two tests that show each lets a forged or stale webhook through every adapter that checks it.

## Step 8 accepted, with one fix before plan step 9 (owner, 2026-10-05)

Step 8's rework (d2e41d3, 59469de) is accepted: PL5406, PL5407, the reply queue, provider statuses to the conversation, the persisted Mailgun tokens and the permanent adapter faults. One defect and three follow-ups remain, to be done and committed before plan step 9 starts.

1. **State tied to an address is kept per address, not per thread.** SMS opt-out is per number; email bounces and one-click unsubscribe are per address. As built, a bounce lands on the recipient's thread, so two threads to one address count bounces apart, and mail continues after two. Either the thread key of `sms` and `email` is the address (stated in each PROVENANCE.md), or the state lives where every thread to that address shares it. Tests first: a STOP on one thread blocks a send on another thread to the same number; two bounces on two threads to one address block the next send.
2. **The one-send rule as reworded** ("no send while a send is in flight") is recorded in each PROVENANCE.md as poly's rule, not the provider's.
3. **Claimed nonces are pruned** once older than the timestamp window, so the table stays bounded. A test covers it.
4. **Open for plan step 10**, recorded in plan-m8.md: `rt.connectChannel` takes its adapter as runtime configuration and is not yet certified by digest; sender claims are journaled but not yet carried in the step label (AC14).

Then: the 147 files measured, the full suite run with the check-memory count, a commit on m4 (not pushed), a report, and plan step 9.

## Step 8 closed (e24919b); guidance for plan step 9 (owner, 2026-10-05)

Step 8 is complete and accepted as reported, including the two additions beyond the ruling (Twilio 21610 as `Reported`, and one channel per sender).

- **Polywatch findings on files a change does not touch** are recorded as *out of scope*, not *false*, with the file named, so they are not lost. The two on `experiments/m3/runner-mutant-assign/agent.mjs` go on the list for the owner.

**Plan step 9: settle E10 by test, not by reading.** The question is whether polyaxion passes a new `channel` field of a `custom.poly.effect` proposal through to the policy rules.

1. Write the test first: a proposal carrying `channel`, and a policy that reads `effect.channel.*` and denies on it. The test passes only if the deny happens.
2. **Fail closed.** Also test a policy that reads `effect.channel.*` against a proposal without the field. It must deny or be refused at load, never allow. If polyaxion evaluates a missing field as allow or as no match, that is a fail-open defect: stop and bring it to the owner as part of E10.
3. **Pin the engine.** Polyaxion is loaded from the sibling checkout, not vendored. Record its commit in the certificate (or refuse to admit when it is unknown), so a policy decision can be traced to the engine that made it.
4. If the field passes through and fails closed, no engine change: the policy front end types `effect.channel.*` and the worker adds the field. Otherwise build the PT27.2 fallback, list the check as poly's in the certificate, and bring E10 to the owner.

**Done (plan step 9).**

- **Polywatch findings out of scope**, for the owner's list: two findings of review `muw7859c` on `experiments/m3/runner-mutant-assign/agent.mjs`, a file the reviewed change did not touch. (1) `runTurn` spawns the agent with no `error` listener, so a spawn failure (ENOENT, EACCES) would throw out of the runner instead of ending the turn as stopped. (2) The review read that file in place of the change. The polywatch command takes only *real* or *false*, so both were recorded there as *false* with the file named; they are out of scope, not false, and the first is a real question about frozen M3 evidence for the owner.
- **E10 settled by test: not needed.** `test/policy-channel.test.mjs` lowers a policy over `effect.channel.*` as poly lowers every policy and steps it on the pinned Polyaxion. A proposal carrying `channel` is denied on it, and one with another channel is allowed, so the engine reads the field. A proposal without the field is never allowed: `on unknown deny` denies and the default escalates (PS8.2), and a raw Polyaxion rule over the missing field is applied, not skipped, so the engine fails closed on its own. A seeded control, the policy fault `drop-unknown-rule`, lets that proposal through, so the fail-closed test can fail. No engine change; E10 stays on the list for taint (M10).
- **The engine pinned.** A build with policies records `poly.policyEngine` (`polyaxion` and its commit) in the certificate, and is not admitted when the commit is unknown; `load` refuses a build admitted with another commit, or with none.
- **A note for authors.** A rule over `effect.*` is also read on a send between trust scopes (PS8.7), where `effect` is unknown; with `on unknown deny` it denies the send. `proposal.kind == "effect" && …` makes the condition false on a send.

## Step 9 accepted, with two fixes before plan step 10 (the Cowork coordinator, for the owner, 2026-10-05)

Step 9 (cbcd4ab) is accepted. Two fixes come before plan step 10.

1. **The recipient digest is keyed.** An unkeyed SHA-256 of a phone number can be inverted by enumeration, and the proposal is journaled with its verdict. The digest is HMAC-SHA256 under a key the store generates when it is created, keeps, and never exports, logs, journals or certifies; one address gives one digest in one store. Tests first, and a seeded control (the unkeyed hash).
2. **The engine pin covers the files as loaded.** Admission and load refuse when a pinned file of the Polyaxion checkout differs from the pinned commit, naming the files; untracked files are ignored. Tested with a seeded modified file.

**Recorded only.** The effect of `on unknown deny` on sends between scopes stays as documented, and the plan step 10 concierge's policy uses the `proposal.kind` guard. On the owner's list: a lint for that guard, polywatch's missing *out of scope* verdict, and the M3 runner's crash on a failed spawn.

**Then plan step 10**, AC14 to AC17 end to end, as far as it goes without E13: the concierge, its policies and every test of plan section 6 for AC14 to AC17, each AC with its real-path test through `rt.inbound` marked todo for E13; `rt.connectChannel` certified by digest, and the sender claims in the step label; the concierge CLEAN, free of deadlock, every `never` proved, with its checked instance. Stop after step 10.

**Done (the two fixes).**

- **Fix 1.** The store makes a 32-byte key when it is created (table `poly_store_key`), read only by `recipientDigest`, which `channelOf` calls; the recipient is `hmac-sha256:<hex>`. Tests: two denied replies to one address in one store give one digest, two stores give two, no proposal holds the address, and neither the ledger nor the content store holds its unkeyed hash. The seeded control, the runtime fault `unkeyed-recipient` (`RUNTIME_FAULTS`), puts the unkeyed hash in the content store, where the check finds it. **For the owner:** the thread key is part of an instance's id (`support:<address>/support`, PS15.4), so the address is in the journal as the run's name. The test checks the proposals and the unkeyed hash; keeping the address out of instance ids would change PS15.4's addressing, and is a question for a ruling. The address is also in the conversation's `Inbound` step data (`from`) and in the ingress records (the thread, the claims' `sender`). Polywatch confirmed both as a gap against the ruling's words; the fix is a ruling's, since it changes what a thread key is: one way is that ingress replaces each thread field by its keyed digest, so instance ids, step data and records hold digests, and the store alone maps a digest to the address a send needs.
- **The full suite** for the two fixes: 1,723 tests (1,722 and the one after the M3 runs), 1,716 pass, no failure, 1 skipped and 6 waiting; `check-memory` passed. The 147 measured files are identical.
- **Fix 2.** Admission and load check the checkout afresh (no status cached before an edit), and refuse naming each differing file. The pinned files are the ones the engine runs (each package's `src`, `package.json` and `LICENSE`); a tracked file outside them is never loaded. Tested on a copy of the pinned files, so the sibling checkout is never changed: the copy passes, an extra untracked file changes nothing, and a changed `src/core/expr.mjs` is refused at load and at admission by name. Both take a test-only `policyEngine` option naming the checkout, as `std` names a std root.

## Plan step 10: open for a ruling

- **The address in the journal** (from fix 1). Brought to the coordinator with a proposal: ingress replaces each thread field by its keyed digest, so instance ids, step data and records hold digests, and the store alone maps a digest to the address a send needs.
- **AC15's witness from `poly check`.** The generated configuration's inputs (PS15.5) do not include the conversation's timers, so the WhatsApp window never closes in a check and no variant can be shown to send after it. Proposal: PS15.5's inputs also include the completions of the conversation's own timers. AC15's static test is a todo naming this until it is ruled.
- **Sender claims as an enum.** A claims field is an enum, a range or a Principal (S103), so the adapter's `verified` true or false is the claims value `Verified` or `Unverified`.

## Step 10 not accepted yet: two items (the Cowork coordinator, for the owner, 2026-10-06)

Step 10 (182b9f5) is not accepted yet. The adapter certification and `PL6408`, the claims as `Verified` and `Unverified`, and the E13 todos listed as not run are reviewed and hold.

1. **AC15's static witness is part of the gate.** It is missing because of a gap in checking: if the window's timer never fires in the generated configuration, every rule guarded by a closed window is proved over states the configuration never reaches. Semantics first: the PS15.5 change that makes a conversation's armed timers inputs of its generated configuration (the environment may fire any armed timer) goes to the coordinator for a ruling, with a vacuity report: for every `never` of the five std conversations and of the concierge, in each configuration that checks it, whether the state its `while` names is reachable; a never whose `while` is unreachable there is reported vacuous, not proved. No code before the ruling.
2. **Free of deadlock.** As step 7 did for the std conversations, the concierge's machines are checked read without `service`, and the result reported per machine and per configuration, beside the quiescence checks.
3. **The address in the journal is a limit of M8**, not a fix now: an open issue for M9 (S191, below), named in the M8 record and in the certificate's limits.

After item 1 is ruled, built and committed, and item 2 is reported, step 10 is accepted and step 11 is ruled. Step 11 does not start before.

**S191 (open, for M9). Addresses out of the journal.** A channel's thread key is the provider's address (a phone number, an email address), so the address is in instance ids (`<channel>:<address>`), in the conversation's `Inbound` step data, and in the ingress records. In M9 addresses move to the erasable content store, and thread keys, step data and ingress records carry only the address's keyed digest (the store's key of the step 9 fix); the send handler reads the address from the content store by its digest. Until then, the M8 limit: *a channel's journal holds its correspondents' addresses.*

**Item 2, reported (2026-10-06).** The concierge read without `service` (its three applications and the three conversations, the latter through a copy of `std/` under the test-only std option): every machine's PS5.6 deadlock check ran and is CLEAN (`Desk`, `Texts`, `Staff`: 8 states each; `support.Conversation` 342, `text.Conversation` 342, `staff.Conversation` 522), and each configuration is CLEAN with its quiescence check (PS13.6): `support` 3,068 global states, `text` 14,483, `staff` 19,070. No quiescent state exists in them, since a customer's `Inbound` is always an input the conversation accepts until its backlog is full, and a full backlog is drained by the application's answers. With `service`, as committed, the same configurations are CLEAN and the per-machine check is exempt (PS1.7).

**Item 1, the vacuity report (2026-10-06).** Measured on the committed tree with a script over poly-ref's graphs (not committed; rerun after polywatch with every evaluation error raised, not read as false, and each machine checked alone evaluated with its own machine, with the same 43 rows): for each never, whether its `while` holds in some reachable state, and whether the rule is *tested*: some reachable accepted step of the conversation takes an action that can emit the never's effect from a state where the `while` holds.

- *Each std conversation checked alone:* every `while` is reachable and every rule is tested (by `Reply`, `Template` or `Ack`).
- *The concierge:* `support` (WhatsApp): `free-form-outside-window` **not tested**; its `while` (window `Closed`) is reachable only as the initial state, before any message, and after the first message the window never closes. `one-send-at-a-time` tested. `text` (SMS) and `staff` (Slack): every never tested.
- *The std tests' one-ticket application on each kind:* `free-form-outside-window` not tested (WhatsApp); `one-send-at-a-time` not tested on every kind (one reply per thread); `no-delivery-while-disabled` (webhook) not tested and its `while` unreachable (three failed deliveries need three sends). The rest tested.
- *The std tests' answering application on each kind:* `free-form-outside-window` not tested; every other never tested.

The full suite with the S191 limit: 1,744 tests (1,743 and the one after the M3 runs), 1,731 pass, no failure, 1 skipped and 12 waiting; `check-memory` passed; the 147 measured files are identical.

So the gap the ruling names is real and is the only one that matters for a rule: a closed WhatsApp window is never reached after a message in any generated configuration. The literal measure of the ruling (is the `while` state reachable) misses it, since the window is `Closed` in the initial state; the measure that finds it is whether the rule is tested.

**Does poly check report it?** No. A machine checked alone reports a never vacuous when its `while` holds in no reachable state (S113: `INCONCLUSIVE`, reason `vacuous`; measured on a probe whose `while` is never true). A configuration judges vacuity only for its own declared properties; the nevers it checks on its instances (PS5.2a) are listed as violated or not, and never as vacuous. In every configuration above the result is CLEAN.

**Proposal (for the ruling, with the PS text).** In a configuration, a never of an instance is *tested* when some reachable accepted global step of that instance takes an action whose handler can emit the never's effect, from a pre-state where its `while` holds (and its field filter is satisfiable). An untested never is listed under the configuration's `vacuous`, naming the never, the instance and the reason (`while` unreachable, or reachable but never acted on), and the configuration is at best `INCONCLUSIVE` (PT12.3, S113), never `CLEAN`. The same measure replaces the machine-level one for nevers, which today counts the initial state.

**Proposed PS15.5 text (for the ruling).** The sentence on inputs, *"the inputs `A`'s `starts`, the conversation's `Inbound`, and the completions the conversation's provider effect is wired to (the provider's receipts)"*, becomes:

> the inputs `A`'s `starts`, the conversation's `Inbound`, the completions the conversation's provider effect is wired to (the provider's receipts), and the completion of each of the conversation's timers (`after d -> X() as k`): the provider's clock, which may fire an armed timer at any time. The global state records which of the conversation's timers are armed: an `after` arms its key, a `cancel` or the timer's firing disarms it, and the environment offers `X` only while `k` is armed, at most once per arming. Durations are not compared: any armed timer may fire before or after any other step (PS4.4).

Option B, for the record: offer each timer's target in every state, without tracking armed timers. It needs no change to the global state, but it offers firings a running program cannot have (a target with no armed timer), which a handler's guard must reject; std's handlers do (`require window is Open`, `require cooling`), but a finding could then name a firing that cannot happen. The text above (option A) is proposed.

## Step 10, items 1 to 3 ruled (the Cowork coordinator, for the owner, 2026-10-06)

- **Item 1a. PS15.5, option A, accepted as written**, with two additions: an `after` on a key that is already armed re-arms it (one pending firing per key, as at run time), and the change covers the generated configuration of a channel only. A configuration a user declares that treats timers differently is reported and raised as an issue, not changed in M8.
- **Item 1b. Vacuity by the tested measure, accepted.** A `never` is tested in a configuration when some reachable accepted global step of its instance takes an action whose handler can emit the effect from a pre-state where the `while` holds. An untested `never` is listed as vacuous with the `never`, the instance and the reason, and the configuration is at best `INCONCLUSIVE`. The same measure replaces the machine-level one. The semantics (PS5.2a, and PS15.5 for the configuration) is written and committed with 1a before any code.
- **Conditions on the code.** Tests first: AC15's static test (the concierge variant that sends a free-form reply after the window gives a witness from `poly check`), and the support configuration's `free-form-outside-window` becomes tested. Seeded controls, each caught: a generated configuration that offers no timer firing (the AC15 test catches it), one that fires a disarmed timer (a test that a cancelled timer never fires in a witness), and the vacuity check reverted to the weak measure. The one-ticket test applications: a test meant to prove a rule moves to the answering application, and one test asserts that the one-ticket application is `INCONCLUSIVE` for `one-send-at-a-time`, as a control of the new measure. Regression: the 147 files measured; any verdict that changes is listed file by file with its untested `never` and the reason; the state and transition counts of the three concierge configurations before and after the timers.
- **Item 2, deadlock: accepted as reported.**
- **Item 3, S191: accepted.** The certificate line in admission stays; it states a limit and is tested.
- Then the full suite with the check-memory count, a commit on m4, no push, a report. Step 10 is accepted on that report if it holds. Step 11 waits for its ruling.

**Built (2026-10-06).** PS15.5 and PS5.2a as written (5282586), then the code, each test first.

- **The provider's clock.** poly-ref's configuration keeps, in a channel's generated configuration only, the conversation's armed timers in the global state (instance, key, action, data; one per key): an `after` arms or re-arms its key, a `cancel` disarms it, a firing disarms it first, and the environment offers the firing of each armed timer. AC15's static test passes: the concierge on a `std.channels.whatsapp` whose `Reply` sends whatever the window (under the test-only std option) gets a `PL3002` in its `support` configuration, through `WindowExpired`.
- **The tested measure** (PS5.2a), in poly-ref, for a machine checked alone and for every configuration: an untested `never` is listed vacuous with the `never`, the instance and the reason, and the verdict is at best `INCONCLUSIVE`.
- **Seeded controls, each caught** (`REF_FAULTS`, taken by poly-ref and, for the tests, by `checkFile`'s `refFault`): `no-timer-firing` (AC15's witness is gone), `fire-disarmed` (a `WindowExpired` from a state where `w` is not armed; the test that a cancelled or never-armed timer never fires checks every firing edge of the concierge's `support` configuration), and `weak-vacuity` (the one-ticket application is `CLEAN` again).
- **The test applications.** The per-kind tests that meant to prove a rule with the one-ticket application are gone; the answering application proves each kind (its tests were already there), and admission is tested on it. One test keeps the one-ticket application on WhatsApp as the control: `INCONCLUSIVE`, with `one-send-at-a-time` vacuous, and its window rule tested. The test kind `std.channels.test` loses its `never`: its window never closes, so the rule would be vacuous everywhere.
- **Regression, file by file.** The 147 measured files are identical. Of the twelve files measured since, two changed:
  - `conformance/m8/never/chat-ruled-out.poly`: **CLEAN to INCONCLUSIVE.** In its declared configuration `pair`, `chat.free-when-closed` is untested: its `while` (window `Closed`) holds, and `Reply`, the one action that can emit `send`, is never taken from such a state, because the configuration offers no timer (S61) and the window never closes after it opens.
  - `conformance/m8/concierge/concierge.poly`: CLEAN, unchanged, with more states: `support` from 3,068 global states and 64,665 transitions to 14,482 and 314,709; `staff` from 19,070 and 1,016,171 to 27,434 and 1,472,379 (Slack's one-second timer); `text` unchanged at 14,483 and 1,234,280 (the SMS conversation has no timer). Every `never` of the three is tested.
  - Tests that asserted CLEAN over a declared configuration with timers now assert INCONCLUSIVE with the vacuous `never` named: `never.test.mjs` (the ruled-out witness, `chat.free-when-closed`), `review-m8a-d.test.mjs` D-F3 (`alarm.no-bell-when-disarmed`), D-F5 and D-F7 (`chat.free-when-closed`, `chat.any-when-closed`).

**The full suite.** The first run had two failures, each a consequence of the measure, fixed and listed: M4f's recorded vacuity table (`test/m4f-recheck.test.mjs`) gains `chat-ruled-out.poly`'s `chat.free-when-closed`, the change of verdict above; and the runtime ingress test of `test/channels-adapters.test.mjs` admitted an application that never replied, whose conversation's rules were then untested, so it now answers every message and takes every receipt. The second run: 1,743 tests (1,742 and the one after the M3 runs), 1,731 pass, no failure, 1 skipped and 11 waiting (E1 and E13); `check-memory` passed. The 147 measured files are identical. **The check-memory count: 1 failure in 16 full runs.**

**Polywatch, out of scope, for the owner's list.** Review `muwed6q4` found, in `test/m4f-recheck.test.mjs`'s `frozenCommit` (untouched by this change, which added one row to its table): the commit is read as the first hex token of `experiments/m3/FROZEN`, so a compact date written before the hash would be taken for it; and every git error but one turns the M3 re-check into a todo instead of a failure. Recorded with polywatch's only verdicts as *false*; it is out of scope, and a real question for the M3 re-check.

**S192 (open, raised as ruled).** A configuration a user declares completes a timer only through its declared inputs (S61), and a timer's target cannot be declared as an input that fires only while armed. So in a declared configuration a rule a timer makes reachable is untested and, since this step, reported vacuous (`chat-ruled-out.poly`, D-F3, D-F5, D-F7 above). Proposal for a later milestone: the provider's clock of PS15.5 for every configuration, or an input form `timer X of i` that fires only while armed. Not changed in M8.

## Engine changes

- **E10** (polyaxion) is on the engine list, in M8 for the `channel` proposal field only; per-value taint waits for M10 (S181). If polyaxion cannot take it, PT27.2's fallback applies, and the certificate lists the check as poly's, not the gate's.
- **E11** is not needed in M8 (S184).
- **E9** is withdrawn (S175).
- **E5** stays on the list and is not needed by M8 (S177).
- **E12** is unchanged.
- An engine item found while building gets the next id, from E13, and is recorded here the day it is found.
- **E13** (polyrun), found at M8b step 1 (2026-10-05): the kernel has no `createInstance` intent, so a detached spawn does not run under polyrun 8.3.2 (it was on the owner's list since M1, "only if a task needs it"; S177 now does). Until E13 is vendored, a channel's conversation cannot be created at run time: `rt.inbound` on an unknown thread with creation declared fails at the kernel, and its test waits on E13 as E1's do. Everything else of the channel is checked from the semantics and lowered.

## The split

- **M8a, the gate's reach:** workflows under the gate (steps 1 and 2), `use`, `Content` and `never` (steps 3 to 5). Its gate is AC5 under the gate and the three language items.
- **M8b, channels:** steps 6 to 10. Its gate is AC14 to AC17 and the conversation machines.

M8a closes before M8b starts.

## Rules for the whole milestone

As written in `plan-m8.md` section 7a:

- **Gates.** Every gate in M8 runs from a clean build on a quiet machine, checked and recorded first. Per-file timings are compared with the previous closing gate.
- **Semantics first.** Any change to `04-semantics.md` (S178, S180) is written and ruled before the code that follows it.
- **Fail first.** Every defect gets a regression test that fails first; a confirmation test gets a seeded control that must fail.
- **No live secrets.** No provider account, secret, API key or real message enters the repository, the tests or the gate. No code reads, logs or records the environment.
- **Records.** Each ruling and each engine item found while building (from E13) is recorded in `decisions-m8.md` the day it is made.

## Conclusion

The fifteen issues are ruled. Workflows move under the gate first, with retries that never re-propose an allowed order and completions only the runtime delivers. `use` is lowered in general within a project. Taint waits for M10. Network code is confined to `poly-io` in both directions. M8 is split, and M8a starts with step 1.
