# Language findings from the new examples

Where the language or its toolchain got in the way while writing the ten examples (`docs/examples/<name>.md`). Each entry has the symptom, the example where it appeared, the workaround used, and a proposed fix. Entries are added after each batch and are never renumbered. The first three are also proposals in `docs/proposals/v2.0.md`.

## Batch 1: appointment-booker, expense-approval

### 1. A private-text decision is a region finding even when no credential exists

- **Symptom.** A decision labelled `egress:external, read:private` makes the check report `PL7001` ("region credential-egress is reached with no gate crossed: decision.parse"), though the program holds no credential. The message says a policy that names the decision would gate it.
- **Appeared in.** appointment-booker (first check of the program with its policy), then expense-approval.
- **Workaround.** An obligation that names `decision.<name>`, a phase guard that denies the decision outside the phase that asks for it. The rule is arbitrary: nothing in it is about the content.
- **Proposed fix.** A way to declare a decision gated, so that the declaration, not an invented rule, is what the region reads (v2.0 proposal P1).

### 2. A decision over a stored body fails closed, silently, without an audience

- **Symptom.** The host stores a request with `rt.putContent` and dispatches an action carrying it. The decision's `failed` outcome runs with the reason "text names a body with no taint record (S302)". The program checks `CLEAN`; nothing at check time says the decision cannot succeed.
- **Appeared in.** appointment-booker, at the first end-to-end run.
- **Workaround.** `audience { public < patient }` (and `staff` in expense-approval), whose only effect here is that the runtime keeps a taint record.
- **Proposed fix.** A check-time diagnostic when a decision takes a `Content` and the program declares no audience (v2.0 proposal P2).

### 3. A stored range is not cut at its comparison constants

- **Symptom.** `amount: 0..500`, stored by a handler and compared with 0 and 200, makes the check exhaust memory (3.3 GB, over 80 s, no verdict). With `0..10` it takes 25 s and 1,231 states; with `0..3`, 6 s and 370 states. The instance line prints the full range, so the field is explored value by value. Cut points (S458) reduce a parameter, not a value the state keeps.
- **Appeared in.** expense-approval.
- **Workaround.** The amount is in units of 50 euros, `0..10`, stated in the README under what is not checked.
- **Proposed fix.** Extend the cut-point reduction to a stored value that is only compared with constants and copied, with the same read-back and translation-validation conditions as S458 (v2.0 proposal P3).

### 4. A range type and a check clause refuse an outside value differently

- **Symptom.** A parameter `v: 0..10` given 12 makes `rt.dispatch` throw `RefusedDispatch` (rule S140, "outside its type"). A parameter `v: int check 0..10` given 12 returns a rejected step with the reason `outside-check-domain`. The README of the language says a domain refuses "with the reason `outside-check-domain`"; that is true only of the check clause.
- **Settled by.** `test/ex-range-domain.test.mjs` (fixture `test/fixtures/range-domain/range.poly`). For the range type: the dispatch throws, an audit row is written (`rule S140`), the journal has no row for the attempt, and the state is unchanged. For the check clause: the journal holds the rejected step, no audit row is written, and the state is unchanged. So AC30's journaled rejection is the check clause's, and the S140 audit row is the range type's; neither is both.
- **Appeared in.** expense-approval (the end-to-end refusal test expected the journaled form).
- **Workaround.** `amount: int check 0..10`, so the refusal is a journaled step.
- **Proposed fix.** None to the behaviour; the specification should say which form each declaration gives, and PT3.4a should drop "a range ... is always strict" as the way to get `outside-check-domain`.

### 5. A parameter named after a field is a warning that will be an error

