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

## Conclusion

Three of the seven are the cost of a check or an admission (3, 7) or of a silent failure (2) that the toolchain could name at check time. Two (1, 5) are rules whose workaround is arbitrary or whose natural spelling is refused. Item 4 is a difference that the specification states in two places, and the test now holds it.

## Glossary

- **Cut point:** a constant a parameter is compared with; the check explores the values on each side of it instead of every value (S458).
- **Region:** a set of effects polycheck proves is always behind a gate; `PL7001` is its witness.
- **Audit row:** a record the runtime writes for a refused dispatch that is no step.
