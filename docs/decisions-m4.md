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

## Conclusion

Building M4 and M5 alongside M3 saves calendar time without touching the experiment. The worktree keeps the frozen toolchain where the runner reads it, the merge waits for M3's result, and the stop rule keeps its force over everything built in the meantime.
