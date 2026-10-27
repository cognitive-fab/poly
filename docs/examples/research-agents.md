# Example spec: research-agents

Batch 4, example 2. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

A planner and two workers answer a question together. The planner asks a model for a focus, then sends the question to both workers. Each worker retrieves documents, has a model answer from them, and tells the planner. A worker's answer must cite the documents it used, and the planner and the workers draw on one shared budget. The point of the example is the **configuration**: the planner and the workers are checked together, within a stated bound, and the property is about what the system does, not what one machine does: **every worker that reports has cited**. The seeded defect is a worker that can report without citing.

No test calls a model or the network. The models are recorded.

## Files

All paths are under `examples/research-agents/`. The names are fixed.

| File | Content |
|---|---|
| `research-agents.poly` | module `research`, first line `// expected: CLEAN` |
| `research-agents.policy.poly` | module `research_policy`, policy `inquiry`, scope `"research"` |
| `research-agents-defect.poly` | the program with a worker that can guess, first line `// expected: FINDING PL5401` |
| `research-agents-defect.policy.poly` | the defect's policy beside it; the same text as the program's |
| `prices/small.json` | the price table, as `examples/inbox/prices/small.json` |
| `host/inquiry.ts` | typed host code that wires and starts an inquiry; exports `startInquiry` |
| `host/tsconfig.json` | compiles `host/inquiry.ts` for `poly check --host`; run with `--root examples/research-agents` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedResearch(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded documents and answers |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-research-agents.test.mjs` (light) and `test/after/ex-research-agents-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`; `admitExample` copies `host/handlers.ts` and this example has none, so the e2e test makes its own project (see `test/runtime-helpers.mjs` `project`, which writes a stub handlers file). For a source and its retrieval read `test/after/ex-concierge-e2e.test.mjs` and `test/memory-helpers.mjs`.

## Machines

Module `research`, `audience { public < team }`, one source `docs` (`adapter "postgres"`, `audience public`, `freshness 8760h`, not owned).

`service machine Planner`: `PlannerStatus { Idle, Planning, Waiting, Done, Failed }`. State: `status` (`Idle`), `first : Ref<Worker>` and `second : Ref<Worker>` (none), `reports : 0..2` and `gaveup : 0..2` (0), `asked : Content` (none).

- `Wire(a, b: Ref<Worker>)`: `"wired"` unless `first` is none; `"no-worker"` unless both are set and different. Records them.
- `Ask(question: Content)`: `"not-ready"` unless `Idle` and wired. Records `asked`, goes to `Planning`, issues `decide plan(question: question)`.
- `Planned(focus: Focus)` (`Focus { Facts, Opinions }`): `"not-planning"` unless `Planning`. Goes to `Waiting` and sends `Task(question: asked, from: self)` to each worker. `Unplanned()`: same guard; goes to `Failed` and sends `Cancel()` to each worker (an idle worker is not an ended one).
- `Report()` and `GaveUp()`: `"not-waiting"` unless `Waiting`. Count `reports` or `gaveup`; when one more would make two reports or give-ups together, goes to `Done`.

`machine Worker`: `WorkerStatus { Idle, Reading, Researching, Reported, GaveUp }`. State: `status` (`Idle`), `planner : Ref<Planner>` (none), `cited : bool` (false), `answer : Content` (none). `terminal status in { Reported, GaveUp }`.

- `Task(question: Content, from: Ref<Planner>)`: `"busy"` unless `Idle`. Records `planner` from `from`, goes to `Reading`, emits `lookup(topic: question)`.
- `Cancel()`: `"busy"` unless `Idle`; goes to `GaveUp`.
- `Found(items: Items)`: `"not-reading"` unless `Reading`. Goes to `Researching`, issues `decide research(evidence: items)`. `FoundFailed()`: same guard, goes to `GaveUp` and sends `GaveUp()` to the planner.
- `Answered(text: Content, cites: Items)`: `"not-researching"` unless `Researching`. Goes to `Reported`, sets `cited`, records `answer`, sends `Report()` to the planner. `Unanswered()`: same guard, goes to `GaveUp` and sends `GaveUp()`.

`effect lookup(topic: Content)`: `retrieve docs limit 2`; `ok(r)` to `Found(items: r.items)`, `failed` to `FoundFailed`.

## Decisions and the shared budget

- `decision plan(question: Content) -> Focus` in `Planner`: provider `"small"`, `prices "prices/small.json" max input tokens 2000 max tokens 20 budget research`, labels `egress:external, read:private`, timeout 2s; `ok(r)` to `Planned(focus: r.answer)`, `failed` to `Unplanned`.
- `decision research(evidence: Items) -> Content` in `Worker`: provider `"small"`, `prices "prices/small.json" max input tokens 2000 max tokens 200 budget research`, same labels, timeout 5s, `cites evidence`; `ok(r)` to `Answered(text: r.answer, cites: r.cites)`, `failed` to `Unanswered`. An answer that cites nothing, or an item it was not given, is refused by the runtime and takes the `failed` path.
- `budget research { cap usd 0.001 per month }`, one budget, named by both machines' decisions: the planner's and the workers' calls draw on the same cap. With the price table, a `plan` call reserves about 0.000208 dollars and a `research` call about 0.00028, so a whole inquiry (one plan, two research) costs about 0.00077 and a second inquiry does not fit.

## Configuration

```
configuration inquiry {
  planner   : Planner
  worker[2] : Worker { planner: planner }
  inputs    { planner.Wire, planner.Ask, planner.Planned, planner.Unplanned,
              worker[*].Found, worker[*].FoundFailed, worker[*].Answered, worker[*].Unanswered }
  bounds    { transit 4 }
  invariant answers-cite: forall i in worker: worker[i].status is Reported implies worker[i].cited
}
```

The program and its policy check `CLEAN`: `Planner` 301 states, `Worker` 19, the budget machine 96, and the configuration `inquiry` **699 global states**, 30,621 steps, within a transit bound of 4 and the instance bound of one planner and two workers.

## Host code

`host/inquiry.ts` exports `startInquiry(rt, { planner, workers: [a, b], question })`, with type-only imports of `Action` from `../.poly/build/research.Planner/types.js`. It dispatches `Wire` with the two worker ids and then `Ask` with the question's content (`await rt.putContent(question)`), using `rt.dispatch<Action>`, and returns the content id. Nothing else.

## Recorded models and documents

`recorded/answers.json` is `{ "models": { "small": "<id>" }, "documents": [ { "id", "asOf", "body" } ], "plan": { "focus", "p" }, "research": { "text", "p" }, "usage": {...} }`. `recordedResearch(fixture)` returns `{ asked, decisions: { plan, research } }`, each `{ provider, model }`. `plan` answers `fixture.plan.focus`. `research` answers `fixture.research.text` and cites the ids of the items it was given (`materials.items`). `asked` records `{ decision, items: [ids] }` for `research` and `{ decision }` for `plan`, never a body. The fixture holds three documents (ids `d-1`, `d-2`, `d-3`, bodies about a made-up topic), focus `Facts` at 0.9, and an answer.

The `docs` source is unowned: the e2e test connects `postgresSource` over `pgOrders` from `test/memory-helpers.mjs` with the documents as rows (`order_id`, `customer_id`, `summary`, `updated_at`; the fake answers a retrieval with no owner).

## Policy

Policy `inquiry`, scope `"research"`: two obligations, each `else deny` with `on unknown deny`, `proposal.kind == "effect"`: `plan-while-planning` (`decision.plan` requires `machine("research.Planner").status == Planning`) and `research-while-researching` (`decision.research` requires `machine("research.Worker").status == Researching`). (Without a rule that names a decision polycheck reports `PL7001`.)

## Seeded defect

`research-agents-defect.poly` gives `Worker` an action `Guess(text: Content)` that, in `Researching`, goes to `Reported` without setting `cited`, records the text and sends `Report()` to the planner; it is added to the configuration's inputs as `worker[*].Guess`. No machine alone has a property it breaks: the finding is the configuration's. The check rejects it with exactly one code, **`PL5401 CONFIGURATION_INVARIANT`**, naming `answers-cite`. The witness has **6 global steps**: input `Wire@planner`, input `Ask@planner`, input `Planned@planner`, delivery of `Task` to `worker[0]`, input `Found@worker[0]`, input `Guess@worker[0]`. In the end-to-end test the real program has no `Guess`, and the runtime's refusal of an uncited answer is shown instead.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the instance is printed for the machines and the configuration (699 global states);
- the defect is `FINDINGS` with exactly `PL5401`, `answers-cite`, a witness of 6 global steps whose last is the input `Guess`;
- `poly check --host` is `CLEAN`, and a host file with a wrong action name is `PL6836`;
- `startInquiry` dispatches `Wire` then `Ask` (a fake `rt` records the calls);
- the recorded models behave as above, record no body, and throw for an item they do not know.

End-to-end test, over recorded traffic, nothing on the network:

- main path: one inquiry ends with the planner `Done` and both workers `Reported` with `cited` true; each worker's answer cites the ids of the two documents; the planner reached `Done` after the second report; `provider.asked` has one `plan` and two `research`;
- refusal by the shared budget: a second inquiry (a second planner and two more workers) draws on the same budget; its `plan` call fits, its first worker's `research` call does not, and is denied `budget`; that worker is `GaveUp`, the planner is told and ends `Done` (one give-up and one report, or two give-ups);
- refusal of an uncited answer: a recorded `research` that cites nothing is refused by the runtime and that worker is `GaveUp`, not `Reported`, with `cited` false;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

The example has no escalation to a person.

## Amendments made when the code existed

- **The recorded usage is `{ input, output }`, per decision.** The fixture's `usage` moved into `plan.usage` (2000 input, 20 output tokens) and `research.usage` (2000, 200), the maxima the decisions declare, so a call's actual cost equals its reservation and the arithmetic above holds: an inquiry costs 0.000208 + 2 x 0.00028 = 0.000768 of the 0.001 cap, and a second inquiry's plan (0.000208) fits while its first worker's research does not. With the keys `inputTokens` and `outputTokens`, which the price table does not name, the call was charged at the table's highest price, 0.000808, and every later call was denied (language findings 21).
- **`admitExample` copies `host/handlers.ts` only when it exists**; this example has none (its only effect is a retrieval), so `test/ex-kit.mjs` was changed.
- The report's machines include the budget machine (`research.Budget`); the writer's light test expected two machines. `plan` records only `{ decision }` in `asked`, as this spec says, and the test was corrected to expect items on `research` entries only. `host/inquiry.ts` casts the question to the branded `Content` the generated type asks for.
- Planner 301 states, Worker 19 states, configuration 699 global states (1,545 for the defect), as predicted; the check takes about 2 s.

## Conclusion

The property is about the system: no one machine breaks it, and the configuration finds the worker that can report without citing, in six steps. The check is within a bound (one planner, two workers, four messages in transit), and the shared budget is the thing neither machine can see of the other.

## Glossary

- **Configuration:** several machines checked together, with their messages in any order within a bound.
- **Shared budget:** one cap that several machines' decisions draw on.
- **Cites:** an answer's list of the items it used; the runtime refuses an answer that cites none.
- **Transit bound:** the most messages in flight at once in the checked model.
