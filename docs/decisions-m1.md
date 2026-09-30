# poly · Decisions before M1

*Cognitive Fab · September 2026 · answers section 12 of [`plan-m0.md`](plan-m0.md)*

The owner's rulings on what M1 needs that M0 does not provide. They are settled before M1 starts. PT18 is updated in the same commit as this note. Issue ids continue the M0 series, so the first M1 issue is S23.

| Id | Question | Ruling | Spec change |
|---|---|---|---|
| **M1-1** (settles S7) | An accepted step that only emits looks `unhandled` to SAM, so polyrun derives no effects from it. | **Fixed in the engine, not in the lowering.** `@cognitive-fab/sam-pattern` 2.3.0 adds one classification: a step with no rejection, no mutation and no write, whose acceptor declared its frame explicitly with `unchanged(...)`, is `unchanged`, an accepted step. (Amended by S34 below.) A hidden outbox field in the lowering is **rejected**: 04-semantics has no such field, and it would change every state count, so the evidence numbers would no longer compare one to one. polyrun already treats every classification other than `rejected` and `unhandled` as accepted; a test in polygraph pins that for `unchanged`. `PL2201 SILENT_NOOP` still applies to a handler path with no write, no effect and no rejection. | none (PT4.4 already describes the step; the engine catches up) |
| **M1-2** | Liveness is M2, so the three `OutboxIntent` examples are refused with `PL0901` and their safety results are lost. | **Check what can be checked.** `poly check` accepts liveness properties, checks everything else, and lists each liveness property as not run, with the milestone that runs it. A verdict with a not-run item folds to `INCONCLUSIVE` at best, and to `FINDINGS` if a safety check fails. `PL0901` keeps refusing constructs that are not lowered at all. | PT12.2 (`PL0901` note) |
| **M1-3** | `exactly-once` in the `Delivery` gate is a liveness property, so M1 cannot check it. | **Moved to M2.** M1 reproduces the safety results of the four variants: the state counts, `at-most-once`, `in-order`, and both violation witnesses. M2 reproduces `exactly-once` for the two variants that keep dedupe records, and `settles` for the three `OutboxIntent` forms. The checkout's "every placed order settles" moves to M2 on the same grounds; its "no stuck state" (`PL5402`) is a reachability check and stays in M1. | PT18 M1 and M2 rows |
| **M1-4** | Two of the three follow-up defects found after the M0 review were initial values that the finding 3 fix should have caught. | **A generated test.** For every initial-value shape (scalar, union with and without payload, map key, map value, nested union in a map), generate one value inside its type and one outside. The outside value must be `PL1201` at its line; the inside value must lower and pass strict `validate()`. | none |
| **M1-5** | Line endings are part of a file's hash. | **Already enforced.** `.gitattributes` marks `conformance/field-studies/** -text`, and the field-study test re-hashes each copy against `PROVENANCE.md`. Every corpus M1 adds (the `polyrun-oms` order machine and its traces) is copied under the same rule. | none |
| **M1-6** | `poly check` takes one file; configurations span modules. | **The manifest comes first.** Implement `poly.json` as PT1.2 states it. `poly check` takes a file or a project directory. A field the build needs that PT1.2 does not have is a spec issue, raised before it is used. | none |

## Standing rules carried into M1

Every rule of M0 still holds: the import boundary, no model call on a check path, no silent clean, the evidence scripts as acceptance tests, engines as dependencies, `PL2501` and `PL2001` for toolchain faults only, polygraph findings confirmed by poly-ref, and structured diagnostics. One addition:

- **The effect sequence is part of translation validation.** PS9.2 compares `E` as well as the post-state. From M1, poly-ref and the lowered module (`next.cjs` together with `effects.cjs`) must agree on the effect intents of every transition, in order. A lowering that drops or reorders an effect is a deliberately broken lowering in the explicit list, and it must be caught with `PL2501`.

## Rulings on the M1 plan (S23 to S32)

The plan (`plan-m1.md`, 1062948) raised ten issues. S26 was checked against polyrun's store before ruling: `store.mjs` and `store-pg.mjs` apply a step's `cancelTimerKeys` before inserting its `timerRows`, in one transaction, and a timer's id includes the step's sequence number. A re-armed key without a cancellation leaves two scheduled timers that both fire.

