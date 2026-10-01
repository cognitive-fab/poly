# poly · Identity and lineage: verified claims, chain of custody and revocation

*Cognitive Fab · September 2026 · proposal v0.2, reviewed (`docs/reviews/review-pd5.md`), rulings S101 to S113 in `docs/decisions-pd5.md` · ids `PD5` · follows [`pd-model-decisions.md`](pd-model-decisions.md)*

## 0. Scope and status

This proposal adds identity to poly without adding cryptography to it. It came from two sources: Yogi Porla's article *The Cost of Ignoring Context: Why AI Agent Sprawl is Fueling Preventable Hacks* (LinkedIn, September 27, 2026), and the agent identity work of AgentLab. The article asks for four things: a harness that authorizes each tool call against its runtime context, an automated kill switch, continuous verification of the workload (SPIFFE, IETF WIMSE, RATS, the Shared Signals Framework), and a chain of custody that carries the originating user across every hop.

poly already has part of the first two. The gate decides on every effect against the snapshot of the step that emitted it (PT9.3). A lint over handler files refuses imports of ambient-authority modules (`PL6401`). The M5 gate fails closed under an outage. What poly lacks is a typed place for *who* is acting, and a lineage that survives a message crossing trust scopes.

The design principle is the one PD1 used for model answers. Verification happens outside poly, in a verifier that speaks SPIFFE, WIMSE or RATS. Its result enters poly as a **finite typed input**. The checker explores every claim value an input could carry, and no verifier is called to do it.

| Id | Addition | Needs | Milestone |
|---|---|---|---|
| PD5.1 | Verified claims: an action may require claims of a declared finite type, supplied by a verifier and explored like any input | strict inputs (PS3.2), PD2 (K10 before K11) | M5 |
| PD5.2 | Lineage: every step, effect and message carries its origin and intent; a send across trust scopes carries a lineage the gate checks | PD5.1, PT9.9 | M5 |
| PD5.3 | Revocation: security signals arrive as typed inputs to a mode machine; a halt mode is checked to admit no compensable or irreversible effect | PD4, the gate (PT9) | M5 |
| PD5.4 | Attributed provenance: the ledger records the claims that admitted each step; heads may carry a workload-identity countersignature | PD2, PD5.1, PD5.2 | M5 |

PD5 changes 04-semantics in three places: the label gains claims (PD5.1.2c), a lemma extends PS4.1b to principals (PD5.1.3), and K11 is added after K10 (PD5.5). It is not ruled into the spec before PD2 is (S110).

The running example is a refund above a limit. It needs an approval, and the approval must come from a person other than the requester.

## PD5.1 Verified claims

### PD5.1.1 The problem

Today an action carries parameters. Nothing in the program says who sent it, so a policy cannot tell an approval from a person from the same approval relayed by an agent. Identity stacks can tell them apart, but they cannot see the application's state. The article's harness needs both at once.

### PD5.1.2 Syntax

A `claims` type is a record whose fields are finite:

```poly
enum Kind { Person, Agent, Service }
enum Attest { Verified, Failed, Absent }

claims Caller {
  kind: Kind
  attest: Attest
  assurance: 0..3
  principal: Principal
}
```

An action names the claims it requires with `by`:

```poly
on Request(a) by caller: Caller {
  require status == Idle else reject "busy"
  requester' = caller.principal
  amount' = a
  if a > limit { status' = AwaitingApproval } else { status' = Refunded; emit refund(a) }
}

on Approve() by caller: Caller {
  require status == AwaitingApproval else reject "not-awaiting"
  require caller.kind == Person else reject "person-required"
  require caller.attest == Verified else reject "not-attested"
  require caller.assurance >= 2 else reject "low-assurance"
  require caller.principal != requester else reject "self-approval"
  approver' = caller.principal
  status' = Refunded
  emit refund(amount)
}
```

- **PD5.1.2a** **Finite fields.** Every field of a `claims` type is an enum, an integer range or `Principal` (S103). An unbounded field is `PL1101 UNBOUNDED_DOMAIN`.
- **PD5.1.2b** **`Principal`.** A principal is an opaque identity. It may be compared for equality with another `Principal`, stored in a state field, or passed as an argument. Any other use is `PL1206 PRINCIPAL_NOT_OPAQUE` (S109).
- **PD5.1.2c** **Claims are part of the label (S101).** A step's label becomes `(a, d, c, v)`. PS3.2 gains a row after row 2: claims missing, malformed or outside their domains give `rejected("claims-unverified")` and leave the state unchanged. The runtime applies it before the module, as it applies row 2. The reason is reserved, like `terminal` and `outside-check-domain` (`PL1207`).
- **PD5.1.2d** **Policies read claims (S104).** The gate proposal (PT9.1) carries the claims of the emitting step, under `claims`. Policies read them as `step.claims.kind` and so on. The snapshot is still the post-state of PT9.3; the claims come from the label and travel beside it.

