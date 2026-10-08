# Referee report: "poly: Checked State Machines and a Governed Runtime for Code Written by Agents"

Written in the manner of Leslie Lamport. It is not by him and does not speak for him.

Draft reviewed: 7 October 2026, docs/paper/main.tex.

## Summary

The paper describes a language in which programs are finite state machines, a checker that explores their reachable states, and a runtime that gates and journals their effects. It reports an experiment in which a coding agent learned the language and every program it delivered passed the checker. The baselines had no defects, so the experiment says nothing about whether the language prevents any.

The ideas are reasonable, and some are good. The paper does not state precisely what it claims, so I cannot tell whether the claims are true. A paper about checking programs against precise properties should be held to the standard it proposes for others.

## Major comments

**1. What is checked against what?** The central slogan is that "the program is the model". A model, or a specification, is useful because it is simpler than the program and says what the program should do. If the program is the model, the only specification left is the set of properties the agent wrote. The checker then shows that the program satisfies properties written by the same author, at the same time, from the same brief. That is worth something, but it is not correctness. The paper's own T3 result shows the gap: every defective program was admitted, because no property said that a refund of 3 units must be refused. The paper should say plainly that the checker establishes consistency between a program and its stated properties, and that the hard problem is getting the properties right. It should then say what poly does about that problem. "The agent writes the invariants" is not an answer, since the agent also wrote the bug.

**2. There is no semantics in the paper.** I was told that a document called 04-semantics exists. The paper does not give its reader any of it. I could not find a definition of:
- a state (does it include pending effects, timers, the journal, the gate's sessions?);
- a step, and which variables a step may change;
- the next-state relation of a machine whose environment sends actions, completions and timer firings in any order;
- how several instances and machines interleave;
- what "every reachable state" ranges over.

Without these, "explores every reachable state" has no meaning a reader can check. A page of mathematics would fix this. Define the state space, the initial predicate, the next-state action as a disjunction of the action handlers, completions and timer firings, and the behaviors as sequences of states. Then each property kind is a formula over behaviors, and the reader knows what a CLEAN verdict asserts.

**3. Exhaustive over what?** The checker is exhaustive over declared finite domains, so what it checks is a finite instance of the system. That is what TLC does, and it is very useful, but it should be called what it is. The paper needs two things it does not have.
- **An argument about small instances.** Why should a property that holds for amounts {1, 2} hold for all amounts? Sometimes it does, by a data-independence argument (Wolper's, or the small-scope hypothesis of Jackson). Sometimes it does not. The paper asserts that "the defects that matter in stateful code are reachable within small finite domains" without evidence.
- **The tension with strict mode.** Strict mode makes the checked domain the running domain by refusing every other input. A payment service whose amounts are strict over {1, 2} refuses real payments. So either domains are small and the running program is useless, or they are large and the state space is too big to explore, or they are disclosed and the guarantee does not hold where the program runs. The proposed change to strict-by-default sharpens the tension. The paper must say how a real program resolves it.

**4. Safety, liveness and deadlock.** The turnstile example reports a "deadlock": a non-terminal state in which every action is rejected. In an open system, where actions come from the environment, that is a liveness property: the turnstile can never again let anyone through. It should be stated as one. Liveness "under stated fairness" is mentioned once and never defined. Which fairness? Weak or strong? On which actions? A checker that reports liveness results without saying what fairness it assumed has told the reader nothing.

**5. The runtime is an unverified concurrent system.** The paper makes strong claims about the runtime:
- a step commits atomically;
- effects run at least once and are emitted exactly once;
- the gate never fails open;
- the journal replays every gate decision;
- concurrent admissions do not move the anchor backward.

These are claims about a concurrent system with retries, failures and persistent storage. Exactly this kind of claim is wrong more often than not unless it is specified and checked. The authors have a model checker. They should write a specification of the runtime (dispatch, the gate, effect retries, completions, the journal and the anchor) and check it. I would rather read that specification than the paragraph that describes the runtime.

**6. The gate reads a state that may no longer be current.** The gate evaluates an effect "against the state of the step that emitted it, never a later one". An escalated effect waits for a person. Suppose the order is cancelled while a refund waits for approval, and the approval then arrives. Does the refund run? If the gate's decision reads the old state, the policy "no irreversible effect on a cancelled order" can be broken by an approved effect. Either this cannot happen, and the paper should say why, or it can, and the paper should say what the program must do about it.

**7. Translation validation, between what?** The lowered module is "validated per program against poly-ref". The paper should state the relation that is checked: equality of next states on every explored state, trace equivalence, or something else. Note that it is checked only on explored states, which is where it matters least. The disclosed inputs that broke T3 were never explored. Note also that poly-ref and the compiler were written from the same English semantics by the same author. That they share no code does not make their errors independent.

**8. The experiment supports a narrower claim than the paper makes.** The title and contributions promise a language that makes stateful code correct. The experiment shows that an agent can learn the language. That is a good result, and it should be the paper's claim. "Admitted in 100 of 100 runs" is weaker than it sounds, because admission is the checker's own verdict on properties the agent wrote. Report how many admitted programs failed the independent oracle (five of 100). That number is the one a reader needs.

## Minor comments

- **Related work misdescribes P.** It says of P, TLA+ and Alloy that "in each, the checked model is separate from the production code". That is false for P. P programs compile to executable code, and that code shipped in Windows device drivers. PlusCal, which translates an algorithm into a TLA+ specification, is the closest precedent for writing one text that is both checked and meant to be run, and it is not cited. Event-B, with code generation from refined models, and verified systems such as IronFleet and Verdi, should also be discussed.
- **Three-valued policies.** Say which logic: Kleene's strong logic, or another. Give the truth tables for "and", "or" and "not" with unknown. "An unknown never satisfies a requirement" does not determine them.
- **Confidence intervals.** Exploring one value per interval is sound only because the program's behavior depends on confidence only through comparisons with constants. State that as a lemma and prove it; it takes three lines.
- **UNDERPOWERED** is defined as "evidence too thin to support a verdict". What evidence does an exhaustive search have too little of? Give a precise condition, or drop the verdict.
- **Witnesses.** Breadth-first search gives a shortest witness only for safety. Say what a witness to a liveness violation is (a lasso) and whether it is shortest.
- **Path properties.** `count("payment.charge") <= 1` is over which sequence: all effects emitted in a behavior, effects emitted by one instance, or effects actually executed after retries? These differ.
- **The surface rule.** The embedded TypeScript surface is said to produce "the same syntax tree". Is the TypeScript around it checked? If not, say what the checker assumes about it.

## Recommendation

Major revision. The paper should:
1. state its claims precisely, with the transition system and the meaning of each property and verdict written as mathematics;
2. replace the slogan "the program is the model" with what the checker actually establishes;
3. add a specification of the runtime, checked with the authors' own tools;
4. narrow the experimental claim to what the experiment shows: the learnability result.

The pending strict-default experiment will not answer comments 1 and 3. A harder experiment, on tasks where the baselines fail, might answer the question the paper wants to ask.

## Conclusion

The paper's ideas need a precise statement, and the paper does not yet contain one. Writing it will show which claims hold. I expect most of the language claims will survive, the runtime claims will need a specification to survive, and the slogan will not survive at all.
