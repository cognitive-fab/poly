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
| **Total, 5 runs** | | **2** | **1** |

## S178 in detail, ruled

**Accepted (2026-10-05).** PS5.2 and PS5.2a as proposed, with all five choices: `while` reads the pre-state; a never takes a name; `emits` names effects only; a filter compares a field with a constant; the lowering reads the step's intents through the effects mapper. The text is written into `04-semantics.md` first (f5df1f1). Three test requirements:

- **Choice 1 both ways.** A step from an open window that writes it open and sends is allowed; a step that sends from a closed pre-state, even if it opens the window in the same step, is a finding. (The proposal's wording, "a step that opens the window and sends is allowed", read as a step from a closed window; the ruling's two cases are the ones tested, and PS5.2a's text says the rule directly.)
- **Unconstrained witnesses, both outcomes.** One confirmed by the configuration check, and one ruled out by it, which then does not count as a finding.
- **Out-of-scope kinds.** `emits` on a send, a timer or a spawn is `PL1001`, with a test for each.

Seeded faults: a never dropped, its `while` inverted, a field filter dropped, and `while` evaluated on the post-state. After step 5, M8a's steps are done: the M8a record, the review, and the closing gate on a quiet machine, with the failure-count totals.

## Engine changes

- **E10** (polyaxion) is on the engine list, in M8 for the `channel` proposal field only; per-value taint waits for M10 (S181). If polyaxion cannot take it, PT27.2's fallback applies, and the certificate lists the check as poly's, not the gate's.
- **E11** is not needed in M8 (S184).
- **E9** is withdrawn (S175).
- **E5** stays on the list and is not needed by M8 (S177).
- **E12** is unchanged.
- An engine item found while building gets the next id, from E13, and is recorded here the day it is found.

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
