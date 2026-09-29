# poly · Functional specification

*Cognitive Fab · September 2026 · draft v0.5 · specification only, no code*

The meaning of every requirement below is defined in [`04-semantics.md`](04-semantics.md). v0.2 to v0.5 answer the four reviews in [`reviews/`](reviews/).

Requirement ids (`PF1.1`) are cited by the architecture (`PA`) and technical (`PT`) specifications.

## 1. What poly is

poly is a programming language and runtime for the stateful core of software written by coding agents.

A poly program is a set of declared state machines. Each machine carries:

- its contract;
- its invariants;
- its effects;
- the obligations that govern it.

The compiler checks the whole program exhaustively over declared finite domains before it can run. The runtime executes the same program durably, gates every effect, and writes a journal that replays exactly.

poly adds no new checking, simulation or governance engine. It is a compiler, a toolchain and one runtime integration over the primitives the Poly stack already has (the full scope is in the architecture, section 2a):

- the SAM v2 strict profile;
- the polygraph family (polygraph, polygen, polynv, polyrun, polyvers);
- polyflow and polycrew;
- Polyaxion and polycheck;
- Polyx;
- Polytrion.

Each poly construct lowers to an artefact one of those engines already reads.

## 2. The problem

### 2.1 Coding agents fail on stateful code

Coding agents are now the main authors of new code in many teams. They do well on local, self-contained tasks. They do poorly where state, composition and time are involved:

- **Real systems.** SysMoBench asks models to write TLA+ models of real systems. Syntax passes almost always, but conformance to real traces averages about 46%. The models "recite textbook protocols" instead of modelling the implementation [1].
- **Composition.** On DafnyComp, 13 models reached 99% syntactic correctness and 7% verification on multi-function programs. The failure is composition, not syntax [2].
- **Long horizons.** On SlopCodeBench, no agent solved any problem end to end across its checkpoints [3].

The Poly stack's own origin is the same failure. A sequence that could double-charge a customer was searched for, not found by a person or by an agent, and then happened in production.

### 2.2 The primitives exist, but they are separate

The stack already answers each part of the problem:

| Question | Engine that answers it today |
|---|---|
| Does every reachable state satisfy the invariants? | polygraph |
| Is the model faithful to the code? | polygraph replay |
| What may the machine emit, on every path? | polyrun `check-effects` |
| Does this version break the runs already in flight? | polyvers |
| Are the invariants adequate? | polynv |
| May this effect happen now, given what already happened? | Polyaxion |
| Does any path reach credential egress with no gate? | polycheck |
| What does the history say the agent should do next? | Polyx |
| What happens across many futures? | Polytrion |

Today a coding agent reaches these engines through different formats, different CLIs and different plugins. It writes several files for one machine:

- `contract.json`;
- `next.cjs`;
- `invariants.mjs`;
- `effects.cjs`;
- `effects.manifest.json`;
- `effect-invariants.mjs`;
- `migrate.cjs`.

Governance is authored separately again, in `polyaxion.policy.json`. The artefacts can drift apart, and the agent must hold the relationships in context.

### 2.3 The gap in current practice

No current system combines all five of these properties [4]:

1. The program is the checked model.
2. Exhaustive checking happens before execution.
3. The runtime is durable.
4. Governance is tied to the program's own state machine.
5. The language is designed for agents as the primary authors.

The nearest systems each cover part of the ground:

| System | What it offers | What it lacks |
|---|---|---|
| P and Quint [5, 6] | Model-checked specifications | The specification is separate from the production code |
| Stateright [7] | Model-checks the actor code it runs | No agent tooling, governance or durable runtime |
| Temporal, DBOS and similar runtimes [8, 9] | Durable execution | Workflow determinism is a convention, enforced by replay errors at runtime |
| AWS Step Functions [10] | A declared state machine, with a coding-agent setup | No invariants and no model checking |
| Dogwood and AgentSpec [11, 12] | Sequence rules on agent traces at runtime | No link to a declared program model |
| Zero [13] | A language designed for agents | No state-machine semantics and no model checking |
| Dafny [14] | Verified code that LLMs can write, at the function level | Collapses under composition (section 2.1) |

## 3. Users

