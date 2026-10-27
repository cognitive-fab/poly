# The support desk

A support agent reaches the MISSION Agent Lab's customer-records server through an Affinidi Agent Gateway. The gateway decides each request and hides `export_all_customers`. This program decides the order of the calls: it is the stateful core that the gateway cannot be, because the slow export is made of calls that are each allowed. It is Act 1 and the program of Acts 2 and 3 of the demo (`poly-agentlab/PROPOSAL.md`, section 3.2). The host, the gateway adapter and the MCP effect come in later prompts (P2 to P4); this directory holds the program, its policy and the teaching variant, and their check.

## What it does

- **One `Desk` per caller (PS15.0a, S450).** The channel `gateway` is a webhook channel with `thread "{source}"` and `principal from principal`, as the concierge keys a Desk per WhatsApp thread. The caller is the gateway's DID, delivered as a verified claim by the adapter (K11) and never read from a request. The first verified message of a thread fixes its principal, and a later message that names another is refused `principal-mismatch`.
- **A read budget of 10 per `Desk`.** A `find_customers` result or a `read_customer` is a customer read. The handlers of `Find` and `Read` refuse an eleventh with the reason `read-budget`, and the path property `bounded-reads: count("customers.read") <= 10` checks that no path emits more than 10. The field is `reads: 0..10`: the domain holds the whole budget and, at `reads == 10`, the one attempt past it, which the handlers refuse. Both read tools are one effect with one kind, so one property counts them together.
- **No export.** The program declares no effect for `export_all_customers`. The language cannot state it as a `never` (see the limits).
- **Phone and address changes run.** An email change is emitted too, and `desk.policy.poly` escalates it to a person, as the concierge escalates a refund above 100: the `Desk` sets `sensitive` when the write in flight is an email change, and the policy rule reads `machine("desk.Desk").sensitive`. A person approves with a signed record. While a write is waiting or in flight the `Desk` takes reads and no second write (`write-pending`).
- **Effects and classes (PS23.6).** The reads are `egress:external` and `class reversible`. They are not `class none`, because MCP carries a read as a POST and a `none` effect is limited to GET and HEAD (PS23.10, `PL6412`). The write is `egress:external` and `class irreversible` with `retry { attempts 1 }`: one attempt only. It declares no idempotency key. The Lab's server takes no key, so declaring one would make K17 an assumption the server does not meet. The check reports no `PL4003`, and prints `retry-safe  customers.write  irreversible, attempts 1, at most once`.
- **Typed actions after a verified arrival.** `Got` is the verified arrival that fixes the caller. `Find`, `Read` and `Update` are refused `unverified` before it. The host dispatches them after the adapter has verified the gateway's presentation.

## The two verdicts

The project, the program with its policy, reads `CLEAN`, and every stage ran. The project is checked as the gate checks it: the policy is signed by a test key first (`poly sign policy`). Output, verbatim:

```
── C:\Users\jjdub\code\poly-lab\.poly\test-examples-project\agentlab-readme\src\desk.policy.poly
scope "desk" (changes): policy-types CLEAN · policy-lower CLEAN (2 obligation(s) in .poly/build/policies/desk.policy.json) · consistency CLEAN (0 mandate(s); 0 discharge check(s)) · policy-admission CLEAN (coverage changes.email-change-reviewed: checked, changes.email-change-reviewed.unknown: checked) · policy-tv CLEAN (18 proposals over 1 state pairs agree) · regions CLEAN (lethal-trifecta: unreachable, no effect provides untrusted, sensitive; credential-egress: unreachable, no effect provides sensitive; source-egress: unreachable, no effect provides proprietary) · never CLEAN (no never statement)
verdict: CLEAN (exit 0)
engines: sam-pattern 2.3.0, polygraph 8.4.0, polygraph sam-pattern (vendored) 2.3.0, poly-ref 0.0.0
── C:\Users\jjdub\code\poly-lab\.poly\test-examples-project\agentlab-readme\src\desk.poly
Desk: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (12768 transitions and 532 property evaluations agree) · model-check CLEAN (532 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (50000 paths, 288 states, bounded)
  retry-safe  customers.write  irreversible, attempts 1, at most once
  class  customers.read  reversible
  class  customers.write  irreversible
  note: polyrun reports cycle-edge-emits at SendFailed({}), Delivered({}) (and 699470 more), emitting sendTo: a note, not a poly property; path properties are decided over every path, cycles included, by poly-ref (S39)
gateway.Conversation: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (35577 transitions and 174267 property evaluations agree) · model-check CLEAN (603 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  channel.gateway.send  irreversible, attempts 1, at most once
  class  channel.gateway.send  irreversible
configuration gateway: configuration CLEAN (17707 global states, 374738 global steps)
verdict: CLEAN (exit 0)  desk.Desk  over reads ∈ 0..10; Got.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002"}; Find.query ∈ {"ada"}; Read.id ∈ {"c1"}; Update.id ∈ {"c1"}; Update.field ∈ Field; Update.value ∈ {"v1"}; SendRejected.reason ∈ {"endpoint-disabled"}; 2 principal representatives (PD5.1.3c); 2 content representatives and none (PS4.1f); 532 states; kernel assumptions K7, K11
         desk.gateway.Conversation  over failures ∈ 0..3; waiting ∈ 0..2; queued ∈ 0..2; pending ∈ 0..3; Open.app ∈ {none, desk.Desk#1, desk.Desk#2}; Inbound.source ∈ {"hook-1", "hook-2"}; Inbound.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Reply.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Template.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; 2 principal representatives (PD5.1.3c); 3 content representatives and none (PS4.1f); 603 states; kernel assumptions K7, K11
         desk.gateway  over app: Desk, desk.gateway.Conversation[0..0]: desk.gateway.Conversation; transit ≤ 3; instances ≤ 2; 17707 global states; kernel assumptions K1, K2, K4, K7, K8
         gateway.Conversation: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
engines: sam-pattern 2.3.0, polygraph 8.4.0, polygraph sam-pattern (vendored) 2.3.0, poly-ref 0.0.0
handlers: lint CLEAN over 1 file (PT6.5)
project agentlab-readme: CLEAN (exit 0) over 2 modules
```

