# poly · Identity and lineage: verified claims, chain of custody and revocation

*Cognitive Fab · September 2026 · proposal v0.1, not ruled · ids `PD5` · follows [`pd-model-decisions.md`](pd-model-decisions.md)*

## 0. Scope and status

This proposal adds identity to poly without adding cryptography to it. It came from two sources: Yogi Porla's article *The Cost of Ignoring Context: Why AI Agent Sprawl is Fueling Preventable Hacks* (LinkedIn, September 27, 2026), and the agent identity work of AgentLab. The article asks for four things: a harness that authorizes each tool call against its runtime context, an automated kill switch, continuous verification of the workload (SPIFFE, IETF WIMSE, RATS, the Shared Signals Framework), and a chain of custody that carries the originating user across every hop.

poly already has the first two in part. The gate decides on every effect against the snapshot of the step that emitted it (PT9.3), handlers hold no ambient authority (`PL6401`), and the M5 gate fails closed. What poly lacks is a typed place for *who* is acting, and a lineage that survives a message crossing trust scopes.

The design principle is the one PD1 used for model answers. Verification happens outside poly, in a verifier that speaks SPIFFE, WIMSE or RATS. Its result enters poly as a **finite typed input**. The checker then explores every claim value an input could carry, and no verifier is called to do it.

| Id | Addition | Needs | Proposed milestone |
|---|---|---|---|
| PD5.1 | Verified claims: an action may require claims of a declared finite type, supplied by a verifier and explored like any input | actions, strict inputs (PS3.2) | M5 |
| PD5.2 | Lineage: every step, effect and message carries its origin principal and intent; a send across trust scopes carries a lineage token the gate checks | PD5.1, PT9.9 | M5 |
| PD5.3 | Revocation: security signals arrive as typed inputs to a mode machine; a halt mode is checked to emit no compensable or irreversible effect | PD4, the gate (PT9) | M5 |
| PD5.4 | Attributed provenance: the ledger records the claims that admitted each step; certificates and ledger heads are signed with the workload's identity | PD2, the certificate | M4 |

Nothing here changes 04-semantics except one new kernel assumption, K11 (PD5.5). Each item is ruled on separately and enters the spec only when ruled.

The running example is the refund branch of the PD1 router: a refund above a limit needs an approval, and the approval must come from a person, not from an agent acting for one.

## PD5.1 Verified claims

### PD5.1.1 The problem

Today an action carries parameters. Nothing in the program says who sent it, so a policy cannot tell an approval from a person apart from the same approval relayed by an agent. Identity stacks can tell them apart, but they cannot see the application's state. The article's harness needs both at once.

### PD5.1.2 Syntax

A `claims` type is a record whose fields are finite:

```poly
enum Kind { Person, Agent, Service }

claims Caller {
  kind: Kind
  attested: Tri
  assurance: 0..3
  principal: Principal
}
```

An action names the claims it requires with `by`:

```poly
on Approve(amount) by caller: Caller {
  require status == AwaitingApproval else reject "not-awaiting"
  require caller.kind == Person else reject "person-required"
  require caller.assurance >= 2 else reject "low-assurance"
  require caller.principal != requester else reject "self-approval"
  status' = Approved
  emit refund(amount)
}
```

- **PD5.1.2a** **Finite fields.** Every field of a `claims` type is an enum, an integer range, `Tri` or `Principal`. An unbounded field is `PL1101 UNBOUNDED_DOMAIN`.
- **PD5.1.2b** **`Principal`.** A principal is an opaque identity. It may only be compared for equality with another `Principal`, stored in a state field, or passed as an argument. Any other use is `PL6702 PRINCIPAL_NOT_OPAQUE`. Under this restriction no handler can tell two principals apart except by equality, so the checker explores principals by symmetry, with as many distinct representatives as the module has `Principal` fields plus one (open question 1).
- **PD5.1.2c** **Strict by default.** The claims of an action are strict inputs. **run** rejects an action whose claims are missing, malformed or outside their domains before the handler, and journals the rejection (PS3.2 row 2). Rejection reason `claims-unverified`.
- **PD5.1.2d** **Policies read claims.** The gate sees the claims of the step that emitted a proposal, as `step.caller.kind` and so on, under the snapshot rule of PT9.3.