| User | Role | What they need from poly |
|---|---|---|
| **Coding agent** (Claude Code, Codex, Cursor and others) | Primary author | A small language with finite types, structured diagnostics with stable codes, and witnesses it can act on without human help. |
| **Engineer** | Reviewer and owner | One readable file per machine, a verdict with evidence, and a gate that refuses unchecked changes. |
| **Operator** | Runs the system | Durable execution, a journal that replays, receipts, and an upgrade path that does not break live runs. |
| **Agent platform** | Runs agents | The same language for the agent's own workflows and policies as for the code the agent writes. |

## 4. Goals

- **G1.** An agent writes one poly source per machine. Everything the engines need is derived from it.
- **G2.** A poly program cannot run until it is admitted. Admission means the program passes every applicable check or the failure is recorded as a declared exception.
- **G3.** Every finding comes as a witness: a concrete, replayable sequence plus a generated test.
- **G4.** The checked program is the running program, over its check domains. The runtime executes the lowered artefacts the checker checked, and no other code. Inputs outside a `strict` check domain are rejected; inputs outside a `disclosed` one are journaled as drift.
- **G5.** Every effect crosses a gate and every decision is journaled with a receipt. That every effect is eventually executed or refused is part of the delivery guarantee, which belongs to the semantics (PS14). The runtime is obliged to implement it (R1), and a missed delivery is a runtime fault.
- **G6.** The journal feeds back into design:
  - replay corpora;
  - mined rules (Polyx);
  - proposed workflows (polyness);
  - twins (Polytrion), in v2.
- **G6a.** One machine, three interpretations: the same program is checked, simulated (v2) and run, and only the environment's interpretation changes (PS4.1a).
- **G7.** One language covers three kinds of program:
  - the application's stateful core;
  - the agent's own workflows;
  - the policies that govern the agent.

## 5. Non-goals

- **N1.** poly is not a general-purpose language. Computation that is not state-machine logic stays in the host language (TypeScript first).
- **N2.** poly does not prove properties over unbounded domains. Checks are exhaustive over declared finite domains. The representativeness of those domains is graded (polynv), not assumed.
- **N3.** poly does not replace the engines. It adds no model checker, simulator or gate of its own.
- **N4.** poly does not decide what the agent should do. Polyx advice is advisory and never changes a transition.
- **N5.** poly does not simulate continuous or hybrid systems. This follows the Polytrion boundary.
- **N6.** poly does not call a language model on any check or runtime decision path.

## 6. Functional requirements

### PF1 · Declaring a machine

- **PF1.1** A machine declares its state as a sealed set of typed fields with initial values. Writing an undeclared field is a compile error.
- **PF1.2** Every field and every action parameter has a finite **check domain**. The check domain may be narrower than the runtime type (for example `amount: int check {10, 20}`). Each check domain has a mode:
  - `strict`: an input outside the domain is rejected at dispatch, so the checked domain is the running domain;
  - `disclosed`: an input outside the domain is accepted and journaled as drift, and the certificate lists the field.

  The default is `strict` for any value that can reach an irreversible or compensable effect, and `disclosed` elsewhere.
- **PF1.3** A machine declares its actions (named intents with typed parameters) and its terminal states.
- **PF1.4** A handler (`on Action`) either accepts, writing the next state, or rejects with a named reason.
  - A handler that writes nothing and does not reject is flagged.
  - Rejection is a result, never an exception.
- **PF1.5** Fields a handler does not write are unchanged. The compiler derives the frame; the author never writes `unchanged(...)`.
- **PF1.6** A field may have a **tagged union** type, with constructors that carry payloads. Handlers read unions with exhaustive `match` or `is`, and write them as whole values. States that the union cannot express need no invariant to rule them out.

### PF2 · Declaring what must hold

- **PF2.1** A machine declares properties of distinct kinds, each with its own keyword (PS5):
  - **invariants**, predicates over a state;
  - **step properties**, predicates over an accepted step `(pre, action, data, post)`;
  - **reject properties**, predicates over any step and its verdict.
- **PF2.2** A machine declares **path properties** over the effects it may emit along any path. They are prefix-closed, so they are safety properties with finite witnesses.
- **PF2.3** A module declares **composition invariants** over a parent and its children.
- **PF2.4** An invariant may name a forbidden region. A check returns either a proof that no path enters it or the shortest witness that one does.
- **PF2.5** A machine may declare **liveness** properties (`eventually P`, `P leads to Q`), always with the weak-fairness assumption they need (PS6). A violation is reported as a lasso: a path to a cycle that can repeat forever.
- **PF2.6** Every machine is checked for **deadlock**: a reachable non-terminal state in which no action is accepted. No declaration is needed. Machines marked `service` (never terminal) are exempt and are covered by the configuration's stuck check.
- **PF2.7** A module may declare **configurations**: finite sets of instances with their initial addresses, the inputs the environment may inject and a bound on messages in transit. A configuration is checked with messages arriving in any order. Its invariants may span instances, and a bound hit is reported, never treated as clean.