The teaching variant, `desk-per-request.poly`, has only the per-request rules of the Lab's recipes: no export, an email change refused outright, and no read budget. It keeps the path property. Its first line is `// expected: FINDING PL4001`, and the check gives exactly that. This is Act 1. Output, verbatim:

```
desk-per-request.poly:119  PL4001 PATH_PROPERTY  bounded-reads
  path property bounded-reads is violated: count("customers.read") reaches 11, above 10 on this path
  witness (12 steps):
    Got(null, {principal:p1})   false/null/false/false/false/false -> false/p1/false/true/false/false   emits sendTo
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
    Find(ada)                   false/p1/false/true/false/true     -> false/p1/false/true/false/false   emits customers.read
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
    Find(ada)                   false/p1/false/true/false/true     -> false/p1/false/true/false/false   emits customers.read
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
    Find(ada)                   false/p1/false/true/false/true     -> false/p1/false/true/false/false   emits customers.read
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
    Find(ada)                   false/p1/false/true/false/true     -> false/p1/false/true/false/false   emits customers.read
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
    Find(ada)                   false/p1/false/true/false/true     -> false/p1/false/true/false/false   emits customers.read
    Find(ada)                   false/p1/false/true/false/false    -> false/p1/false/true/false/true   emits customers.read
Desk: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (1632 transitions and 0 property evaluations agree) · model-check CLEAN (68 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects FINDINGS (50000 paths, 68 states, bounded)
  retry-safe  customers.write  irreversible, attempts 1, at most once
  class  customers.read  reversible
  class  customers.write  irreversible
  note: polyrun reports cycle-edge-emits at SendFailed({}), Delivered({}) (and 904989 more), emitting sendTo: a note, not a poly property; path properties are decided over every path, cycles included, by poly-ref (S39)
gateway.Conversation: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (35577 transitions and 174267 property evaluations agree) · model-check CLEAN (603 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  channel.gateway.send  irreversible, attempts 1, at most once
  class  channel.gateway.send  irreversible
configuration gateway: configuration CLEAN (17707 global states, 374738 global steps)
verdict: FINDINGS (exit 1)  desk_per_request.Desk  over Got.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002"}; Find.query ∈ {"ada"}; Read.id ∈ {"c1"}; Update.id ∈ {"c1"}; Update.field ∈ Field; Update.value ∈ {"v1"}; SendRejected.reason ∈ {"endpoint-disabled"}; 2 principal representatives (PD5.1.3c); 2 content representatives and none (PS4.1f); 68 states; kernel assumptions K7, K11
         desk_per_request.gateway.Conversation  over failures ∈ 0..3; waiting ∈ 0..2; queued ∈ 0..2; pending ∈ 0..3; Open.app ∈ {none, desk_per_request.Desk#1, desk_per_request.Desk#2}; Inbound.source ∈ {"hook-1", "hook-2"}; Inbound.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Reply.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Template.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; 2 principal representatives (PD5.1.3c); 3 content representatives and none (PS4.1f); 603 states; kernel assumptions K7, K11
         desk_per_request.gateway  over app: Desk, desk_per_request.gateway.Conversation[0..0]: desk_per_request.gateway.Conversation; transit ≤ 3; instances ≤ 2; 17707 global states; kernel assumptions K1, K2, K4, K7, K8
         gateway.Conversation: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
engines: sam-pattern 2.3.0, polygraph 8.4.0, polygraph sam-pattern (vendored) 2.3.0, poly-ref 0.0.0
```

