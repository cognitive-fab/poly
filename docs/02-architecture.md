# poly · Architecture

*Cognitive Fab · October 2026 · v1.1.0 · built and tagged (`v1.1.0`, commit `dedf8945`)*

The meaning of poly programs is defined in [`04-semantics.md`](04-semantics.md). v0.2 to v0.6 answered the five reviews in [`reviews/`](reviews/). This revision brings the document to the code as it stands at v1.1.0. Where the code differs from the earlier design, the text below states the code and cites the file. What the design names and the code does not build is collected under "Planned, not in v1.1" (section 13a).

This document describes how poly is built from the engines of the Poly stack. What poly must do is in [`01-functional-spec.md`](01-functional-spec.md) (`PF` ids). The grammar, semantics and formats are in [`03-technical-spec.md`](03-technical-spec.md) (`PT` ids). Facts about the existing engines come from [`research/primitive-inventory.md`](research/primitive-inventory.md).

## 1. The architecture in one paragraph

A poly module is compiled to the artefact family the Poly engines already read. The checker then runs those engines in a fixed order and folds their verdicts into one diagnostic model. An admitted module carries a certificate binding its source digest to its artefact digests and its check results. The runtime loads only certified artefacts. It executes them on the polyrun kernel, with every effect passing the Polyaxion gate, and writes a ledger chained per run. That ledger is the input to the next check, to Polyx mining, to polyness proposals and to Polytrion twins.

## 2. Design principles

| Id | Principle | Consequence |
|---|---|---|
| PA0.0 | **The semantics is the definition.** | 04-semantics defines what a program means. The lowering is correct when it agrees with it (PS9), and every `poly check` verifies that agreement for the program at hand. |
| PA0.0a | **One program, three interpreters.** | A machine is a pure step function. Checking (polygraph, poly-ref), simulation (Polytrion, v2) and running (the runtime) are three interpretations of one environment interface over it: all inputs, sampled inputs, real inputs (PS4.1a). "The checked program is the running program" is a theorem about two of them (PS4.1b). |
| PA0.1 | **The engines check single machines; poly checks how machines relate.** | Safety of single machines, emission and composition of attached children, governance, simulation and mining stay in the engines, and a new need there is a change to that engine. poly has its own model checker, `poly-ref`. It checks the lowering against the semantics, deadlock freedom, liveness under fairness, and configurations of communicating machines. These are the checks that concern how machines relate over time, and no engine performs them today. poly-ref is the part of poly most likely to have bugs of its own, so the independent evidence explorations are its first acceptance tests. If polygraph gains any of these checks, poly defers to it. |
| PA0.0b | **Machines talk only by messages.** | A machine holds addresses (`Ref<M>`), not other machines' state. `send` is the only way to affect a peer, and `emit` is a send to a capability's address. The checked unit for interacting machines is a configuration, explored with messages arriving in any order (PS13). |
| PA0.2 | **The checked program is the running program, over its check domains.** | The runtime executes the lowered `next.cjs` the checker checked. The certificate binds them by digest, and a digest mismatch refuses the load. Inputs outside a `strict` check domain are rejected at dispatch; inputs outside a `disclosed` domain are accepted and journaled as drift, and the certificate lists those fields (PT3.4). |
| PA0.3 | **One source per machine.** | Contract, module, invariants, effects, manifest, emission invariants and the other lowered files (section 4) are derived. None is edited by hand. |
| PA0.4 | **No silent clean.** | Every check reports `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED` or `INCONCLUSIVE`. A check that did not run is listed as not run, and admission refuses a build that has one (section 6, `packages/poly-check/src/admit.ts:262`). |
| PA0.5 | **No model call on a check or decision path.** | Language models may draft source (`poly new`) and explain findings. They never decide a verdict or a gate decision. |
| PA0.6 | **The journal is the corpus.** | Runtime journals use the trace window format, so they feed every design-time engine unchanged. |
| PA0.7 | **Respect the engine boundary.** | Public engines ship with the toolchain. A check that needs a private engine (Polytrion) is reported as not run when that engine is unavailable. |

## 2a. Scope: what is new, what changes, what stays

poly adds no new checking, simulation or governance engine. It is still a substantial build: a compiler, a toolchain and one runtime integration. The table is the full extent.

