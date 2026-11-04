# poly v1.5.1: one rule for a file location, a bound on every wait of the demo driver, and one checkout

v1.5.1 is a bug-fix release on v1.5.0. It fixes findings 32 and 33 of `docs/examples/language-findings.md`, and retires the tree guard of M4-0 (S585), each under rule 7a: the specification first, then tests by a separate writer who had read only it, then the code. No format, command or verdict of v1.5.0 changes. `v1.5.0` is not moved. It is also the first release built and tested in the one checkout `C:\Users\jjdub\code\poly` on `main`, where the worktrees of earlier milestones were brought back.

## A `file:` location is read as written (finding 32, PT1.2)

**The fault.** `keyringsOf` read `people[].publicKey` and `agents[].publicKey` at `join(projectDir, PATH)`, so an absolute `file:` path was joined under the project. On Windows the joined path does not exist and the build fails. On POSIX it names another file, and if a PEM exists there admission certifies that key into the ring in place of the one named. The other `file:` locations (`keys.admission.location`, `run.trust`, `run.ledger.signer`) honoured an absolute path. A key file kept outside the project is the arrangement S126 asks for, and it was the one that failed. The poly-tau2 session found it.

**The fix.**

1. **Spec** (`d4d77eb6`). PT1.2 states one rule for every `file:` location in `poly.json`: an absolute path names that file as written, a relative path is read from the project's directory.
2. **Tests, by a separate writer** (`f1a36598`, `test/finding32-file-locations.test.mjs`). Eight tests, seven of which failed on v1.5.0. One plants a decoy PEM at the joined path and fails if it is read.
3. **Code** (`794a111c`). `fileLocation(dir, path)` in `packages/poly-core/src/manifest.ts` is the one rule. The keyrings, the admission key and `run.trust` and `run.ledger.signer` all use it.

One key named by an absolute path and by the relative path to the same file now gives the same key and the same rings digest.

## Every wait of the demo driver ends (finding 33, DB6 item 12, DAC32)