| Issue | Ruling | Spec change |
|---|---|---|
| **S23** `check-effects` does not accept an `unchanged` step | **Approved, with one addition.** Change polygraph so `check-effects` accepts every classification other than `rejected` and `unhandled`, as the kernel does. **Addition:** the rule lives in one exported predicate that the kernel, `check-effects` and `check-product` all call, so the three cannot drift again. A polygraph test runs each classification through all three and requires the same answer. Commit in polygraph as `kizo-core` and bump to 8.3.1. Do not publish or push: I release it. | none |
| **S24** The OMS corpus cannot replay at 100% | **Accepted: (a) and (b).** (a) The copied corpus is gated as S1 gated raft: window-by-window identity with the hand-written module (53/81 each). (b) A second corpus is recorded by polyrun's kernel from the hand-written artefacts along the sixteen scenarios, exported with `polyrun export-traces`, and copied with provenance. The scenario script is checked in, so the corpus is reproducible, and `PROVENANCE.md` says the corpus was generated from the hand-written artefacts. The poly order replays (b) at 100%. Record in `plan-m1.md` that corpus (a) predates polygraph `22c676f`; regenerating it upstream is my change, and it is not on M1's path. | AC1; PT18 M1 row |
| **S25** An object without a tag | **Accepted.** `type R = { f: T, … }` is a record type: nominal, finite when its fields are, with no optional fields and no recursion. It lowers to a plain JSON object and compares field by field. A record literal lists every field (`PL1502`). A literal `{ k: v }` is a map or a record by its expected type, as S22 resolves constructors; with no expected type it is `PL1005`. Records may be used wherever a type may. | PT2 `TypeDecl`, PT3.1 |
| **S26** When `after` emits `cancelTimer` | **Accepted: always.** Every `after` lowers to `cancelTimer` then `timer`. The AC1 comparison does not drop `cancelTimer` intents wholesale. It tracks armed keys along each path and ignores a `cancelTimer` only for a key that is not armed on that path. Any other difference is a mismatch. If the hand-written OMS mapper re-arms a key that is armed, that is a defect in the example (two timers fire): report it, and do not normalise it away. | PT6.3 |
| **S27** `check-product` needs cross-machine invariants | **Accepted, with an order.** The hand-written `invariants.compose.mjs` is committed first, in its own commit, before the poly order lowers. The poly `compose invariant`s are then written to state the same predicates. That keeps the comparison from being shaped by the lowering's output. | none |
| **S28** Machine ids | **Accepted.** The lowering uses `<module>.<Machine>`, the PT1.5 build directory name, and the AC1 comparison maps ids before comparing. PT1.5 gains one sentence saying so. | PT1.5 |
| **S29** A send to `none` | **Accepted.** In a configuration it is a finding, `PL5404 SEND_TO_NONE`, with its path. In a single-machine check it is an ordinary intent (S30). | PT12.2; PS13.3 |
| **S30** `send` in a single-machine check | **Accepted as the reading of PS4.4 and PS13.3.** A send is an intent in `E`. Alone, a machine's receivers' replies are ordinary actions the environment may offer in any state. This over-approximates, and the configuration check is where the receiver's actual behaviour is used. PS4.4 gains one sentence saying so. | PS4.4 |
| **S31** `InputRef` | **Accepted:** `InputRef = Ident [ "[" ( Int \| "*" ) "]" ] "." Ident`. | PT2 |
| **S32** Naming an instance's field | **Accepted, with the control field made precise.** In a configuration property, `x.f` and `g[i].f` name field `f` of an instance. `g[i] is C` and `g[*] is C` resolve `C` against the machine's fields: legal when exactly one field's type has the constructor `C`, and it then tests that field. Otherwise it is `PL1005`, and the fix is `g[i].f is C`. Every property in PT7a and PS13.6 must parse under this rule unchanged; any that does not is a spec issue. A field access on an instance is legal only in configuration properties, never inside a machine (PS1.6). | PT7a; PS13.6 |

The agent applies the spec text for S25, S28, S29, S30, S31 and S32 in one commit, citing the ids, before the steps that use them. This commit applies AC1, PT6.3 and PT18.

The order of work in `plan-m1.md` stands. S23 unblocks the engine step now.

## Rulings before the engine step (S33, S34)