| Category | Item | Size class |
|---|---|---|
| **New code** | `poly-core`: AST with node ids and digests, types (with tagged unions and `Tri`), domains | compiler core |
| | Two surfaces over `poly-core`: the standalone syntax (lexer, parser, canonical formatter) and the embedded TypeScript surface (`poly-embed`). The experiment decides which is primary; the other may leave v1 scope | compiler front ends |
| | Handler capability objects and the handler lint (PT6.5); OpenShell policy generation from labels (opt-in) | runtime and toolchain |
| | Type and domain checker, flow analysis for `strict` defaults | compiler |
| | Lowering to the artefact files of section 4: the contract, the module, the invariants, the effects mapper and manifest, the path and compose invariants, `liveness.mjs`, `types.d.ts` and, under `isolation`, `openshell.policies.yaml`, plus the policy, workflow, channel, credential, source, flow, route and budget files (`packages/poly-lower/src/lower.ts:33`) | compiler back end |
| | Verdict fold, diagnostic model, node-addressed fixes, witness export | toolchain |
| | Certificate format, signer and verifier, person keyring | toolchain |
| | Runtime host: certificate check at load, an effect worker that hosts the `OutboxIntent` machine with the gate interface (S119), per-run ledger writer in the step's transaction (S121), anchors | runtime |
| | The outbox intent machine (PT9.7), written in poly | runtime model |
| | `poly-ref`, poly's model checker: a reference interpreter written from 04-semantics; translation validation, deadlock, liveness (with per-value fairness and oldest-copy delivery), configuration exploration (arrival-order nondeterminism, declared bounds), possibility checks for obligation consistency | model checker (PA0.1) |
| | The `Delivery` machine (PT9.8) and the `OutboxIntent` machine (PT9.7), both written in poly and checked; the runtime conforms to them by trace replay (K8) | runtime models |
| | CLI, MCP server, language server, workflow server (`poly run --mcp`), and a Claude Code plugin made of a skill, the MCP and language servers, all as configuration (`adapters/claude-code/.claude-plugin/plugin.json`) | agent interface |
| | `poly-io` (the only network code, S182), `poly-new` (model drafting), `poly-mine` (the seam that starts polyx and polyness), and the feedback commands that read journals and signed verdicts (`mine`, `adjudicate`, `promote`, `propose`, `verdict`, `refit`) | tools and feedback |
| **Changed code in engines** | polyrun: a `sendTo` built-in intent beside `spawnChild` and `signalChild` (M3); tombstones that keep dedupe keys at archive (E1, K4); shard placement by attached-tree root. poly vendors polygraph and polyrun 8.4.0 unchanged from branch `e13-create-instance` at commit 755ac09, which adds the `createInstance` intent (`vendor/polygraph/PROVENANCE.md:3`). The gate hook and the ledger store option are not needed: poly-runtime hosts its own effect worker and subclasses polyrun's store (S119, S121) | small, specified in PT7a, PT9 and PT16 |
| | polyflow kernel and verifier: the ledger kinds `step`, `advice`, `decision` and `outcome` (E2). **Pending at v1.1.0:** the vendored polyflow refuses these four kinds, so poly verifies its own chain by the same rules over the ten kinds, and `polyflowAcceptsPolyKinds` reports when E2 is vendored (`packages/poly-runtime/src/ledger.ts:5-6`, `:57`; `vendor/polyflow/PROVENANCE.md`) | small, PT16 |
| | polyaxion: an `effect` proposal kind that carries the emitting-step snapshot | small, PT9.1 and PT9.3 |
| | polyx and polyness are not changed. They are separate tools that poly pins by digest and runs by path through `poly-mine` (section 9). poly itself turns an adjudicated rule into an obligation (`poly promote`) and reads polyness's rules by four fixed text templates into poly source (`poly propose`) | none in the tools; poly-side code, PT30 and PT31 |
| **Unchanged** | polygraph model check, `check-effects`, `check-product`, polycheck (pinned in `peers/polycheck`), polyflow and polycrew tools, Polytrion. polynv and polyvers are not used (section 13a) | none |