### PD5.1.3 Checking

- **PD5.1.3a** **Renaming invariance (lemma, S102).** In a module where principals are used only as PD5.1.2b allows, for every bijection `π` on principals, `(s, l, s') ∈ R_M` iff `(π s, π l, π s') ∈ R_M`. No handler or rule can tell two principals apart except by equality, so renaming them consistently changes nothing.
- **PD5.1.3b** **Extension of PS4.1b.** With the lemma, every path of **run**, whatever principals it carries, is the renaming of a path of **check** over a finite set of representatives, provided the set holds enough of them. `check` offers every claim value, and every representative for each `Principal` field, in every state where the action can arrive.
- **PD5.1.3c** **How many representatives.** The number of `Principal` fields plus one, and never fewer than 2. The verdict prints it in its instance. The evidence (`docs/reviews/evidence/principal_symmetry.py`) shows the verdict on the example stable from 2, where the guard relates two principals; a tighter bound of that form enters only with the lemma's proof.
- **PD5.1.3d** For the example, `check` proves that no path emits `refund` above the limit after an approval whose caller is an agent, is not attested, or is the requester. A `CLEAN` verdict holds for every identity the verifier can assert. With one representative, no approval is reachable at all; S113 makes that verdict `INCONCLUSIVE` (`vacuous`), never `CLEAN`.

### PD5.1.4 The verifier adapter

The host supplies a verifier adapter: a function from the transport's credentials (an X.509 SVID, a JWT-SVID, a WIMSE workload token, a RATS attestation result, or a person's key signature) to a value of the declared `claims` type, or a refusal. poly checks the adapter's *output* against the type. It never checks the adapter's cryptography. That boundary is K11.

A person signature (PT12.5, PD4.2a) is one such adapter. Its output is `{ kind: Person, attest: Verified, assurance: 3, principal: <key owner> }` (S107). PD4.2a is restated this way when both land.

## PD5.2 Lineage

### PD5.2.1 The problem

The article's chain of custody runs from the user to service A, then B, then C, each hop adding a claim. In poly, a step's origin is lost the moment it emits a `send`. Within one run the ledger chain keeps the order of events. Across trust scopes and across runs, nothing carries who started the work and why.

### PD5.2.2 What a lineage is

Every accepted step has a **lineage**: its **origin** (the claims of the step that started the chain), its **intent** (the module, machine and action of that step), and the digest of the previous hop. The runtime computes it. Code cannot write it.

- **PD5.2.2a** A step started by an action from outside takes its origin from that action's claims. A step started by an effect completion, a timer or a delivered message inherits the lineage of the step it follows, and appends one hop.
- **PD5.2.2b** A `send` across trust scopes (PT9.9) carries the lineage. The encoding is the adapter's, so a WIMSE or transaction-token encoding fits. The verifier checks the chain; the gate receives the verified origin and intent as proposal fields (`origin`) and decides whether they are admissible for the target action. A missing or broken chain is a deny, delivered to the sender as `SendDenied(to, action, "lineage")`.
- **PD5.2.2c** Policies and properties read `lineage.origin.<field>` and `lineage.intent`. No expression can name a hop. "No irreversible effect whose origin is not a person" is one policy line.
- **PD5.2.2d** **Carriage.** Lineage travels in a reserved field of the effect or message payload, written by poly's lowering and read by the receiving step. A change to polyrun is needed only if the kernel cannot pass that field to the receiving step.

### PD5.2.3 Checking (S105)

In **check**, lineage is abstracted to its **origin class**: the origin's claims and the intent. Hop chains and digests exist only at runtime, like ids and `seq`. A message in a configuration's multiset carries its origin class, which is finite, so the state stays finite. The abstraction is exact because nothing a property or policy can read depends on hops (PD5.2.2c).

A labelled scope may require attribution. A `compensable` or `irreversible` effect reachable from an origin with no claims is then `PL6701 UNATTRIBUTED_EFFECT`, a finding with a witness: the path from the unattributed action to the effect.

## PD5.3 Revocation

### PD5.3.1 The problem

The article's kill switch acts when a workload stops being trustworthy: a revoked credential, a failed attestation, a session ended by the identity provider. In a stack without state, a kill switch is a blunt stop. In poly it is a state of the program.

### PD5.3.2 Signals as inputs

Security signals (for example Shared Signals Framework events, such as a revoked session or a changed credential) arrive through an adapter as actions on a mode machine (PD4.2):

```poly
enum Level { Normal, Restricted, Halted }

machine Trust {
  state level: Level = Normal

  on CredentialRevoked(p: Principal) {
    level' = Halted
  }

  on AttestationFailed() {
    level' = Halted
  }

  on Restore() by op: Caller {
    require level == Halted else reject "not-halted"
    require op.kind == Person else reject "person-required"
    require op.attest == Verified else reject "not-attested"
    require op.assurance == 3 else reject "low-assurance"
    level' = Normal
  }
}
```

