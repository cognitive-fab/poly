# poly · Model decisions: typed answers, provenance, model independence and operating modes

*Cognitive Fab · September 2026 · proposal v0.2, ruled at M1's close (see `decisions-m1.md`) · ids `PD` · v0.2 answers [`review-2026-09-30-decisions.md`](../reviews/review-2026-09-30-decisions.md)*

## 0. Scope and status

This proposal adds four things to poly. They came from reading *When Agents Decide* (Enochs, Cockcroft, Eder, Spykerman and Wald, Enterprise Technology Leadership Journal, Fall 2026) and TypeSafe's Jev beside the Poly stack. The paper names four capabilities for governing decisions made by agents: continuous evaluation, decision tracking, policy enforcement, and a substrate of small agents that can be swapped. poly already has most of the substrate. What it lacks is a first-class place for the decision a model makes, and a way to make the numbers a model returns mean something stable.

| Id | Addition | Needs | Milestone |
|---|---|---|---|
| PD1 | Typed decisions: a model call whose answer is a finite typed value, checked for every answer; confidence explored exactly by the intervals the program uses; a calibration map per decision | effects (M1) | M2 |
| PD2 | Decision provenance: a `decision` event written by the runtime with the completion step, and `outcome` links for adjudication | the ledger (PT16) | M4 |
| PD3 | Model independence: verdicts survive a model swap; the program's meaning survives it only through a refitted calibration map | PD1, PD2, the certificate | M4 |
| PD4 | Operating modes: autonomy calibrated to stakes and to the mode the business is in | PD2, policies (PT8), the gate (PT9) | M5 |

Nothing here changes 04-semantics except one new kernel assumption, K10 (PD2.3). PD1 lowers to constructs that already exist, and its guarantee is PS4.1b applied to a new kind of input. Each item is ruled on separately and enters the spec only when ruled.

The running example is the support-ticket router probed in `jev-lab` (seam 1): a message is routed to `refund`, `reschedule`, `status`, `complaint` or `other`.

## PD1. Typed decisions

### PD1.1 The problem

A model that answers in text leaves the program to parse it, and the parse is the unchecked part. A decision engine returns a value from a supplied schema instead: a choice among named options, a score on a rubric, or a truth value, each with probabilities. A closed set of answers is what poly can check. If every possible answer is an input to a checked machine, every answer the model can give has already been explored, and no model is called to do it.

Confidence needs more care than the answer. Calibration is a statement about groups of predictions on one distribution of traffic; it says nothing about a single answer, it differs between models, and it drifts. A threshold written in a program therefore needs a stable meaning (PD1.6), and the checker should explore only the confidence values the program can tell apart (PD1.4).

### PD1.2 Syntax

A `decision` is declared in a machine, like an `effect`:

```poly
enum Branch { Refund, Reschedule, Status, Complaint, Other }

decision route(text: string) -> Branch {
  provider "jev"
  labels { egress:external, read:private }
  timeout 800ms
  ok(r) -> Routed(branch: r.answer, conf: r.conf, margin: r.margin)
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

- **PD1.2a** **Result types.** The result type after `->` is finite: an enum (a choice), an integer range (a score), `Tri` (a truth value, PD1.2d), or a record of these (S25), which asks several questions about the same state in one call. An unbounded result type is `PL1101 UNBOUNDED_DOMAIN`.
- **PD1.2b** **The reply.** `ok(r)` binds the reply. `r.answer` has the result type. `r.conf` and `r.margin` have type `Conf` (PD1.3). For a record result, each field has its own: `r.answer.branch`, `r.conf.branch`, `r.margin.branch`. The margin is the difference between the probabilities of the first and second answers.
- **PD1.2c** **Failure.** `timeout` is required, and a timeout is a `failed`. A decision with no `timeout` or no `failed` completion is `PL6202 DECISION_WITHOUT_FAILURE`, because a machine waiting on a dead provider can wait forever. The recommended fallback is a person or a default branch. A second decision as fallback is legal, and it costs a second calibration map to maintain (PD1.6).
- **PD1.2d** **Truth values.** A truth question returns `Tri`. The decision declares its band, `band 0.3..0.7`: a calibrated probability below the band is `False`, above it is `True`, inside it is `Unknown`. PS8.0's three-valued logic already covers what follows.
- **PD1.2e** **Provider.** `provider` names the engine kind, never a model version. The version is recorded at runtime (PD2) and is outside the certificate (PD3).
- **PD1.2f** **Completion parameters.** The completion action's parameter types must be those of the bound expressions. Anything else is `PL1201` at the action.
- **PD1.2g** **Bindings in ordinary effects.** `ok(r)` is general: an ordinary `effect` completion may bind its handler's result the same way. The S44 rules for completion parameters extend to these bindings.

### PD1.3 The `Conf` type

- **PD1.3a** At runtime a `Conf` is a fixed-point value in `0..1000` (thousandths), after the calibration map (PD1.6). In source it is written as a decimal in `[0, 1]`: `conf >= 0.8`.
- **PD1.3b** A `Conf` may only be **compared with a constant**, or **passed** as a completion argument. Arithmetic on it, a comparison with a field or parameter, a comparison between two `Conf` values, and a write of it to a state field are all `PL1205 CONFIDENCE_NOT_COMPARED`. PD1.4 needs this restriction to be exact.

### PD1.4 Checking

- **PD1.4a** **Every answer.** The completion's parameters are `strict` by default, whatever the handler does with them. So `check` offers every answer in every state where the completion can arrive (PS4.1), and **run** rejects anything outside the domain before the handler (PS3.2 row 2).
- **PD1.4b** **Confidence by intervals.** For each `Conf` quantity of each decision, the checker collects the constants it is compared with, in the module and in the admitted policies (PD4), and splits `[0, 1]` into the intervals those constants induce. It explores one representative per interval. For the router, `conf >= 0.8` gives two intervals, `[0, 0.8)` and `[0.8, 1]`, not a thousand values. This is exact: under PD1.3b no handler or rule can tell two values of one interval apart. Adding a constant to a policy changes the partition, which is why policies are admitted before the check (PT8.4).
- **PD1.4c** **The guarantee** is PS4.1b, unchanged. A decision's answer, confidence and margin are inputs. Every path of **run** whose inputs stay in their domains is a path of **check**, and an input outside them is rejected, journaled and never reaches a handler. A property that is `CLEAN` holds for every answer the model can give, at every confidence.
- **PD1.4d** **Gated decisions.** A decision is gated iff, for every answer whose accepted completion can emit a `compensable` or `irreversible` effect, some confidence or margin interval keeps every accepted completion with that answer, and the cascade after it, from emitting one (S85). Rejected completions emit nothing, so a `require` that rejects below a threshold is a gate. A decision in a machine with attached children is `PL0901` until the cascade is followed through the joint machine (S85). poly-ref decides this on the graph it already builds. An ungated decision is `PL6201 UNGATED_DECISION`, a finding. A `require` that tests nothing does not make a decision gated. **Limit (S75):** `PL6201` looks at the completion step and its cascade only. An answer stored in the state and acted on by a later step is not covered by `PL6201`; it is covered by the properties the author writes over that state. Looking further would reach most irreversible effects through unrelated inputs and make the finding meaningless.

### PD1.5 The example, checked

```poly
on Routed(branch, conf, margin) {
  require status == Routing else reject "not-routing"
  match branch {
    Refund => {
      if conf >= 0.8 && margin >= 0.3 { status' = Refunding  emit refund(order) }
      else                             { status' = NeedsHuman }
    }
    Other  => { status' = NeedsHuman }
    _      => { status' = Handled  emit reply(branch) }
  }
}

path property one-routing: count("decision.route") <= 1
path property refund-once: count("payments.refund") <= 1
```

`check` explores 5 answers times 2 confidence intervals times 2 margin intervals in `Routing`. `refund-once` is checked against every one of them, including a model that answers `Refund` at confidence 1 to every message. `PL1501` catches a `match` that forgets a branch the engine can return. Removing the `if` makes the decision ungated (`PL6201`).

### PD1.6 The calibration map

- **PD1.6a** Each decision has a **calibration map**: a monotone function from the engine's raw probability to a calibrated one, fitted on adjudicated outcomes for that decision (PD2.4), for example by isotonic regression. The adapter applies it before delivering `conf`, `margin` and the `Tri` band.
- **PD1.6b** A map is runtime configuration, identified by `{ decision, version, fittedFor, digest }`, where `fittedFor` is the model id it was fitted on. It is not part of the module, so changing it needs no re-check.
- **PD1.6c** Until a map is fitted, the map is the identity and is marked `uncalibrated`. A policy can refuse uncalibrated decisions where the stakes require it (PD4.3).
- **PD1.6d** With a map, `conf >= 0.8` means "at least 0.8 on this decision's own measured calibration". Without one it means only "the engine said 0.8".

### PD1.7 Lowering

A decision is an effect. Nothing in the engines changes.

- `decide route(text)` lowers to an effect intent of kind `decision.route` (the kind defaults as in S41).
- The manifest entry carries `class "none"`, its labels, its timeout, and a completion that maps the reply with polyrun's existing `map` field (`workers.mjs`, `mapCompletion`):

  ```json
  "decision.route": {
    "payloadSchema": { "text": { "type": "string", "required": true } },
    "retry": { "maxAttempts": 1, "timeoutMs": 800 },
    "onSuccess": { "action": "Routed",
                   "map": { "branch": "$.result.answer", "conf": "$.result.conf", "margin": "$.result.margin" } },
    "onFailure": { "action": "RouteFailed" },
    "onExhausted": { "action": "RouteFailed" },
    "labels": ["egress:external", "read:private"], "class": "none",
    "decision": { "provider": "jev", "result": ["Refund", "Reschedule", "Status", "Complaint", "Other"] } }
  ```

- The effect handler is a provider adapter, outside the checked core. It sends the typed question, applies the calibration map, and returns the whole decision record (PD2.2) as its result. The Jev adapter in `jev-lab` is the first provider. Tests use a recorded provider: no test calls a model.

### PD1.8 Acceptance (M2)

- **PD1-A1** The router lowers, passes strict `validate()`, and runs under polyrun with a recorded provider. The journal shows the typed answer, confidence and margin as the completion's data.
- **PD1-A2** poly-ref explores 5 × 2 × 2 completions in `Routing`. A seeded defect that refunds when `margin < 0.3` is found with a witness, exported as a test that fails before the fix.
- **PD1-A3** A reply outside the domain (a sixth branch, a confidence of 1001) is rejected at dispatch with `outside-check-domain` and journaled. Since a decision engine cannot return a value outside its schema, this tests the adapter.
- **PD1-A4** `PL1205`, `PL6201` and `PL6202` each have an error source, and a vacuous `require conf >= 0` does not silence `PL6201`.

## PD2. Decision provenance

### PD2.1 The problem

The paper's Context BOM records the inputs and reasoning behind each agent decision. poly's ledger records steps and gate decisions (PT16), but not where a decision's answer came from, and not whether it turned out right. Without the first, replay reproduces steps but cannot explain them. Without the second, calibration (PD1.6) and evaluation (PD3.3) have nothing to learn from.

### PD2.2 The `decision` event

The adapter returns the decision record as the effect's result. The runtime writes it as a `decision` event **in the same transaction as the completion step** (K1), so the two exist together or not at all. The adapter never writes to the ledger: PT16 has one writer per run (K2).

```json
{ "kind": "decision", "run": { "ns": "support", "wf": "support.Ticket", "run": "t-4417" }, "seq": 7,
  "body": { "decision": "route", "intent": "sha256:…", "provider": "jev",
            "model": { "id": "jev-latest", "reported": "jev-2026-09-18" },
            "calibration": { "version": 3, "fittedFor": "jev-2026-09-18", "digest": "sha256:…" },
            "request": "sha256:…", "inputs": ["sha256:…", "sha256:…"],
            "answer": "Refund", "raw": 0.93, "conf": 910, "margin": 880,
            "distribution": [["Refund", 0.93], ["Complaint", 0.05], ["Other", 0.02]],
            "latencyMs": 276, "cost": { "units": 1, "unit": "call" } },
  "prev": "sha256:…", "hash": "sha256:…" }
```

- **PD2.2a** `request` is the digest of the RFC 8785 canonical JSON of the typed question and the state sent with it. `inputs` are digests of every document, record or tool result placed in that state. Bodies are kept in the content store under the operator's retention policy (PT16); the chain holds digests only.
- **PD2.2b** `model.reported` is whatever version the provider reports, or `null`. `cost` is recorded when the provider reports it.
- **PD2.2c** On a retried effect, only the attempt whose result is dispatched is recorded in the chain. The other attempts stay in the outbox attempt log.
- **PD2.2d** The completion's `step` event carries the hash of its `decision` event. `poly verify` refuses a run in which a decision completion has no `decision` event, or in which the completion's data differs from the recorded answer, confidence or margin. With the transaction of PD2.2, that refusal only fires on tampering.
- **PD2.2e** **Integration point, to verify at M4.** The runtime reads the decision record from the effect's stored result when it commits the completion step. If polyrun does not keep an effect's result with the outbox row until then, poly-runtime keeps it.

### PD2.3 Replay and K10

- **K10. A decision's answer is fixed by its recorded event, not by its request.** Engines are not deterministic: the same request can get a different answer on a second call, even from the same model version.
- Journal replay (AC6) uses the recorded answer and never calls the model. So replay reproduces every post-state and gate decision exactly, and the `decision` events explain each answer. Re-asking a recorded question to a model is evaluation (PD3.3), not replay.

### PD2.4 Outcomes

A later step on the same run can adjudicate an earlier decision:

```poly
on RefundReversed(reason) {
  require status == Refunded else reject "not-refunded"
  status' = Reversed
  adjudicate route as Wrong
}
```

- **PD2.4a** `adjudicate d as Correct | Wrong` lowers to an `outcome` intent. The runtime writes an `outcome` event linked to the hash of the most recent `decision` event for `d` on the run. *Ruled (S129):* the checker reports an accepted adjudication reachable without a preceding accepted `ok` completion of `d` as `PL6203 ADJUDICATION_WITHOUT_DECISION`, with the path, and the runtime reason `no-decision-to-adjudicate` is dropped (PT6.1).
- **PD2.4b** Evaluation, calibration fitting and drift monitoring read `decision` events joined with their `outcome` links. None of them writes to a run's chain.

### PD2.5 Acceptance (M4)

- **PD2-A1** For the router, every completion step links to a `decision` event. A crash injected between the effect's result and the completion commit leaves neither the event nor the step, and the run recovers and completes.
- **PD2-A2** `poly verify` refuses a journal where one link is removed or one answer is altered.
- **PD2-A3** Replay of a recorded run reproduces every post-state with no network access.
- **PD2-A4** A reversed refund produces an `outcome` event linked to the right `decision` event.

## PD3. Model independence

### PD3.1 What is proved: verdicts are independent of the model

**Corollary of PS4.1b.** The certificate binds the module digest, the check domains, the policies and the kernel assumptions. A decision's answer, confidence and margin are inputs bounded by their domains, and the calibration map is runtime configuration. The model is not part of anything the certificate binds. So replacing the model or the provider leaves every verdict valid, provided the result type is unchanged. Changing the result type changes the module digest and needs a new check, as any source change does.

### PD3.2 What is preserved only through the map: the program's meaning

A verdict that survives a swap is not the same as a program that means the same thing. `conf >= 0.8` meant "at least 0.8 on the old model's calibration". On a new model with the old map it means something else, although no verdict changed. The meaning is preserved only when the new model has its own map, fitted before it acts.

- **PD3.2a** Every `decision` event records the model and the map's `fittedFor`. A policy can require them to agree (PD4.3), so a model without its own fitted map cannot act on a gated decision.
- **PD3.2b** The certificate's `decisions` section lists, per decision, the result domain, the confidence and margin partitions of PD1.4b, the labels, and `modelBound: false`. The calibration map is listed as runtime configuration, not bound.

### PD3.3 Correctness and quality are separate

The certificate says what the system may do with any answer. It does not say how good the answers are. Quality is measured by evaluation: replaying recorded questions against a candidate model, off the step path, and comparing its answers with the adjudicated outcomes of PD2.4. The same data fits the candidate's calibration map. Polytrion and Polyx are the natural hosts. Evaluation can block a swap by policy; it never changes a verdict.

### PD3.4 Acceptance (M4)

- **PD3-A1** Swapping the router's provider configuration from one model to another changes no file under `.poly/build` and leaves the certificate's digest unchanged.
- **PD3-A2** *(Moved to M5 with PD4, S131.)* With the policy of PD4.3, the new model cannot take a gated refund decision until a map fitted for it is installed; after that it can, and its `decision` events record the new map.
- **PD3-A3** An evaluation over 100 recorded router questions with outcomes reports agreement and calibration for the candidate model, and writes nothing to any run's chain.

## PD4. Operating modes

### PD4.1 The problem

The paper, after the Cynefin framework, describes a business that moves between complicated, complex and chaotic conditions and needs different rules for automated action in each. In chaotic conditions it wants fewer actions without a person. In poly, the rules for automated action are policies, and stakes are expressed by effect class and labels. What is missing is a mode the policies can depend on, changed only by people.

### PD4.2 The mode machine

```poly
enum Mode { Normal, Complex, Crisis }

service machine OpsMode {
  state { mode: Mode = Normal }
  action Declare(mode: Mode)
  on Declare(m) { mode' = m }
}
```

- **PD4.2a** `Declare` is dispatched only with a person's signature (PT12.5). An unsigned `Declare` is refused at dispatch, and the signer is journaled.
- **PD4.2b** The gate reads the current mode through PT8.3 (`machine("ops.OpsMode").mode`), like any program state.

### PD4.3 Mode-dependent policy

Rules name the decision they read, `decision("route")`, which denotes the most recent `decision` event for `route` on the emitting instance's run.

```poly
policy autonomy {
  scope "support"

  obligation calibrated-for-model "A gated decision acts only with a map fitted for its model." rule {
    when effect.class in { "compensable", "irreversible" } && decision("route").taken
    require decision("route").calibration.fittedFor == decision("route").model.reported else escalate
    on unknown escalate
  }

  obligation refund-by-mode "Refunds need a person below the mode's confidence floor." rule {
    when effect.kind == "payments.refund"
    require (machine("ops.OpsMode").mode == Normal  && decision("route").conf >= 0.8)
         || (machine("ops.OpsMode").mode == Complex && decision("route").conf >= 0.9) else escalate
    on unknown escalate
  }

  obligation crisis-irreversible "In a crisis, every irreversible effect needs a person." rule {
    when effect.class == "irreversible" && machine("ops.OpsMode").mode == Crisis
    require false else escalate
  }
}
```

- **PD4.3a** `decision("d").taken` is true iff the run has a `decision` event for `d`. Any other field of `decision("d")` read for an effect with no such event evaluates as unknown (PS8.2), and the rule's `on unknown` applies.
- **PD4.3b** The constants a policy compares a decision's confidence with join that decision's partition (PD1.4b). Admitting a policy with a new constant therefore changes the check, as PT8.4 already orders.

### PD4.4 What is checked

- **PD4.4a** **Consistency per mode.** Obligation consistency (PT8.5) is checked for each value of the mode, so no mode has contradictory obligations.
- **PD4.4b** **Every mode can finish the work.** For each mode, dischargeability (PS8.6, a possibility property) is checked with the mode held fixed: every task the machine can start still has some path to completion, with escalations counted as allowed once approved. A mode that blocks all work is `PL6501 UNDISCHARGEABLE_MANDATE`, naming the mode.
- **PD4.4c** **Escalation stays bounded.** The escalate-once rule and its timeout (PT9.7 rule 2) hold in every mode.

### PD4.5 Acceptance (M5)

- **PD4-A1** The gate allows a refund at confidence 0.91 in `Normal`, escalates it in `Crisis`, and records the mode in its `verdict` event.
- **PD4-A2** A policy that denies every effect of the refund flow in `Crisis`, with no escalation, is reported `PL6501` naming `Crisis`.
- **PD4-A3** An unsigned `Declare` is refused, and a signed one is journaled with its signer.

## 5. New codes and assumptions

| Id | Meaning | Item |
|---|---|---|
| `PL1205 CONFIDENCE_NOT_COMPARED` | A `Conf` value is used other than by comparison with a constant or as a completion argument. | PD1.3b |
| `PL6201 UNGATED_DECISION` | For some answer, at every interval, an accepted completion can emit a compensable or irreversible effect. A finding. | PD1.4d, S85 |
| `PL6202 DECISION_WITHOUT_FAILURE` | A decision declares no `timeout` or no `failed` completion. | PD1.2c |
| K10 | A decision's answer is fixed by its recorded event, not by its request. | PD2.3 |

Every other diagnostic reuses an existing code: `PL1101`, `PL1201`, `PL1501`, `PL6501`, and the dispatch rejection `outside-check-domain`.

## 6. Open questions

1. **Comparing two confidences.** Routing to the more confident of two decisions needs a partition over pairs. It is computable, but it is not small, so PD1.3b refuses it for now.
2. **Adjudication across runs.** A complaint filed a week later, on another run, adjudicates a decision it did not see. PD2.4 is limited to the same run.
3. **Where the mode machine lives.** One mode per organisation, per domain or per trust scope. The syntax works for all three; the policy names the machine it reads.

## Conclusion

A model's decision enters poly as a typed input with a finite domain, so the checker explores every answer the model can give without calling it. Confidence is explored exactly, by the intervals the program actually compares, and it means something stable because each decision carries a calibration map fitted on its own adjudicated outcomes. The runtime records each decision with the step that used it, in one transaction, so a run can be explained as well as replayed, and outcomes flow back as the labels that calibration and evaluation need. The verdicts are independent of the model; the program's meaning survives a model swap only through a new map, and policy can require it. Operating modes let people change how much the system may do alone, and the policy checks confirm that every mode is consistent and still lets the work finish.