## 3. Layers

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ AGENT INTERFACE    CLI · MCP server · language server · workflow server ·  │
 │                    Claude Code plugin (skill + MCP + LSP, configuration)   │
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
 │                    also → liveness.mjs, types.d.ts, openshell.policies.yaml,│
 │                           channel, credential, source, flow, route, budget  │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ CHECK              strict validate · polygraph model check · check-effects  │
 │ (existing engines) check-product · polyaxion compile + admission ·          │
 │ + poly-ref         polycheck · poly-ref (translation validation, deadlock,  │
 │                    liveness, configurations, cross-checks of the engines)   │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ADMISSION          certificate {source, artefacts, checks, domains} signed  │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ RUNTIME            polyrun kernel (dispatch, journal, outbox, timers,       │
 │ (existing engines) children) · Polyaxion gate on every effect ·             │
 │                    polyflow work orders (served by poly-runtime)            │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ LEDGER             chained per run, signed heads, periodic anchor · export  │
 └────────────────────────────────────────────────────────────────────────────┘
                 │ traces, snapshots, agent journals
                 ▼
  trace corpus (poly export traces) · polyx mining · polyness proposals,
  both run by poly-mine · (v2: Polytrion twin)
```

**Three boundary rules the earlier design did not state.** `scripts/check-boundaries.mjs` reads every source in CI and fails on a crossing of these lines (a file that cannot be read is an error, never a pass):

1. **Network code lives in poly-io alone** (S182). The check packages (`poly-core`, `poly-lang`, `poly-lower`, `poly-ref`, `poly-embed`, `poly-check`, `poly-agent`) never import it; poly-io imports the runtime's adapter interface as types only; outside poly-io no package imports an npm package other than poly's own, the vendored engines and typescript, uses a socket global or names a network module in a string (`check-boundaries.mjs:11-13` and `:51-52`).
2. **Only `poly-new` and `poly-mine` may start a process** (S507). poly-new starts Claude Code headless. poly-mine starts exactly polyx and polyness, with `execFileSync`, a fixed argument vector and a fresh environment (`:21-28`). No other package imports `node:child_process` or a worker module.
3. **A host-neutral core with configuration-only adapters** (S167). No package names a host or imports a host's SDK; what a host launches lives under `adapters/<host>/` as `.json` and `.md` files and declares no hooks (`:17-20`, and the launch list at `:65-70`).

A fourth rule is the first in the file: poly-ref shares no code with the compiler. It may import node builtins, its own files and sam-pattern, and from `@poly/core` types only (`import type`, erased at compile time); it never imports `@poly/lang`, `@poly/lower`, `@poly/embed` or `@poly/check` (`:1-12`).

## 4. The lowering map

Every construct has one target artefact and one or more engines that read it. The lowering is total: every construct in the grammar has a row.

| poly construct | Lowered artefact | Read by | Existing format |
|---|---|---|---|
| `machine`, `state`, `action`, `terminal` | `contract.json` | every engine | `stateKeys`, `actions`, `dataDomain`, `initState`, `terminalStates` |
| `on Action { require … else reject …; field' = … }` | `next.cjs` (SAM v2 strict: named intents, sealed `modelShape`, keyed acceptors, `reject`, `next`, `unchanged`) | polygraph, polyrun, polyflow, Polytrion, polyaxion | `module.exports = { instance, init, actions, getState, setState }` |
| `invariant`, `step property`, `reject property` | `invariants.mjs` | polygraph, poly-ref, Polytrion monitors (v2) | `stateInvariants`, `transitionInvariants`, `rejectionInvariants` |
| `emit`, `after`, `cancel`, `spawn`, `signal` | `effects.cjs` (pure mapper) | polyrun, polyflow | built-in `timer`, `cancelTimer`, `spawnChild`, `signalChild` plus manifest kinds |
| `effect Kind { … }` | `effects.manifest.json` | polyrun, polyflow, Polyaxion (labels) | `payloadSchema`, `onSuccess`, `onFailure`, `onExhausted`, `retry` |
| `path property` | `effect-invariants.mjs` | polyrun `check-effects`, polyflow admission | `effectInvariants:[{name, pred(path)}]` |
| `compose invariant` | `invariants.compose.mjs` | polyrun `check-product` | joint state and stimulus predicates |
| `policy`, `obligation` (in `.policy.poly` files) | `polyaxion.policy.json` (version 2) | Polyaxion compile, admission, gate; polycheck regions | `rule`, `machine`, `invariant`, `recalled` kinds |
| effect `labels`, `class` | manifest fields + Polyaxion label catalogue | Polyaxion, polycheck | closed label vocabulary |
| `workflow` | `polyflow.workflow.json` with the five machine files | polyflow, polycrew | name, input action, tools, key template |
| `world` (deferred to v2) | `topology.json`, `responders.mjs`, `drivers.mjs`, `probes.mjs` | Polytrion | Polytrion world layout |
| `version N from M { migrate … }` | planned, not built: the machine header parses `version N` (`packages/poly-lang/src/parser.ts:923`) and nothing lowers a migration (section 13a) | | |
| `check` domains | `dataDomain` + certificate `domains` | polygraph | disclosed assumptions |

Every row is checked, per program, by translation validation against 04-semantics (PS9.3). Liveness properties and the deadlock check have no engine artefact; poly-ref checks them.

**The full artefact list.** The table above is the core. The lowering also writes the files below (`Lowered.files`, `packages/poly-lower/src/lower.ts:33`), and the certificate covers the build files by digest (`CERTIFIED_ARTEFACTS`, `packages/poly-core/src/certificate.ts:12`):

- `liveness.mjs`, the liveness properties (`lower.ts:374`);
- `types.d.ts`, the declarations that host code compiles against (`lower.ts:259`);
- `openshell.policies.yaml`, one OpenShell sandbox policy per effect kind, written only when `poly.json` sets `isolation: "openshell"` (`lower.ts:268`);
- per module, the channel (`../channels/`), credential (`../credentials/`), source (`../sources/`), flow (`../flow/`), route (`../routes/`) and budget (`../budgets/`) files, and per workflow `../workflows/<name>/polyflow.workflow.json`.

Every artefact the runtime reads is compared with the source, either by translation validation or by a round-trip read-back (`packages/poly-ref/src/artefacts.ts`). `migrate.cjs` is named in the certified list and nothing produces it (S570, `docs/decisions-v1.md`).

Two constructs have no artefact of their own:

- **Frames.** The compiler derives `unchanged(...)` from the fields a handler does not write (PF1.5). This removes the class of `SamFrameError` and `rejectAfterWrite` mistakes from agent-written code.
- **Rejection reasons.** Each `else reject "reason"` becomes a named reason in the module and a vocabulary entry. When the version gate exists (section 13a), it will treat renaming a reason as a breaking change.

## 5. The check pipeline

`poly check` runs the stages below in order (`packages/poly-check/src/pipeline.ts`, `StageName` at line 38). A stage that cannot run because an earlier stage refused is listed as not run. All stages in v1 use public engines. Stages 7 and 8 of the earlier design are not built and are listed under "Planned, not in v1.1".

```
source ─► 0 parse, type, domain ─► lower ─► 1 strict validate
                                           ─► 1b translation validation (poly-ref vs lowered module, PS9.3)
                                               │
          ┌────────────────────────────────────┘
          ▼
   2 model check (polygraph BFS: invariants, step and reject properties)
   2b deadlock freedom and liveness under stated fairness (poly-ref, PS5.6, PS6)
   3 path properties (polyrun check-effects over effect-invariants)
   4 composition of attached children (polyrun check-product over invariants.compose)
   4b configurations (poly-ref: messages in any order, declared bounds, PS13)
   5 policy admission (polyaxion compile → triple → harden, fullyMediated)
   5b obligation consistency (every mandate dischargeable under all sources, PS8.6)
   6 capability proof (polycheck regions over effect labels and agent tools)
          │
          ▼
   fold ─► verdict + diagnostics + witnesses ─► certificate (if CLEAN or accepted exceptions)
```

**Two implementations, compared.** Stages 2, 3 and 4 do not take an engine's word. polygraph's model check, polyrun's `check-effects` and `check-product` each run on the lowered files, and poly-ref explores the same machine from the semantics. The two must agree: the state counts must be equal when no bound was hit, and each engine finding is replayed by poly-ref (`confirmWitness`) and must be confirmed. Any disagreement is `PL2501`, addressed to the toolchain and not to the author (`pipeline.ts:546`, `:566`, `:685`). A finding whose witness leaves the checked instance is `PL3901`, a bound hit and not a finding (`pipeline.ts:564`).

**Folding rule.** The module verdict is the worst stage verdict, in the order `REFUSED` > `FINDINGS` > `INCONCLUSIVE` > `UNDERPOWERED` > `CLEAN` (`packages/poly-core/src/diagnostics.ts:338`). A stage that is not run does not lower the verdict. It is listed in the report under `notRun`, with the reason, and admission refuses a build that has one (section 6).

**Exceptions.** A finding may be accepted by a person, never by an agent. This mirrors the polygents gate rule, "an agent cannot move a decision toward pass". An acceptance is recorded in the certificate as `boundAccepted`, with the finding digest and the approver. An acceptance covers a finding only: it never covers a check that did not run or a vacuous property (`admit.ts:262`).

## 6. Admission and the certificate

The certificate reuses the polyflow platform certificate shape, `{ v, subject, artefacts, guarantees, checks, domains, boundAccepted, toolchain, issuedAt, buildId, signatures, digest }`, and puts poly's own fields under one key, `poly` (`packages/poly-core/src/certificate.ts:25`):

- `poly.sources` and `poly.moduleDigests`: the source files by digest and the canonical AST digest of each module (this is the earlier design's `source`);
- `boundAccepted`: the findings a person accepted, each with the signed acceptance (this is the earlier design's `exceptions`);
- `poly.instances`, `poly.kernelAssumptions`, `poly.limits` and `poly.assumptions`: the checked instance of each machine, the kernel assumptions, what this runtime does not do, and the liveness assumption with its status;
- `poly.decisions` and `poly.handlers`: the decisions with their providers and calibration, and the handler files with their lint result and package hashes;
- `poly.promotions`, `poly.proposals` and `poly.refits`: the mined rules, proposals and refit records read back at admission.

There is no `notRun` field. **A certificate never records a check that did not run, because admission refuses to issue one.** The only way into a certificate is a build whose every stage ran and came out clean, or whose findings a person accepted: `if (m.notRun.length || m.vacuous.length) throw new AdmitError(…)`, `packages/poly-check/src/admit.ts:262`. The consequence is that a build whose optional stage cannot run cannot be admitted at all.

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
        │ five checks that refuse finally (section 7.2)
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

**Five checks come before the gate.** The gate is not the first thing an effect meets. The worker applies these in a fixed order, and each refusal or escalation is final whatever a policy says (`packages/poly-runtime/src/worker.ts:452-478`):

1. the **origin** of the envelope, and the count of a one-item parameter (PS17.3a, PS17.4b);
2. the **memory** check: the flow rule and freshness of retrieved items (PT10k, PS17);
3. the **budget**: a tier's call or a budgeted decision is read against its budget (PS18.4);
4. the **grant**: the credential grant for the effect (PS16.3);
5. the **mandate**: an effect outside the mandate is denied as `outside-mandate`.

Only an effect that passes all five is proposed to the Polyaxion gate (`PolicyGate.propose`, `packages/poly-runtime/src/policy-gate.ts:257`). A policy can therefore add refusals but can never remove one of these.

This is the only engine integration poly requires that does not exist today. It is specified in PT9.

The gate also sees the program's own state, but only one snapshot of it: the post-state of the step that emitted the effect, carried with the proposal by `seq` and digest. The gate keeps no mirror of application state. This lets an obligation refer to machine states (PF4.3) while every decision stays a function of recorded inputs (kernel assumption K6). Because the gate's session state depends on the order of events across runs, each proposal and settle carries a session sequence number and the digest of the state before it, so a session replays exactly (PS11).

The interleavings of retry, gate decision, handler and settle are themselves specified as a poly machine and model-checked (PT9.7).

Handlers receive **capabilities, not ambient authority** (PT6.5). An effect's labels and declared targets decide which capability objects its handler is given, and a lint rejects handler modules that reach for ambient authority. With the opt-in isolation mode, each effect kind's handlers run in an OpenShell sandbox whose policy is generated from the same labels and targets, so a wrong label fails closed. Labels therefore describe what a handler *can* do, which is what the gate reasons about. One rule matters most: once allowed, an intent is not proposed again for the same idempotency key.

### 7.3 One ledger

Today there are three journals:

| Engine | Journal |
|---|---|
| polyrun | `pr_journal` |
| Polyaxion | `px_window` with receipts |
| polyflow platform | ledger events (`admission`, `proposal`, `verdict`, `effect`, `observation`, `closure`) |

poly writes one ledger, in the polyflow platform event format, which is already hash-chained and signed. polyrun journal rows and Polyaxion windows become event kinds in that ledger. The chain is **per run**, following polyrun's single writer per instance, so the ledger adds no runtime-wide serialisation point. A periodic, signed Merkle anchor over the run heads covers audit periods (PT16). Trace export projects the ledger onto `{pre, action, data, post}` windows. Receipt verification uses Polyaxion's four checks: signature, chain, binding and replay.


## 8. Three kinds of program, one runtime

| Program kind | Declared with | Hosted by | Effects become | Gate mounted on |
|---|---|---|---|---|
| **Application core** | `machine` | the host process, through the TypeScript runtime API | host handlers | the outbox worker |
| **Agent workflow** | `workflow` | `poly run --mcp`, poly-runtime serving polyflow's workflow tools over MCP, under the gate since M8a (S173 to S175); the polycrew broker for several participants is not served in v1 | work orders claimed by an agent or a person | work-order issue and report |
| **Agent policy** | `policy` | the Polyaxion daemon mounted on the agent harness (Claude Code hooks, MCP wrap, Agent SDK, Vercel AI SDK, NVIDIA NAT, OpenShell middleware) | the agent's own tool calls | every tool call |

All three are checked by the same pipeline and journaled in the same ledger format. A coding agent can therefore work inside a workflow written in poly, governed by a policy written in poly, while writing application code in poly. One ledger holds all three.

## 9. Where Polyx plugs in

**What is built.** polyx and polyness are not part of poly. They are separate tools that the project pins by digest, and the package `poly-mine` runs them by path: `execFileSync` only (no shell), a fixed argument vector, an environment built fresh from an allowlist, the pin checked before each start, a timeout and a cap on output (`packages/poly-mine/src/index.ts:63-69` for polyx, `:119-132` for polyness). polyness runs in a temporary home that holds only copied transcripts and is removed afterwards. `poly-mine` and `poly-new` are the only packages that may start a process, and only `packages/poly-check/src/mine.ts` may name `@poly/mine` (`scripts/check-boundaries.mjs`, rule 6).

**The promotion path.** A polyx rule becomes enforceable only by promotion: `poly export traces` writes the corpus, `poly mine` has polyx propose candidate rules, a person signs an adjudication (`real`, `spurious` or `defer`; an agent key never signs one), `poly promote` adds a rule judged `real` to the source under a marker and checks the project (undoing the change if the check refuses it), and admission reads every promotion back (PS19 to PS20, PT29 and PT30). `poly propose` does the same for polyness: poly reads its rules by four fixed text templates and writes poly source and an evidence file, and admission refuses a rule its history does not support (`PL6520`, `PL6521`; PS21, PT31). `poly verdict` and `poly refit` do it for calibration (PS22, PT32). The polyx obligation patterns map onto rule kinds that already exist:

| Polyx pattern | polyflow platform G1 rule / Polyaxion rule |
|---|---|
| `no-X-without-prior-Y` | `requires-prior` |
| `X-implies-prior-Y` | `implies-prior` |
| `at-most-one-X` | `at-most` |
| `no-X-unless-state` | machine obligation guard over the declared state |

The advisor that the earlier design placed in the runtime (advice at work-order issue and at the gate) is not built; it is listed under "Planned, not in v1.1".

## 10. The agent interface

The command line, the MCP server and the language server are three transports over one command set (PF9.1). Every result has a JSON schema (PF9.2).

```
 describe ─► poly new (a model drafts source) ─► edit ─► poly check
     ▲                                                     │
     │                     FINDINGS: diagnostic + witness + typed fixes
     │                                                     │
     └──── poly fix / poly witness ◄── apply fix / edit ◄──┘
                                                           │ CLEAN
                                                           ▼
                                      poly admit (a person's key) ─► poly run
                                                           │
                                                           ▼
                       runtime ─► ledger ─► poly export traces / mine / propose / refit
```

The command registry is `COMMANDS` in `packages/poly-check/src/commands.ts`; `explain`, `grade`, `deploy` and `dispatch` are listed in `NOT_BUILT` (line 603) and are planned.

The Claude Code plugin is built as configuration: `adapters/claude-code/.claude-plugin/plugin.json` launches `poly mcp` and `poly lsp`, and `adapters/claude-code/skills/poly/SKILL.md` is a skill for writing and checking poly. An adapter is JSON and markdown only; `scripts/check-boundaries.mjs` (rule 3) accepts exactly three launches: `poly mcp`, `poly lsp` and `poly run --mcp --project`. The slash commands the earlier design named (`/poly:new`, `/poly:check`, `/poly:explain`, `/poly:admit`) do not exist and are listed under "Planned, not in v1.1". The existing polygraph, polyflow and Polyaxion plugins keep working. poly adds a front end; it does not replace them.

## 11. Architectural decisions

| Id | Decision | Options | Proposed |
|---|---|---|---|
| AD-14 | Which sends the gate sees | (a) none; (b) all; (c) sends that cross a trust scope | (c), since v0.6. A denied send is returned to the sender as `SendDenied`, an ordinary message. |
| AD-15 | Delivery order | (a) always in order; (b) unordered by default, in order where declared `fifo` | (b). The checked `Delivery` machine shows that `fifo` needs the in-order worker, and that exactly-once holds either way. |
| AD-12 | How machines talk to peers | (a) through host code; (b) `Ref<M>` and `send`, checked as configurations | (b), since v0.5. (a) remains possible but is outside every check. |
| AD-13 | Composition of children | (a) atomic cascades only; (b) attached (atomic, co-located) or detached (messages, configuration check) | (b), since v0.5. |
| AD-10 | Surface | (a) standalone syntax; (b) TypeScript-embedded DSL over the same AST | Both are built to M2. The first experiment compares them (PT13, arm 4) and the result picks the primary. |
| AD-11 | Handler authority | (a) labels as claims; (b) capability passing with a lint; (c) a generated OpenShell sandbox per effect kind | (b) by default, (c) opt-in. (a) is removed. |
| AD-1 | Canonical form of source | (a) text canonical, AST derived; (b) AST canonical, text as projection, patched by hash-guarded operations as in Zero [1] | (a) for v1, with a canonical formatter and an exported AST. Revisit after the first experiment measures agent edit failures. |
| AD-2 | Expression language inside handlers | (a) a total, side-effect-free subset of TypeScript expressions; (b) a new expression language | (a). It lowers directly to JavaScript, and agents already write it. |
| AD-3 | Ledger | (a) one ledger in the polyflow platform format, chained per run with periodic anchors; (b) keep `pr_journal` and `px_window`, joined by digest | (a). It gives one replay path and one verification tool, with no global chain. |
| AD-4 | Gate placement for application effects | (a) in the outbox worker, in process; (b) in a Polyaxion daemon over a socket | (a) for latency, with (b) available when the operator runs a shared daemon. |
| AD-5 | Host languages | TypeScript first; Python through the existing polyflow platform Python ports | TypeScript for v1. |
| AD-6 | Worlds | (a) in v1; (b) deferred to v2 | (b). They are not needed for the first experiment and add a fourth expression language. |
| AD-8 | How the two logics are kept apart | (a) separate files and operators (v0.2); (b) a separate truth type, `Tri`, checked by the type checker | (b), since v0.4. `.policy.poly` remains a reading convention. |
| AD-9 | Out-of-domain inputs at runtime | (a) always accept and journal; (b) per-field `strict` or `disclosed`, `strict` by default where a value reaches an irreversible or compensable effect | (b), with `strict` the default for every parameter that has a check domain since S400 (PT3.4a). |
| AD-7 | Licence | follow each engine's licence; the language and compiler under one licence | Open question for the owner (section 13). |

## 12. What changes in existing repositories

The aim is to change the engines as little as possible.

| Repository | Change | Why |
|---|---|---|
| polygraph / polyrun | Tombstones at archive (E1). poly vendors the files it runs, unchanged, from polygraph 8.4.0 on branch `e13-create-instance` at commit 755ac09, cut from `m3-sendto`; that branch adds the `createInstance` intent beside `sendTo` (`vendor/polygraph/PROVENANCE.md:3`). The gate is reached from poly-runtime's own effect worker, and the ledger is written by a subclass of polyrun's store, so neither needs an engine change (S119, S121). | Section 7.2 and AD-3. |
| polyaxion | A proposal kind for effect intents that carries the emitting-step snapshot. | PF4.3 and PF8.4. |
| polyflow | Load a workflow from lowered artefacts: this is already the six-file format, so no change is needed. The ledger kinds of E2 are the one change, and it is pending: the vendored polyflow still refuses `step`, `advice`, `decision` and `outcome` (section 2a). | PF5, PT16. |
| polyx | None. polyx is a separate tool, pinned by digest and run by path through `poly-mine`. The conversion from an adjudicated rule to a poly obligation is poly's (`poly promote`, PT30). | PF4.4. |
| polyness | None. polyness is a separate tool, pinned by digest and run through `poly-mine`. poly reads its rules by four fixed text templates and writes the poly source (`poly propose`, PT31). A polyness release that exports structured rules would replace the templates. | PF10.3. |
| Polytrion | None in v1. | Worlds are deferred (AD-6). |

## 13. Open questions for the owner

1. **Name and file extension.** `poly` and `.poly` are assumed throughout.
2. **Licence.** Options for the compiler, runtime package and language specification:
   - Apache-2.0, like polygraph and polyflow's kernel;
   - BUSL-1.1, like Polyaxion and Polyx.
3. **Canonical form (AD-1).** Should the canonical form change after the first experiment?
4. **Programs across repositories.** Should a module be allowed to import machines from another repository, and how are certificates composed in that case?

## 13a. Planned, not in v1.1

Each item below is named by the earlier design and is not built. Each is kept as a plan.

- **Version gate (stage 7) and `replay --against` (stage 8).** `poly check` has no `--since` or `--against` option; polyvers and polynv are imported nowhere. A ledger replay exists as `poly journal replay`, which is not a pipeline stage (`packages/poly-check/src/replay.ts`).
- **`poly grade` (polynv adequacy).** Listed in `NOT_BUILT`: "not scheduled: polynv adequacy (PF7.7)" (`packages/poly-check/src/commands.ts:605`). No grade is recorded in the certificate. `poly.json` accepts a `require.grade` key (`packages/poly-core/src/manifest.ts:115`) and nothing acts on it.
- **`poly test`.** There is no such command in `COMMANDS`. Witnesses are exported with `poly witness`.
- **Migration (`version N from M { migrate … }`, `migrate.cjs`).** The machine header parses `version N` and nothing lowers a migration; `CERTIFIED_ARTEFACTS` names `migrate.cjs` and nothing produces it (S570, `docs/decisions-v1.md`).
- **The Polyx advisor in the runtime.** `PolyRuntime.advise` appends an `advice` event to a run (`packages/poly-runtime/src/runtime.ts:1842`) and the trace export counts such events, but no package calls it outside tests, and no advisor is consulted at work-order issue or at the gate.
- **The `/poly:*` slash commands of the Claude Code plugin.** The plugin is built as a skill, an MCP server and a language server (section 10); it has no `/poly:new`, `/poly:check`, `/poly:explain` or `/poly:admit`.
- **`poly explain`, `poly deploy`, `poly dispatch`.** Listed in `NOT_BUILT` (`commands.ts:603-608`), "not scheduled".
- **Polytrion and worlds.** Deferred to v2 (AD-6); the grammar has no `world` declaration.

## 14. Conclusion

poly is a compiler, a toolchain and one runtime integration over engines that already exist, with a meaning of its own defined in 04-semantics. Section 2a lists its full extent. Safety checking, governance and execution come from the engines; poly-ref adds what none of them checks today: agreement of the lowering with the semantics, deadlock freedom and liveness. Every guarantee about a running program names the kernel assumptions it rests on (PS10). The new runtime surface is small and is itself modelled: the gate hook evaluates against recorded snapshots, the outbox intent is a checked machine, and the ledger is chained per run. This keeps the claims of each engine intact. poly checks nothing the engines do not check, and it runs nothing the checker did not see. At v1.1.0 the parts that depend on polyvers, polynv, the Polyx advisor and Polytrion are plans (section 13a), and the rest is built and tagged.

## References

1. InfoQ, "Vercel Labs Ships Zero: a Graph-First Language Built So Agents ...". https://www.infoq.com/news/2026/08/vercel-ships-zero-ai/
2. [`research/primitive-inventory.md`](research/primitive-inventory.md): the source of every engine format cited in this document.
