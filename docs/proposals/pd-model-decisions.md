# poly · Model decisions: typed answers, provenance, model independence and operating modes

*Cognitive Fab · September 2026 · proposal, not part of draft v0.6 · ids `PD`*

## 0. Scope and status

This proposal adds four things to poly. They came from reading *When Agents Decide* (Enochs, Cockcroft, Eder, Spykerman and Wald, Enterprise Technology Leadership Journal, Fall 2026) and TypeSafe's Jev beside the Poly stack. That paper names four capabilities for governing decisions made by agents: continuous evaluation, decision tracking, policy enforcement, and a substrate of small agents that can be swapped. poly already has most of the substrate. What it lacks is a first-class place for the decision a model makes.

| Id | Addition | Needs | Proposed milestone |
|---|---|---|---|
| PD1 | Typed decisions: a model call whose answer is a finite typed value, checked for every answer | effects (M1) | after the M1 gate, before M3 |
| PD2 | Decision provenance: a ledger record of what each decision saw and returned | the ledger (PT16) | M4 |
| PD3 | Model independence: a model swap does not invalidate the certificate | PD1, the certificate | statement now, certificate section in M4 |
| PD4 | Operating modes: autonomy calibrated to stakes, and to the mode the business is in | policies (PT8), the gate (PT9) | M5 |

Nothing here changes 04-semantics. PD1 lowers to constructs that already exist, and its guarantee is PS4.1b applied to a new kind of input. Each item is ruled on separately, like the M0 and M1 spec issues, and enters the spec only when ruled.

The running example is the support-ticket router probed in `jev-lab` (seam 1): a message is routed to `refund`, `reschedule`, `status`, `complaint` or `other`.

## PD1. Typed decisions

### PD1.1 The problem

A model that answers in text leaves the program to parse it. The parse is the unchecked part: the program branches on whatever the parser extracted. Jev and similar decision engines return a value from a closed set instead: a choice among named options, a score on a rubric, or a truth value between 0 and 1, each with a probability and a confidence. A closed set of answers is exactly what poly can check. If every possible answer is an input to a checked machine, then every answer the model can give has already been explored.

### PD1.2 Syntax

A `decision` is declared in a machine, like an `effect`:

```poly
enum Branch { Refund, Reschedule, Status, Complaint, Other }

decision route(text: string) -> Branch {
  provider "jev"
  labels { egress:external, read:private }
  confidence 0..10
  ok(answer, conf) -> Routed(branch: answer, conf: conf)
  failed -> RouteFailed()
}
```

A handler asks for it with `decide`:

```poly
on Received(text) {
  require status == New else reject "not-new"
  status' = Routing
  decide route(text)
}
```

- **PD1.2a** The result type after `->` must be finite: an enum (a Jev choice), `bool` or `Tri` (a truth value, see PD1.4), or an integer range (a score). An unbounded result type is `PL1101 UNBOUNDED_DOMAIN`.
- **PD1.2b** `confidence 0..n` declares how the engine's confidence is quantised: a confidence `c` in `[0, 1]` is delivered as `floor(c * n)`, with `c = 1` delivered as `n`. The completion receives it as an integer in `0..n`. Leaving `confidence` out means the completion cannot receive one.
- **PD1.2c** `provider` names the engine kind, never a model version. The version is recorded at runtime (PD2) and is outside the certificate (PD3).
- **PD1.2d** The completion action's parameters are the result and the confidence. Their types must be the declared result type and `0..n`. Anything else is `PL1201` at the action.
- **PD1.2e** `ok(answer, conf)` binds the engine's reply. This is the only new syntax in a completion. It is general: an ordinary `effect` completion may bind its handler's result the same way.

### PD1.3 Lowering

A decision is an effect. Nothing in the engines changes.

