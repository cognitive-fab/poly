# poly v1.5 · Release notes (checking faster)

Not tagged. This document is the draft for the owner's approval; the tag and the push wait for it.

## What v1.5 is

v1.4 shipped ten examples on the language and runtime of v1.3.1. The largest program written with poly since then, agentapp's (nine machines, ten configurations), showed where the check's time goes. Its build ran 18 `poly check` processes and took about 176 minutes, and most of that was the same machines checked again in every process. v1.5 removes the repetition without changing any verdict:

- `poly check` keeps a **result cache**;
- it checks **chosen configurations** (`--config`);
- it checks **goals**, the paths a configuration is meant to cover (`--goals`, `PL5410`);
- it checks **seeded defects** in memory (`--defects`).

The suite's own demo tests stop admitting the same concierge again and again: each distinct source is admitted once per test run (DF27).

**How it was built.** On the branch `check-speed`, cut from v1.4.0 (`f469b560`, which is `origin/main`): 28 commits, `87f8ec6a` to `f72f0979`. Every change followed rule 7a: the spec first, committed alone; then tests by a separate writer who had read only the spec; then the code.

## The result cache and the new options of `poly check` (PT14a, PS13.10)

- **`--config a,b`** checks every machine, then only the configurations named. A configuration left out is listed as not run (`not selected with --config`), and the verdict is the fold over what ran. A machine's `never` finding is ruled out only when every configuration that includes it ran, so one left out keeps the finding.
- **The result cache.** A machine's result from `validate()` onward, and a configuration's result, are stored under a key and read back when the key recurs.
  - **Where:** `.poly/cache/` beside the source (or the project), `--cache <dir>` to share one between processes, `--no-cache` to neither read nor write. `POLY_NO_CACHE=1` turns the command line's default off.
  - **The key** is the SHA-256 of the canonical JSON of everything the result depends on: the bytes of the built toolchain and of `std/`, the options, and the machine's or configuration's own declarations with what they use. It holds more than strictly needed; a key that missed an input would change a verdict.
  - **Never cached:** the parse, the types and the lowering, which run on every check, so `.poly/build/` is always this check's; policies.
  - **Integrity:** an entry is written whole and renamed; an entry that does not parse, or whose recorded key differs, is a miss and is checked again.
  - **The verdict never depends on the cache.** Warm, cold and `--no-cache` give the same findings, witnesses and instances. Only the command line reads a cache. `poly admit`, the language server and the suite do not, so a certificate never rests on a cached result, and the release gate runs without one.
- **`--goals <file>`.** A goal is a predicate on a configuration's global states, written like an invariant and expected to fail: it names a path the configuration is meant to cover (PS13.10). Each goal joins its configuration's exploration and is printed `reached <name> (<n> global steps): <path>` or `NOT REACHED <name>`. **`PL5410 GOAL_UNREACHED`** is new: a goal no explored state reaches makes the configuration, and the check, `INCONCLUSIVE` (exit 2). A goal is not a finding, and a configuration's own verdict is the same with or without goals.
- **`--defects <file> [--only a,b]`.** Each seeded defect's edits are applied in memory, and the patched program is checked through the cache in the configurations its `keep` lists.
  - A machine the patch leaves alone is read from the cache.
  - The unpatched program is checked once for each distinct `keep` list, and a finding it reports too is set aside, not counted as the defect's (ruled 2026-10-30).
  - Each defect prints `found` or `NOT FOUND`. The exit is 0 when every defect is found and 1 when one is not.
- **Side by side.** No check package starts a process. A host that wants checks in parallel starts several `poly check` processes on one `--cache`. The README's "Checking a large program" shows the commands.

**Measured** on agentapp at `5842383` (2026-10-29): one process at a time, a 22-CPU Windows machine, nine machines, ten configurations, 32 goals, 17 seeded defects.

| Step | What it checks | Time |
|---|---|---|
| without the cache | every machine and configuration, `--no-cache` | 1,289 s |
| cold | the same and the 32 goals, filling the cache | 1,219 s |
| warm | the same again | 2.2 s |
| one machine changed | Stock and the four configurations that run it | 190.5 s |
| one defect in Stock | `stock-oversold`, kept in `two-orders` | 5.6 s |
| one defect in Order | `cancel-keeps-reservation` | 418.1 s |

The cold and warm reports agree with the one made without the cache, and every goal is reached.

## The demo is admitted once per source in a test run (DF27, DAC31)

Every demo test assembled the concierge and admitted it, which is a full check. In v1.4's serial suite a test that assembles once took 630 s to 940 s. Now a test run keeps each admission in a store under the system's temporary folder, keyed by:

- the run;
- the project;
- the bytes of the source;
- the handlers;
- the toolchain digest.

Every later call for the same key gets a copy.

- **One run id per command.** The suite's `test` script starts each `node --test` command through `scripts/test-run.mjs`, which sets one new `POLY_TEST_RUN` for it. The runner of `node --test` does not load the suite's preload (measured on Node 24.12.0), so the first build, which set the id in the preload, shared only within each file (DF27 item 10).
- **A run by hand** (`node --test` without the script) shares within each file: correct, only slower.
- **Cleanup.** When its command ends, the script prints `poly-demo-admissions: run <id>, <n> admissions` and removes that run's store. Before it starts, it removes any store older than seven days.
- `POLY_DEMO_ADMISSION=fresh` makes every call admit afresh. A source a test changes is another key, and is admitted on its own.