| Issue | Ruling | Spec change |
|---|---|---|
| **S34** What `unhandled` means in sam-pattern 2.3.0 | **Option A.** A step is `unhandled` when no acceptor ran for its intent: none is keyed to it, and no broadcast acceptor is registered. It no longer throws. An acceptor that ran without declaring a frame still throws `SamFrameError`, so a forgotten frame stays loud. `unchanged('*')` and `unchanged('a', 'b')` both classify `unchanged`: the wildcard means exactly what listing every field means. poly lowers an action with no handler as an intent with no acceptor, which is PS3.2's "a has no handler". Option B is rejected because it would give the wildcard a meaning of its own. The sam-lib tests cover the four rows: no acceptor, an acceptor with no frame, `unchanged('*')`, and named fields. | none |
| **S33** `check-effects` flags every emit-only step | **Accepted as a finding, not as an illegal step.** PS3.4 stays as it is: such a step is legal and accepted. The check is sound on **check**: every input is offered in every state (PS4.1), the step is deterministic, and its post-state equals its pre-state, so the same step is enabled again and repeats its effects without limit. It is reported as `PL4002 EMIT_WITHOUT_STATE_CHANGE`, in the path-property range, with a witness of two repetitions. poly-ref confirms it as an accepted step whose effect sequence is not empty and whose post-state equals its pre-state; polyrun's `identity-accept-emits` must name the same steps (a disagreement is `PL2501`). It applies whatever the effect's class. The fix is to record the emission in the state, as in the README's `enter-charging-status`. A person may accept the finding under PT12.5, like any other. The double-charge example in the README and PT4.5 now reports `PL4002` on `Pay` as well as `PL4001`, and both outputs are updated. | PT12.2; PT5; PT4.5 and README outputs |

The agent applies the spec text for S33 in one commit, citing the id, before step 5. The engine step goes ahead under S34.

## S34 amended, and rulings on S35 and S36

**S34 is amended to option (b)**, as built in sam-lib 3047024. An intent with no acceptor throws `SamFrameError`, exactly as in 2.2. The rest of 2.3.0 stands: a step that writes nothing and declares its frame with `unchanged(...)` is `unchanged`, an accepted step. Reason: the engine audit showed that polysec's mediator and polyman refuse a step only on a throw or on `rejected`, and polygraph's adapter explored the no-acceptor step as an accepted step. Keeping the throw leaves every engine as it was on that case.

| Issue | Ruling | Spec change |
|---|---|---|
| **S35** (revised) An action with no handler | **Accepted, with three conditions.** An action with no handler is not an intent of the lowered module and not in the contract's `actions`. The runtime reports it `unhandled` before any acceptor runs (PS3.2 row 3, PS9.1a), and the broadcast acceptor for guards stays, so PT4.3 is unchanged. (1) Translation validation does not skip these actions: for each one, it applies rows 1 to 3 as the runtime does and compares the verdict with poly-ref's (`terminal` in a terminal state, `unhandled` elsewhere). (2) A reject property that names an action with no handler is decided by poly-ref alone, and the verdict record says so under the instance line. It is never counted as checked by polygraph. (3) Re-run the M0 gate: the three field studies must give the same window results, and any contract whose `actions` list changes is recorded in `plan-m1.md`. | PT4.5 (the lowered example); PS9.1a (one sentence on the action surface) |
| **S36** polygraph vendors sam-pattern 2.2.0 | **Approved, after a full re-run.** Re-vendor the 2.3.0 build of 3047024 in polygraph 8.3.1, with its provenance header; I fill in the tarball hash when I publish. Before the commit: (1) re-run every suite in the audit on this build, including those not re-run on it (polygraph selftests, polynv, polygents, the SAM tests of polysim, sam-fsm), and record the counts; (2) add the audit's probe to polygraph's tests as a permanent test, both changed cases through the adapter, because no existing suite covered them. The same probe in polyflow and polyaxion is my change to make; list it for me. | none |

The agent applies the spec text for S35 in one commit, citing the id. Step 5 starts when S36's re-run is clean.

## Rulings after step 5 (S37 to S42)

| Issue | Ruling | Spec change |
|---|---|---|
| **S37** `before(a, b)`, and path properties outside the accepted forms | **Accepted, with its own code.** In M1, `before("k1", "k2")` ranges over effect kinds: it holds on a path iff every emission of `k2` is preceded by an emission of `k1`. It is prefix-closed. `count("k") < n` is accepted as `count("k") <= n - 1`. A form that is not a conjunction of these is refused with a **new code**, `PL1701 NOT_PREFIX_CLOSED`, whose message cites PS5.4. `PL1201` is rejected: the property may type-check perfectly, and the defect is its shape. `before` over actions is not added; it can come when a program needs it. | PS5.4; PT2.2; PT12.2 |
| **S38** A machine that emits but has no path property | **Accepted.** Stage 3 runs only when the machine has a path property. Otherwise `PL4002` is decided by poly-ref alone, and the verdict record says so under the instance line, as for S35. The synthetic always-true invariant is rejected, for the reason given in the plan. | none |
| **S39** polyrun's `cycle-edge-emits` | **Accepted as a note, printed in the output.** It is never dropped: the stage 3 section of the output lists each one with its edge, marked as a note. A `count` property over that kind is decided by poly-ref over every path, cycles included. | none |
| **S40** A completion action with no handler | **Accepted, with its own code.** A completion (`ok`, `failed`, `exhausted`) that names an action which is not declared stays `PL1001`. One that names a declared action with no handler is **`PL6101 COMPLETION_WITHOUT_HANDLER`**, at the completion's line, because polyrun refuses to load such a manifest. The fix it offers is to add a handler. | PT6.1; PT12.2 |
| **S41** An effect with no `kind` | **Accepted, with a collision check.** The kind defaults to the effect's name. Two effect declarations in one project with the same kind and different payloads, completions or class are `PL1002 DUPLICATE_DECLARATION`, since polyrun keys handlers by kind. | PT6.1 |
| **S42** PT4.5 has four findings | **Narrow the property.** It is about the draft state: `(action == Place && pre.status == Draft && pre.items == 0) implies rejected("empty-order")`. Update PT4.5, its lowered excerpt (the `place-empty` predicate) and `examples/orders/orders.poly` together, so "three findings" stays true. | PT4.5 |