- `decide route(text)` lowers to an effect intent of kind `decision.route` (the kind defaults as in S41).
- The manifest entry carries `class "none"`, its labels, and a completion that maps the reply with polyrun's existing `map` field:

  ```json
  "decision.route": {
    "payloadSchema": { "text": { "type": "string", "required": true } },
    "onSuccess": { "action": "Routed",
                   "map": { "branch": "$.result.answer", "conf": "$.result.conf" } },
    "onFailure": { "action": "RouteFailed" },
    "labels": ["egress:external", "read:private"], "class": "none",
    "decision": { "provider": "jev", "result": ["Refund", "Reschedule", "Status", "Complaint", "Other"],
                  "confidence": 10 } }
  ```

- The effect handler is a provider adapter, outside the checked core. It sends the typed question, receives the answer, quantises the confidence, and returns `{ answer, conf }`. The Jev adapter already exists in `jev-lab`; it becomes the first provider.

### PD1.4 Checking

- **PD1.4a** The completion's parameters are `strict` by default, whatever the handler does with them. So `check` offers every `(answer, conf)` pair in every state where the completion can arrive (PS4.1), and **run** rejects anything outside the domain before the handler (PS3.2 row 2).
- **PD1.4b** The guarantee is PS4.1b, unchanged. A decision's answer is an input. Every path of **run** whose answers stay in the result type is a path of **check**, and an answer outside it is rejected, journaled and never reaches a handler. So a property that is `CLEAN` holds for every answer the model can give. No model is called during checking (the standing rule of `CLAUDE.md`).
- **PD1.4c** A truth value lowers to `bool` by a declared threshold (`threshold 0.5`), or to `Tri` with two thresholds, where the band between them is `Unknown`. `Tri` is the recommended form: it makes the program say what happens when the engine is unsure, and PS8.0's three-valued logic already covers it.
- **PD1.4d** A handler that ignores the confidence is legal. The checker notes a decision whose completion reaches an effect of class `compensable` or `irreversible` without reading `conf` or `answer` in a `require` on the way (`PL6201 UNGATED_DECISION`, a finding). This is the one new check.

### PD1.5 The example, checked

```poly
on Routed(branch, conf) {
  require status == Routing else reject "not-routing"
  match branch {
    Refund => {
      if conf >= 8 { status' = Refunding  emit refund(order) }
      else         { status' = NeedsHuman }
    }
    Other  => { status' = NeedsHuman }
    _      => { status' = Handled  emit reply(branch) }
  }
}
```

`check` explores 5 answers times 11 confidence levels in `Routing`. A property such as `path property refund-once: count("payments.refund") <= 1` is then checked against every answer, including a model that answers `Refund` with confidence 10 to every message. `PL1501` catches a `match` that forgets a branch the engine can return.

### PD1.6 Acceptance

- **PD1-A1** The router above lowers, passes strict `validate()`, and runs under polyrun with the Jev adapter. The journal shows the typed answer as the completion's data.
- **PD1-A2** poly-ref explores every `(answer, conf)` pair. A seeded defect that refunds at confidence 7 is found with a witness, and the witness is exported as a test that fails before the fix.
- **PD1-A3** An adapter reply outside the result type (a sixth branch name, a confidence of 11) is rejected at dispatch with `outside-check-domain` and journaled.

## PD2. Decision provenance

### PD2.1 The problem

The paper's Context BOM records the inputs and reasoning behind each agent decision. poly's ledger records steps and gate decisions (PT16). It does not record where a decision's answer came from: the model and its version, the question asked, and what it was shown. Without that, replay reproduces the steps but cannot explain them.

### PD2.2 The ledger event

A new event kind, `decision`, written by the provider adapter when the reply arrives, before the completion is dispatched:

