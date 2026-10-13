# E3.7: the twelve offline tasks and their stage checks

*Cognitive Fab, October 2026. Written as the light work of E3.7, before any task is built. Nothing here has been run.*

Status: a specification, with the owner's rulings of 2026-10-12 on its three questions applied (section 6). It follows the ruling on Q-E3-3 (the tasks come from the owner's small personal repositories, with a check per stage, read-only on the originals, each copied into a scratch folder, a negative result at that size reported as inconclusive).

## 1. What a task is

A task is a small piece of work in a repository, with a plan of two to four stages, and a check for each stage. The harness's `Trial` machine carries the plan's length (`Begin(cx, n)` with n in 2 to 4); each stage ends in one `tool.stage-check`, whose completion is `StagePassed` or `StageFailed`; the scorer (`host/score.mjs`) reads those completions from the journal (HF2.7, HAC7).

A task is a directory, `examples/harness/tasks/<id>/`, of:

| File | What it holds |
|---|---|
| `task.json` | the id, the repository and the commit it is taken from, the language, the prompt the agent is given, the plan (2 to 4 stage titles), and for each stage its check: a list of commands, each with its working directory, its timeout and the exit status that means pass |
| `break.patch` | the change that turns the pristine copy into the task's starting state: it removes or damages the behaviour the plan restores |
| `stage-<k>.patch` | the reference change that makes stage k's check pass, applied after the earlier stages' (the oracle) |
| `tests/` | the test files the checks run, when the repository has none for the behaviour; they are added to the copy, never to the original |

The agent sees the prompt and the plan, and the repository in its starting state, and never `stage-<k>.patch` or the checks' expected output.

## 2. The rules