- **Symptom.** `warning: parameter amount of Expense.Submit is named after the field amount, which it shadows (S19); it will be PL1002 after v1`. The natural names for an action's data and the state it writes are the same.
- **Appeared in.** expense-approval (`amount`, `category`).
- **Workaround.** The field is `cost`, and the `Categorized` parameter is `picked`.
- **Proposed fix.** Allow `on A(x)` to write `x' = x` where the field and the parameter share a name, by reading the parameter as `x` and the field as `pre.x` in the handler only; or keep the error and say so in PT2.2 with a suggested fix in the message.

### 6. Names in the test and host API that a reader guesses wrong

- **Symptom.** Three guesses that were wrong: `rt.create(kind, { id })` returns an object, not the id; the check report names a machine `Calendar`, not `booker.Calendar`; there is no `rt.state(id)`, it is `(await rt.getState(id)).state`. Independent test writers made all three.
- **Appeared in.** appointment-booker (the test writer), repeated in expense-approval's brief.
- **Workaround.** The brief to a test writer lists them; `test/ex-kit.mjs` holds the shared admission helper.
- **Proposed fix.** `rt.create` returns the id, or the object has a `toString`; the report's machine name carries the module; PT15 lists `getState`.

### 7. Admission is slow and per test

- **Symptom.** Admitting an example takes 20 to 50 s, and a file whose tests each admit takes minutes for what is one admission of one build.
- **Appeared in.** expense-approval (seven tests, 4 min 45 s before the admission was shared; 50 s for the admission and under 2 s for the seven tests after).
- **Workaround.** One admission per file, shared by the tests, each loading its own runtime.
- **Proposed fix.** `admit` keyed by the digest of the sources and the handlers, so an unchanged project returns its certificate.

## Batch 2: incident-oncall, order-fulfilment

