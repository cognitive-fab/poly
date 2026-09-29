# Review: poly specification set, draft v0.2

*Peer review of `README.md` and `docs/01` to `docs/03`, draft v0.2. Written in the manner of a formal-methods reviewer at the author's request: it asks what each statement means, and whether that meaning has been written down. 29 September 2026.*

## Verdict

**Major revision.** The documents describe a system carefully. They do not specify one. I read about 11,000 words and could not find a definition of what a poly program *means*. There is a great deal about what the compiler produces, what the engines check and what the runtime does. There is no statement, independent of those tools, of the set of behaviours a poly program allows. Without that, the central claims cannot be judged, and no amount of engineering will make them true:

- the checked program is the running program;
- lowering preserves meaning;
- replay reproduces every decision.

The good news is that the author has the tools to fix this, and one of the documents already contains the right idea (PT9.7). It needs to be applied to the language itself.

## 1. There is no semantics

A programming language is specified by its semantics. The grammar (PT2) says which texts are programs. The lowering map (02 §4) says what files the compiler writes. Neither says what a program does.

Section PT4 comes closest. But it defines a handler by describing the SAM acceptor it lowers to. That makes the lowering the definition, so the question "is the lowering correct?" has no content. A compiler cannot be wrong about a language that is defined as whatever the compiler produces.

**What I would like to see** is a short, mathematical definition, and short is the point. It should state:

- **State.** A state of a machine is a function from its declared fields to values of their types.
- **Steps.** A step is a pair of states, together with the action and its data, that satisfies the handler's condition. It needs a precise account of what `require`, `if`, the primed assignments and the derived frame contribute to that condition.
- **Behaviours.** A behaviour is a sequence of states, starting in the initial state, in which each consecutive pair is a step or leaves the state unchanged.
- **Properties.** A program satisfies an invariant when every state of every behaviour satisfies it.

Writing this down will take a few pages. It will also expose questions the prose has not settled (sections 2 to 5 below). Once it exists, the lowering to SAM has a precise correctness condition: every behaviour of the lowered module is a behaviour of the poly program, and the converse. That condition can then be checked mechanically on the conformance suite, or argued once.

I would write it in TLA+ or in poly itself. The author's stack uses the SAM pattern, whose step is explicitly modelled on the TLA+ step, so either choice is natural.

## 2. Is a rejected step a step?

The documents say "rejection is a result, not an error" and journal rejected steps. They also define **reject invariants** that hold "over every step". So a rejected step is in the journal and is quantified over by invariants. But it leaves the state unchanged.

In the usual terms, that makes a rejected step either a *stuttering step* (no change of state) or a step of a larger state that includes the last verdict. These two readings give different meanings to the same invariants:

- **If rejected steps are stuttering steps**, a reject invariant is not a property of the machine's behaviours at all. It is a property of how the machine is *observed*, and it is invisible to any check that looks only at states.
- **If the verdict is part of the state**, then the "sealed state" of PF1.1 is not the whole state. The model checker, the version gate and the replay must all agree on which state they mean.

The author should choose one reading, state it, and make every check use it.

## 3. "Invariant" is used for things that are not invariants

An invariant is a predicate on states that is true of every reachable state. The documents use the word for four different kinds of object:

| poly form | What it actually is |
|---|---|
| `invariant` | a state predicate: an invariant proper |
| `step invariant` | a predicate on pairs of states, which must hold of every step; this is an *action property*, not an invariant |
| `reject invariant` | a predicate on steps and their verdicts; its meaning depends on section 2 |
| `emits invariant` | a predicate on the *sequence* of effects along a path; this is a property of behaviours, not of states |

Calling all four "invariants" is harmless for the author, who knows the difference. It is harmful for the intended author of poly programs, a coding agent. The agent will generalise from the word and write a path property as a state predicate. I would use three words: *invariant* for state predicates, *step property* for predicates on steps, and *path property* for predicates on sequences.

## 4. There is no liveness, and the documents rely on it

