# poly · Decisions for milestone M6

*Cognitive Fab · October 2026 · the owner's rulings on `plan-m6.md`, recorded on branch `m4`*

## The plan's issues, S164 to S171

| Issue | Ruling |
|---|---|
| **S164** Which runtime runs a workflow | **Accepted, with the limit stated.** For M6 a workflow is checked and lowered by poly and run by polyflow. PT10 says so, and the certificate lists every workflow as `ungated: polyflow runtime`, so it never reads as covered by the gate (PA0.4): G5 says every effect crosses the gate, and workflows run on polyflow are an exception. Running workflows on `poly-runtime` is added to PT18 as a named item before the v1 release, at the latest with M8, since channels need the gate. E9 stays optional. |
| **S165** A workflow's files and bounds | **Accepted.** |
| **S166** Workflow checks | **Accepted**, with the codes `PL6801` to `PL6803`. The v1 proposal's channel codes move in its next revision; that is the owner's, not M6's. |
| **S167** The host-neutral core | **Accepted.** |
| **S168** The language server and the two surfaces | **Amended.** M3's report applied the surface rule, and the answer was embedded (`docs/m3/report.md`, section 2.1, "The surface rule"). The language server gives full support on both surfaces: diagnostics, formatting where it applies, and code actions for typed fixes. If the typed fixes for embedded modules (S70) do not exist yet, they become M6 work, tested first. Whether the standalone surface stays in v1 is a separate decision, not M6's. |
| **S169** `poly new` and the model | **Amended: no per-token API spend.** MCP sampling (the client's model) is the primary provider. The second is a command-line provider that runs Claude Code headless under the user's own login (the Max subscription), as the M3 runs did. An Anthropic API provider may exist behind the interface, but it is not the default, is configured nowhere in the repository, and is used by no test and not by the gate. No provider reads, logs or records an API key or the environment. Tests use the recorded provider only. Five rounds: accepted. |
| **S170** Two hosts in the gate | **Accepted.** M6 may close on the Claude Code half. The DeepSeek Harness half is listed as waiting until the owner declares its plugin API stable. |
| **S171** Commands through the language server | **Accepted.** |

## S172 and the AC5 finding

**S172 accepted, with the code `PL6804 WORKFLOW_UNCHECKED`.** A workflow whose machine declares no path property is REFUSED by `poly check`. The diagnostic sits at the workflow line and says that polyflow admits only workflows whose machine has at least one path property. It mirrors polyflow's rule exactly and goes no further: requiring a property per effect kind would be a separate proposal. No fix is attached, since the checker cannot invent a property for the author. The interim `ERROR` goes. S165 is amended in the spec: a workflow's machine always has `effect-invariants.mjs`, and `PL6804` guarantees its list is never empty. Built with a test that failed on the interim `ERROR`, and an error source for the code.

**AC5 accepted.** The deny-path difference stays named in the test.

**E12 (polyflow, for the owner's engine list).** polyflow's example workflow `customer-brief` breaks its own contract on the deny path: its contract declares `DENIED`'s `reason` as only `"not-ready"`, and a denied approval reported with free text writes that text into `reason`. The defect is in polyflow's example, not in poly. The vendored copy is not changed.

## Steps 5 and 6, and S167 amended

**Steps 5 and 6 accepted**, with the gate fixes in 1445bef: the new scripts call the tree guard (the standing rule doing its job), and an account-independence run has 30 minutes. With the next gate counts, the measured time of each of that test's two child runs is reported, inside the gate and alone; if the gap keeps growing, the test runs after the rest of the suite instead of the limit being raised again.

**S167 amended.** The registry stays in `packages/poly-check/src/commands.ts`, next to the command line, and `poly-agent` re-exports it: the `poly` binary, its tests and the frozen M3 runner all point there, so moving it would touch frozen paths. The boundary rules apply to the registry unchanged: it imports no host name and no host SDK.

## A test defect found under gate load: the M3 cleanup cap test

**Ruled.** M3 is closed, and its tests now belong to the toolchain, which may change after the close; the runner stays frozen and untouched. The test is fixed in M6.

**The defect.** `test/m3-cleanup.test.mjs`, "a run a cap stops ends the CLI and everything under it, at once, and lists them as leftovers", failed in the gate after the account check moved after the suite (1,419 tests: 1,413 passed, 1 failed, 1 skipped, 4 waiting), and again in the rerun. The run's 4-second wall cap is counted by the runner from the turn's start, and under the gate's load the launcher had not yet started the stand-in CLI when the cap fired, so only the launcher was listed where at least two are expected.

**Reproduced first.** A version that holds the launcher suspended for 6 seconds once the job holds it (`test/fixtures/suspend.ps1`) fails every time, listing only the launcher, as in the gate.

**The fix.** The stand-in CLI signals that it is ready (a marker file, once it has started and left its process), and the test starts the cap's clock only at that signal: until then the clock the runner reads stands still. The assertion is unchanged: at least two leftovers, all ended. Both cap tests, the original and the suspended version, pass with it.

**The rest checked.** No other M3 cleanup test has a cap or a timeout that can fire before a child process has started: the other runs there have a 600-second cap and turns that end by themselves, `endsOnce` assigns a process that already exists, and `hostFailsFast` waits up to 30 seconds for a failure that comes at once.

## Step 8, and the rules for step 9

**Step 8 accepted, with one change to its test.** `claude plugin validate` runs with `CLAUDE_CONFIG_DIR` at a stand-in folder the test creates and removes, so the gate never reads or writes the owner's own Claude configuration; where `claude` is not installed, the check is listed as not run, never as passed. Built with a test that failed first.

**Step 9 approved, with one rule.** The headless Claude Code provider refuses to start when an Anthropic API key variable is present in its environment: it checks only that the variable is present, never reads or logs its value, as the M3 runner does, since a key would move billing from the owner's subscription to per-token spend. The refusal is tested with a stand-in variable name in a child process, never a real key. As ruled: tests use only the recorded provider, no provider runs in the gate, and nothing reads or records the environment.

**Gate reports** include the per-file timings: the ten slowest files and the suite's total.

## Step 9, the gate after it, and the closing gate

**Step 9 accepted.** The DeepSeek Harness half is not waited for: its plugin API is not declared stable, so per S170 it is listed as waiting in the M6 record, and M6 closes on the Claude Code half.

**The gate after step 9 accepted** (0b0a29e: 1,432 tests, 1,427 passed, 0 failed, 1 skipped, 4 waiting; 36 min 19 s). Its times rose because another session's economy simulation ran on the same machine from 18:58, during the last part of the suite and all of `test/after/` (the account check's child runs took 964 s and 998 s, against 231 s alone). Nothing is attributed to code until the closing gate gives an idle-machine comparison, file by file.

**The closing gate** runs only when the machine is otherwise idle: no other session's simulation or gate is running, checked and recorded first. It is compared file by file with the gate after step 9.

**The timing writer needs no guard.** `.poly/` is build output, not experiment evidence, and `npm test` must keep working on `main`, where the tree guard refuses to run. `test/reporters/file-times.mjs` writes nothing itself; `node --test` writes its output to `.poly/file-times.json` and `.poly/file-times-after.json`.

**The provider fixes have tests** (196340d). The rule bars a real model and a real `claude` from tests, not tests of the launcher: a stand-in `claude` (`claude.cmd` on Windows) on a PATH the test builds echoes its stdin, and exits early in a second case. Both tests failed against the provider before 4ecddf8 and pass now; with a stand-in key variable present, the stand-in is never started.

## Step 11: the review and the closing gate

The code review's 26 findings are fixed, each with a test that failed first (7ad6bfb, ea4075c, 9190006, f29118d), and recorded in `plan-m6.md` section 10. The closing gate ran from a clean build at 9561785 on an otherwise idle machine, checked before it started and watched while it ran: 1,464 tests, 1,459 passed, 0 failed, 1 skipped, 4 waiting, in 16 min 5 s, with the account check's child runs at 206 s each. Compared file by file with the gate after step 9, the earlier rise was the machine's load; nothing is attributed to code. M6's close and the merge of `m4` into `main` wait on the owner's ruling.

## M6 closed

**Ruled: closed, on the Claude Code half.** The closing gate is green on an idle machine, the 26 findings are fixed with tests that failed first, and the comparison file by file shows that the earlier rise came from the machine's load. The DeepSeek Harness half stays waiting (S170).

- **The gate:** at 9561785, from a clean build: 1,464 tests (1,463 in the suite, 1 in `test/after/`), 1,459 passed, 0 failed, 1 skipped (S152's OpenShell enforcement, with no gateway configured), 4 waiting, in 16 min 5 s; the account check's child runs took 206 s each.
- **Docs only after the gate.** `git diff --stat 9561785..HEAD`, taken before the merge, lists `docs/history/decisions-m6.md` and `docs/history/plan-m6.md` and nothing else, so the gate at 9561785 covers every change of code and test merged.
- **The limits, as stated:**
  - Workflows run on polyflow, outside poly's gate, until they move to `poly-runtime` before v1, at the latest with M8 (S164, PT18).
  - The DeepSeek Harness half is waiting until the owner declares its plugin API stable (S170).
  - The language server, `poly fmt` and `poly fix` refuse a module holding a construct the parser skips (`PL0901`, a `world` or a migration), and offer it no formatting or fix, until that construct is lowered (review C-F3).

**The four waiting tests**, each with its engine item. None moved and none changed status: the same four waited in the gate after step 9, and in M5's gates.

| Test | File | Engine item | Why it waits |
|---|---|---|---|
| M4c across an archive: a late duplicate after the receiver is purged (K4) | `test/runtime-delivery.test.mjs` | **E1** (polyrun tombstones at archive, S124) | polyrun 8.3.2 dead-letters the duplicate. The test runs and fails as expected, and is reported as waiting. |
| polyflow's own verifier accepts poly's chains once E2 is vendored (S122) | `test/runtime-journal.test.mjs` | **E2** | polyflow's `KINDS` refuses `step`, `advice`, `decision` and `outcome`. |
| S153: `rt.createFrom(configuration)` creates each instance at its certified initial values | `test/config-instances.test.mjs` | **E5** (polyrun create at given initial values, S141, S153) | polyrun cannot create an instance at given values. |
| S160: a cross-scope send between configuration instances, end to end | `test/config-instances.test.mjs` | **E5** | there are no configuration instances in the runtime before S153. |

The report of this gate, and the record of it in 0fecd3d, named only E1 and E5. That was an error in the summary, not a change: the gate's output names all four, and the E2 test is unchanged and still waits on E2. `plan-m6.md` is corrected.

## m4 merged into main

**Ruled and done.** The main tree at `C:\Users\jjdub\code\poly` was clean on `main` at 34305c8, with no lock file and no file written in it in the two hours before. The only processes holding it were an editor's TypeScript language server, which writes nothing. `git merge --ff-only m4` moved `main` from 34305c8 to 40b2a98, `m4`'s HEAD, with no merge commit: `main` was an ancestor of `m4`. The gate at 9561785 covers every change of code and test merged, since only `docs/` changed after it.

**The freeze.** `node experiments/m3/freeze.mjs --check` on `main` at 40b2a98 lists two parts as changed: `examples` (the four files under `examples/evidence`) and `toolchain` (poly's package sources, the vendored engines and `package-lock.json`, 163 files in all with `examples`). Both are expected parts. Every evidence part reports no change: the tasks T1 to T10 at every version, P1, O1-R, O1, the O1 prompt, `template`, `controls`, `adapter`, `runner and prompts`, `analysis`, `manual` and `arm 2 polygraph`, as the standing rule of `decisions-m3.md` requires. `toolchain build` also reports no change.

**`toolchain build`: two results, unexplained.** At 34305c8 the check listed `toolchain build` as changed (`decisions-m5.md`); after this merge it reports no change. What was checked: the part hashes each package's `dist` and `node_modules/typescript` in the main tree (`freeze.mjs`, line 84); the main tree holds a built `dist` (`packages/poly-check/dist` has `src` and its `tsconfig.tsbuildinfo`); a merge does not rebuild it; the check was run once after the merge, with the tree clean before and after. Why the same tree's build output matched the freeze this time and not at 34305c8 was not found. It is an expected-to-change part, so it blocks nothing; by the owner's ruling it is recorded and not pursued now.

**Fast-forwarded again.** After the owner's v0.2 revision of the v1 surfaces spec was committed on `m4` (93f4a79, `docs/proposals/` only), `main` was moved from 40b2a98 to 93f4a79 by `git merge --ff-only m4`, with the same checks: the tree clean, no lock file, and the only files written since the first merge were that merge's own (all at 21:10:37). Every commit after 40b2a98 changes `docs/` only.

## Changes to the plan

- **Step 0.** `main` is already merged (34305c8, which contains `m4`'s merge), and `m4` is at it; the merge is dropped from the step.
- **The M3 runner test risk** is removed from the plan's risks: it is fixed (`plan-m5.md` section 11).
- **A measurement step** for the two findings left open from M5: memory per file checked in one long process, and the 53-second program. Measure first. If a leak is confirmed, fix it with a test that fails first; otherwise record the measurements. M6's close does not depend on a speed-up.

## Recorded with the rulings

- **Embedded typed fixes exist.** `poly fix` already applies a typed fix to an embedded module: the edit is made on its AST and the changed node is reprinted and spliced in at its span (`packages/poly-check/src/fixes.ts`, M3-3). M6's language server offers them on both surfaces, and its tests cover each surface; a fix kind found missing on the embedded surface becomes M6 work, tested first.
- **PT10 and PT18** now state S164's limit and the named item.

## Conclusion

M6 is ruled: workflows run on polyflow with their limit stated and its removal scheduled, the agent interface is one host-neutral core, the language server serves both surfaces fully, `poly new` spends no per-token API money, and M6 closes on the Claude Code half.
