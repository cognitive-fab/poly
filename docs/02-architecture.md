# poly · Architecture

*Cognitive Fab · September 2026 · draft v0.1 · specification only, no code*

This document describes how poly is built from the engines of the Poly stack. What poly must do is in [`01-functional-spec.md`](01-functional-spec.md) (`PF` ids). The grammar, semantics and formats are in [`03-technical-spec.md`](03-technical-spec.md) (`PT` ids). Facts about the existing engines come from [`research/primitive-inventory.md`](research/primitive-inventory.md).

## 1. The architecture in one paragraph

A poly module is compiled to the artefact family the Poly engines already read. The checker then runs those engines in a fixed order and folds their verdicts into one diagnostic model. An admitted module carries a certificate binding its source digest to its artefact digests and its check results. The runtime loads only certified artefacts. It executes them on the polyrun kernel, with every effect passing the Polyaxion gate, and writes a single hash-chained ledger. That ledger is the input to the next check, to Polyx mining, to polyness proposals and to Polytrion twins.

## 2. Design principles

| Id | Principle | Consequence |
|---|---|---|
| PA0.1 | **Lower, never reimplement.** | poly has no model checker, simulator, gate or miner of its own. A new semantic need is a change to an engine, made in that engine's repository. |
| PA0.2 | **The checked program is the running program.** | The runtime executes the lowered `next.cjs` the checker checked. The certificate binds them by digest, and a digest mismatch refuses the load. |
| PA0.3 | **One source per machine.** | Contract, module, invariants, effects, manifest, emission invariants and migration are derived. None is edited by hand. |
| PA0.4 | **No silent clean.** | Every check reports `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED` or `INCONCLUSIVE`. A check that did not run is listed as not run. |
| PA0.5 | **No model call on a check or decision path.** | Language models may draft source (`poly new`) and explain findings. They never decide a verdict or a gate decision. |
| PA0.6 | **The journal is the corpus.** | Runtime journals use the trace window format, so they feed every design-time engine unchanged. |
| PA0.7 | **Respect the engine boundary.** | Public engines ship with the toolchain. A check that needs a private engine (Polytrion) is reported as not run when that engine is unavailable. |

## 3. Layers

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ AGENT INTERFACE    CLI · MCP server · language server · Claude Code plugin │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ LANGUAGE           parser · formatter · type and domain checker ·          │
 │                    canonical AST (content-hashed) · diagnostics model       │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ LOWERING           machine → contract.json, next.cjs, invariants.mjs        │
 │                    effects → effects.cjs, effects.manifest.json,            │
 │                              effect-invariants.mjs                          │
 │                    compose → invariants.compose.mjs                         │
 │                    policy → polyaxion.policy.json                           │
 │                    workflow → polyflow.workflow.json (six-file workflow)    │
 │                    world → topology.json, responders.mjs, drivers.mjs       │
 │                    version → migrate.cjs                                    │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ CHECK              strict validate · polygraph model check · check-effects  │
 │ (existing engines) check-product · polyaxion compile + admission ·          │
 │                    polycheck · polyvers · polynv · polygraph replay ·       │
 │                    Polytrion experiment (optional, hosted)                  │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ADMISSION          certificate {source, artefacts, checks, domains} signed  │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ RUNTIME            polyrun kernel (dispatch, journal, outbox, timers,       │
 │ (existing engines) children) · Polyaxion gate on every effect ·             │
 │                    polyflow / polycrew work orders · Polyx advisor          │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ LEDGER             one hash-chained, signed ledger · trace export           │
 └────────────────────────────────────────────────────────────────────────────┘
                 │ traces, snapshots, agent journals
                 ▼
  replay corpora · polyvers corpus · polynv drift · Polyx mining ·
  polyness proposals · Polytrion twin