No check in this batch came near the 8 GB limit: the largest was 126 global states (order-fulfilment's configuration) and each check took about a second.

### 8. A decision that pages must be confident, which moves the unsure case to a person

- **Symptom.** A decision whose completion emits an irreversible effect at every confidence is `PL6201 UNGATED_DECISION` ("for sev = High, its completion Triaged can emit a compensable or irreversible effect at every confidence and margin the program tells apart", PD1.4d). The first draft paged on an unsure answer, on the reasoning that a missed page costs more than a needless one.
- **Appeared in.** incident-oncall.
- **Workaround.** `Triaged` pages only when `conf >= 0.8`; an unsure or failed answer goes to `Review`, and a person's `Classify` pages. The example gained a state and an action.
- **Proposed fix.** None to the rule, which is right. The message could say that a failed or unsure answer routed to a person is the usual shape, and a fail-safe default for an alarm (page when unsure) has no spelling: it needs the confidence to be compared and the paging on both sides of the comparison, which the rule reads as ungated.

### 9. A terminal instance rejects with `terminal`, not the handler's reason (resolved: the specification now says so)

- **Symptom.** The spec said `Ack` on a `Logged` incident is rejected `not-waiting`. The runtime answers `terminal`: every action of an instance in a terminal state is refused before its handler.
- **Appeared in.** incident-oncall (the end-to-end refusal test).
- **Workaround.** The spec and the test say `terminal`.
- **Resolved.** The runtime was right: PS3.2 already gives the row `term(s)` the verdict `rejected("terminal")` and PS3.1 reserves the reason. The example spec was wrong, and PT4.4a did not say it. PT4.4a now says it, with a pointer to PS3.2, and `test/ex-terminal-reason.test.mjs` shows that the dispatch is rejected `terminal` before the handler, so a handler's own `reject` text is unreachable from a terminal state. The choice was the spec, not the runtime, because PS3.2 is the definition and the runtime agrees with it.

### 10. A `Ref` field is wired in the check and by an action at run time

- **Symptom.** In a configuration, `order[2]: Order { stock: stock }` wires the field. At run time `rt.create` takes no `Ref` and the field starts `none`, so the program needs an action that carries the reference. The first draft had none. With one, the check explores `Place(none)` and reports `PL5404 SEND_TO_NONE` and `PL5402 STUCK` until a `require warehouse != none` is added.
- **Appeared in.** order-fulfilment.
- **Workaround.** `Place(warehouse: Ref<Stock>)` with the guard; the configuration still wires the field, though the action overwrites it.
- **Proposed fix.** Let `rt.create` take a `Ref` for a field with an initial value of `none`, checked against the configuration's wiring, so the checked wiring and the running wiring are one declaration.

### 11. There is no way to observe the middle of a chain of effects

- **Symptom.** `settle` runs the worker until nothing is due, which carries a saga from `Place` to `Done` in one call. All three independent test writers asserted intermediate states (`Triaging`, `Reserving`, `Escalating`) that a run never rests in.
- **Appeared in.** incident-oncall, order-fulfilment (about a dozen assertions between them).
- **Workaround.** Assert the end state and the requests sent, in order.
- **Proposed fix.** A `rt.worker.tick` that takes one step and reports it, or a journal view of the states a run passed through (the journal has them; a test helper that folds it would do).

### 12. `Conf` is a decimal in source and thousandths in data

- **Symptom.** Source compares `conf >= 0.8`; the witness prints `Triaged(High, 800, 0)`; a dispatch of `conf: 0.95` is refused (`Triaged.conf is 0.95, outside 0..1000`). A test writer dispatched the decision's own completion, which the runtime also forbids for an outside caller (K10).
- **Appeared in.** incident-oncall.
- **Workaround.** The recorded provider's distribution gives the confidence; no test dispatches a completion.
- **Proposed fix.** Print a `Conf` in a witness and in the host types as the decimal the source writes, or document the scale in PT28.1a next to the `number` type it gives.

## Batch 2 follow-up: incident-oncall

### 13. A handler may not do nothing, so a late completion cannot be ignored

- **Symptom.** `on PageSent { if status == Paging { status' = Paged } }` is `PL2201` ("can complete with no write, no effect and no rejection", PT4.4): the `if` has a path that does nothing. The alternative, a `require`, makes a late completion a rejected one, which is consumed and never completes again, so the machine's liveness assumption (S126, S463) is open. A page can be acknowledged before its answer, so the case is real; a review found it.
- **Appeared in.** incident-oncall (a review of the batch 2 commit).
- **Workaround.** A field `answered`, written on every path, so the handler always writes. It doubles the state count (25 to 35) and carries no meaning the program uses.
- **Proposed fix.** A statement that says a completion was seen and changes nothing (`ignore`), accepted by PL2201 and recorded by the journal, or an exemption for a completion handler whose guard is an `if` on the status (v2.0 proposal P7).

## Batch 3: pr-reviewer, support-drafts

Both policy-dependent findings the batch was asked to show need nothing beyond the default check: the regions (`PL7001`), the `never` statements (`PL6503`) and the path properties (`PL4001`) all run in `poly check` with a policy beside the program. No flag or configuration is needed. Nothing in this batch exceeded 8 GB or lacked a verdict.

### 14. A finding stops a program from running unless a person signs an acceptance of it

- **Symptom.** `admit` of a program with a finding fails ("has no signed acceptance (PT12.5)"). A seeded defect therefore cannot be run to show the gate refusing what the check found, which is the point of a defense in depth.
- **Appeared in.** pr-reviewer (the end-to-end run of the defect, to show the policy denying the merge).
- **Workaround.** `acceptFindings` in `test/ex-kit.mjs` checks the project and writes one signed acceptance per finding, as an owner who accepted the defect would. Each README says so.
- **Proposed fix.** None to the rule, which is right. A `poly accept` example in the READMEs, so the step is a command and not test code (v2.0 note, no proposal).

### 15. A work order spends its order cap, whatever usage it reports

- **Symptom.** With a run cap of 0.20 and an order cap of 0.10 a review held two orders, not four, though the agent reported small usage: the settled record reads `reserved 100000, actual 100000`. The reported usage is kept for reconciliation (`reconciled: "under"`) and nothing reads it.
- **Appeared in.** pr-reviewer (the spec's budget arithmetic was wrong; the test writer saw it).
- **Workaround.** The run cap is the number of orders on the longest path times the order cap: order cap 0.05, run cap 0.25. A month cap makes the refusal visible.
- **Proposed fix.** A check-time finding when a workflow's longest path of orders costs more than its run cap (the path is known), and a README sentence in PT24.6 that the spend is the cap (v2.0 proposal P8).

### 16. (Retracted) The check was said to need a large heap

- **What was reported.** `support-drafts` (1,705 states) took 112 s in the default heap and 8 s with `--max-old-space-size=8192`, so batch 3 put it in the serial group and told readers to pass the flag.
- **What the re-measurement shows.** Run alone, the project check of `support-drafts` takes 10 s in the default heap and 12 s with 8 GB; the program alone through the command line takes 24 s and 18 s. The 112 s was a run that shared the machine with other processes. The heap is not the cause, and no re-execution is needed for this example.
- **What is still true.** The heap limit is real for the expense example: its first version, with an amount of `0..500`, exhausted the default 4 GB heap (3.3 GB in use, no verdict). Whether 8 GB would have finished it was not tried; the amount was reduced instead (finding 3).
- **Why no launcher was built.** Giving `poly check` an 8 GB re-execution would make the command-line module start a process, which the import-boundary check forbids on a check path (rule 6: only poly-new and poly-mine may start one). A change to that rule is the owner's to rule on; it is not needed for this example, and none was made. If the owner wants the launcher for the cases where the heap does matter, the specification line, the test and the code are small (the work was done and reverted: `heapReexec(limitMb, totalMb, env)` as a pure function, a child with `--max-old-space-size=8192` and `POLY_HEAP_REEXEC=1`), and the rule would need one exception for a launcher file that starts only `node` with the command line's own path.
- **Proposed fix.** Decide whether the exception is wanted. A note in the READMEs that a check of a large instance may need `--max-old-space-size`, when one does.

### 17. The check does not read the flow from a source to a decision

- **Symptom.** In `support-drafts-defect.poly` the owner's notes are given to the external model's decision. Beside the program's own policy the check says `CLEAN`: the gate denies the notes at run time, and nothing at check time follows the items from the retrieval to the decision. Beside a policy without the audience rule the finding is `PL7001` and `PL6503`, and it is the policy's, not the program's. A change of the decision's provider is invisible to both, because a policy sees a decision's kind and taint, not its provider.
- **Appeared in.** support-drafts.
- **Workaround.** The rule, the `never` that proves it, and the end-to-end test that shows the gate saying no. The README states the limit.
- **Proposed fix.** A declared audience ceiling on a decision (`audience customer`), checked statically against the classes of the sources its `Items` arguments come from, so the defect is a finding of the program (`PL6831`) without a policy (v2.0 proposal P9).

### 18. Two effects of one machine cannot retrieve the same source

- **Symptom.** `PL1002 effect read_notes has kind "source.notes.retrieve", which read declares with a different payload, completions or class (S41)`: a second effect that retrieves the source the first already retrieves, with other completions, is a duplicate kind.
- **Appeared in.** support-drafts (the first draft of its defect, which pointed `read` at the notes source).
- **Workaround.** A defect that adds a decision call instead of redirecting a retrieval.
- **Proposed fix.** Give a retrieval effect its own kind from its name, or allow two retrievals of one source when their completions differ.

### 19. A workflow must map a tool for an effect the program never emits

- **Symptom.** To name `github.merge` in a policy the machine must declare the effect, and every declared effect of a workflow's machine must map a tool (`PL6803`), so the example maps a `gh_merge` tool that no order will ever use.
- **Appeared in.** pr-reviewer.
- **Workaround.** The effect is declared and mapped, never emitted, and the path property `never-merges` proves it. The bridge has no merge.
- **Proposed fix.** A policy may name an effect kind of a tool declared in the workflow without a machine effect (a `deny tool` item in the workflow), so the denied tool need not be an effect the machine could emit.

## Where the static check stops (finding 17, in full)

The question: what does `poly check` follow for taint, what does it not, and what does only the gate enforce at run time. The answer is written from the specification and shown by `test/ex-flow-boundary.test.mjs`, one test for each claim, over the programs in `test/fixtures/flow-boundary/`. Quotations are from `docs/04-semantics.md` (PS) and `docs/03-technical-spec.md` (PT).

### What the check follows

1. **A tainted `Content` that leaves in an effect whose recipient is below it: the flow rule, `PL6831 AUDIENCE_LEAK`.** PS17.3: "The flow rule is the step property: on every accepted step, for every intent of an effect other than a retrieval, a decision or a `remember`, the recipient may read the taint of every `Content` value of the payload. It is checked on every machine alone, over its pending taints, and in every configuration". The taint comes from a source through a retrieval and a decision's *answer* (PS17.2: "A decision's intent's taint is the join of the taints of the `Content` and `Items` values of its payload" and "every `Content` and `Items` value in its data carries `t`" in the completion). The recipient is the field `to p` names, the claims' audience, the effect's `audience c`, a channel's declared audience, or otherwise the lowest class. Only a `Content` answer carries it: "*Limit (S323):* only a `Content` answer carries the decision's taint. An answer of a finite type (a `bool`, an enum, a range) carries none: a decision with a finite answer is a declassification point" (PS17.2). Test: claim 1 (`leak.poly`: the owner's notes come back as a `Content` and are sent at audience `customer`; `PL6831`, witness of 3 steps, no other code).
2. **A message that carries a taint to another machine, where a configuration holds both.** PS17.3: "a message keeps the taints of its values, so a value tainted in one instance and emitted by another is judged where it leaves." Where no configuration holds the two machines it is not followed: "`PL6838 FLOW_NOT_FOLLOWED`, inconclusive, naming the message; the flow rule's verdict is then at best `INCONCLUSIVE`, never a silent clean" (S322; PT10k, "Messages no configuration follows"). Test: claim 2 (`send-taint.poly`: `INCONCLUSIVE`, exactly `PL6838`).
3. **A region reached with no gate crossed: `PL7001 REGION_WITNESS`, by labels and not by taint.** PT8.4, "Stage 5a as built (M5a, S161)": polycheck "models the effects of the modules the scope governs: each effect kind is an action whose flags are its labels' by the table below, gated when an obligation of the scope names that kind (`effect.kind == "k"` or `effect.kind in { … }`); a `never` statement enforces nothing and gates nothing". The default regions are `lethal-trifecta`, `credential-egress` and `source-egress`; `read:private` is `sensitive`, `read:repo` is `proprietary`, `egress:external` and `egress:public` are `egress`. A decision is one of the effects, so a decision labelled `read:private` and `egress:external` is reached with no gate crossed until a rule of the scope names it. The region is named for credentials but is about labels: it is reported with no credential in the program. A rule that names it gates it whatever the rule says; one that reads only the phase is enough. Test: claim 3 (`PL7001` with a policy that names only the retrieval; still `PL7001` with a policy that adds only a `never`; `CLEAN` once a rule names the decision).

### What the check does not follow

4. **A source's body into a decision's inputs.** The flow rule's own text excludes decisions ("an effect other than a retrieval, a decision or a `remember`"), so nothing compares the taint of an `Items` or `Content` argument of a `decide` with any class. The owner's notes can be given to a decision with provider `"external"` and the check says `CLEAN`, with no policy and with a policy that gates the decision by phase alone. Only the decision's *answer* is followed, and only when it leaves (item 1). Test: claim 4 (`decision-input.poly`; the test also pins the sentence of PS17.3 it relies on).
5. **A decision's provider.** `provider "x"` is a string. No stage reads it, no policy input carries it, and the decision table's proposals for a decision have no `provider` or `model` field (PT10k: a policy reads `effect.taint.class`, `effect.items.count`, `effect.items.class` and `effect.items.age`). Changing the provider changes no verdict, no diagnostic and no state count. Test: claim 5 (the same program with another provider string is identical in every report field the test reads).
6. **A decision's audience.** A decision has no declared audience. What exists is a policy rule over `effect.taint.class`, which is read when the proposal is made at run time and over the decision table at check time. The check proves the *policy*: a `never` over the table (`PL6503`) says whether the policy allows the class. It does not say that the program gives the decision that class. Test: claim 6 (the policy that allows the owner class is `PL6503`; the one that denies it is `CLEAN`; the program's own check is `CLEAN` either way, by claim 4).

### What only the gate enforces at run time

7. **A decision denied for the audience of its inputs.** PT10k, "The proposal": "An intent carrying a `Content` is proposed with `taint: { class, owners }` … one carrying an `Items`, an effect's or a decision's, with `items: { count, class, ageMs, provenance }`". The policy rule that reads it is evaluated by the gate when the decision is proposed. Shown by `test/after/ex-support-drafts-e2e.test.mjs` (the gate denies `decision.summary` over the notes, `wrong-state` from `external-model-audience`, and the provider is never asked about a note).
8. **The effect flow rule, again.** PT10k, "The flow check (S302)": the worker applies PS17.3 "before the grant check and the policy … A recipient that may not read a taint denies the intent `audience`, final whatever a policy says". The check finds the leak of item 1 statically; the gate refuses it at run time too, and a body with no taint record is refused `audience`, fail closed. Shown by `test/memory-enforce.test.mjs` ("AC22 (run time): the variant without where owner == customer has its reply denied audience before the handler runs").
9. **Freshness.** PT10k, "Freshness (S307)": an item set older than its source's `freshness` is denied `stale-items` or escalated, "both before the policy"; the check never reads a clock. Shown by `test/memory-enforce.test.mjs` ("S307: with stale deny, the answer over stale orders is denied stale-items").

Claim 7 is the one test that is not a check: it holds that the three end-to-end tests exist and assert the denials, so a change that removed one would fail here.

### One sentence for the documents

The static check follows a taint from a source to the places where data *leaves* (an effect's recipient, a message, and, by label, a region), and it proves a policy over the decision table; it does not follow a source into a decision's inputs, and it never sees a decision's provider. A decision's audience is enforced by the gate, through a policy rule over its taint.

### 20. A policy whose scope names no module governs nothing, and says CLEAN

- **Symptom.** A policy with `scope "fb"` beside a program in module `fb_input` checks `CLEAN` with every stage clean, and its regions read "unreachable, no effect provides sensitive, egress": the scope is the module it governs, and no module is named `fb`. The ungated decision that should have been `PL7001` is not reported.
- **Appeared in.** the flow-boundary tests (the first version of claim 3 passed for the wrong reason).
- **Workaround.** The scope is the module's name.
- **Proposed fix.** A policy whose scope matches no module of the project is a finding (`PL6504`, "the scope governs nothing"), since the regions it reports are then about no effect at all.

## Conclusion

After two batches there are twelve entries. Most are the cost of a check or an admission (3, 7), a silent failure the toolchain could name (2), a rule whose workaround is arbitrary (1), or a spelling the language refuses (5, 10). Item 4 is a difference that the specification states in two places, and a test now holds it. Items 8, 9 and 12 are rules that are right but not said where an author looks. Item 11 is about the tests, not the language. The second batch ran nowhere near the memory limit: its largest instance was 126 global states.

## Glossary

- **Cut point:** a constant a parameter is compared with; the check explores the values on each side of it instead of every value (S458).
- **Region:** a set of effects polycheck proves is always behind a gate; `PL7001` is its witness.
- **Audit row:** a record the runtime writes for a refused dispatch that is no step.