The eight demo files, each run alone on the machine with the suite's command (2026-10-31):

| Admission | Real admissions | Total |
|---|---|---|
| Fresh (`POLY_DEMO_ADMISSION=fresh`) | one per call | 8,067.9 s |
| Shared within each file (the first build) | 9 | 3,456.7 s |
| Shared across the run, through the test script (`28f0926b`) | 3, one per distinct source | 1,448.6 s |

All 39 demo tests passed in all three runs, and each test's result was the same in each. DF27 item 10 has the times per file.

**DAC13.** The release run's main suite found that the two files of the shared admission read the environment (`POLY_TEST_RUN`, and `POLY_DEMO_ADMISSION`) and were not on the test's list of code that may. Neither variable is a credential, so the spec (DF27 item 12, `e3e641ae`) and then the test (`f72f0979`, by the separate writer) put both files on the list. The file passes 6 of 6.

## The test runs on v1.5

At `c52082d6`, through the test script, with nothing else started on the machine (idle at 1.1 of 22 cores before the start).

- **The main suite:** 4,294 tests, 4,275 pass, 12 fail, 3 skipped, 4 to-do (`M4c` and its siblings, waiting on E1). The 12 failures:
  - **One real, now fixed:** `DAC13` (`test/demo-secrets.test.mjs`), above. Rerun at `f72f0979`: 6 of 6.
  - **Eleven environmental, from load on the machine:** the Docker replay cases of the four driver files. Run alone at `f72f0979`, the four files pass 73 of 73, these eleven among them.

    | File | Failed in the suite | On v1.4.0's own failure list |
    |---|---|---|
    | `test/demo-driver-confirm.test.mjs` | `B2`, `B7`, `B10` | `B7`, `B10` |
    | `test/demo-driver-hygiene.test.mjs` | `(c1)`, `(c2)`, `(c3)` | all three, as in v1.3.1 and v1.4 |
    | `test/demo-driver-timeout.test.mjs` | `DB6.11a`, `DB6.11b`, `DB6.11d` | all three |
    | `test/demo-driver.test.mjs` | `DAC8, O1`, `DAC8, O2` | both |

    Ten of the eleven also failed in the main suite of v1.4.0 run on the same machine. `B2` did not fail there; it drives the same replay double as `B7` and passed alone. Which cases of these files fail under load varies from run to run: v1.4.0's list also holds `B3`, `B4`, `B6` and `DAC9`, which passed here.
- **The serial after-suite** (`test/after`, one file at a time): **155 tests, 155 pass, 0 fail**, in 12,110 s, with 3 real demo admissions. The last branch run before DF27 took about nine hours. `test/after/ex-concierge-ledger.test.mjs`, which timed out under load on 2026-10-30, passed both tests.

## Known limits

- **A defect in a large machine pays its effects stage again.** polyrun's `check-effects` costs time linear in a path's depth at each step. On agentapp it is 740 s of the 1,289 s check (Order 387 s, Incident 318 s, Run 35 s), and Order and Incident stop at its 50,000-path cap. It is the engine's to lower; filed as `cognitive-fab/polygraph#4`.
- **agentapp's program is `FINDINGS` on v1.4.0 and v1.5:** `PL4003 UNGUARDED_RETRY` on Run's `publish`. agentapp's own toolchain predates `PL4003`. The changes agentapp needs are given to its own session after the release; poly does not edit agentapp.
- **The cache is the command line's.** The registry's `check` (MCP and the language server) uses one only when its input names one, and `poly admit` never does.
- **Defects are checked one after the other in one process.** Parallel checks are several processes on one cache, started by the host.
- **The shared demo admission is for the suite.** Without `POLY_TEST_RUN` (the launcher, any host) every admission is fresh, as before.
- **A demo store left by a run by hand** stays in the temporary folder until a scripted run starts seven days after it last changed.

## Conclusion

v1.5 makes the check cheap to repeat without making it cheaper to trust. The same program gives the same findings with the cache, without it, cold or warm, and nothing that certifies a program reads it. On agentapp a warm check takes 2.2 s instead of about 21 minutes, a changed machine pays for itself and the configurations that run it, and a seeded defect pays only for what its patch changes. The suite's demo tests share one admission per source, and the serial after-suite now takes 3.4 hours instead of 9. Two things were found on the way and fixed in the usual order. The run id never reached the files of one run, which a measurement showed. The new code read the environment without being on DAC13's list, which the release run showed. Both rest on a spec ruled before the tests and the code. The tag and the push wait for the owner.

## Glossary

- **Result cache:** the stored result of a machine's or a configuration's check, read back when its key recurs; it never changes a verdict.
- **Key:** the SHA-256 of the canonical JSON of everything a result depends on, the toolchain's bytes among them.
- **Goal:** a predicate on a configuration's global states, written like an invariant and expected to fail, which names a path the configuration is meant to cover; reached, or `PL5410 GOAL_UNREACHED`.
- **Seeded defect:** a change applied to the program in memory, with the finding the check is expected to report for it; `found` or `NOT FOUND`.
- **Set aside:** a finding of a defect's check that the unpatched program reports too, and so is not the defect's.
- **Admission:** the full check and certificate of a project (`poly admit`); the demo's assembly admits the concierge.
- **Test run:** one `node --test` command started by `scripts/test-run.mjs`, with one `POLY_TEST_RUN`.
- **Environmental failure:** a test that fails under the suite's load and passes alone, on the same commit.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