Every property the checker verifies is a **safety** property: something bad never happens. Several requirements are **liveness** properties, where something good eventually happens:

- PT9.7 rule 2: an escalation "has a timeout" and is denied when it expires.
- PF8.3: effects run at least once, and exhausted effects "dispatch the declared action".
- PT6.3: timers fire.
- 01 G5 and PF8.4: every effect "crosses the gate".

None of these can be established by checking invariants. They require an assumption of fairness: the timer eventually fires; the worker eventually takes an enabled intent. They also require a check of the form "from every reachable state, a terminal state is eventually reached". The documents contain neither the assumption nor the check.

This is not an academic point. The `OutboxIntent` machine in PT9.7 has a behaviour that stops short of a terminal state:

- **The sequence.** Take an intent through `Propose`, `GateAllow`, `Start`, `HandlerOk` and `SettleFailed` until `attempts` reaches 3. On the last `SettleFailed`, the machine returns to `Allowed`.
- **Why it is stuck.** From `Allowed`, `Start` requires `attempts < 3` and is rejected. No other action is accepted in `Allowed`. The intent is in a non-terminal state with no enabled step.
- **What the checker says.** Every invariant holds in that state, so the model check reports it clean.

The machine that was written to make the runtime's most dangerous code safe is stuck on an ordinary path of settle failures. A check for deadlock, or for eventual termination under fairness, finds this at once.

**Recommendations.**

