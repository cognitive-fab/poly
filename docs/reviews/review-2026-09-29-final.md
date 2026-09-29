# Final review: poly specification set, draft v0.5

*Peer review of `README.md` and `docs/01` to `docs/04`, draft v0.5. The same formal-methods reviewer who read v0.2, written in that manner at the author's request, and asked to have the last word. 29 September 2026.*

## Verdict

**Accept, subject to the corrections below.** When I last read these documents they described a system and specified none. They now specify one. `04-semantics` defines what a program means, and every other document defers to it. The lowering is checked against that definition on every run. The one component I found stuck is now a checked machine, and the check that would have caught it runs on every machine. Configurations of communicating machines have a precise meaning.

Most remaining problems are small and precise, which is what one hopes for at this stage. One is not small: the runtime's delivery protocol is the foundation of the new configuration semantics, and it has no model (section 4). I list the problems in the order I would fix them.

## 1. Messages need identities

PS13.2 makes the messages in transit a **multiset** of triples (target, action, data). PS14.2 then asks for "weak fairness of each message's delivery". These two statements do not fit together.

- **Identical messages cannot be told apart.** In a multiset, two identical messages are indistinguishable. Delivering one of them satisfies every fairness condition that mentions its value, while the other may wait forever.
- **"Each message" has no meaning in the model.** The runtime does not have this problem, because every message carries an idempotency key. The model does, because it has no keys.

This matters in practice: two orders that each send `Query(from: inv)` to a shared service with the same data are exactly such a pair.

**Correction.** Give each message an identity in the model: its sender, the sender's step number and its position in that step's intents. This is the model's image of the idempotency key. `μ` becomes a set of identified messages. Fairness is then weak fairness of each identified message, as PS14.2 intends. The explored state space does not grow in any case that matters, because identities are erased when states are compared for liveness, and only kept for fairness bookkeeping.

## 2. "Exactly one step per message" rests on a dedupe table that must never forget

PS14.3 derives "each message takes exactly one step at its receiver" from at-least-once delivery plus deduplication (K4). K4 says that "a repeated `actionId` returns the recorded result and takes no step". It does not say for how long.

polyrun has an `archive` command. If archiving removes dedupe rows, a redelivery that arrives after the archive takes a second step. The outbox retries by design, so such a redelivery can happen. In that case the exactly-once claim is false.