The agent applies the spec text for S37 and S40 to S42 in one commit, citing the ids, and removes the provisional marks from S37 to S41. Step 6 can start.

## Rulings before attached children (S43 to S48)

S45 was checked against polyrun before ruling. `kernel.mjs` delivers a child's completion and a parent-terminal cancel itself, but `dispatch` (and `http.mjs` behind it) accepts any action of the surface from outside, a child's completion action included. So check-product's rule matches the kernel's own deliveries, not everything the runtime accepts.

| Issue | Ruling | Spec change |
|---|---|---|
| **S43** `spawn`'s arguments | **Accepted.** `spawn M as k -> Start(args)`: the child is created in its initial state and then takes `Start(args)` as its first step, as polyrun does. `spawn M as k` with no creation action is also legal. `initData` is removed from PT6.4. | PT6.4 |
| **S44** Completion and cancel payloads | **Accepted, with exact types.** A completion action declares `(childKey: string, childState: R)`, where `R` is a record type whose fields match the child's state (S25), or declares no parameters. A cancel action declares `(reason: string check { "parent-terminal" })` or none. Any other parameter list is `PL1201` at the action, because polyrun will not supply it. | PT6.4 |
| **S45** Which stimuli the parent is offered | **Accepted, as a kernel assumption.** PS7.1 adopts polyrun's rule: a child's completion action is offered to the parent only when that child is terminal, and a terminal instance is offered nothing. Because polyrun accepts that action from outside today, the rule is stated as **K9: a child-completion or cancel action is delivered only by the kernel**. poly-ref and check-product both assume it, and every verdict that relies on it lists K9 under the instance line. The runtime must enforce it: M4's gate checks that an external dispatch of such an action is refused. The polyrun change (refuse an external dispatch of an action wired as a child completion or cancel) is mine to make; list it for me. | PS7.1; PS10 (K9); PT18 M4 row |
| **S46** Children of children | **Accepted.** `PL0901` in M1, and the plan lists it for a later milestone. | none |
| **S47** Codes for polyrun's doctrine findings | **Accepted.** `PL5102 UNHANDLED_CASCADE_DELIVERY` is new. An unnamed reject or a poisoned lowered module means the lowering lost something, so each is `PL2501`, and each gets a deliberately broken lowering in the explicit list. | PT12.2 |
| **S48** A compose invariant that reads a child not yet spawned | **Accepted, with its own code.** A read of `children.k.f` is legal only under a `k spawned` narrowing, as `action == A` narrows parameters (S19). An unnarrowed read is `PL5103 CHILD_READ_WITHOUT_SPAWNED`, and the fix it offers is the narrowing. | PT7; PT12.2 |

**The OMS shipments spawned in a loop.** Raise it as S49 before step 7, with a proposal. My direction: keys indexed by a bounded range, `spawn Shipment as f[i]` lowering to the key `f<i>`, with `i` from a declared integer range, and a bounded `for i in 0..n` statement unrolled at compile time, where `n` is a constant or a field bounded by its type. No unbounded loop, and no key built from a string at runtime.

The agent applies the spec text for S43 to S45, S47 and S48 in one commit, citing the ids. Attached children can start.

## Rulings before step 7 (S49 to S51, and one from K9)