1. **Read-only on the originals.** `todo-app`, `md2pdf` and `snip` under the owner's code folder, outside this repository, are never written, built in or run in. A task's run starts from a copy in a scratch folder (`.poly/e3-tasks/<run>/<id>/`, ignored by git), made by `git archive` of the pinned commit, so no working-tree change of the owner's is copied.
2. **Offline.** No network at any stage: the dependencies a check needs are the ones the copy already has. For `todo-app` that is its `node_modules`, which the copy reaches by a link to the original's folder (read-only use); for `snip`, the Go module cache. `md2pdf` is not used: PyMuPDF is not installed on this machine (`import fitz` fails with ModuleNotFoundError, checked 2026-10-12 with `py`, with nothing installed), `pdf2md.py` imports it at the top, and `md2pdf.py` needs weasyprint and a PDF renderer as well.
3. **A check is deterministic and fast.** A command with a fixed result for a fixed copy, under 30 seconds, with no clock, no random seed and no network. A test that reads the date is given a fixed date.
4. **A check fails before its stage and passes after it.** For every stage k, the check of stage k fails on the copy with `break.patch` and stages 0 to k-1 applied, and passes with stage k's reference applied. The oracle run proves this for all twelve tasks before any model is asked, and a task whose oracle does not pass is not used.
5. **A stage's check is the conjunction of its commands**, and a stage scores 1 or 0 (the scorer's rule). The finer score of the proposal (the share of a stage's checks that pass) would need several check effects per stage, which `Trial` does not have; it is noted as a limit.
6. **The original check of the whole task is the last stage's**, so a run that passes every stage has passed the task's own tests.

## 3. The twelve tasks (proposed)

Each is a break of a function of the repository that its existing tests, or the tests added in `tests/`, cover. Proposed from the files read on 2026-10-12; the exact breaks are fixed when the oracles are built.

| Id | Repository | Behaviour restored | Stages |
|---|---|---|---|
| `todo-urgency` | todo-app | `computeUrgency` and `urgencyLevel` (src/core/urgency.js): the score's overdue weight, then the level thresholds | 2 |
| `todo-recurrence` | todo-app | `nextOccurrence` and `parseRecurrence` (src/core/recurrence.js): the month-end rule, the weekly rule, the parse of an interval | 3 |
| `todo-dates` | todo-app | `relativeTime`, `isDueSoon`, `startOfDay` (src/utils/dates.js) | 2 |
| `todo-fuzzy` | todo-app | `fuzzyScore` and `fuzzyFilter` (src/utils/fuzzy-match.js): the consecutive-match bonus, the ordering | 3 |
| `todo-safehtml` | todo-app | `escapeHtml` and the `html` tag (src/utils/safe-html.js): the escape set, and a `SafeHtml` value passing through | 2 |
| `snip-headtail` | snip | `head` and `tail` actions (internal/filter/actions.go): an off-by-one, then the count parameter | 2 |
| `snip-dedup` | snip | `dedup`: the repeated-line count and the order kept | 3 |
| `snip-group` | snip | `groupBy` and `aggregate` | 3 |
| `snip-config` | snip | the configuration loader's precedence (internal/config) | 2 |
| `snip-gain` | snip | the formatting of the gain display (internal/display/gain.go) | 4 |
| `todo-nlparse` | todo-app | `parseQuickCapture` (src/parsers/nl-parser.js): the priority token, the due-date phrase, the tags, with the reference date fixed | 3 |
| `snip-pipeline` | snip | the pipeline of filters (internal/engine/pipeline.go): the order the actions run in, and what an action's error does to the rest | 2 |

Six tasks are in JavaScript and six in Go, and the plans are 2, 3, 2, 3, 2, 3, 2, 3, 3, 2, 4, 2 stages, 31 stages in all. The logs the Reducer reads come from `go test` and `vitest run`, 4 KiB and over only when a run is verbose or fails in several places; the tasks are chosen so that some stages fail loudly (a failing test file prints its diff) and some are quiet, because the Reducer and ObservationPack have opportunities only on the loud ones.

## 4. What the live run needs from the tasks

- The `act` handler runs the agent's tool calls in the scratch copy, with a command table of the declared runners and the file edits the agent makes, under the timeout, offline (no `exec` target outside the copy, no egress). It replaces the recorded `act` of E3.4.
- The `stageCheck` handler runs the stage's commands in the copy and returns pass only if all pass. It replaces the recorded one.
- The fused action is exposed in the tool schema (the paper found prompt-only triggering unreliable), and the retrieval of a range through a handle is a tool.
- A trial's end: the work in the scratch copy is kept on disk when a cap ends the trial (HF3.9), under `.poly/e3-tasks/`.

## 5. What the offline runs will and will not show (the labels)

The twelve tasks are small and the paired comparison on them detects only a large gap: at 12 pairs, an exact one-sided McNemar test on the discordant pairs reaches 0.05 only when all of 5 discordant pairs go one way, or 7 of 8, or 8 of 9 (6 of 7 gives 0.0625), so a harness that is better on 3 or 4 tasks out of 12 is reported `INCONCLUSIVE`, not as no difference (Q-E3-3, ruled). Every figure from these runs carries the labels of `assumptions.json` (`recordings-evidence` for recordings) and, for the live run, its own: the number of tasks, the number of reruns, the noise floor and the smallest gap the set can detect.

## 6. The owner's rulings (2026-10-12)

- **The patches are committed.** `todo-app` is the owner's, so its patches are committed as they are. `snip` is MIT licensed ("Copyright (c) 2026 snip contributors", by Edouard Claude and contributors, https://github.com/edouard-claude/snip), a permissive licence, so its patches are committed too, each task directory carrying `NOTICE` with snip's licence text and the line "Portions of snip, by Edouard Claude and contributors, MIT licensed". `md2pdf` has no task, so nothing of it is committed.
- **`md2pdf` is replaced.** PyMuPDF is missing (section 2), nothing was installed, and the two `md2pdf` tasks are replaced by `todo-nlparse` and `snip-pipeline`: twelve tasks, six from each repository.
- **The E3 tests run by `npm run test:e3` only, not in `npm test`.** They live in `test/e3/`, which the repository's `test/*.test.mjs` glob does not reach, and `test:e3` runs them one file at a time. The M7.7 gate and the release gate list `npm run test:e3` as their own named item.
- **The detectable gap is stated in the live run's report as computed here:** with 12 pairs, an exact one-sided McNemar test is significant at 0.05 only for a lopsided result: all of 5 discordant pairs one way, 7 of 8, or 8 of 9 (6 of 7 gives 0.0625). Anything less is reported `INCONCLUSIVE`, not as no difference.

## Conclusion

The twelve tasks are small, offline and checked stage by stage, and each stage's check has an oracle that proves it can pass and fails before. The scorer and its tests are written and need nothing from the checker; the runtime half of HAC7 and the task builds wait for the go. The owner's three questions are ruled (section 6): the patches are committed with snip's notice, `md2pdf` is replaced because PyMuPDF is missing, and the E3 tests run by `test:e3` only.