### PF3 · Declaring effects, timers and children

- **PF3.1** A machine emits effects only from accepted steps. Each effect kind declares:
  - its payload type;
  - its completion actions (ok, failed, exhausted);
  - its retry policy;
  - its **class** (none, reversible, compensable or irreversible);
  - its **labels** from a closed vocabulary (for example `egress:external`, `read:private`).
- **PF3.2** A machine may set and cancel named timers that fire actions.
- **PF3.3** A machine may spawn and signal child machines. Attached children (the default) take part in their parent's atomic cascade and are co-located with it. Detached children are separate actors that communicate by messages and are checked as a configuration.
- **PF3.3a** A machine may hold the address of another instance (`Ref<M>`) and send it a message (`send`). Addresses may be passed in messages. A machine cannot read another machine's state.
- **PF3.4** An effect declares its targets as well as its labels. Its handler receives only the capabilities those labels and targets grant, and a handler module that reaches for ambient authority is refused. Optionally, handlers run in a sandbox whose policy is generated from the labels and targets.

### PF4 · Declaring governance

- **PF4.1** A project may declare policies that govern the program's effects or an agent's tool calls. Policies live in their own files (`.policy.poly`) with their own comparison operators, so the three-valued semantics never shares a file with machine code. A policy contains four kinds of obligation:
  - rule obligations;
  - machine obligations;
  - invariant obligations;
  - recalled text.
- **PF4.2** Policy expressions have their own truth type, `Tri` (true, false, unknown), because policy inputs may be missing; machine expressions have type `Bool`. The type checker keeps them apart, and one set of operators serves both. Policy expressions are three-valued. An unknown value never satisfies a requirement, and a deny rule whose condition is unknown escalates unless the author states otherwise (PS8.2). In a scope with label-based rules, an unlabelled effect is refused at admission (PS8.4).
- **PF4.3** A policy may reference effect labels and the program's own machine states. This is the link between governance and program semantics. A machine state is read as of the step that emitted the effect under decision, so every gate decision can be replayed.
- **PF4.4** A rule mined by Polyx and adjudicated `real` can be emitted as a poly obligation.
- **PF4.5** All obligations in a scope, from every source, are checked together: each mandate must remain dischargeable. A conflict is reported with the smallest set of obligations that causes it, and a promotion that would create one is refused.

### PF5 · Declaring agent workflows

- **PF5.1** A machine may be declared a **workflow**. Its effects become work orders handed to an agent or a person, who claims each one, runs it with their own tools and reports back.
- **PF5.2** A workflow declares:
  - its input action;
  - its run-key template;
  - the mapping from effect kinds to agent tools.
- **PF5.3** Several participants may work one run. Claims are leases, and only the holder may report.

### PF6 · Declaring worlds (deferred to v2)

- **PF6.1** In v2, a module may declare a world:
  - nodes that are machines;
  - responders that complete effects with declared distributions;
  - drivers that generate arrivals.
- **PF6.2** A world lowers to Polytrion artefacts. Running it requires the Polytrion engine. Worlds are not needed to test the claims of the first experiment and are out of v1.

### PF7 · Checking

- **PF7.1** `poly check` runs every applicable check in a fixed order and returns one verdict: `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED` or `INCONCLUSIVE`.
- **PF7.2** No check reports clean when it did not run to completion. A bounded exploration that hits its bound reports `INCONCLUSIVE` with the bound.
- **PF7.3** Every finding is a structured diagnostic with:
  - a stable code;
  - a source location;
  - a witness where one exists;
  - zero or more typed fixes, addressed to AST nodes and guarded by a digest of the node, so a fix invalidated by an earlier edit is refused, never misapplied.
- **PF7.4** Every witness can be exported as a trace (`{pre, action, data, post}` windows) and as a host-language test.
- **PF7.5** `poly check --against <traces>` replays recorded traces from the host system against the program and reports divergences. Positive and negative controls run first.
- **PF7.6** `poly check --since <version>` runs the version gate against the previous version and, when given, live snapshots.
- **PF7.7** `poly grade` reports the adequacy of the invariants by mutation (polynv).
- **PF7.8** Every `poly check` validates the lowering: a reference interpreter written from the semantics explores the checked instance and must agree with the lowered module on every transition (PS9.3). A disagreement refuses the program and is reported as a toolchain defect.
- **PF7.9** Every verdict is printed with the checked instance it holds for: the domains, the bounds, and the kernel assumptions it relies on.

