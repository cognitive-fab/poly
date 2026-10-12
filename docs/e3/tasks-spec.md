# E3.7: the twelve offline tasks and their stage checks

*Cognitive Fab, October 2026. Written as the light work of E3.7, before any task is built. Nothing here has been run.*

Status: a specification for the owner's rulings on the open questions at the end. It follows the ruling on Q-E3-3 (the tasks come from the owner's small personal repositories, with a check per stage, read-only on the originals, each copied into a scratch folder, a negative result at that size reported as inconclusive).

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

1. **Read-only on the originals.** `todo-app`, `md2pdf` and `snip` under `C:\Users\jjdub\code` are never written, built in or run in. A task's run starts from a copy in a scratch folder (`.poly/e3-tasks/<run>/<id>/`, ignored by git), made by `git archive` of the pinned commit, so no working-tree change of the owner's is copied.
2. **Offline.** No network at any stage: the dependencies a check needs are the ones the copy already has. For `todo-app` that is its `node_modules`, which the copy reaches by a link to the original's folder (read-only use); for `snip`, the Go module cache; for `md2pdf`, only the pure functions of `pdf2md.py`, since `md2pdf.py` needs the installed packages weasyprint and PyMuPDF and a PDF renderer.
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
| `pdf2md-headings` | md2pdf | `classify_heading_level` and `detect_body_font_size` (pdf2md.py), pure functions on numbers | 2 |
| `pdf2md-merge` | md2pdf | `convert_to_markdown` over a list of spans: the merge of spans of one line, lists, the heading marks | 3 |

Five tasks are in JavaScript, five in Go and two in Python, and the plans are 2, 3, 2, 3, 2, 2, 3, 3, 2, 4, 2, 3 stages, 31 stages in all. The logs the Reducer reads come from `go test` and `vitest run`, 4 KiB and over only when a run is verbose or fails in several places; the tasks are chosen so that some stages fail loudly (a failing test file prints its diff) and some are quiet, because the Reducer and ObservationPack have opportunities only on the loud ones.

## 4. What the live run needs from the tasks

- The `act` handler runs the agent's tool calls in the scratch copy, with a command table of the declared runners and the file edits the agent makes, under the timeout, offline (no `exec` target outside the copy, no egress). It replaces the recorded `act` of E3.4.
- The `stageCheck` handler runs the stage's commands in the copy and returns pass only if all pass. It replaces the recorded one.
- The fused action is exposed in the tool schema (the paper found prompt-only triggering unreliable), and the retrieval of a range through a handle is a tool.
- A trial's end: the work in the scratch copy is kept on disk when a cap ends the trial (HF3.9), under `.poly/e3-tasks/`.

## 5. What the offline runs will and will not show (the labels)

The twelve tasks are small and the paired comparison on them detects only a large gap: at 12 pairs, an exact one-sided McNemar test on the discordant pairs reaches 0.05 only when all of 5 discordant pairs go one way, or 7 of 8, or 8 of 9 (6 of 7 gives 0.0625), so a harness that is better on 3 or 4 tasks out of 12 is reported `INCONCLUSIVE`, not as no difference (Q-E3-3, ruled). Every figure from these runs carries the labels of `assumptions.json` (`recordings-evidence` for recordings) and, for the live run, its own: the number of tasks, the number of reruns, the noise floor and the smallest gap the set can detect.

## 6. For the owner

- **Q-E3-7. May the task definitions be committed?** `break.patch` and `stage-<k>.patch` hold lines of the repositories. `todo-app` and `md2pdf` are the owner's; `snip` carries a licence of its own (its LICENSE file) and is by another author. Proposed: commit the patches for the owner's two repositories, and for `snip` commit no code, only a script that makes the breaks from a pinned commit by named, small text replacements and states the licence; or exclude `snip`'s tasks. The owner decides.
- **Q-E3-8. `md2pdf` is only partly runnable offline.** Its two tasks use the pure functions of `pdf2md.py`. If the installed Python lacks PyMuPDF, `pdf2md.py` does not import, and the two tasks are replaced by two `snip` or `todo-app` tasks.
- **Q-E3-9. Where the E3 tests run.** The E3 test files are in `test/` and the repository's `npm test` runs `test/*.test.mjs` in parallel with the rest; the E3 batch takes about 18 minutes sequentially, with admissions of up to 1 GB. Proposed: they run in the serial group (`test/after/`) or are named in `test:e3` only, as the owner prefers.

## Conclusion

The twelve tasks are small, offline and checked stage by stage, and each stage's check has an oracle that proves it can pass and fails before. The scorer and its tests are written and need nothing from the checker; the runtime half of HAC7 and the task builds wait for the go. Three questions are the owner's: whether the task patches may be committed, what to do if `md2pdf` cannot run offline, and where the E3 tests run.