The witness is the one to show: a `Got`, then eleven `Find(ada)`, 12 steps. Each `Find` is a step the desk accepts, each passes every per-request rule, and the eleventh makes the count 11. The fix is the read budget of `desk.poly`.

## Check it yourself

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/agentlab/desk-per-request.poly
node --test test/examples-expected.test.mjs
```

The first gives the finding above. The second checks both programs against their first lines, the desk with its policy as one signed project. The desk's check is long on a loaded machine (about 10 minutes in the run above, its configuration holding 17,707 global states); run it alone, not beside another check in the same root.

## Stated limits

- **Finite domains.** poly checks over the domains declared. The budget of 10 is checked, and "about ten" is not. Strings are explored at one representative each (`"ada"`, `"c1"`, `"v1"`), because the program only passes them on, and `Field` at its three values.
- **Order, not rate.** poly checks no time. The budget is a count of reads in a sequence, not reads per minute.
- **The budget is per `Desk`, not per person across surfaces.** A caller is a DID the gateway derives for one surface. The same person on another surface is another DID and another `Desk` with its own budget.
- **The budget counts calls, not customers.** A search returns up to 10 customers, so 10 reads can reach 100 records, and five searches can still read all 50 customers within the budget. The budget bounds the length of the sequence, not what it learns. To bound customers the effect's completion would have to carry the number of customers returned, which the program cannot see today. This is an open point for the MCP effect (P3).
- **No `never` for the export.** A `never` names an effect of the machine (`PL1001` otherwise), and a `count` path property names a kind some effect declares. Both were tried with `export_all_customers` and with the kind `customers.export`, and both were refused `PL1001`, because no such effect exists. The control is that the program declares none, so the manifest the runtime executes holds no export kind. The check does not state it.
- **The reply on the thread is a receipt.** `Got` emits `gateway.reply` with the request's own body. This is there because the webhook conversation's rules (`one-send-at-a-time`, `no-delivery-while-disabled`) are otherwise vacuous in the configuration, and a vacuous rule folds the verdict to `INCONCLUSIVE` (PT12.3). The server's answer to the tool call is the host's to return to the agent. P4 should confirm this.
- **Toggles for polyrun.** `arrivals`, `receipts` and, in the variant, `turn` flip on each step of their kind. A step that emits and changes nothing is reported by polyrun as `PL2501`, and in the variant a read that changes nothing is also `PL4002`; the flips make each such step a state change. They carry no meaning.
- **The email rule waits on the host.** The policy escalates the write; the signed approval and the effect's targets (the address of the gateway's second surface) are the host's and P3's. The effects declare no `targets`.
- **The claims reach the typed actions from the host.** `Got` takes its claims from the channel. The typed actions take none, and are refused until a `Got` has fixed the caller. How the host dispatches them is P4's.
- **K11 and K7.** The check does not verify the adapter's cryptography (K11), and it lists K7 among its kernel assumptions.
- **The effects stage is bounded.** polyrun's path walk stops at 50,000 paths. The path property is decided over every path by poly-ref, and the stage reads `CLEAN` with the bound printed.

## Conclusion

The desk says in a program what the Lab's recipes could not say in a rule: at most 10 reads per caller, no export, and an email change only with a person's approval. The teaching variant shows the gap, a sequence of eleven allowed searches that the check names, and the desk closes it and reads `CLEAN` with its instance printed. The limits are the ones to state aloud: the budget counts calls and not customers, it is per `Desk`, and the export is absent and not forbidden.

## Glossary

- **Desk:** the machine of this program, one instance per caller.
- **Caller:** the DID the gateway signs for one surface, delivered as a verified claim.
- **Read budget:** at most 10 customer reads per `Desk`, refused `read-budget` above it.
- **Path property:** a predicate over the effects emitted along a run; here `count("customers.read") <= 10`.
- **Witness:** the shortest sequence of steps that violates a property.
- **Teaching variant:** an example with a defect put in on purpose, whose first line names the finding.
- **Project:** a program and the policy beside it, checked together.
- **Escalate:** the policy's decision that a person must approve the effect first.
- **K17:** the assumption that a provider honours an idempotency key; not made here, because the write declares none.
- **At most once:** an irreversible effect with `retry { attempts 1 }`: sent once, and a lost answer ends with its failed completion.
