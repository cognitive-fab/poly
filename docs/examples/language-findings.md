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

## Conclusion

After two batches there are twelve entries. Most are the cost of a check or an admission (3, 7), a silent failure the toolchain could name (2), a rule whose workaround is arbitrary (1), or a spelling the language refuses (5, 10). Item 4 is a difference that the specification states in two places, and a test now holds it. Items 8, 9 and 12 are rules that are right but not said where an author looks. Item 11 is about the tests, not the language. The second batch ran nowhere near the memory limit: its largest instance was 126 global states.

## Glossary

- **Cut point:** a constant a parameter is compared with; the check explores the values on each side of it instead of every value (S458).
- **Region:** a set of effects polycheck proves is always behind a gate; `PL7001` is its witness.
- **Audit row:** a record the runtime writes for a refused dispatch that is no step.
