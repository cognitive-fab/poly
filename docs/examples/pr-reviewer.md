# Example spec: pr-reviewer

Batch 3, example 1. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

An agent reviews a pull request. The program is a workflow: each effect is a work order for an agent's tool. The agent fetches the diff, reviews it, posts the review as a comment and sets a label. The policy allows the comment and the label and denies the merge, and a budget caps what one review may cost. The point of the example is the **merge**: it is a tool the agent has, the policy denies it, and the program must never ask for it. The seeded defect makes the merge reachable.

The agent is a model in life. Here it is recorded: no test calls a model or GitHub.

## Files

All paths are under `examples/pr-reviewer/`. The names are fixed.

| File | Content |
|---|---|
| `pr-reviewer.poly` | module `reviewer`, first line `// expected: CLEAN` |
| `pr-reviewer.policy.poly` | module `reviewer_policy`, policy `review`, scope `"reviewer"` |
| `pr-reviewer-defect.poly` | the program that merges after a good review, first line `// expected: FINDING PL4001` |
| `pr-reviewer-defect.policy.poly` | the defect's policy beside it; the same text as `pr-reviewer.policy.poly` |
| `prices/agent.json` | the agent's price table, as `test/fixtures/m7/workflow-budget/prices/agent.json` |
| `host/agent.ts` | the agent bridge; exports `perform` |
| `host/tsconfig.json` | compiles `host/agent.ts` for `poly check --host`; run with `--root examples/pr-reviewer` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedAgent(fixture)` and `recordedGithub(fixture)` |
| `recorded/answers.json` | the recorded pull requests |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-pr-reviewer.test.mjs` (light) and `test/after/ex-pr-reviewer-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`; for work orders read `test/workflow-orders.test.mjs` and `test/workflow-budget.test.mjs`.

## Machine

One `machine Review` in module `reviewer`, one run per pull request. Enums: `Phase { Idle, Reading, Reviewing, Commenting, Labelling, Merging, Done, Failed }` and `Verdict { Good, Bad }`. State: `phase` (`Idle`), `number : 1..3` (1), `outcome : Verdict` (`Bad`). `terminal phase in { Done, Failed }`.

Actions and handlers (a failed `require` rejects with the quoted reason):

- `Start(pr: 1..3)`: `"started"` unless `Idle`. Records `number`, goes to `Reading`, emits `fetch(pr: pr)`.
- `Fetched()`: `"not-reading"` unless `Reading`. Goes to `Reviewing`, emits `analyze(pr: number)`. `FetchFailed()`: same guard, goes to `Failed`.
- `Reviewed(verdict: Verdict)`: `"not-reviewing"` unless `Reviewing`. Records `outcome`, goes to `Commenting`, emits `comment(pr: number, verdict: verdict)`. `ReviewFailed()`: same guard, `Failed`.
- `Commented()`: `"not-commenting"` unless `Commenting`. Goes to `Labelling`, emits `label(pr: number, verdict: outcome)`. `CommentFailed()`: same guard, `Failed`.
- `Labelled()`: `"not-labelling"` unless `Labelling`. Goes to `Done`. `LabelFailed()`: same guard, `Failed`.
- `Merged()`: `"not-merging"` unless `Merging`. Goes to `Done`. `MergeFailed()`: same guard, `Failed`. (Nothing in this program enters `Merging`.)

## Effects

Each is a work order. Labels, class and retry as in the table; the retry clause is `attempts 3, base 1s, timeout 30s` except `analyze` (`attempts 2, base 1s, timeout 60s`) and `merge` (`attempts 1, base 1s, timeout 30s`).

| Effect | Payload | Kind | Labels | Class | ok | failed |
|---|---|---|---|---|---|---|
| `fetch` | `pr: 1..3` | `github.diff` | `read:repo` | `none` | `Fetched` | `FetchFailed` |
| `analyze` | `pr: 1..3` | `agent.review` | `read:repo` | `none` | `Reviewed(verdict: r.verdict)` | `ReviewFailed` |
| `comment` | `pr: 1..3, verdict: Verdict` | `github.comment` | `egress:external` | `compensable` | `Commented` | `CommentFailed` |
| `label` | `pr: 1..3, verdict: Verdict` | `github.label` | `egress:external` | `reversible` | `Labelled` | `LabelFailed` |
| `merge` | `pr: 1..3` | `github.merge` | `egress:external` | `irreversible` | `Merged` | `MergeFailed` |