### PF8 · Running

- **PF8.1** The runtime loads only admitted programs. An admitted program carries a certificate: the digests of its source, its lowered artefacts and its check results.
- **PF8.2** `dispatch(instance, action, data, actionId)` executes one step atomically. The step, snapshot, journal entry, outbox and timers commit together, and dispatch is idempotent on `actionId`.
- **PF8.3** Effects run at least once, with exactly-once emission and an idempotency key. Exhausted effects go to a dead-letter queue and dispatch the declared action.
- **PF8.4** Every effect crosses the governance gate before it runs. A denial carries a witness and dispatches the effect's failure action with the denial reason.
- **PF8.5** Every step and every gate decision is journaled. The ledger is hash-chained per run, with signed heads and a periodic signed anchor over all runs.
- **PF8.5a** Once the gate allows an effect, retries of that effect are not proposed again. Escalations have a timeout and are denied when it expires.
- **PF8.6** A run can be replayed from its journal alone, and the replay must reproduce every post-state. Gate decisions are reproduced by replaying the gate sessions the run touched, in their recorded session order (PS11).
- **PF8.7** The runtime refuses to load a new version that the version gate rejected. Instances can be pinned, migrated or upgraded.

### PF9 · The agent interface

- **PF9.1** Every command is available on the command line, as an MCP tool and through a language server.
- **PF9.2** All output has a JSON form with a published schema. Human-readable output is a projection of it.
- **PF9.3** `poly new "<description>"` drafts a machine from a feature description (polygen). The draft is not admitted until it passes `poly check`.
- **PF9.4** `poly explain <code|witness>` returns the rule, the witness and the fixes in a form an agent can act on.
- **PF9.4a** poly has two surfaces over one core: a standalone syntax and an embedded TypeScript surface that is valid TypeScript. Both produce the same AST and go through the same checks. The first experiment decides which is primary.
- **PF9.5** Formatting is canonical. The content hash is taken over the AST; comments are trivia and do not change it.
- **PF9.6** Accepting a finding and approving an escalation require a signature from a key registered to a person. An agent key cannot sign either record.

### PF10 · Feedback from runtime to design

- **PF10.1** `poly export traces` writes journals as trace corpora for replay, the version gate and grading.
- **PF10.2** `poly mine` passes journals to Polyx. Candidate rules come back as proposed obligations for a person to adjudicate.
- **PF10.3** `poly propose` passes agent journals to polyness. Repeated work comes back as a proposed workflow in poly source.
- **PF10.4** (v2) `poly twin` imports runtime snapshots into a Polytrion world.

## 7. Acceptance criteria for v1

| Id | Criterion |
|---|---|
| AC1 | The order machine of the `polyrun-oms` example, rewritten in poly, lowers to artefacts that replay its existing trace corpus at 100% and produce the same `check-effects` result as the hand-written artefacts. |
| AC2 | The turnstile, raft role-transition and hatchet status-derivation machines from the field studies are expressible in poly. Their positive and negative controls behave as they do today. The raft study found no defects, so for raft this criterion establishes expressibility and control behaviour only. |
| AC3 | A seeded invariant violation yields a diagnostic with a witness. The exported host test fails on the unfixed program and passes on the fixed one. |
| AC4 | A policy with a machine obligation over effect labels compiles, is admitted, and denies an irreversible effect in the forbidden state, with a witness and a signed receipt. |
| AC5 | A workflow declared in poly runs through the polyflow MCP tools with no change to those tools. |
| AC6 | Replaying a journal reproduces every post-state. Replaying the sessions it touched, in session order, reproduces every gate decision and every session-state digest. |
| AC8 | For every conformance case, translation validation agrees on every transition, and a deliberately broken lowering is refused with `PL2501`. |
| AC9 | The `OutboxIntent` machine is deadlock-free and satisfies its liveness property under its stated fairness. Replacing the `Dead` branch of `SettleFailed` with `Allowed` yields a witness: `PL3102 DOMAIN_ESCAPE` in the union form, `PL3201 DEADLOCK` in the v0.3 five-field form. |
| AC10 | The `checkout` configuration (two orders, one inventory) reports the double-confirmation witness when the order confirms optimistically, and is clean, with no stuck state, when the order waits for `Taken`. |
| AC11 | Promoting a mined rule that makes a mandate undischargeable is refused, and the finding names the minimal conflicting set. |
| AC7 | A breaking change is refused by `poly check --since` against a live snapshot set. |

