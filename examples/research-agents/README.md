# Research agents

A planner and two workers answer a question together. The planner asks a model for a focus and sends the question to both workers. Each worker retrieves documents, has a model answer from them and tells the planner. An answer must cite the documents it used, and the planner's and the workers' decisions draw on one shared budget. Everything here runs on recorded answers and a fake database: no model is called and nothing leaves the machine. The spec is `docs/examples/research-agents.md`.

## What it shows

- **Machines that talk, checked together.** The configuration `inquiry` holds one planner and two workers, with their messages in any order within a transit bound of 4. The property `answers-cite` is about the system: every worker that has reported has cited. No machine alone has it as a property.
- **Answers that cite.** `research` is a decision with `cites evidence`; the runtime refuses an answer that cites nothing, or an item it was not given, and that worker gives up.
- **One shared budget.** The planner's `plan` and the workers' `research` name the same budget, `research`, so their calls draw on one cap. A second inquiry's plan fits and its first worker's research is denied `budget`.
- **A planner that cancels.** A plan that fails leaves the workers unasked, and the planner tells them (`Cancel`): an idle worker is not an ended one (`PL5402 STUCK` without it).
- **A seeded defect.** `research-agents-defect.poly` gives a worker an action `Guess` that reports with no citation.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/research-agents/research-agents.poly
node packages/poly-check/dist/src/cli.js check examples/research-agents/research-agents-defect.poly
node packages/poly-check/dist/src/cli.js check examples/research-agents/research-agents.poly --root examples/research-agents --host examples/research-agents/host/tsconfig.json
node --test test/ex-research-agents.test.mjs
node --test test/after/ex-research-agents-e2e.test.mjs
```

The tests check each program with its policy beside it, as a project. The configuration is small (699 global states, about 2 s); a larger bound or a third worker may need `NODE_OPTIONS=--max-old-space-size=8192`. The program has no effect handler (its only effect is a retrieval), so the host code is `host/inquiry.ts`, which wires and starts an inquiry against the generated types.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Planner` over 301 states, `Worker` over 19, the budget over 96, and the configuration `inquiry` over 699 global states and 30,621 steps, transit at most 4; about 2 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL5401 CONFIGURATION_INVARIANT` (`answers-cite`), a witness of 6 global steps: input `Wire@planner`, input `Ask@planner`, input `Planned@planner`, delivery of `Task` to `worker[0]`, input `Found@worker[0]`, input `Guess@worker[0]`; the configuration has 1,545 global states |
| Host code | compiles under `poly check --host`; a wrong generated type is `PL6836` |
| End to end | 5 tests: an inquiry in which both workers report with citations, the shared budget refusing a second inquiry's first worker, an uncited answer refused by the runtime, and a journal that replays (9 runs, 52 rows, 1 gate session, no divergence) |

## What is not checked

- **A larger inquiry.** The configuration has one planner and two workers and a transit bound of 4. `CLEAN` is a statement about that instance (699 global states); three workers or a bound of 6 were not tried. The check took about 2 s, so none of this was a memory limit. Nothing else was reduced.
- **The citations' truth.** The runtime checks that an answer cites items it was given and cites at least one. That the answer is supported by them is the model's.
- **The budget in the check.** The shared budget is a machine the check explores on its own (96 states); that the planner's and the workers' calls reach the same instance is shown by the end-to-end run, not by the configuration.
- **Documents.** Three, unowned and public; the audience is declared only because a stored question needs a taint record.

## Conclusion

The property is about the system: no one machine breaks it, and the configuration finds the worker that can report without citing, in six steps. The check is within a bound (one planner, two workers, four messages in transit), and the shared budget is the thing neither machine can see of the other.

## Glossary

- **Configuration:** several machines checked together, with their messages in any order within a bound.
- **Shared budget:** one cap that several machines' decisions draw on.
- **Cites:** an answer's list of the items it used; the runtime refuses an answer that cites none.
- **Transit bound:** the most messages in flight at once in the checked model.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