`merge` is declared because the agent has the tool and the workflow maps it (every effect of the machine maps to a tool, PL6803), and the policy names it. The program never emits it.

## Workflow and budget

```
budget review_spend { cap usd 0.2 per run }

workflow review runs Review {
  input Start
  key "{pr}" where pr matches "^[1-3]$"
  tool "github.diff"    -> gh_diff    why "read the pull request's diff"
  tool "agent.review"   -> reviewer   why "review the diff"
  tool "github.comment" -> gh_comment why "post the review as a comment"
  tool "github.label"   -> gh_label   why "label the pull request"
  tool "github.merge"   -> gh_merge   why "merge the pull request"
  budget review_spend prices "prices/agent.json" order cap usd 0.1
}
```

A run costs at most 0.20 dollars, and no order more than 0.10. The price table gives a step 10 micro-dollars (`perMillionTokens.step` 10000000), so an order that reports `usage: { step: n }` costs `n * 10` micro-dollars.

## Agent bridge

`host/agent.ts` exports `perform(order, deps)`, with a type-only import from `../.poly/build/reviewer.Review/types.js`. `order` is a work order as `rt.workOrders` returns it (`tool`, `kind`, `args`). `deps` is `{ github, reviewer }`: `github.diff(pr)` returns the diff text, `github.comment(pr, body)` and `github.label(pr, name)` return nothing, and `reviewer.review(pr, diff)` returns `{ verdict, comment, steps }`. `perform` returns the report for `rt.reportWorkOrder`:

- `gh_diff`: reads the diff, remembers it for the review, returns `{ ok: true, result: {}, usage: { step: 1000 } }`;
- `reviewer`: returns `{ ok: true, result: { verdict }, usage: { step: steps } }`, where `steps` is what the reviewer reported;
- `gh_comment`: posts the reviewer's comment and returns `{ ok: true, result: {}, usage: { step: 1000 } }`;
- `gh_label`: sets the label `lgtm` for `Good` and `needs-work` for `Bad` and returns `{ ok: true, result: {}, usage: { step: 1000 } }`;
- any other tool (`gh_merge` among them), or an error from `deps`, returns `{ ok: false, result: {} }` and calls nothing: the bridge has no merge.

`recordedGithub(fixture)` returns `{ calls, github }`; `calls` lists each call as `{ method, number, ... }`. `recordedAgent(fixture)` returns `{ asked, reviewer }`; the reviewer finds the pull request by number, records `{ number }` in `asked` and returns the recorded `{ verdict, comment, steps }`; an unknown number throws.

`recorded/answers.json` is `{ "prs": [ { "number", "title", "diff", "verdict", "comment", "steps" } ] }`:

| number | title | verdict | steps |
|---|---|---|---|
| 1 | "Fix off-by-one in pager" | `Good` | 4000 |
| 2 | "Remove input validation" | `Bad` | 4000 |
| 3 | "Rewrite the scheduler" | `Good` | 10000 |

## Policy

Policy `review`, scope `"reviewer"`, with these obligations (each `else deny` and `on unknown deny`, for `proposal.kind == "effect"` and an `effect.kind`):

- `comment-while-commenting`: `github.comment` requires `machine("reviewer.Review").phase == Commenting`;
- `label-while-labelling`: `github.label` requires `phase == Labelling`;
- `no-merge`: `github.merge` requires `false`;
- and the statement `never merge-is-never-allowed "No merge is ever allowed.": allow when effect.kind == "github.merge"`.

The comment and label rules also gate the repository-to-egress region (without a rule that names them polycheck reports `PL7001`). The policy is signed as a person signs it.

## Properties