## 8. How success is measured

The first experiment (PT13) is milestone M3. It runs as soon as the language core, effects and diagnostics exist, before any runtime work, and the rest of the plan depends on its result. It compares three arms. In each, a coding agent implements the same stateful features behind the same host interface:

1. the host language alone;
2. the host language plus polygraph after the fact;
3. poly, standalone syntax;
4. poly, embedded in TypeScript.

The comparison of arms 3 and 4 decides which surface is primary.

The co-primary measures are:

- escaped defects, judged by scenario tests written from the brief by someone who has not seen any reference machine;
- tokens per delivered task.

The decision rule is fixed before any run:

- **Win:** at least one poly arm reduces mean escaped defects by at least 30% against both non-poly arms, at no more than twice the tokens of arm 1.
- **Stop:** neither poly arm delivers an admitted program in 70% of its runs. The language surface is then revised before any runtime work.

A null result is reported with the same prominence as a positive one.

## 9. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Agents write poly less well than TypeScript, because there is little poly in training data. | Adoption stalls. | Keep the surface small and close to TypeScript expressions. Make diagnostics carry fixes. Measure this directly in the first experiment. |
| Check domains are too narrow to find real defects. | False confidence. | Grade adequacy with polynv. Report domains as disclosed assumptions in every certificate. |
| State explosion on realistic machines. | Checks hit bounds. | `INCONCLUSIVE` with the bound, never clean. Rely on composition semantics (atomic cascades) and small machines. |
| Two expression semantics: two-valued in machines, three-valued in policies. | Author confusion. | A separate truth type, `Tri`, for policy expressions; the type checker rejects a `Tri` where a `Bool` is expected (PS8.0). One operator set serves both. |
| Engine licences differ (Apache-2.0, BUSL-1.1, private Polytrion). | Distribution friction. | The compiler emits all artefacts. Checks that need a private engine are reported as not run, never as clean. |

## 10. Conclusion

The Poly stack already has every primitive a coding agent needs to write stateful code that holds: declared machines, exhaustive checks with witnesses, admission, durable execution, gated effects, receipts, mined expertise and simulation. Today those primitives sit behind separate formats and tools. poly puts them behind one language. The program the agent writes is the model that is checked, the policy that governs it, and the code that runs. Its journal becomes the corpus for the next check. The first version is judged early, at M3, on one question: does an agent writing poly ship fewer escaped defects than an agent writing the host language alone, and at what cost?

## References

1. "SysMoBench: Evaluating AI on Formally Modeling Complex Real-World Systems". https://arxiv.org/pdf/2509.23130 ; SIGOPS blog, "Can LLMs model real-world systems in TLA+?" https://www.sigops.org/2026/can-llms-model-real-world-systems-in-tla/
2. "Local Success Does Not Compose: Benchmarking Large Language Models for Compositional Formal Verification", ICLR 2026. https://mlanthology.org/iclr/2026/xu2026iclr-local/
3. "SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks". https://huggingface.co/papers/2603.24755
4. [`research/landscape-2026-09.md`](research/landscape-2026-09.md), section "Gaps".
5. P language. https://github.com/p-org/P
6. Quint, "Reliable Software in the LLM Era". https://quint.sh/posts/llm_era
7. Stateright. https://github.com/stateright/stateright
8. Temporal, Event History. https://docs.temporal.io/encyclopedia/event-history/event-history-typescript
9. DBOS, "Why DBOS?" https://docs.dbos.dev/why-dbos
10. AWS, "Set up your AI coding agent to build with AWS Step Functions". https://aws.amazon.com/blogs/compute/set-up-your-ai-coding-agent-to-build-with-aws-step-functions/
11. AWS, "Introducing Dogwood: runtime verification for AI agents". https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/
12. "AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents", ICSE 2026. https://ink.library.smu.edu.sg/sis_research/10278/
13. InfoQ, "Vercel Labs Ships Zero: a Graph-First Language Built So Agents ...". https://www.infoq.com/news/2026/08/vercel-ships-zero-ai/
14. "A benchmark for vericoding: formally verified program synthesis". https://huggingface.co/papers/2509.22908