```

## 4. The lowering map

Every construct has one target artefact and one or more engines that read it. The lowering is total: every construct in the grammar has a row.

| poly construct | Lowered artefact | Read by | Existing format |
|---|---|---|---|
| `machine`, `state`, `action`, `terminal` | `contract.json` | every engine | `stateKeys`, `actions`, `dataDomain`, `initState`, `terminalStates` |
| `on Action { require … else reject …; field' = … }` | `next.cjs` (SAM v2 strict: named intents, sealed `modelShape`, keyed acceptors, `reject`, `next`, `unchanged`) | polygraph, polyrun, polyflow, Polytrion, polyaxion | `module.exports = { instance, init, actions, getState, setState }` |
| `invariant`, `step invariant`, `reject invariant` | `invariants.mjs` | polygraph, polynv, polyvers, Polytrion monitors | `stateInvariants`, `transitionInvariants`, `rejectionInvariants` |
| `emit`, `after`, `cancel`, `spawn`, `signal` | `effects.cjs` (pure mapper) | polyrun, polyflow | built-in `timer`, `cancelTimer`, `spawnChild`, `signalChild` plus manifest kinds |
| `effect Kind { … }` | `effects.manifest.json` | polyrun, polyflow, Polyaxion (labels) | `payloadSchema`, `onSuccess`, `onFailure`, `onExhausted`, `retry` |
| `emits invariant` | `effect-invariants.mjs` | polyrun `check-effects`, polyflow admission | `effectInvariants:[{name, pred(path)}]` |
| `compose invariant` | `invariants.compose.mjs` | polyrun `check-product` | joint state and stimulus predicates |
| `policy`, `obligation` | `polyaxion.policy.json` (version 2) | Polyaxion compile, admission, gate; polycheck regions | `rule`, `machine`, `invariant`, `recalled` kinds |
| effect `labels`, `class` | manifest fields + Polyaxion label catalogue | Polyaxion, polycheck | closed label vocabulary |
| `workflow` | `polyflow.workflow.json` with the five machine files | polyflow, polycrew | name, input action, tools, key template |
| `world` | `topology.json`, `responders.mjs`, `drivers.mjs`, `probes.mjs` | Polytrion | Polytrion world layout |
| `version N from M { migrate … }` | `migrate.cjs` | polyvers, polyrun deploy gate | pure `migrate(oldState)` |
| `check` domains | `dataDomain` + certificate `domains` | polygraph, polynv | disclosed assumptions |

Two constructs have no artefact of their own:

- **Frames.** The compiler derives `unchanged(...)` from the fields a handler does not write (PF1.5). This removes the class of `SamFrameError` and `rejectAfterWrite` mistakes from agent-written code.
- **Rejection reasons.** Each `else reject "reason"` becomes a named reason in the module and a vocabulary entry for polyvers, which treats renaming a reason as a breaking change.

## 5. The check pipeline

`poly check` runs the stages below in order. A stage that cannot run because an earlier stage refused is listed as not run. Stages 1 to 8 use public engines. Stage 9 needs the hosted Polytrion.

```
source ─► 0 parse, type, domain ─► lower ─► 1 strict validate
                                               │
          ┌────────────────────────────────────┘
          ▼
   2 model check (polygraph BFS over declared domains, invariants, rejection invariants)
   3 emission admission (polyrun check-effects over effect-invariants)
   4 composition (polyrun check-product over invariants.compose)
   5 policy admission (polyaxion compile → triple → harden, fullyMediated)
   6 capability proof (polycheck regions over effect labels and agent tools)
   7 version gate (polyvers lanes, when --since or live snapshots are given)
   8 replay (polygraph replay with controls, when --against traces are given)
   9 world experiment (Polytrion, when a world and a hosted engine are declared)
          │
          ▼
   fold ─► verdict + diagnostics + witnesses ─► certificate (if CLEAN or accepted exceptions)
```

**Folding rule.** The module verdict is the worst stage verdict, in the order `REFUSED` > `FINDINGS` > `INCONCLUSIVE` > `UNDERPOWERED` > `CLEAN`. A stage that is not run does not lower the verdict. It is listed in the certificate under `notRun`, with the reason.

**Adequacy.** `poly grade` runs polynv separately, because grading needs mutation runs and a ledger of dispositions. Its grade (`CONVERGED` or `PARTIAL`) is recorded in the certificate but does not block admission unless the project sets `require.grade`.

**Exceptions.** A finding may be accepted by a person, never by an agent. This mirrors the polygents gate rule, "an agent cannot move a decision toward pass". An acceptance is recorded in the certificate with the finding digest and the approver.

## 6. Admission and the certificate

The certificate reuses the polyflow platform certificate shape, `{ v, subject, artefacts, guarantees, checks, domains, boundAccepted, toolchain, issuedAt, buildId, signatures, digest }`, with three additions:

- `source`: the canonical AST digest of each module;
- `notRun`: the stages not run, with reasons;
- `exceptions`: the accepted findings.

The runtime verifies the certificate before loading:

1. **Signatures.**
2. **Artefact digests** against the files on disk.
3. **Toolchain** against the runtime's engine versions, as a declared compatibility range.

Any mismatch refuses the load, with a diagnostic (PF8.1).

## 7. The runtime

### 7.1 One step

The kernel is polyrun, unchanged. A step is one atomic transaction over:

- the snapshot;
- the journal entry;
- the outbox;
- the timers;
- the dedupe key.

```
host / agent / timer / completion
        │ dispatch(instance, action, data, actionId)
        ▼
   polyrun kernel ── acceptor (lowered next.cjs) ── accepted | rejected | unhandled
        │ one transaction: snapshot · journal · outbox · timers · dedupe
        ▼
   outbox worker ── effect intent {kind, payload, labels, class, idempotencyKey}
        │
        ▼
   Polyaxion gate: PROPOSE(effect as action with labels) ── allow | deny | escalate
        │ allow                               │ deny / escalate
        ▼                                     ▼
   handler (host code, at-least-once)    dispatch declared failure action
        │                                     with reason and witness digest
        ▼
   SETTLE {observed} ─► completion dispatch (ok | failed | exhausted)
        │
        ▼
   ledger: step · proposal · verdict · effect · observation (hash-chained, signed)
```

### 7.2 The new integration: kernel meets gate

polyrun already executes effects at least once, with idempotency keys, a dead-letter queue and completion actions. Polyaxion already mediates tool calls in two phases:

- **PROPOSE** before the call;
- **SETTLE** after it.

poly connects the two at the outbox worker. Each effect intent is proposed to the gate as an action carrying its labels and class. The handler runs only on allow, and its observed result is settled back.

This is the only engine integration poly requires that does not exist today. It is specified in PT9.

The gate also sees the program's own state. The session state Σ is extended with the instance snapshot. This lets an obligation refer to machine states (PF4.3).

### 7.3 One ledger

Today there are three journals:

| Engine | Journal |
|---|---|
| polyrun | `pr_journal` |
| Polyaxion | `px_window` with receipts |
| polyflow platform | ledger events (`admission`, `proposal`, `verdict`, `effect`, `observation`, `closure`) |

poly writes one ledger, in the polyflow platform event format, which is already hash-chained and signed. polyrun journal rows and Polyaxion windows become event kinds in that ledger. Trace export projects the ledger onto `{pre, action, data, post}` windows. Receipt verification uses Polyaxion's four checks: signature, chain, binding and replay.

**Open decision (AD-3).** The ledger could instead stay as two stores joined by digest. Section 11 gives the options.

## 8. Three kinds of program, one runtime

| Program kind | Declared with | Hosted by | Effects become | Gate mounted on |
|---|---|---|---|---|
| **Application core** | `machine` | the host process, through the TypeScript runtime API | host handlers | the outbox worker |
| **Agent workflow** | `workflow` | the polyflow gateway (single agent) or the polycrew broker (several participants), over MCP | work orders claimed by an agent or a person | work-order issue and report |
| **Agent policy** | `policy` | the Polyaxion daemon mounted on the agent harness (Claude Code hooks, MCP wrap, Agent SDK, Vercel AI SDK, NVIDIA NAT, OpenShell middleware) | the agent's own tool calls | every tool call |

All three are checked by the same pipeline and journaled in the same ledger format. A coding agent can therefore work inside a workflow written in poly, governed by a policy written in poly, while writing application code in poly. One ledger holds all three.

## 9. Where Polyx plugs in

The Polyx advisor answers `recommend`, `warn` or `abstain` from rules a person has adjudicated `real`. poly consults it at two points:

- when a workflow issues a work order (the advice travels with the order);
- when the gate receives a proposal (the advice is attached to the decision record).

**The guarantee.** Advice never changes a transition or a gate decision. It is recorded, delivered to the participant, and journaled.

This extends the Polyx safety invariant (JF7: no warning withdrawn, no abstention created by observation) to the runtime. The advisor has no write path into Σ or into any machine.

**The promotion path.** A Polyx rule becomes enforceable only by promotion: `poly mine` emits it as a proposed poly obligation, a person adjudicates it, and it is admitted through the pipeline like any other obligation. The Polyx obligation patterns map onto rule kinds that already exist:

| Polyx pattern | polyflow platform G1 rule / Polyaxion rule |
|---|---|
| `no-X-without-prior-Y` | `requires-prior` |
| `X-implies-prior-Y` | `implies-prior` |
| `at-most-one-X` | `at-most` |
| `no-X-unless-state` | machine obligation guard over the declared state |

## 10. The agent interface

The command line, the MCP server and the language server are three transports over one command set (PF9.1). Every result has a JSON schema (PF9.2).

```
 describe ─► poly new (polygen drafts source) ─► edit ─► poly check
     ▲                                                     │
     │                     FINDINGS: diagnostic + witness + typed fixes
     │                                                     │
     └──── poly explain ◄──── apply fix / edit ◄───────────┘
                                                           │ CLEAN
                                                           ▼
            poly test (exported witnesses + replay) ─► poly admit ─► poly deploy
                                                           │ (version gate vs live)
                                                           ▼
                                          runtime ─► ledger ─► poly export / mine / twin
```

The Claude Code plugin packages this loop as a skill with commands (`/poly:new`, `/poly:check`, `/poly:explain`, `/poly:admit`), following the polygraph plugin. The existing polygraph, polyflow and Polyaxion plugins keep working. poly adds a front end; it does not replace them.

## 11. Architectural decisions

| Id | Decision | Options | Proposed |
|---|---|---|---|
| AD-1 | Canonical form of source | (a) text canonical, AST derived; (b) AST canonical, text as projection, patched by hash-guarded operations as in Zero [1] | (a) for v1, with a canonical formatter and an exported AST. Revisit after the first experiment measures agent edit failures. |
| AD-2 | Expression language inside handlers | (a) a total, side-effect-free subset of TypeScript expressions; (b) a new expression language | (a). It lowers directly to JavaScript, and agents already write it. |
| AD-3 | Ledger | (a) one ledger in the polyflow platform format; (b) keep `pr_journal` and `px_window`, joined by digest | (a). It gives one replay path and one verification tool. |
| AD-4 | Gate placement for application effects | (a) in the outbox worker, in process; (b) in a Polyaxion daemon over a socket | (a) for latency, with (b) available when the operator runs a shared daemon. |
| AD-5 | Host languages | TypeScript first; Python through the existing polyflow platform Python ports | TypeScript for v1. |
| AD-6 | World lowering in the public toolchain | (a) emit world artefacts publicly, run them only on hosted Polytrion; (b) keep world syntax private | (a), consistent with PA0.7. |
| AD-7 | Licence | follow each engine's licence; the language and compiler under one licence | Open question for the owner (section 13). |

## 12. What changes in existing repositories

The aim is to change the engines as little as possible.

| Repository | Change | Why |
|---|---|---|
| polygraph / polyrun | A gate hook in the outbox worker. The ledger writer as a store option. | Section 7.2 and AD-3. |
| polyaxion | Accept an instance snapshot in Σ. A proposal kind for effect intents. | PF4.3 and PF8.4. |
| polyflow | Load a workflow from lowered artefacts. This is already the six-file format, so no change is expected. | PF5. |
| polyx | An exporter from an adjudicated rule to a poly obligation. | PF4.4. |
| polyness | Emit proposals as poly source as well as the six files. | PF10.3. |
| Polytrion | None. Worlds arrive in the existing layout. | PF6.2. |

## 13. Open questions for the owner

1. **Name and file extension.** `poly` and `.poly` are assumed throughout.
2. **Licence.** Options for the compiler, runtime package and language specification:
   - Apache-2.0, like polygraph and polyflow's kernel;
   - BUSL-1.1, like Polyaxion and Polyx.
3. **Canonical form (AD-1).** Should the canonical form change after the first experiment?
4. **Programs across repositories.** Should a module be allowed to import machines from another repository, and how are certificates composed in that case?

## 14. Conclusion

poly is a thin architecture by design. It has four layers of its own:

- a language layer;
- a lowering layer;
- a verdict fold;
- a certificate.

Every other layer is an existing engine. Only two integrations are new: the gate in the outbox worker and the single ledger. Everything else is a mapping from a construct to an artefact an engine already reads. This keeps the claims of each engine intact. poly checks nothing the engines do not check, and it runs nothing the checker did not see.

## References

1. InfoQ, "Vercel Labs Ships Zero: a Graph-First Language Built So Agents ...". https://www.infoq.com/news/2026/08/vercel-ships-zero-ai/
2. [`research/primitive-inventory.md`](research/primitive-inventory.md): the source of every engine format cited in this document.