A policy reads `machine("security.Trust").level` and denies every compensable or irreversible effect while it is `Halted`.

### PD5.3.3 What is checked (S106)

- **PD5.3.3a** polycheck's region check at admission (PT8) proves that in `Halted` no compensable or irreversible effect is admitted. The kill switch is a checked property.
- **PD5.3.3b** A possibility property, as PD4.4b: from every state reachable while halted, every machine can still reach a state where it finishes, compensates or escalates. A halt never strands work.
- **PD5.3.3c** Only a verified person at assurance 3 can leave `Halted`, by the guards of `Restore`.

## PD5.4 Attributed provenance

- **PD5.4a** The ledger's step record (PT16) gains the claims that admitted the step and its lineage digest. With PD2's `decision` event, a run answers three questions per step: who asked, what the model saw, and why it was allowed.
- **PD5.4b** **Countersignature (S108).** Ledger heads and certificates (written by `poly admit`, PT14, verified at load, PT15) stay ed25519, signed as today. A workload-identity signature (for example with an SVID) is an additional countersignature over the head's hash, in its own record, made and verified by the host's verifier adapter. Polyaxion's four checks and polysec are unchanged. A relying party can verify which deployment produced a run through the identity stack it already trusts.
- **PD5.4c** Attestation of the runtime itself (RATS evidence that polyrun is the build that was certified) stays the host's. poly states the expected digests; the host's verifier appraises them.

## PD5.5 What stays outside the checked core

poly verifies no credential, appraises no evidence and manages no key beyond its own ed25519 signing. The verifier adapter, the token encodings and the identity provider are the host's. The checked core sees only their typed results.

- **K11** The claims and lineage origins the runtime receives have been verified by the configured verifier. poly trusts the verifier's result and checks everything the program does with it. K11 follows K10, which enters PS10 with PD2 (S110).

Identity standards change; the checked core should not change with them.

## 5. New codes and assumptions

| Id | Meaning | Item |
|---|---|---|
| `PL1206 PRINCIPAL_NOT_OPAQUE` | A `Principal` is used other than by equality, storage or passing. | PD5.1.2b |
| `PL6701 UNATTRIBUTED_EFFECT` | In a scope that requires attribution, a compensable or irreversible effect is reachable from an origin with no claims. A finding. | PD5.2.3 |
| `claims-unverified` | Reserved rejection reason, applied by the runtime before the module. | PD5.1.2c |
| K11 | Claims and lineage origins have been verified by the configured verifier. | PD5.5 |

`PL1207 RESERVED_REJECT_REASON` and the `vacuous` reason (S113) are already in the spec, enforced from M4. Every other diagnostic reuses an existing code: `PL1101`, `PL1201`, `PL1203`, and `SendDenied` with reason `lineage`.

## 6. Open questions

1. **A tighter bound on principals.** The evidence suggests the most principals one guard, property or input relates. It enters with the proof of PD5.1.3a, not before.
2. **Token formats.** The WIMSE work is still an IETF draft. PD5.2.2b names no encoding, and the adapter carries the choice.
3. **Lineage across runs.** A refund approved today for an order placed last week crosses runs. PD5.2 covers one run and the sends it makes; a link between runs needs the same answer as open question 2 of the PD proposal.
4. **Delegation.** An agent acting for a person carries both. Whether `claims` should model delegation (an actor and an "on behalf of") or leave it to two fields is open.

## 7. Talking points (AgentLab, and the article's audience)

1. Identity stacks answer who is acting, where, and whether the chain was tampered with. They do not answer whether the code will do something wrong when every call is authorized. The checkout race passes every identity check and still confirms one unit to two orders.
2. poly does no cryptography. It takes the verified result as a typed input and checks the program against every value it can take. Their verification and our checking compose; neither replaces the other.
3. The harness decides on application state as well as identity: "only a verified person other than the requester may approve, and only while the refund awaits approval" is one set of guards, checked for every caller.
4. The kill switch is a checked state: proved to stop every irreversible effect, and proved not to strand work.
5. The ledger records who asked, what the model saw and why the step was allowed, and can carry the workload's own countersignature.
6. A concrete joint test: their identity layer as the verifier adapter, poly's refund example as the program, and one injected revocation.

## Conclusion

Identity enters poly the way model decisions do: verified outside, typed inside, and explored exhaustively by the checker. Claims become part of a step's label, with a reserved rejection when they are missing, and a renaming lemma lets a finite set of principals stand for all of them. A policy can decide on who acts and on the state the program is in, and a send across trust scopes carries a lineage that the checker sees as a finite origin class. Revocation is a mode whose effect is proved, not assumed. The ledger records the claims behind each step and can carry a workload countersignature without any change to the engines. Cryptography, evidence and keys stay with the host's verifier under one new assumption, K11. The result is the chain of custody the article asks for, with one thing it does not ask for: a proof, before the program runs, that an authorized and attested chain still cannot do the wrong thing.
