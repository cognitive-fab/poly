# Response to the actor-model review of draft v0.4

*Cognitive Fab · September 2026 · answers [`review-2026-09-29-actors.md`](review-2026-09-29-actors.md) · produces draft v0.5*

Every requested change was made. The table gives the change and where it lives.

| # | Review item | Change in v0.5 | Where |
|---|---|---|---|
| 1 | No way for one machine to send to another | `Ref<M>` is a value type: the address of an instance, which can be stored, passed in messages and compared, but not dereferenced. `send r <- A(d)` is the only way to affect a peer. It lowers to a new built-in intent, `sendTo`, delivered through the outbox at least once and deduplicated at the receiver, so each message takes exactly one step there. A rejected delivery is a rejected step at the receiver, and replies are messages. | 04 PS1.6, PS2.2, PS14.3; 03 PT2, PT7a; 02 PA0.0b, AD-12; 01 PF3.3a |
| 2 | Check configurations, not only trees | A configuration declares instances with their initial addresses, the environment's inputs and bounds on messages in transit and on instances. Its global state is the instances' states plus the multiset of messages in transit. A step is an input or the delivery of any one message, in any order (`fifo` only where declared and co-located). Configuration invariants span instances. Stuck quiescent states are reported, and a bound hit is `INCONCLUSIVE`, never `CLEAN`. The three interpretations apply unchanged, and a v2 world is a configuration run with **simulate**. | 04 PS13; 03 PT7a, PT12.2; 02 §5 stage 4b; 01 PF2.7, AC10 |
| 3 | Atomic cascades do not scale past one machine room | Children are **attached** (the default: atomic cascade, co-located on the root's kernel shard, `PL5202` if the runtime would place one elsewhere) or **detached** (a separate actor that talks by messages and is checked as a configuration). The co-location rule is stated beside K3. | 04 PS7; 03 PT6.4, PT7; 02 AD-13; 01 PF3.3 |
| 4 | Delivery belongs in the semantics | Every message sent is eventually received. Every intent is eventually completed or refused. Every due timer eventually fires. This is part of the meaning of `send` (PS14). Liveness checks add weak fairness of each message's delivery automatically. K5 is retired, and the runtime now carries obligation R1: when delivery fails, the kernel is at fault. | 04 PS10, PS14; 03 PT19; 01 G5 |
| 5 | The gate is an actor | Stated. Its own arrival order, recorded as `sseq`, is the only order its decisions depend on. Throughput is measured per session, the gate is sharded along sessions only, and a policy needing state across sessions is refused (`PL6601`) unless that state lives in a separate machine reached by messages. | 04 PS11.0; 03 PT9.6, PT9.6a |
| 6 | Obligations from several sources can contradict each other | Stage 5b checks that every mandate is dischargeable under all obligations together: declared, promoted, recalled and native. This is Polyaxion's m2 condition, surfaced. A conflict is `PL6501`, with a minimal conflicting subset found by deletion, and a path. `poly mine` re-runs the stage for every promotion and refuses one that would create a conflict. | 04 PS8.6; 03 PT8.5; 02 §5 stage 5b; 01 PF4.5, AC11 |
| 7a | Capabilities are addresses | A capability is the address of a host actor that performs one kind of effect for declared targets. `emit k(d)` is a message to that address. The effect system and the message system are one mechanism. | 04 PS2.2; 03 PT6.5 |
| 7b | Creation and address passing | A detached spawn creates an instance with a fresh address, within the configuration's instance bound. Addresses in messages and in state have finite check domains inside a configuration: its instances plus `none`. | 04 PS1.6, PS13.3 |
| 7c | Say that the fragment is bounded | Stated: checks cover finite domains, finitely many instances and bounded transit. The unbounded delivery guarantee is approximated by fairness and implemented by the runtime. | 04 PS4.1e |

## Evidence

The configuration check was exercised on the checkout example of PT7a with a short, independent exploration written from PS13: [`evidence/config_check.py`](evidence/config_check.py). It models two orders and one inventory, with a transit bound of 4.

- **Optimistic order** (confirms on `Available`): the invariant that confirmed orders never exceed the initial stock is violated. The six-step witness is both queries answered before either take, then both confirmations. Both machines are individually safe, so no per-machine check sees it.
- **Order that waits for `Taken`**: the invariant holds over 44 global states, no quiescent state is stuck, and the bound is not hit.

## A change to a principle

The exception to "lower, never reimplement" grows. `poly-ref` now also explores configurations, because no engine checks communicating peers with arrival-order nondeterminism. The architecture names the configuration explorer as a candidate to move into polygraph, beside its single-machine exploration.

## Conclusion

v0.5 moves poly from checking actors to checking societies of them. Machines have addresses and talk only by messages. Configurations are checked with messages arriving in any order, and bounds are reported, never hidden. Delivery is part of what sending means. Cascades are atomic only where the machines share a shard. Obligations are checked together for a way to discharge each mandate. The defect the new check finds in the checkout example, one unit of stock confirmed twice, is the kind of sequence the Poly stack exists to find, now caught between machines as well as inside them.
