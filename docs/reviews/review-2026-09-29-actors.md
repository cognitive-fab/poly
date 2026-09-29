# Review: poly specification set, draft v0.4

*Peer review of `README.md` and `docs/01` to `docs/04`, draft v0.4. Written in the manner of the authors of the actor model, at the author's request: it reads poly as a system of communicating agents and asks what happens when there is more than one of them. 29 September 2026.*

## Verdict

**Accept the single machine; revise everything between machines.** Read as one instance in isolation, a poly machine is already an actor:

- it has local state that no one else can touch;
- it processes one message at a time (the single writer, K2);
- in response it computes its next behaviour (the step) and sends messages (intents).

That core is sound, and v0.4 describes it well. But the documents quietly assume that the interesting system is one machine, or a parent with its children. Real systems are **configurations of many peers that address each other**:

- an order and an inventory;
- a payment and a ledger;
- an agent and the dozen services it touches.

Between peers, poly offers only host code, which is exactly where checking stops. This review is about that gap.

## 1. There is no way for one machine to send to another

A poly machine can send messages to three places:

1. **The host,** via an effect intent, executed by a handler.
2. **Its own children,** via `spawn` and `signal`.
3. **Its parent,** by completing.

It cannot send to a **peer**, meaning another instance that is neither its parent nor its child. If an `Order` needs to reserve stock in an `Inventory`, the only route is:

- an effect;
- a TypeScript handler;
- a `dispatch` call to the inventory instance, written by hand in host code.

The model checker sees the order emit an intent and sees the inventory receive an action. It never sees that the two are the same message. So the interaction between them, which is where the double charges and the oversold stock live, is not checked. It is the same class of sequence bug the Poly stack was built to find, moved one level up where the checker cannot follow.

**Recommendation.** Make the address of an instance a value, and sending a message to it a primitive:

```poly
state { stock: Ref<Inventory> }          // an address, not a copy
on Place {
  …
  send stock <- Reserve(sku: sku, qty: 1) as reserve
}
```

- `Ref<M>` is the address of an instance of machine `M`.
- `send r <- A(d)` lowers to an intent of a built-in kind, `send`. The runtime delivers it as a dispatch to `r`, with the idempotency key as its `actionId`, so delivery is exactly-once at the receiver (K4).
- Addresses can be passed in messages and stored in state. This is how a configuration's shape can change as it runs: actors learn about other actors by being told.

## 2. Check configurations, not only trees

Composition is checked today only for a parent and its children, under atomic cascades (PS7). A system of peers needs a unit of checking that is a **configuration**: a finite set of instances with their initial addresses.

```poly
configuration checkout {
  order[2]  : orders.Order     { stock: inv }
  inv       : stock.Inventory  { onHand: 1 }
  invariant never-oversold: inv.onHand >= 0
  invariant reserved-matches: sum(order[*].reserved) == 1 - inv.onHand
}
```

**The semantics of a configuration:**

- **State.** The global state is the tuple of the instances' states plus the multiset of messages in transit.
- **Steps.** A step is the delivery of one in-transit message to its target, followed by the target's step.
- **Arrival order.** Messages in transit may be delivered in any order. This is arrival-order nondeterminism: the order in which messages reach an actor is not the order in which they were sent.
- **Environment.** The environment may inject messages at any instance.

This is the **check** interpretation of v0.4, applied to many machines at once. The configuration is finite: a fixed number of instances, and a bound on in-transit messages that is declared and printed with the verdict. So the existing explorer applies. The witness is the interleaving of deliveries that oversells the last unit.

Two consequences follow:

- **v2 worlds become configurations with the simulate interpretation.** Once configurations exist, the Polytrion worlds of appendix A are configurations with distributions attached. The v0.4 principle "one program, three interpreters" then extends from one machine to a system of them. That is the version of the principle worth having.
- **Checking gets harder, by exactly the right amount.** The state space of a configuration is larger than a single machine's, and it should be. The interactions are where the bugs are, and a checker that does not pay for them does not find them.

## 3. Atomic cascades do not scale past one machine room

PS7.2 makes a parent and its children one atomic step: a stimulus and every completion, parent-terminal action and signal it causes, "applied in order", in one transaction. This is convenient, and it makes the product check small. It is also a global lock over a tree of actors. It forbids those actors from living on different nodes, because one transaction cannot span them without a distributed commit.

Actors do not share a transaction. They share messages.

**Recommendation.**

- **State the co-location assumption.** K3 means that a parent and all its descendants must be served by one kernel shard. Write that down beside K3, and have the runtime enforce it.
- **Offer the asynchronous alternative.** Let a child be declared `detached`. Messages between parent and child then travel like peer messages (section 1). The composition is checked as a configuration (section 2), with arrival-order nondeterminism, not as an atomic cascade. Attached children keep today's cheap check. Detached ones get the check a distributed system needs. The author chooses, and the verdict says which was checked.

## 4. Delivery is a property of the model, not an assumption about the kernel