```json
{ "kind": "decision", "run": { "ns": "support", "wf": "support.Ticket", "run": "t-4417" }, "seq": 7,
  "body": { "decision": "route", "intent": "sha256:…", "provider": "jev",
            "model": { "id": "jev-latest", "reported": "jev-2026-09-18" },
            "request": "sha256:…", "inputs": ["sha256:…", "sha256:…"],
            "answer": "Refund", "conf": 9,
            "distribution": [["Refund", 0.93], ["Complaint", 0.05], ["Other", 0.02]],
            "latencyMs": 276 },
  "prev": "sha256:…", "hash": "sha256:…" }
```

- **PD2.2a** `request` is the digest of the RFC 8785 canonical JSON of the typed question and the state sent with it. `inputs` are digests of every document, record or tool result placed in that state. Bodies are kept in the content store under the operator's retention policy (PT16), so the chain holds digests only.
- **PD2.2b** `model.reported` is whatever version the provider reports. If it reports none, the field is `null`, and the certificate's instance line says so for runs that relied on it.
- **PD2.2c** The completion's `step` event carries the hash of its `decision` event. `poly verify` refuses a run in which a decision completion has no matching `decision` event, or in which the completion's data differs from the recorded answer.

### PD2.3 Replay

Journal replay (AC6) uses the recorded answer. It never calls the model again. So replay reproduces every post-state and gate decision exactly, and the `decision` events explain each answer. Re-asking the same question to a new model is evaluation, not replay (PD3.3).

### PD2.4 Acceptance

- **PD2-A1** For the router, every completion step links to a `decision` event, and `poly verify` refuses a journal where one link is removed or one answer is altered.
- **PD2-A2** Replay of a recorded run reproduces every post-state with no network access.

## PD3. Model independence

### PD3.1 The statement

- **PD3.1a** **Corollary of PS4.1b.** The certificate binds the module digest, the check domains, the policies and the kernel assumptions. A decision's answers are inputs, bounded by the result type. The model that produces them is not part of anything the certificate binds. So replacing the model, or the provider, leaves every `CLEAN` verdict valid, provided the result type and the confidence quantisation are unchanged.
- **PD3.1b** Changing the result type or the quantisation changes the module digest, so it needs a new check, as any source change does.

### PD3.2 The certificate section

The certificate gains a `decisions` section, one entry per decision: its result domain, its confidence quantisation, its labels, and `modelBound: false`. A verifier can then see that no verdict depends on which model runs.

### PD3.3 Correctness and quality are separate

The certificate says what the system may do with any answer. It does not say how good the answers are. Quality is measured by evaluation: replaying recorded questions (PD2) against a candidate model, off the step path, and comparing its answers and confidences with the recorded ones and with adjudicated outcomes. Polytrion and Polyx are the natural hosts for that evaluation. Its result can block a swap by policy (PD4.3), but it never changes a verdict.

### PD3.4 Acceptance

- **PD3-A1** Swapping the router's provider configuration from one Jev model to another changes no file under `.poly/build` and leaves the certificate's digest unchanged.
- **PD3-A2** An evaluation run over 100 recorded router questions reports agreement and calibration for the candidate model, and writes nothing to any run's ledger.

## PD4. Operating modes

### PD4.1 The problem

The paper, after the Cynefin framework, describes a business that moves between complicated, complex and chaotic conditions, and needs different rules for automated action in each. In chaotic conditions it wants "wartime" guardrails: fewer actions allowed without a person, and reserves kept. In poly, the rules for automated action are policies, and stakes are already expressed by effect class and labels. What is missing is a mode that the policies can depend on, changed only by people.

### PD4.2 The mode machine

A mode is an ordinary machine, so its changes are journaled and checked:

```poly
enum Mode { Normal, Complex, Crisis }

service machine OpsMode {
  state { mode: Mode = Normal }
  action Declare(mode: Mode, by: string check { "ops-lead", "cto" })
  on Declare(m, by) { mode' = m }
}
```

- **PD4.2a** `Declare` is dispatched only with a person's signature (PT12.5). An unsigned `Declare` is refused at dispatch.
- **PD4.2b** The gate reads the current mode through PT8.3 (`machine("ops.OpsMode").mode`), like any program state.