### PD5.1.3 Checking

The guarantee is PS4.1b applied to a new kind of input. `check` offers every claim value in every state where the action can arrive. For the example, it proves that no path emits `refund` above the limit after an approval whose caller is an agent, or whose principal is the requester. A `CLEAN` verdict holds for every identity the verifier can assert, not only the ones a test suite thought of.

### PD5.1.4 The verifier adapter

The host supplies a verifier adapter: a function from the transport's credentials (an X.509 SVID, a JWT-SVID, a WIMSE workload token, a RATS attestation result) to a value of the declared `claims` type, or a refusal. poly checks the adapter's *output* against the type. It never checks the adapter's cryptography. That boundary is K11.

## PD5.2 Lineage

### PD5.2.1 The problem

The article's chain of custody is User to Service A to B to C, each hop adding a claim. In poly, a step's origin is lost the moment it emits a `send`. Within one run the ledger chain keeps the order of events. Across trust scopes and across runs, nothing carries who started the work and why.

### PD5.2.2 What a lineage is

Every accepted step has a **lineage**: the origin principal, the origin intent (the module, machine and action of the step that started the chain), and the digest of the previous hop. The runtime computes it. Code cannot write it.

- **PD5.2.2a** A step started by an action from outside takes its origin from that action's claims. A step started by an effect completion, a timer or a delivered message inherits the lineage of the step it follows, and appends one hop.
- **PD5.2.2b** A `send` across trust scopes (PT9.9) carries the lineage as a token. The proposal format leaves the encoding to the adapter, so a WIMSE or transaction-token encoding fits. The gate checks that the chain verifies and that the origin is admissible for the target action. A missing or broken chain is a deny, delivered to the sender as `SendDenied(to, action, "lineage")`.
- **PD5.2.2c** Policies read `lineage.origin.kind`, `lineage.origin.principal` and `lineage.intent`. A rule such as "no irreversible effect whose origin is not a person" is then one policy line.

### PD5.2.3 Checking

Lineage is deterministic given the path, so the checker knows, for every effect it can reach, which origin classes can lead to it. A labelled scope may require attribution. An effect labelled `compensable` or `irreversible` reachable from an origin with no claims is then `PL6701 UNATTRIBUTED_EFFECT`, a finding with a witness: the path from the unattributed action to the effect.

## PD5.3 Revocation

### PD5.3.1 The problem

The article's kill switch acts when a workload stops being trustworthy: a revoked credential, a failed attestation, a session ended by the identity provider. In a stack without state, a kill switch is a blunt stop. In poly it can be a state of the program.

### PD5.3.2 Signals as inputs

Security signals (for example Shared Signals Framework events such as a revoked session or a changed credential) arrive through an adapter as typed actions on a mode machine (PD4.2):

```poly
machine Trust {
  state level: enum { Normal, Restricted, Halted } = Normal
  on CredentialRevoked(p: Principal) { level' = Halted }
  on AttestationFailed() { level' = Halted }
  on Restore() by op: Caller {
    require op.kind == Person and op.assurance == 3 else reject "restore-needs-person"
    level' = Normal
  }
}
```

A policy reads `mode("Trust").level` and denies every compensable or irreversible effect while it is `Halted`.

### PD5.3.3 What is checked

- **PD5.3.3a** The policy check (PT8.5) proves that in `Halted` no compensable or irreversible effect is admitted. The kill switch is then a checked property, not a hope about wiring.
- **PD5.3.3b** It proves that every machine still reaches a state where it can finish, compensate or escalate while halted, so a halt never strands work. This is PD4's liveness obligation, applied to one more mode.
- **PD5.3.3c** It proves that only an attested person can leave `Halted`, by the claims rule above.