| Issue | Ruling | Spec change |
|---|---|---|
| **S49** The looped OMS shipments | **Accepted as proposed, with four limits.** (1) A child family is declared by an indexed key, `spawn Shipment as f[i]`, lowering to the key `f<i>`; `i` has an integer range type, and that range bounds the family. (2) `for i in 0..n { … }` is unrolled at compile time. `n` is a literal, or a field or parameter whose range type bounds it; when `n` is not a literal, the loop unrolls to the bound of its type and each copy is guarded by `i <= n`. (3) A loop body may contain `spawn`, `signal`, `emit`, `after` and `cancel` with keys indexed by `i`, and writes to `m'[i]` of a map. Any other write is refused by the existing rules (`PL2102` on the second copy), and a non-indexed timer key is `PL2301`. (4) Spawning `f[i]` twice for one `i` on one path is `PL5101`. Compose invariants reach a family through S32's `forall` and `count(children.f[*] …)`. The OMS joint state count is measured and recorded in `plan-m1.md`, since a family multiplies it. | PT2; PT6.4; PT7 |
| **S50** A signal to a child not yet spawned | **Accepted:** `PL5104 SIGNAL_TO_ABSENT_CHILD`, with its path. polyrun poisons the parent, so this is a finding, not a note. | PT7; PT12.2 |
| **S51** A completion's `childKey` needs a finite domain | **Covered by S49.** Its domain is the set of keys of the families and single children whose completion names that action. | PT6.4 |
| **S52** (new, from the K9 note) One action wired to two sources | Once polyrun refuses a child's completion from outside, an effect completion or a timer wired to the same action would be refused too. **Refuse it at compile time:** an action that is both a child's completion or cancel action and an effect completion or timer action is `PL6102 SHARED_COMPLETION_ACTION`, at the second wiring. | PT6.4; PT12.2 |

The agent applies the spec text for S49, S50 and S52 in one commit, citing the ids. Step 7 can start.

## Ruling on S53 (from the review of step 7)

| Issue | Ruling | Spec change |
|---|---|---|
| **S53** A parameter declared `strict` on an action with no handler | PS9.1a says row 2 of PS3.2 never applies to such an action, because a parameter becomes `strict` only by flowing into an effect. An explicit `strict` breaks that: the semantics would answer `rejected("outside-check-domain")` for data outside the domain, and the runtime answers `unhandled`, because the action is not in the module's surface (S35). **Refuse the declaration, and keep the table.** An explicit `strict` on a parameter of an action with no handler is `PL1302 STRICT_ON_UNHANDLED_ACTION`, at the declaration; the fixes it offers are to remove `strict` or to add a handler. PS9.1a's parenthetical then holds by construction, and PS3.2's row order stays as it is. Reordering the table was considered and rejected: it would change the semantics to fit one lowering choice. | PS9.1a (the parenthetical cites PL1302); PT3.4; PT12.2 |

The agent applies the spec text in one commit, with a regression test that fails first, before families.

## Rulings on S54 and S55, and when the model-decisions proposal enters

| Issue | Ruling | Spec change |
|---|---|---|
| **S54** The OMS enters `charging` from two handlers | **Accepted: two copies in M1, no new construct.** `FRAUD_PASSED` and `AMEND` each emit `chargeCard` and arm `chargeTimeout`; in `AMEND` the payload is the `totalCents` parameter, since expressions read the pre-state. The AC1 comparison with the hand-written mapper catches the copies drifting apart. An entry construct is recorded as a candidate, to be decided from the M3 experiment's data, not from one example. | none (candidate listed in `plan-m1.md`) |
| **S55** Entry writes to one map from the copies of a loop | **Accepted, with the rule made static.** Writes to entries of one map on one control path combine when their keys are **distinct constants after unrolling** (literals, constructors, or the index of different loop copies). A whole write together with any entry write, or two entry writes whose keys are the same constant or are not both constants, is `PL2102`. The checker never reasons about runtime key values: a write `m'[k]` with `k` a field or parameter may not share a path with another entry write to `m`. | PS2.2, PS2.4 (one sentence each) |

**The model-decisions proposal** (`docs/proposals/pd-model-decisions.md`, v0.2, with its review and response in `docs/reviews/`) is not part of M1. It is ruled at M1's close, after the M1 code review and before the M2 handoff. If ruled as proposed, PD1 joins M2's scope and gate (PD1-A1 to A4), PD2 and PD3 join M4 with K10, and PD4 joins M5. Nothing in M1 reads it or builds toward it.

## Conclusion

M1 starts with its three open questions settled. The emit-only step is fixed where it originates, in the engine. Liveness no longer blocks a safety result. The one gate item that needs liveness moves to the milestone that builds it. The configuration explorer is the main work, and its first targets (the checkout witness and the delivery variants) are already measured by independent scripts. The rulings on the plan add the record type the OMS order needs and fix the timer rule against polyrun's store.
