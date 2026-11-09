# poly · Decisions: how the work is run

*Cognitive Fab · November 2026 · rulings on the way poly is built by its owner and coding agents, not on the language*

The language's rulings live in the other `decisions-*.md` files. This file records the owner's rulings on the working practice: how a change is ordered, tested, closed and handed over. The rules themselves are in `CLAUDE.md`, under *How the work is run*, each citing the ruling here. A rule the owner gives in conversation is recorded here before it is relied on, so that no rule lives only in a conversation or in one agent's memory.

## The rules given before this file (owner, 2026-10-31 to 2026-11-07)

Each was given in a session and kept until now in the agent's own memory, outside the repository. They are recorded here as they were ruled.

| Rule | Ruled | Why |
|---|---|---|
| Rule 7a The order of work: the specification first, committed alone; then failing tests by a separate writer who has read only it; then the code. | 2026-10 (the M8 plan, `docs/history/plan-m8.md` section 7a, "semantics first" and "fail first"); its present form, with the separate writer, in `docs/history/plan-demo.md` (2026-10-14) | A test written by the code's author tests what the author built, not what the specification asks; a spec committed alone is the record the tests and the code are judged against. |
| W1 The separate test writer of rule 7a runs on the session's model, never Haiku. | 2026-10-31 | A writer for DF27 ran on Haiku 4.5; its tests needed three rounds of fixes (an inverted assertion, a syntax error, contradictory asserts), and it signed the commit with a Haiku trailer. On 2026-11-06 a writer launched without a model came up on Haiku, since this account's default subagent model is Haiku. |
| W2 The full suite runs only at the owner's word. Targeted test files need no ask. | 2026-11-01 | agentapp writes `~/.poly/anchors.json` and trips the home guard, and a loaded machine stalled a driver test (finding 33); the owner makes sure other work is idle first. |
| W3 Nothing heavy runs beside a test group: no build, no other test file, no fan-out of agents. | 2026-11-03 | The v1.5.1 serial group's DF19 item 6 reached its 600 s bound while builds and agents ran beside it. |
| W4 Full-suite and serial-group runs go on the AMD box, not the laptop. | 2026-11-07 | The laptop's overnight v1.6.0 run ran short of memory, and three after-group tests reached their bounds. |
| W5 Work happens in `C:\Users\jjdub\code\poly`, on `main` or a branch there, never in a sibling worktree. | 2026-11-03 | The worktrees were brought back into one checkout, and a review hook (polywatch) reviews each turn there. |
| W6 Processes on the AMD box are stopped by the owner, not by an agent. | 2026-11-06 | A stop through the agent was refused by the session's permission classifier; the owner runs it. |

## S590 Working practice after S.A.W. (owner, 2026-11-09)

The owner asked what poly's working practice could learn from S.A.W. 3.2 ("SDD Another Way", odahan, `github.com/odahan/SAW-SDD-Another-Way`) and from TeamSparkAI's Spec-Agent Workflow, without moving poly toward spec-driven development: the semantics stays the authority on what a program means, and the program is checked against itself. Five practices were adopted.

- **W7 One status file.** `STATUS.md` at the repository's root is the one record of work in flight: each open branch, its state, its next action and what blocks it, and each open item with its destination. It replaces the paragraph that grew in the agent's private memory, which no other agent or person saw. A session resumes from it, not from conversation memory. Measured in the sessions before: a context compaction left the state to be rebuilt from a summary, and the memory paragraph once had its backslashes corrupted.
- **W8 Process rules in the repository.** Every rule of working practice is in `CLAUDE.md` with an id, and its ruling is in this file. A rule given in conversation is written here and there before it is relied on.
- **W9 Closure with convergence.** A finding or a ruling that closes ends with a **Convergence** part: each requirement or acceptance id is either met, with its evidence, or a deviation, with who accepted it; and each open item has a destination: resolved, a ruling (S-n), a finding (n), a release, discarded with a reason, or waiting for the owner, naming the decision or the action it waits for. No item is left as "not built" with nowhere to go. Measured: finding 35 closed with three tests not built and two questions left to the specification, with no destination for any of the five.
- **W10 A parallelism contract, and the status last.** Before a second agent works in the checkout (the separate writer, a reviewer, a fork), the agent that starts it writes in the request who owns which paths and what each must not do until when; by default the writer owns its test files and the author writes no code and runs no build until the writer's commit has landed. In an operation of several steps (merge, test, tag, push), the decision is recorded first, what is replaced is kept, and `STATUS.md` is written last; after an interruption, what was written is compared with what was decided. Measured: on 2026-11-08 the code of `poly rules` was built while the writer was confirming its tests failed, which spoiled the failing-first evidence and was recorded as a departure; and a box run started on the wrong commit because a fetch into a checked-out branch was refused and the script went on.
- **W11 Test diffs reviewed.** A change to an existing test is read diff by diff before it is committed. A removed or loosened assertion, a widened pattern, a new skip or to-do, a raised timeout or a changed expected value is named in the commit message with its reason. A change by the code's author to the separate writer's tests is a departure from rule 7a and is marked so. From TeamSparkAI's workflow: an agent that fixes a failing test can remove the check the test made.

**Not adopted.** S.A.W.'s six global files and four per lot, its mandatory history log, its single active lot per project, and the spec as the authority on the result. Git history and commit messages already hold the log, branches run in parallel by the owner's choice, and in poly the semantics, not a spec of the change, is the authority.

**Convergence.** W7 to W11 are written in `CLAUDE.md` and this file. `STATUS.md` is created with every open branch and open item known on 2026-11-09, each with a destination; items whose destination is the owner's to choose say so. W1 to W6 move from the agent's memory to `CLAUDE.md`. Nothing else is open.

## The old branches (owner, 2026-11-09)

Seven branches were not merged into `main`. Each was read against `main`, and the owner approved this plan:

- **Archived first.** Each branch tip below is tagged `archive/<branch>` and the tags are pushed, so every commit stays reachable once its branch is gone.
- **Dropped:** `aside-measure-verdicts` (all its changes are in `main`), `cleanup` (its one change is `a4d0200d`), and `archlens` (10 of its 12 distinct changes are in `main` as cherry-picks; the other two, the v1.1.0 architecture analysis and the S570 update, are superseded by `main`'s later architecture documents).
- **Merged:** `proposal-extensions` (proposal 28 and S584, for v2.0) and `v1.4` (the VS Code adapter, its PT14 text and test, and `docs/proposals/v2.0-ideas.md`).
- **Taken in part from `public-ready`:** LICENSE (Apache-2.0, as every `package.json` declares), NOTICE, SECURITY and CONTRIBUTING, the last brought up to date. Left out: its v1.3 README status, the v1.3.1 skill and its reference files (`poly guide` now does that work), and its frozen README for the demo baseline (`main` edits the baseline's reference instead, since ba69a88e). Then dropped.
- **Kept and pushed:** `agentlab`, the Agent Lab demo, pushed to GitHub as a branch for safekeeping; it stays the owner's work in progress.

## Conclusion

The working practice is now in the repository, where every agent and every person reads it: who decides, in what order a change is made, how it is closed, and where the work stands. It borrows S.A.W.'s discipline for state, closure and parallel work, and leaves its ceremony and its spec-driven premise aside.