**Correction.** State K4 with its horizon. Either the dedupe record is kept for the life of the instance (so archiving keeps it), or it is kept for at least the maximum retry horizon of every sender (declared, and checked against every manifest's retry policy). The first is simpler and I would choose it.

## 3. The theorem for configurations needs its happens-before argument

PS13.7 extends the theorem of PS4.1b: every run of the deployed instances is a path of the check interpretation. But a deployed configuration does not execute a sequence of global steps. Different instances take steps at the same time on different workers, and nobody ever observes a global state. A run is a **partial order** of events, ordered by the causal relation: a step precedes a later step of the same instance, and a send precedes the delivery of that message.

The theorem is still true, but it needs its argument, and the argument is short:

1. **Commutation.** Every step touches one instance's state and adds messages to transit. Two steps of different instances that are not causally ordered therefore commute.
2. **Linear extensions.** So every linear extension of the run's partial order is a sequence of global steps, and it is a path of **check**, because **check** delivers any message in transit in any order.
3. **Coverage.** A configuration invariant that holds on every path of **check** holds in every state of every linear extension. So it holds however the run is linearised.

Write this down in PS13.7. It is also the place to note what the theorem does *not* give. A configuration invariant is a statement about states that no participant can observe. It constrains the system's behaviour, but no runtime monitor can check it directly. Monitoring it needs a consistent snapshot of the instances, or checking it offline over the ledger.

## 4. The delivery protocol has no model

The `OutboxIntent` machine (PT9.7) models one effect intent's life at the sender. Configurations now depend on a second protocol, delivery, which is not modelled:

- `sendTo` is written to the sender's outbox inside the sender's step (K1);
- the sender's outbox is drained at least once;
- the receiver's `dispatch` is deduplicated by `actionId` (K4);
- deliveries are sometimes retried after the receiver has already stepped;
- archiving happens (section 2);
- `fifo` is kept only between co-located instances (PS13.4).

Each of these is simple. Their interleavings are exactly the kind of thing these documents were written to catch.

**Correction.** Write the delivery protocol as a poly configuration, just as the outbox was written as a poly machine:

- **Instances.** A sender, its outbox worker, and a receiver with its dedupe table.
- **Bounds.** A small retry count.
- **Properties.**
  - The safety property is that each identified message takes at most one step at its receiver.
  - The liveness property is that it takes at least one, under fairness of the worker.
  - For co-located pairs, messages are delivered in send order.

Check it with the configuration explorer the documents already specify. Until this is done, "exactly one step per message" is an assumption. It should be listed under PS10 as one, not derived in PS14.3.

## 5. `order[*]` does not say which order

The checkout configuration (PT7a) declares:

```
liveness settle: order[*] is Asked leads to order[*] is Done | Refused
```

The notation has three plausible readings:

- each order that is asked is eventually settled (for all `i`, `order[i] is Asked leads to order[i] is Done | Refused`);
- if any order is asked, some order is eventually settled;
- if any order is asked, all orders are eventually settled.

The first is intended. The second is much weaker and the third may be false. Instance groups need explicit quantifiers wherever they appear in a property:

```
liveness settle: forall i in order: order[i] is Asked leads to order[i] is Done | Refused
```

The same holds for `count(order[*] is Done)`, which is clear, and for any future use of `[*]` in a state predicate, which may not be. Define `[*]` only inside aggregate functions (`count`, `sum`, `all`, `any`), and require `forall` or `exists` elsewhere.

In the same example, `count(order[*] is Done) <= 1` carries its meaning in a comment (`// initial stock`). Write it as `count(order[*] is Done) <= init(inv.onHand)`, with `init` defined in PS13 as the value in the configuration's initial state. A property that is correct only because of a comment will not stay correct.

## 6. "Dischargeable" is not a property of behaviours

PS8.6 defines a mandate as dischargeable if **some** path reaches its discharge state without a deny. Every other property in these documents is a statement about **all** behaviours: invariants, step and path properties, and liveness. This one is existential. It asserts that a good path exists, not that every path is good. It cannot be expressed as a property of behaviours, and a system all of whose behaviours satisfy every property may still fail it, and the converse.

That is not a defect. Possibility is exactly the right notion for asking whether obligations contradict each other. But the documents should name it as a different kind of property (a **possibility property**), and say that it is checked as reachability on the explored graph, not with the machinery of PS5 and PS6.

Two further points:

- **"Minimal" is not "smallest".** The deletion procedure finds *a* minimal conflicting subset, and different deletion orders can find different ones. PS8.6 should say "a minimal subset", and should fix the deletion order (declaration order, then promotion order) so that the result is reproducible.
- **An alphabet is not a set of tools.** Discharge is checked over the scope's declared action alphabet, which may include actions the agent has no tool for. A mandate can be dischargeable in principle and impossible for the agent in practice. Say which alphabet is meant, and prefer the one the scope's tools provide.

## 7. Which messages cross the gate?

PS2.2 now says an effect is a message to a capability's address, and PT6.5 says that effects and messages are one mechanism. The gate (PT9) is specified for effect intents only. So either:

- messages to peers are gated too, in which case a denied `send` must have a defined outcome (there is no `failed` action on a send); or
- they are not, in which case governance cannot see traffic between machines, and "one mechanism" holds for execution but not for control.

Either answer is defensible. The documents must give one. I would gate peer sends to peers in other trust scopes, not gate those within one scope, and define a denied send as a message delivered to the sender itself (`SendDenied(to, action, reason)`), which the sender may handle or reject like any other message.

## 8. The exception has become the rule

PA0.1 says "lower, never reimplement", and then lists one exception: `poly-ref`. `poly-ref` now checks four things:

- that the lowering agrees with the semantics;
- deadlock freedom;
- liveness under fairness;
- configurations of communicating machines, the largest state spaces in the system.

A component that does all of that is a model checker. It should be called one. The principle should then say what is true: safety of single machines, governance, simulation and mining are the engines' job, and poly has its own checker for everything that concerns how machines relate over time. Keeping the old wording invites a reader to believe the checking is all done elsewhere. It is not, and the part done here is the part most likely to have bugs of its own. So the evidence scripts matter, and so does the next point.

## 9. The evidence scripts are witnesses, not proofs

The three exploration scripts in `reviews/evidence` are useful, and I am glad they exist. But they are hand translations of the examples, written for this review cycle. Their agreement with the poly source, and later with `poly-ref`, is not established by anything. When `poly-ref` exists, the same examples should be run through it. Agreement with the scripts is then one of its first acceptance tests. A disagreement means one of the two is wrong, and finding out which is worth the afternoon.

## 10. What is right

- **The semantics exists, and it is short.** It defines a machine as a deterministic, labelled transition relation. Rejections are labelled stuttering steps. There are five kinds of property with distinct names, liveness always comes with its fairness, and composition and configurations have precise meanings. This is the foundation I asked for, and it is sound.
- **Translation validation on every check.** The compiler is not trusted. Its output is compared with the semantics each time.
- **Bounds are always printed with the verdict.** A clean result says what it is clean over.
- **Delivery is in the semantics.** The runtime is obliged to implement it, and when a message is lost it is clear which party is wrong.
- **The development process.** Each review produced a numbered response with evidence. Each claimed fix to a model was checked by exploring it, and the examples found real defects: a stuck outbox, a turnstile that locks forever, one unit of stock confirmed twice. That is the practice the language asks of its users, applied to the language itself.

## 11. Corrections, in order

1. Message identities in the model; fairness per identified message (section 1).
2. K4 stated with its horizon; dedupe records kept for the life of the instance (section 2).
3. The happens-before argument for PS13.7, and a note on monitoring configuration invariants (section 3).
4. The delivery protocol written as a poly configuration and checked; "exactly one step per message" listed as an assumption until then (section 4).
5. Explicit quantifiers for instance groups; `init(…)` in place of constants in comments (section 5).
6. Dischargeability named as a possibility property; "a minimal" subset with a fixed deletion order; the alphabet defined by the scope's tools (section 6).
7. A decision on gating peer sends, and the outcome of a denied send (section 7).
8. PA0.1 restated to say that poly has its own checker (section 8).
9. The evidence scripts made acceptance tests for `poly-ref` (section 9).

## Conclusion

At v0.2, these documents asked the reader to trust a description. At v0.5, they give a definition the reader can check, and a toolchain designed to check itself against it. The corrections above are small, with one exception. Messages need names. A dedupe table needs a lifetime. A theorem needs its two-line proof. A quantifier needs to be written down. A mechanism needs to say whether the gate sees it. The exception is the delivery protocol, which the configuration semantics now rests on and which nobody has yet modelled. The tool to model it is already specified in these documents, so the next step is to use it. After that, what remains is to build the thing and run the experiment. Writing it down with this much care is what makes both of those possible.