## PD5.4 Attributed provenance

- **PD5.4a** The ledger's step record gains the claims that admitted the step, and its lineage digest. With PD2's `decision` event, a run then answers three questions per step: who asked, what the model saw, and why it was allowed.
- **PD5.4b** Certificates (PT12) and ledger heads may be signed with the workload's own identity (an SVID) as well as with person keys. A relying party can then verify which deployment produced a run, through the same identity stack it already trusts.
- **PD5.4c** Attestation of the runtime itself (RATS evidence that polyrun is the build that was certified) stays the host's. poly states the expected digests; the host's verifier appraises them.

## PD5.5 What stays outside the checked core

poly verifies no signature, appraises no evidence, and manages no key. The verifier adapter, the token encodings and the identity provider are the host's. The checked core sees only their typed results.

- **K11** The claims and lineage tokens the runtime receives have been verified by the configured verifier. poly trusts the verifier's result and checks everything the program does with it.

This split is deliberate. Identity standards change; the checked core should not change with them.

## 5. New codes and assumptions

| Id | Meaning | Item |
|---|---|---|
| `PL6701 UNATTRIBUTED_EFFECT` | In a scope that requires attribution, a compensable or irreversible effect is reachable from an origin with no claims. A finding. | PD5.2.3 |
| `PL6702 PRINCIPAL_NOT_OPAQUE` | A `Principal` is used other than by equality, storage or passing. | PD5.1.2b |
| K11 | Claims and lineage tokens have been verified by the configured verifier. | PD5.5 |

Every other diagnostic reuses an existing code: `PL1101`, `PL1201`, the dispatch rejection `claims-unverified`, and `SendDenied` with reason `lineage`.

## 6. Open questions

1. **How many principals.** Equality-only use makes symmetry exact, but the number of representatives needed grows with the principals a property relates. Fields plus one is the conjecture; poly-ref should confirm it on the examples before it is ruled.
2. **Token formats.** The WIMSE work is still an IETF draft. PD5.2.2b names no encoding on purpose, and the adapter carries the choice.
3. **Lineage across runs.** A refund approved today for an order placed last week crosses runs. PD5.2 covers one run and the sends it makes; a link between runs needs the same answer as PD open question 2.
4. **Delegation.** An agent acting for a person carries both. Whether `claims` should model delegation (an `actor` and an `on behalf of`) or leave it to two fields is open.

## 7. Talking points (AgentLab, and the article's audience)

1. Identity stacks answer who is acting, where, and whether the chain was tampered with. They do not answer whether the code will do something wrong when every call is authorized. The checkout race passes every identity check and still confirms one unit to two orders.
2. poly does no cryptography. It takes the verified result as a typed input and checks the program against every value it can take. Their verification and our checking compose; neither replaces the other.
3. The harness decides on application state as well as identity: "only a person may approve, and only while the order awaits approval" is one rule.
4. The kill switch is a checked state: proved to stop every irreversible effect, and proved not to strand work.
5. The ledger records who asked, what the model saw and why the step was allowed, signed with the workload's own identity.
6. A concrete joint test: their identity layer as the verifier adapter, poly's refund example as the program, and one injected revocation.

## Conclusion

Identity enters poly the way model decisions do: verified outside, typed inside, and explored exhaustively by the checker. An action can require claims, a policy can decide on who acts and on the state the program is in, and a send across trust scopes carries a lineage the gate verifies. Revocation becomes a mode whose effect is proved, not assumed. The runtime records the claims behind each step and signs its outputs with the workload's identity, while cryptography, evidence and keys stay with the host's verifier under one new assumption, K11. The result is the chain of custody the article asks for, with one thing it does not ask for: a proof, before the program runs, that an authorized and attested chain still cannot do the wrong thing.