K5 (worker and timer fairness) is listed as an operational assumption with no evidence, and liveness claims rest on it.

In the actor model, guaranteed delivery is not an assumption about a particular runtime. It is part of the meaning of sending a message: every message sent is eventually received. Put it in the semantics:

- every intent is eventually completed or refused;
- every sent message is eventually delivered;
- every timer eventually fires.

Liveness properties then need only the fairness of the machines' own actions. K5 becomes the runtime's obligation to implement the semantics. It is no longer an axiom the semantics borrows. The monitoring stays. What changes is who is wrong when a message is never delivered: the kernel, not the specification.

## 5. The gate is an actor. Treat it as one

v0.3 gave the gate a session sequence (`sseq`) so that its decisions replay. This is correct, and it is correct for an actor-model reason: the order that matters is the **arrival order at the receiving actor**, and the gate is an actor. There is no global order to recover, and none is needed. The gate's own arrival order, recorded, is sufficient. The documents should say so. It also answers a worry the formal review raised: sessions span runs, but that is no problem when each actor keeps its own arrival order.

Two consequences follow:

- **A session is a serialisation point.** Every proposal from every run in the session queues at one actor. That is the price of the session's state Σ, and PT9.6 should measure it per session, not only per runtime.
- **The gate can be sharded along sessions,** and only along sessions. If a policy needs state across sessions, it needs another actor, and a message to it. It cannot have a shared variable.

## 6. Obligations from several sources can contradict each other

Obligations now come from four sources:

- policies written by people;
- rules mined by Polyx and promoted;
- recalled text;
- imported native kernels.

These sources were written at different times, by different people and processes, from different evidence. They will disagree. PS8.3 resolves each individual decision (deny wins over escalate, which wins over allow). But it does not detect the case where the obligations together deny **every** way to discharge a mandate. Suppose a promoted rule requires a review before every deploy, and a declared rule forbids any action after a review until a timer expires. Then there may be no lawful path to a deploy at all. Each decision is locally consistent. The system as a whole is stuck.

Polyaxion's admission already checks that a mandate is "lawfully dischargeable" (its mandate item m2).

**Recommendation.**

- **Surface the check.** Make it a named stage of `poly check` with its own diagnostic.
- **Run it on every promotion.** Re-run it whenever a mined rule is promoted, because promotion is exactly when inconsistency enters.
- **Report it as a finding.** When the combined obligations make a mandate undischargeable, the finding should name the smallest set of obligations that conflict. A system that learns its rules from its history must expect those rules to contradict each other, and should find the contradictions before the agent does.

## 7. Smaller points

- **Capabilities are addresses.** The v0.4 capabilities (PT6.5) and the `Ref` of section 1 are the same idea. An `egress` capability is the address of an actor that performs egress to a declared target. Unify them, and the effect system and the message system become one mechanism: every effect is a message to an address the machine was given.
- **Creation is part of the configuration.** `spawn` creates an actor and hands the parent its address. With `Ref`, the parent may pass that address to a peer. The configuration check must then track addresses in transit as well as messages, and so must the delivery bound.
- **Unbounded nondeterminism is out of scope, and the documents should say so.** A finite checked instance cannot express "the message is delivered, after an unbounded but finite delay". The fairness of PS6 approximates it for liveness. Say in PS4 that poly checks the bounded fragment, and that the runtime implements the unbounded guarantee.

## 8. What is right

- **One writer per instance** and **one message at a time** are the actor discipline, stated as kernel assumptions K2 and K1.
- **No shared state between machines.** A machine's fields are its own, and the only way to affect them is a message. Keep that absolutely. Section 1 asks for more messages, not for shared variables.
- **The next behaviour computed from the message** is a clean account of an actor's step. The step's purity (PS2.3) is what makes replay trivial.
- **Arrival order at the gate is recorded,** not a reconstructed global order. That is the right choice.

## 9. Requested changes, in order

1. Addresses as values (`Ref<M>`) and a `send` primitive for peer messages (section 1).
2. Configurations as a unit of checking, with arrival-order nondeterminism and a declared in-transit bound (section 2).
3. The co-location assumption stated for attached children, and `detached` children checked as configurations (section 3).
4. Guaranteed delivery as part of the semantics, with K5 as the runtime's obligation (section 4).
5. The gate described as an actor, with per-session throughput measured and sharding along sessions only (section 5).
6. An obligation-consistency stage, re-run on every promotion, naming the minimal conflicting set (section 6).
7. Capabilities unified with addresses; creation and address passing in the configuration semantics; the bounded fragment stated (section 7).

## Conclusion

poly has built a good actor and specified it carefully. What it has not yet specified is a society of them. Today every conversation between machines passes through host code, where the checker cannot see it, and the checks that do span machines assume a transaction that distributed systems do not have. Give machines addresses and a way to send to them. Check finite configurations with messages arriving in any order. Put delivery in the semantics. Then the Poly stack's central claim, that the dangerous behaviour is a sequence of individually acceptable steps, will hold where it matters most: between the machines, not only inside each one.