**The fault.** A full parallel run started `test/demo-driver-confirm.test.mjs` and the process was still running close to two hours later. The run never printed its totals. Alone, the file passes. `demo/driver/replay.mjs` had waits with no bound (the self-check's HTTPS requests, the `taskkill` in `stop()`), and the suite set no per-test timeout, so a stall could not be told from a long test.

**The fix.**

1. **Spec** (`cd040f43`). DB6 item 12 and DAC32 of `docs/proposals/demo-refund.md`.
2. **Tests, by a separate writer** (`fff3f9aa`, `test/demo-driver-bounds.test.mjs`). Sixteen tests, fifteen of which failed on the old tree; one is for POSIX only. The writer also read the bodies of the driver functions it tests, which `0a146f3d` records; its assumptions are `test/demo-driver-bounds.assumptions.md` (`e8e87d1e`).
3. **Code** (`23848b44`). The self-check's requests are bounded by `requestMs` (`selfCheckMs` in `replay()`), `taskkill` by `stopMs`, and the listen loop's attempts and the stand-in's close have bounds of their own. Every result carries a `cleanup` list, which `format()` prints, so a stop that did not finish is said and not hidden. The five driver test files take `test` from `test/fixtures/demo/driver-test.mjs`, with a per-test timeout of 300,000 ms (`POLY_DRIVER_TEST_MS` replaces it), so a stuck test fails under its own name.

**Fixed in part.** The finding also proposed a margin on `quietMs` and `maxMs` in `test/demo-driver-hygiene.test.mjs` for a loaded machine. The owner left it out on 2026-11-01, so that part stays open.

## One checkout, and the tree guard retired (S585)

Until this release the work lived in some twenty worktrees, and `C:\Users\jjdub\code\poly` was still on `archlens`, a line older than v1.4. It is now on `main`. The worktrees whose branches were merged and that held no uncommitted change were removed; no branch was deleted, so every commit stays reachable. `C:\Users\jjdub\code\poly-e3`, where `main` was checked out, is now a directory junction to the one checkout, so the paths that named it still resolve.

The first release run on that checkout failed two tests, `test/tree-guard.test.mjs` and M6 step 1 of `test/check-memory.test.mjs`, and both were the tree guard of M4-0 doing what it was built for: it refuses a script that writes files when the repository is `C:\Users\jjdub\code\poly` or the branch is `main`. M3 closed on 2026-10-04 and is reproduced from its freeze commit `b8a8cfb`, so the guard protected nothing, and since `m4` was merged it had made thirteen scripts refuse on `main` everywhere.

1. **Ruling** (`30640128`). S585 in `docs/history/decisions-m4.md` retires M4-0 rules 1, 2 and 5 and removes the guard.
2. **Tests, by a separate writer** (`7b47b059`, `test/s585-tree-guard-retired.test.mjs`, replacing `test/tree-guard.test.mjs`). Seven tests; four failed on the old tree, among them two that run former callers from a checkout on `main`. One is a control on another branch, one a guard that the thirteen scripts still exist. A checkout at the path itself cannot be built in a temporary folder, so the path rule is covered by checking that no script refers to the guard.
3. **Code** (`152804f9`). `scripts/tree-guard.mjs` is deleted, and the thirteen scripts lose its import and call. The seven tests and `check-memory` pass, 8 of 8.

## The test runs on v1.5.1

At `152804f9`, through the suite's command, with nothing else heavy on the machine, on Node 24.12.0.

- **The main suite:** 4,321 tests, 4,310 pass, 3 fail, 4 skipped, 4 to-do (`M4c` and its siblings, waiting on E1). The three failures are `(c1)`, `(c2)` and `(c3)` of `test/demo-driver-hygiene.test.mjs`, the part of finding 33 left open. They are on the failure lists of v1.3.1, v1.4 and v1.5.0. Run alone at the same commit, the file passes 15 of 15.
- **The serial after-suite** (`test/after`, one file at a time), at `f2fb10b7`: **155 tests, 154 pass, 1 fail**, in 14,897 s, with 3 real demo admissions. The failure is DF19 item 6 of `test/after/ex-concierge-ledger.test.mjs`, which reached its own timeout of 600 s while other work ran on the machine. Alone, with nothing else running, it passes in 304 s. No file of the after-suite reads anything S585 changed, so the run holds for `152804f9`.
- **A first main run that is not counted.** At `f2fb10b7` the first run was launched from a shell whose PATH had no `openssl`, which the demo's throwaway authority runs. It gave 4,319 tests and 78 failures: 76 were `spawnSync openssl ENOENT`, and the files that hold them pass with `openssl` on the PATH (154 tests, 152 pass, 0 fail, 1 skipped, 1 to-do); the other two were the tree guard, above.

## Known limits

The limits of v1.5.0 hold (`docs/release-notes-v1.5.md`). One more:

- **The hygiene file's waits are wall-clock.** `(c1)` to `(c3)` of `test/demo-driver-hygiene.test.mjs` can fail under load and pass alone, as on v1.3.1 to v1.5.0, and as in this release's run (finding 33, the part left open).
- **The demo needs `openssl`.** The throwaway authority runs `openssl` from the PATH; a test run launched without it fails every test that starts a stand-in.
- **DF19 item 6 is close to its timeout under load.** It takes 304 s alone and has a bound of 600 s; on a busy machine it can fail by time alone, as on 2026-10-30 and in this release's run.

## Conclusion

v1.5.1 changes no format, command or verdict. It reads a key file where `poly.json` says it is, on every platform and in every field. It bounds every wait of the demo driver and names a stuck driver test instead of hanging the run. And it brings the work back into one checkout on `main`, which showed that a guard from M4 still refused that checkout, so the guard was retired by a ruling and a test before the code. The four failures of the release runs are all of one kind: tests that wait on the clock and pass alone, three of them the open part of finding 33. The tag is local; the push waits for the owner.

## Glossary

- **`file:` location:** a field of `poly.json` that names a file by `file:PATH`; absolute as written, relative from the project's directory.
- **Rings digest:** the digest of the people and agent keyrings an admission certifies (PT12.5).
- **Bound:** the longest a wait of the driver may last before it gives up and says so.
- **Cleanup list:** the entries of a `replay()` result that name a stop or a close that did not finish.
- **Tree guard:** the M4-0 module that refused a writing script in M3's experiment tree or on `main`; retired by S585.
- **Environmental failure:** a test that fails under the suite's load and passes alone, on the same commit.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