1. **Path property `comment-at-most-once`**: `count("github.comment") <= 1`.
2. **Path property `never-merges`**: `count("github.merge") <= 0` (a workflow's machine must declare a path property, PL6804).

The program and its policy check `CLEAN`.

## Seeded defect

`pr-reviewer-defect.poly` is the program whose `Labelled` goes to `Merging` and emits `merge` when the verdict is `Good`, and to `Done` otherwise. The check rejects it with exactly one code, `PL4001 PATH_PROPERTY`, naming `never-merges`. The shortest witness has **5 steps**: `Start`, `Fetched`, `Reviewed(Good)`, `Commented`, `Labelled`, the last emitting `github.merge`. The policy beside it is the same as the program's and still denies the merge, so at run time the gate refuses the order: the check finds the reachability, the policy is the second layer.

A defect at the policy layer: the program's policy with `no-merge` changed to `require true` (the merge allowed) is `PL6503 NEVER_VIOLATED`, from the `never` statement, with the program unchanged. (The test makes this copy in a temporary directory; no file of the example holds it.)

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the instance is printed for `Review` and the budget machine;
- the defect (beside its policy) is `FINDINGS` with exactly `PL4001`, `never-merges`, a witness of 5 steps whose last step is `Labelled`;
- the program's policy, with `no-merge` changed to allow, gives `PL6503` over the clean program;
- the defect's policy, read through poly-ref's decision table as `test/ex-concierge-policy.test.mjs` does, denies every proposal of `github.merge`, allows `github.comment` in `Commenting` and denies it elsewhere;
- `poly check --host` is `CLEAN`, and a bridge with a wrong field of `order.args` is `PL6836`;
- `perform`: each tool's report as above; `gh_merge` returns `{ ok: false }` and calls nothing; an error from `deps` returns `{ ok: false }`;
- `recordedAgent` and `recordedGithub` behave as above, an unknown number throws.

End-to-end test, over recorded traffic, nothing on the network. A run is `rt.create('reviewer.Review', { id, creation: { action: 'Start', data: { pr } } })`, then `rt.tick()`, `rt.workOrders(id)` and `rt.reportWorkOrder(order.orderId, report)` as in `test/workflow-orders.test.mjs`; the test's driver reports each open order through `perform`:

- main path: pull request 1 issues the orders `gh_diff`, `reviewer`, `gh_comment`, `gh_label` in that order, ends `Done`, with one comment and the label `lgtm` recorded and no `gh_merge` order; pull request 2 gets the label `needs-work`;
- refusal by budget: pull request 3 reports 10000 steps, which leaves too little of the run's 0.20 for the comment's order; the gate denies the comment, no `gh_comment` order is issued, the review ends `Failed`, and no comment was posted;
- refusal by policy: the defect program, admitted with its policy, reaches `Merging` after a good review; the gate denies the merge, no `gh_merge` order is issued, and the run ends `Failed` (the `MergeFailed` completion);
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

The example has no escalation to a person.

## Amendments made when the code existed

- **The budget spends the order cap, whatever usage is reported.** The spec's arithmetic read the reported steps as the spend. The budget bounds by reservation (K15): each order is charged its order cap, and `usage` is kept for reconciliation. With a run cap of 0.20 and an order cap of 0.10 a review held two orders. The numbers are now: order cap **0.05**, run cap **0.25**, a new month cap **0.45** (`cap usd 0.25 per run` and `cap usd 0.45 per month`). A review of four orders costs 0.20; the defect's merge is a fifth order that fits the run cap, so the policy, not the budget, is what refuses it (the budget is consulted first); and a third review in a month is refused at its second order. The price table and the recorded `steps` are unchanged and decide nothing.
- **The refusal by budget** is therefore the month cap: pull requests 1 and 2 complete, pull request 3 gets its diff and its `reviewer` order is denied `budget`, ending `Failed` with no comment posted. The test asserts the denial reason, and for the merge that it is not `budget`.
- **The defect runs only with a signed acceptance.** A program with findings is admitted only when a person has signed an acceptance of each (PT12.5). The end-to-end test uses `acceptFindings` in `test/ex-kit.mjs`, as an owner who accepted the finding would.
- **The bridge keeps its memory per GitHub client** (the agent's session), not per `deps` object, since a driver may build `deps` anew for each order.
- **The `PL6836` test** mutates the generated type the bridge imports (`Effects['github.label']['verdict']`), since `order.args` is a plain record and a wrong key in it is no type error.
- **Sizes.** `Review` has 31 states (34 for the defect) and the budget machine 96. The tests were corrected for these after the code existed: the policy facts argument, `assert.rejects` for an async throw, the `asked` key `number`, and the `tsconfig` file name.

## Conclusion

The check finds that the program can ask for a merge, in five steps, and the policy is what refuses it when the program does. Neither is enough alone: the policy cannot see why a merge was proposed, and the check cannot see what an agent does with a tool the program never mentions. The budget bounds what one review may spend, and the end-to-end test shows it refusing an order.

## Glossary

- **Work order:** an effect of a workflow, handed to an agent to run and report.
- **Order cap:** the most one work order may cost; a run's cap bounds their sum.
- **Region:** a set of effects behind a gate; `PL7001` reports one reached with no gate crossed.
- **Never statement:** a policy line proved over every proposal the program can make; `PL6503` reports a proposal it allows.