- Add a *deadlock check* to stage 2: every reachable non-terminal state has at least one accepting action. polygraph already enumerates the reachable states, so this costs almost nothing.
- Add the ability to state liveness properties under explicit fairness assumptions (for example `eventually terminal` under weak fairness of the worker's actions). Specify which engine checks them. If none does yet, say that they are unchecked, rather than listing them among the guarantees.
- Fix the machine: `SettleFailed` with `attempts == 3` should go to `Dead`, as `HandlerFailed` does.

## 5. Expressions need a grammar with precedence

PT2.2 lists operators but gives no precedence or associativity. PT9.7 then writes:

```
invariant one-decision-per-execution: executed implies decisions <= 1 || approved
```

This could mean `executed implies (decisions <= 1 || approved)`, which is what the prose intends. It could also mean `(executed implies decisions <= 1) || approved`, which is a much weaker property. The two readings are checked differently and pass or fail on different programs. The specification must define precedence. It should also state whether `implies` is right-associative, as in logic, or left-associative, as a TypeScript programmer might guess. I would further require the formatter to insert parentheses around any mixture of `implies` with `&&` or `||`, so no author has to remember the answer.

## 6. Three-valued logic changes the meaning of safety

Policies use a three-valued logic in which "an unknown value never satisfies a requirement". That is the right choice for `require`. But the documents do not say what an unknown value does to `when`. The natural reading, and the one Polyaxion's document suggests, is that a rule whose `when` is unknown does not apply.

Consider PT8.1:

```
when action.effects has "egress:external"
require not history.any(a => a.effects has "read:private") else deny
```

If `action.effects` is unknown, for example because an effect was not labelled, the rule does not apply and the action is allowed. So the rule's safety depends on the completeness of the labels, and the policy text gives no hint of this. PT6.2 reports unlabelled effects, but only as a finding, and the project can turn it into a report.

The meaning of a policy should not depend on how complete its inputs happen to be. I would ask for:

- a precise definition of the value of `when` and `require` under each of true, false and unknown;
- a rule that a `deny` obligation whose `when` is unknown is treated as applicable, with the decision `escalate`, unless the author writes otherwise;
- unlabelled effects made a refusal, not a finding, in any scope that has an obligation mentioning labels.

## 7. The claim of section 7.3 needs a proof, or a smaller claim

The architecture says a gate decision "is a function of the policy digest, Σ at proposal and the snapshot at the emitting `seq`", so replay reproduces it. This depends on three things the documents do not establish:

1. **Σ at proposal is determined by the ledger.** The gate's state is updated by settles as well as proposals, and settles of *other* intents can interleave with this one. So Σ at proposal depends on the order in which the gate received events. Is that order in the ledger? Chaining per run (v0.2) removed any global order. Σ, however, is per session, and a session spans runs.
2. **The gate's decision function is a function.** The Polyaxion measurements say it is, but the property needs to be stated as a requirement on the engine, not assumed.
3. **Replay feeds the gate the same inputs in the same order.**

I would either define a *session order* and record it (a per-session sequence number in each proposal and settle event), or weaken the claim to "replay reproduces each decision given the recorded Σ", and record Σ's digest with each decision.

## 8. The composition semantics is an assumption about the kernel

PT7 adopts polyrun's rule that cascades are atomic and that dispatch has a single writer per instance. Under those assumptions, the product check of a parent and its children is sound. But the assumptions are properties of the *runtime*, and the runtime is not specified in poly or checked. The claim that "the checked program is the running program" is really the claim that "the checked program runs on a kernel satisfying assumptions A1 to An". Those assumptions should be listed, numbered and cited wherever a guarantee depends on them. The kernel's own tests are then the evidence that they hold.

## 9. "Exhaustive" should always carry its bounds

The documents are careful to say that checks are exhaustive over declared finite domains, and to report `INCONCLUSIVE` when a bound is hit. I would go one step further. Every `CLEAN` verdict should be printed with the instance it holds for: the domains, the number of children, and the cascade depth. For example, "CLEAN for `items ∈ 0..3`, `amount ∈ {10, 20}`, children ≤ 2, depth ≤ 8". This makes the scope of the guarantee visible where it is read, not only in the certificate. It also makes it harder for anyone, including the author's future readers, to repeat the claim without its bounds.

## 10. On the experiment

The experiment in PT13 is well designed. The main oracle is now written without knowledge of the reference machines, and the decision rule is fixed in advance. I have no quarrel with it. I would only note that it measures whether poly helps agents write fewer bugs, and that is a different question from whether poly is well defined. A positive result would not repair sections 1 to 9. A negative one would not show that they are unimportant.

## 11. What is right

- **PT9.7 is the best section in the documents.** It takes the most dangerous piece of the runtime and writes it as a state machine to be checked, not described. That is exactly the practice the rest of the language needs.
- **The environment is modelled as nondeterminism.** In `OutboxIntent`, the gate's decision is an unconstrained choice among `GateAllow`, `GateDeny` and `GateEscalate`. That is correct: the checker then covers every decision the gate might make, without trusting the gate.
- **Derived frames.** Deriving the frame (what is unchanged) from what is written removes a whole class of specification errors. This is the same service TLA+'s `UNCHANGED` does, done automatically.
- **Refusing to report clean** when a bound is hit is correct and uncommon.

## 12. Requested changes, in order

1. A mathematical definition of a poly program's behaviours, including rejected steps (sections 1 and 2).
2. A correctness condition for the lowering, checked on the conformance suite (section 1).
3. Distinct names for state, step and path properties (section 3).
4. A deadlock check; liveness under stated fairness, or an explicit list of unchecked liveness claims; the `OutboxIntent` fix (section 4).
5. Operator precedence and associativity, with forced parentheses around `implies` (section 5).
6. The meaning of unknown in `when`; unlabelled effects refused where labels matter (section 6).
7. A recorded session order for the gate, or a weaker replay claim (section 7).
8. Numbered kernel assumptions, cited by every guarantee that uses them (section 8).
9. Bounds printed with every `CLEAN` (section 9).

## Conclusion

The design is sound, and parts of it are elegant. What is missing is the thing a language most needs: a precise statement of what its programs mean. Every hard question in these documents comes down to that missing statement, including lowering correctness, replay, composition, rejection and the gate's treatment of unknowns. It is also why a stuck state in the one fully modelled component went unnoticed. It will take the author a few pages to write. Those pages will do more for the correctness of poly than the rest of the specification put together.