### PD4.3 Mode-dependent policy

```poly
policy autonomy {
  scope "support"

  obligation refund-by-mode "Refunds need a person below the mode's confidence floor." rule {
    when effect.kind == "payments.refund"
    require (machine("ops.OpsMode").mode == Normal  && decision.conf >= 8)
         || (machine("ops.OpsMode").mode == Complex && decision.conf >= 9) else escalate
    on unknown escalate
  }

  obligation crisis-irreversible "In a crisis, every irreversible effect needs a person." rule {
    when effect.class == "irreversible" && machine("ops.OpsMode").mode == Crisis
    require false else escalate
  }
}
```

- **PD4.3a** `decision.conf` and `decision.answer` name the most recent decision on the emitting instance's path, from its `decision` event (PD2). A rule that reads them for an effect with no decision behind it evaluates `when` as unknown (PS8.2), so the rule's `on unknown` outcome applies.
- **PD4.3b** A model allowed list is a rule over `decision.model.id`, evaluated at the gate. It restricts which models may act without changing the certificate (PD3).

### PD4.4 What is checked

- **PD4.4a** **Consistency per mode.** Obligation consistency (PT8.5) is checked separately for each value of the mode, so no mode has contradictory obligations.
- **PD4.4b** **Every mode can finish the work.** For each mode, dischargeability (PS8.6, a possibility property) is checked with the mode held fixed: every task the machine can start still has some path to completion, with escalations counted as allowed once approved. A mode that blocks all work is `PL6501 UNDISCHARGEABLE_MANDATE`, naming the mode.
- **PD4.4c** **Escalation is bounded in every mode.** The escalate-once rule and its timeout (PT9.7 rule 2) hold unchanged, so a crisis mode adds approvals but never an unbounded wait.

### PD4.5 Acceptance

- **PD4-A1** With the router and the policy above, the gate allows a refund at confidence 9 in `Normal`, escalates it in `Crisis`, and records the mode in the gate's `verdict` event.
- **PD4-A2** A policy that denies every effect of the refund flow in `Crisis`, with no escalation, is reported `PL6501` naming `Crisis`.
- **PD4-A3** An unsigned `Declare` is refused, and a signed one is journaled with its signer.

## 5. New codes

| Code | Meaning | Item |
|---|---|---|
| `PL6201 UNGATED_DECISION` | A decision's completion reaches a compensable or irreversible effect with no `require` on its answer or confidence on the way. A finding. | PD1.4d |

Every other diagnostic in this proposal reuses an existing code: `PL1101`, `PL1201`, `PL1501`, `PL6501`, and the dispatch rejection `outside-check-domain`.

## 6. Open questions

1. **Bindings in ordinary effect completions.** PD1.2e makes `ok(r) -> A(x: r.f)` general. polyrun's `map` supports it, but the S44 rules for completion parameters would need the same treatment. Rule it with PD1 or separately.
2. **Distributions in properties.** PD2 records the engine's distribution. A property over it (for example, "never act when the top two answers are within 0.1") would need the distribution as an input, which multiplies the domain. The proposal leaves it to the gate (PD4.3) for now.
3. **Where the mode machine lives.** One mode per organisation, per domain or per trust scope. The syntax works for all three; the policy names the machine it reads.

## Conclusion

A model's decision enters poly as a typed input with a finite domain, so the checker explores every answer the model can give, and no model is called to do it. The ledger records what each decision saw and returned, so a run can be explained as well as replayed. Because the model is outside everything the certificate binds, it can be replaced without re-checking, and its quality is measured by evaluation instead. Operating modes let people change how much the system may do alone, and the policy checks confirm that every mode is consistent and still lets the work finish. Of the four capabilities the paper names, poly already covered policy enforcement and the substrate. These additions cover decision tracking and make continuous evaluation safe to run without touching a verdict.
