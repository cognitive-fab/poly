# PR reviewer

An agent reviews a pull request. The program is a workflow: each effect is a work order for an agent's tool. The agent fetches the diff, reviews it, posts the review as a comment and sets a label. The policy allows the comment and the label and denies the merge, and a budget caps what one review, and one month of reviews, may cost. The agent is a model in life; here it is recorded, and so is GitHub, so no model is called and nothing leaves the machine. The spec is `docs/examples/pr-reviewer.md`.

## What it shows

- **A workflow that maps agent tools to effects.** `fetch`, `analyze`, `comment` and `label` are work orders for the tools `gh_diff`, `reviewer`, `gh_comment` and `gh_label`. The gate decides each order before it exists, and the agent's report settles it.
- **A merge the program must never ask for.** `merge` is declared because the agent has the tool (every effect of a workflow's machine maps to a tool). The path property `never-merges` says the program never emits it, and the check proves that.
- **A policy that allows two effects and denies one.** A comment is allowed only while the review is commenting, a label only while it is labelling, and the merge never; a `never` statement proves no merge is ever allowed. The rules for the comment and the label are also what satisfy polycheck's region for a repository read followed by an egress (`PL7001` without them).
- **A budget per review.** A run may spend 0.25 dollars and a month 0.45. Each order spends its order cap of 0.05 whatever usage the agent reports, so a review of four orders costs 0.20 and a third review in the month is refused at its second order.
- **A seeded defect.** `pr-reviewer-defect.poly` goes to `Merging` and emits the merge after a good review. The check rejects it; the policy beside it still denies the merge at run time, which is the second layer.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/pr-reviewer/pr-reviewer.poly
node packages/poly-check/dist/src/cli.js check examples/pr-reviewer/pr-reviewer-defect.poly
node packages/poly-check/dist/src/cli.js check examples/pr-reviewer/pr-reviewer.poly --root examples/pr-reviewer --host examples/pr-reviewer/host/tsconfig.json
node --test test/ex-pr-reviewer.test.mjs
node --test test/after/ex-pr-reviewer-e2e.test.mjs
```

The tests check each program with its policy beside it, as a project. The defect runs in the end-to-end test as an owner who had accepted its finding would run it: a program with findings is admitted only with a person's signed acceptance of each (PT12.5), which `test/ex-kit.mjs` writes.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Review` over 31 states, the budget machine over 96; about 1 s |
| Policy | all seven stages `CLEAN`, including the regions and the `never` |
| Defect copy | `FINDINGS`, exactly `PL4001 PATH_PROPERTY` (`never-merges`), a witness of 5 steps: `Start`, `Fetched`, `Reviewed(Good)`, `Commented`, `Labelled`, the last emitting `github.merge`; `Review` 34 states |
| Policy layer | the program's policy with `no-merge` changed to allow is `PL6503 NEVER_VIOLATED`; the defect's policy denies every proposal of `github.merge` in the decision table |
| Agent bridge | compiles under `poly check --host`; a wrong generated type is `PL6836` |
| End to end | 7 tests: both reviews of the main path, a third review refused by the month cap, the defect's merge denied by the policy and not by the budget, and a journal that replays (no divergence) |

## What is not checked

- **The agent.** That the agent calls only the tools of its orders is the bridge's (it has no merge) and the gate's; the check says nothing about what a real model does with a tool it was never asked to use.
- **Cost.** The budget bounds by reservation: an order spends its cap whatever it reports, so the reported usage is for reconciliation and nothing reads it. `CLEAN` does not say a review fits its run cap: the cap of 0.25 holds the program's four orders and the merge's fifth only because the numbers were chosen so.
- **Three pull requests.** `pr` is `1..3`, and the workflow key admits only those. No other domain was reduced.
- **The order of orders.** The program is a straight line; the check proves the properties of its paths, not that the agent reports in the order the gate issues.

## Conclusion

The check finds that the program can ask for a merge, in five steps, and the policy is what refuses it when the program does. Neither is enough alone: the policy cannot see why a merge was proposed, and the check cannot see what an agent does with a tool the program never mentions. The budget bounds what a review and a month may spend, and the end-to-end test shows it refusing an order. The numbers had to be chosen with care: an order spends its cap, so the run cap is the sum of the orders on the longest path.

## Glossary

- **Work order:** an effect of a workflow, handed to an agent to run and report.
- **Order cap:** the most one work order may spend; the budget charges it whatever usage is reported.
- **Region:** a set of effects behind a gate; `PL7001` reports one reached with no gate crossed.
- **Never statement:** a policy line proved over every proposal the program can make; `PL6503` reports a proposal it allows.
- **Acceptance:** a person's signed record that a finding is accepted; a program with findings runs only with one for each.
