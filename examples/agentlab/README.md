# The support desk

A support agent reaches the MISSION Agent Lab's customer-records server through an Affinidi Agent Gateway. The gateway decides each request and hides `export_all_customers`. This program decides the order of the calls: it is the stateful core that the gateway cannot be, because the slow export is made of calls that are each allowed. It is Act 1 and the program of Acts 2 and 3 of the demo (`poly-agentlab/PROPOSAL.md`, section 3.2). The host, the gateway adapter and the MCP effect come in later prompts (P2 to P4); this directory holds the program, its policy and the teaching variant, and their check.

## What it does

- **One `Desk` per caller (PS15.0a, S450).** The channel `gateway` is a webhook channel with `thread "{source}"` and `principal from principal`, as the concierge keys a Desk per WhatsApp thread. The caller is the gateway's DID, delivered as a verified claim by the adapter (K11) and never read from a request. The first verified message of a thread fixes its principal, and a later message that names another is refused `principal-mismatch`.
- **A read budget of 10 customers per `Desk`.** The budget counts customers returned, not calls. The read effect's completion carries `n`, the number of customers the server returned, as a strict range `0..10`: a server that answers more is refused at dispatch (`outside-check-domain`), which is the safe side. The `Desk` keeps `customersRead`. `Find` and `Read` are refused `read-budget` when `customersRead >= 10` before the call, and the completion `Returned(n)` adds `n`. So one full page is allowed and the next request is refused. The first draft counted calls, and five searches of 10 read all 50 customers inside a budget of 10 calls.
- **The bound is 19.** The budget is checked before the call and the server decides `n`, so the worst case is 9 + 10 = 19 customers. The field is `customersRead: 0..19`, and the domain states the bound: the check proves that no path leaves it (`PL3102 DOMAIN_ESCAPE` otherwise, PT3.5). One read is in flight at a time (`read-pending`), because two issued together would both pass the same check and the bound would be 100. Both read tools are one effect with one kind.
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
Desk: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (51984 transitions and 1444 property evaluations agree) · model-check CLEAN (1444 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  customers.write  irreversible, attempts 1, at most once
  class  customers.read  reversible
  class  customers.write  irreversible
gateway.Conversation: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (35577 transitions and 174267 property evaluations agree) · model-check CLEAN (603 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  channel.gateway.send  irreversible, attempts 1, at most once
  class  channel.gateway.send  irreversible
configuration gateway: configuration CLEAN (17707 global states, 374738 global steps)
verdict: CLEAN (exit 0)  desk.Desk  over customersRead ∈ 0..19; Got.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002"}; Find.query ∈ {"ada"}; Read.id ∈ {"c1"}; Update.id ∈ {"c1"}; Update.field ∈ Field; Update.value ∈ {"v1"}; Returned.n ∈ 0..10; SendRejected.reason ∈ {"endpoint-disabled"}; 2 principal representatives (PD5.1.3c); 2 content representatives and none (PS4.1f); 1444 states; kernel assumptions K7, K11
         desk.gateway.Conversation  over failures ∈ 0..3; waiting ∈ 0..2; queued ∈ 0..2; pending ∈ 0..3; Open.app ∈ {none, desk.Desk#1, desk.Desk#2}; Inbound.source ∈ {"hook-1", "hook-2"}; Inbound.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Reply.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Template.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; 2 principal representatives (PD5.1.3c); 3 content representatives and none (PS4.1f); 603 states; kernel assumptions K7, K11
         desk.gateway  over app: Desk, desk.gateway.Conversation[0..0]: desk.gateway.Conversation; transit ≤ 3; instances ≤ 2; 17707 global states; kernel assumptions K1, K2, K4, K7, K8
         Desk: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
         gateway.Conversation: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
engines: sam-pattern 2.3.0, polygraph 8.4.0, polygraph sam-pattern (vendored) 2.3.0, poly-ref 0.0.0
handlers: lint CLEAN over 1 file (PT6.5)
project agentlab-readme: CLEAN (exit 0) over 2 modules
```

The teaching variant, `desk-per-request.poly`, has only the per-request rules of the Lab's recipes: no export, an email change refused outright, and no read budget. It keeps the path property. It keeps the field `customersRead: 0..19`, the bound the program with a budget cannot pass. Its first line is `// expected: FINDING PL3102`, and the check gives exactly that. This is Act 1. Output, verbatim:

```
[check] exploring (pass 1)… 1088 states discovered, frontier 320, 10s elapsed
[check] exploring (pass 2)… 1088 states discovered, frontier 320, 10s elapsed
[check] exploring (pass 1)… 313 states discovered, frontier 57, 11s elapsed
desk-per-request.poly:35  PL3102 DOMAIN_ESCAPE  customersRead
  domain:customersRead is violated: a value leaves its declared type
  witness (5 steps):
    Got(null, {principal:p1})   false/null/0/false/false/false/false -> false/p1/0/false/false/true/false
    Find(ada)                   false/p1/0/false/false/true/false    -> false/p1/0/true/false/true/false
    Returned(10)                false/p1/0/true/false/true/false     -> false/p1/10/false/false/true/false
    Find(ada)                   false/p1/10/false/false/true/false   -> false/p1/10/true/false/true/false
    Returned(10)                false/p1/10/true/false/true/false    -> false/p1/20/false/false/true/false
  fix add-require@9b71cc05adfe: insert-before-first-write require customersRead + n <= 19 else reject "customersRead-range"
  fix widen-range@f1a12e646b34: replace-node with 0..20
Desk: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (46224 transitions and 1284 property evaluations agree) · model-check FINDINGS (1606 states explored, cap 1605 hit) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  customers.write  irreversible, attempts 1, at most once
  class  customers.read  reversible
  class  customers.write  irreversible
gateway.Conversation: parse-type CLEAN · lower CLEAN · validate CLEAN · translation-validation CLEAN (35577 transitions and 174267 property evaluations agree) · model-check CLEAN (603 states explored) · deadlock CLEAN (service: exempt (PS1.7)) · effects CLEAN (no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38))
  retry-safe  channel.gateway.send  irreversible, attempts 1, at most once
  class  channel.gateway.send  irreversible
configuration gateway: configuration CLEAN (17707 global states, 374738 global steps)
verdict: FINDINGS (exit 1)  desk_per_request.Desk  over customersRead ∈ 0..19; Got.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002"}; Find.query ∈ {"ada"}; Read.id ∈ {"c1"}; Update.id ∈ {"c1"}; Update.field ∈ Field; Update.value ∈ {"v1"}; Returned.n ∈ 0..10; SendRejected.reason ∈ {"endpoint-disabled"}; 2 principal representatives (PD5.1.3c); 2 content representatives and none (PS4.1f); 1284 states; kernel assumptions K7, K11
         desk_per_request.gateway.Conversation  over failures ∈ 0..3; waiting ∈ 0..2; queued ∈ 0..2; pending ∈ 0..3; Open.app ∈ {none, desk_per_request.Desk#1, desk_per_request.Desk#2}; Inbound.source ∈ {"hook-1", "hook-2"}; Inbound.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Reply.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; Template.body ∈ {null, "sha256:0000000000000000000000000000000000000000000000000000000000000001", "sha256:0000000000000000000000000000000000000000000000000000000000000002", "sha256:0000000000000000000000000000000000000000000000000000000000000003"}; 2 principal representatives (PD5.1.3c); 3 content representatives and none (PS4.1f); 603 states; kernel assumptions K7, K11
         desk_per_request.gateway  over app: Desk, desk_per_request.gateway.Conversation[0..0]: desk_per_request.gateway.Conversation; transit ≤ 3; instances ≤ 2; 17707 global states; kernel assumptions K1, K2, K4, K7, K8
         Desk: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
         gateway.Conversation: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)
engines: sam-pattern 2.3.0, polygraph 8.4.0, polygraph sam-pattern (vendored) 2.3.0, poly-ref 0.0.0
```

The witness is the one to show, 5 steps: a `Got`, then a `Find`, answered with 10 customers, then another `Find`, answered with 10 more. Each `Find` is a request the desk accepts and each passes every per-request rule, and together they have read 20 customers, past the bound of 19. The fix is the budget of `desk.poly`, and the check offers it as `add-require`: a `require` that refuses the request before the write to the field.

## What the host sends

The host (P4) extracts `n` from the tool result and dispatches the read's completion. The effect `read` declares `ok(r) -> Returned(n: r.n)` and `failed -> ReadFailed()`, so:

- on a successful `find_customers` or `read_customer`, the handler's result must be an object with a field `n`, an integer from 0 to 10: the length of the `find_customers` result list, or 1 for a `read_customer` that found its customer and 0 for one that did not;
- a result without `n`, or with `n` above 10, is refused at dispatch and journaled as a rejected step, and the `Desk` stays in `reading`, so it takes no further read: the safe side;
- on a failure the handler reports a failure, and the `Desk` counts nothing;
- the answer to the agent goes back through the host. The `Desk` returns only the receipt of the arrival on the thread.

## Check it yourself

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/agentlab/desk-per-request.poly
node --test test/examples-expected.test.mjs
```

The first gives the finding above. The second checks both programs against their first lines, the desk with its policy as one signed project. The desk's configuration holds 17,707 global states; run one check at a time in the same root.

## Stated limits

- **Finite domains.** poly checks over the domains declared. A budget of 10 customers and a bound of 19 are checked, and "about ten" is not. `n` is explored at every value of `0..10`: the state space did not grow past the check's bounds, so no value was cut and the budget was not cut. Strings are explored at one representative each (`"ada"`, `"c1"`, `"v1"`), because the program only passes them on, and `Field` at its three values.
- **Order, not rate.** poly checks no time. The budget is a count of customers read in a sequence, not customers per minute.
- **The budget is per `Desk`, not per person across surfaces.** A caller is a DID the gateway derives for one surface. The same person on another surface is another DID and another `Desk` with its own budget.
- **The bound is 19, not 10.** The budget is checked before the call and the server decides `n`, so a `Desk` can read up to 9 + 10 = 19 customers: one full page is allowed, and the next request is refused. The worst case needs a first read that returns 9, so a Desk whose first page is full (10) is refused at the next request, and reading all 50 customers takes at least three Desks. The bound holds when the host sends the `n` the server returned; a host that sends less breaks it, and the check does not see that, because the count is the host's.
- **One read at a time.** A second read while one is in flight is refused `read-pending`. An agent that issues calls in parallel sees refusals it did not see before; the sequence is what the bound needs.
- **No `never` for the export.** A `never` names an effect of the machine (`PL1001` otherwise), and a `count` path property names a kind some effect declares. Both were tried with `export_all_customers` and with the kind `customers.export`, and both were refused `PL1001`, because no such effect exists. The control is that the program declares none, so the manifest the runtime executes holds no export kind. The check does not state it.
- **The reply on the thread is a receipt.** `Got` emits `gateway.reply` with the request's own body. This is there because the webhook conversation's rules (`one-send-at-a-time`, `no-delivery-while-disabled`) are otherwise vacuous in the configuration, and a vacuous rule folds the verdict to `INCONCLUSIVE` (PT12.3). The server's answer to the tool call is the host's to return to the agent. P4 should confirm this.
- **Toggles for polyrun.** `arrivals` and `receipts` flip on each step of their kind. A step that emits and changes nothing is reported by polyrun as `PL2501`; the flips make each such step a state change. They carry no meaning.
- **The email rule waits on the host.** The policy escalates the write; the signed approval and the effect's targets (the address of the gateway's second surface) are the host's and P3's. The effects declare no `targets`.
- **The claims reach the typed actions from the host.** `Got` takes its claims from the channel. The typed actions take none, and are refused until a `Got` has fixed the caller. How the host dispatches them is P4's.
- **K11 and K7.** The check does not verify the adapter's cryptography (K11), and it lists K7 among its kernel assumptions.

## Conclusion

The desk says in a program what the Lab's recipes could not say in a rule: at most 10 customers read per caller before a request is refused, no export, and an email change only with a person's approval. The first draft counted calls and did not stop the slow export, since five searches of 10 read all 50 customers inside a budget of 10 calls; the budget counts customers now. The teaching variant shows the gap in five steps, two allowed searches that read 20 customers, and the desk closes it and reads `CLEAN` with its instance printed. The limits are the ones to state aloud: the worst case is 19 customers and not 10, the budget is per `Desk`, the host must send the count the server returned, and the export is absent and not forbidden.

## Glossary

- **Desk:** the machine of this program, one instance per caller.
- **Caller:** the DID the gateway signs for one surface, delivered as a verified claim.
- **Read budget:** at most 10 customers read per `Desk`, counted by the customers the server returns; a request is refused `read-budget` once 10 have been read.
- **Domain escape (`PL3102`):** a value that can leave its declared range; here `customersRead` past 19.
- **Witness:** the shortest sequence of steps that violates a property.
- **Completion:** the message that settles an effect and carries its result; the read's carries `n`, the number of customers returned.
- **Teaching variant:** an example with a defect put in on purpose, whose first line names the finding.
- **Project:** a program and the policy beside it, checked together.
- **Escalate:** the policy's decision that a person must approve the effect first.
- **K17:** the assumption that a provider honours an idempotency key; not made here, because the write declares none.
- **At most once:** an irreversible effect with `retry { attempts 1 }`: sent once, and a lost answer ends with its failed completion.
