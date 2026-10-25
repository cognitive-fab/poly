# poly architecture

A language and runtime for the stateful core of software written by coding agents, with a checker that is written separately from the compiler it checks.

Analysed at [`116bb50`](https://github.com/cognitive-fab/poly/tree/116bb50c9c3f4e5e965e17d9d1f2b41e7b99a9e5).

**Read from.** docs/02-architecture.md (document); docs/release-notes-v1.2.md, docs/release-notes-v1.3.md, docs/release-notes-v1.3.1.md (document); packages/poly-core, poly-lang, poly-embed, poly-lower, poly-ref, poly-check, poly-runtime, poly-agent, poly-io, poly-new, poly-mine (code); scripts/check-boundaries.mjs, std/PINS.json, adapters/, vendor/*/PROVENANCE.md, peers/polycheck/PROVENANCE.md (code); demo/ (code).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### How the parts fit together

**What are the parts of poly, and which way does a program travel through them?**

poly has to be believable at two moments: when a person decides to trust a program, and when that program runs. The design answers both with one artefact, the certificate, and one record, the ledger. The tension is that the checker, the compiler and the runtime are all code, and only one of them is allowed to decide.

Source is checked and lowered by the pipeline, admitted into a signed certificate, loaded only by the runtime, and every step it takes is chained in the ledger, which feeds the next check.

[Open the diagram](overview.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **poly CLI** | Parses the command line and holds the one command registry that the MCP and language servers re-export. |
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **Admission** | Admits a build only when every check ran and came out clean, then signs the certificate over its digests. |
| **Certified build** | Holds the lowered artefacts of each machine and the certificate that names them by digest, as files. |
| **poly-runtime** | Verifies a certificate and loads only the artefacts it names, then dispatches actions on the polyrun kernel. |
| **Ledger** | Writes each step's events in the step's own transaction, chains them per run and signs heads and periodic anchors. |

**Deliberately not shown.** The language packages, the vendored engines, the network package and the tools poly starts; later questions cover them.

#### The long read

Everything starts at the poly CLI, whose command registry the MCP server re-exports, so an agent and a person reach the same commands.

The Check pipeline takes a source file through parse, type, lower, strict validate, translation validation, model check and the later stages. It writes the lowered files into the Certified build and folds every stage verdict into one report. poly-ref sits beside the pipeline and is the part that compares the lowering with the semantics.

Admission is a separate step. It refuses unless every check ran and came out clean, then signs a certificate over the digests of the source and each artefact. The runtime loads only what that certificate names and refuses any file whose digest differs.

At run time the Effect worker takes each effect from the outbox, passes it through the gate and a handler, and the Ledger records the step and the gate's decision in one transaction. The Feedback commands read that ledger back as traces, so what ran can become the next rule, workflow or calibration.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **translation validation**: Running the lowered module and poly-ref's reading of the semantics on every reachable state, and refusing any difference between them.
- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **outbox**: The table in which a step leaves its effect intents. The effect worker takes them out one at a time, at least once.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **vacuous**: A property whose antecedent is never true where it is judged. It holds for no reason the program gives, so it is INCONCLUSIVE and never CLEAN.
- **vendored engine**: An engine file copied unchanged into vendor/ and pinned by hash and commit, so poly relies on the Poly stack conceptually and not physically.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.

### A check, in order

**What happens, in order, when poly check runs on a machine?**

A check has to be cheap to trust. The pipeline's order is the argument: no engine explores a module that poly-ref has not already shown to mean what the source says, so a finding from an engine is a finding about the program and not about the lowering.

The pipeline parses and lowers the machine, has sam-pattern validate it, has poly-ref compare it with the semantics, and only then lets polygraph explore it, with poly-ref confirming what polygraph finds.

[Open the diagram](check-order.sequence.html). 8 participants.

| Component | Responsibility |
|---|---|
| **poly CLI** | Parses the command line and holds the one command registry that the MCP and language servers re-export. |
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **poly-lang** | Reads the standalone syntax into the canonical AST and prints it back in canonical form. |
| **poly-core** | Defines the AST with content digests, the type and domain checker, the diagnostic codes and the verdict fold. |
| **poly-lower** | Lowers a checked machine to the contract, the SAM v2 module, the invariants and the effect, policy and workflow files. |
| **sam-pattern 2.3.0** | Validates a lowered module against the strict profile and runs its acceptors. |
| **poly-ref** | Re-evaluates the semantics from 04-semantics, compares the lowering with it, and decides deadlock, liveness and configurations. |
| **polygraph 8.4.0** | Explores a lowered module for invariants, effects and products, and runs the polyrun kernel and its store. |

**Deliberately not shown.** Effects, composition, configuration and policy stages, which run after these for machines that have them.

In order:

*Front end*

1. **poly CLI → Check pipeline**: check target. A target path and options; the report is written to .poly/report.json and returned as JSON.
2. **Check pipeline → poly-lang**: parse source. Source text in; a canonical AST with node ids and digests out.
3. **Check pipeline → poly-core**: type and domains. An AST in; typed declarations and diagnostics with codes out.

*Lower*

4. **Check pipeline → poly-lower**: lower the machine. A checked module and a machine name; the artefact files as text out.
5. **Check pipeline → sam-pattern 2.3.0**: strict validate. The lowered next.cjs; a pass or the strict-profile violations (PL2001).

*Agree*

6. **Check pipeline → poly-ref**: translation validation. The source AST and the lowered files; poly-ref returns mismatches, findings and a state count.

*Explore*

7. **Check pipeline → polygraph 8.4.0**: model check. The lowered module and invariants; findings that poly-ref must confirm, and a state count that must agree.
8. **Check pipeline → poly-ref**: confirm, deadlock, liveness. The source AST and the lowered files; poly-ref returns mismatches, findings and a state count.

*Report*

9. **Check pipeline ⇢ poly CLI**: verdict and witnesses

#### The long read

The CLI hands a target to the pipeline. Stage 0 parses the source with poly-lang and runs the type and domain checks in poly-core. A refusal here stops the machine and the later stages are listed as not run, with the reason.

A checked machine is lowered. sam-pattern then validates the lowered module against the strict profile. Only after that does poly-ref run translation validation: it executes the lowered module and its own reading of the semantics on every reachable state and refuses any difference (PL2501).

Now polygraph explores the module for invariants. Its findings are not taken on its word. The pipeline asks poly-ref to confirm each witness against the checked instance, and a finding that leaves the instance becomes a bound hit and not a finding. poly-ref also decides deadlock freedom and liveness, which no engine checks.

The report returns to the CLI with a verdict, the diagnostics and witnesses. A stage that did not run is listed as not run and never lowers the verdict.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **translation validation**: Running the lowered module and poly-ref's reading of the semantics on every reachable state, and refusing any difference between them.
- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **witness**: The path of states and actions that shows a finding, exported as a test and kept so that a person can accept the finding.

### Why the checker does not agree by accident

**What keeps poly-ref from sharing the compiler's mistakes?**

A checker is only worth having if it can disagree with the compiler. The architecture calls poly-ref the part most likely to have bugs of its own, so its independence is the whole reason to trust a CLEAN verdict.

poly-ref imports no compiler code, only erased types from core, and the import-boundary script enforces it; the pipeline then requires poly-ref and polygraph to agree on counts and findings.

[Open the diagram](independence.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **poly-ref** | Re-evaluates the semantics from 04-semantics, compares the lowering with it, and decides deadlock, liveness and configurations. |
| **poly-core** | Defines the AST with content digests, the type and domain checker, the diagnostic codes and the verdict fold. |
| **poly-lang** | Reads the standalone syntax into the canonical AST and prints it back in canonical form. |
| **poly-lower** | Lowers a checked machine to the contract, the SAM v2 module, the invariants and the effect, policy and workflow files. |
| **sam-pattern 2.3.0** | Validates a lowered module against the strict profile and runs its acceptors. |
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |

**Deliberately not shown.** The runtime, the ledger and the feedback commands, none of which touch the independence rule.

#### The long read

poly-ref is written from 04-semantics. Its only compiler-adjacent import is the AST type definitions from poly-core, written as import type so the compiler erases them. It may also import sam-pattern, because it must drive the lowered module to compare with it. It never imports poly-lang, poly-embed or poly-lower.

The boundary is enforced by a script in CI, not by convention. A file that cannot be read is an error and never a pass.

Even so, two implementations can share a blind spot, so the pipeline cross-checks them where it can. polygraph and poly-ref must count the same states on the same lowered module, and each polygraph finding must be confirmed by poly-ref's replay. A disagreement is PL2501 and is addressed to the toolchain, not the author.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.

### From a clean check to a loadable program

**How does a clean check become something the runtime will load?**

Between a check and a run there is a gap in which files can change and a person can be impersonated. Admission closes it with digests and signatures, so the runtime needs no trust in the process that did the checking.

Admission re-runs the pipeline, refuses any check not run, signs a certificate over the digests, and the runtime refuses any file that no longer matches it.

[Open the diagram](admission.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Admission** | Admits a build only when every check ran and came out clean, then signs the certificate over its digests. |
| **Certificate format** | Defines the certificate that binds source and artefact digests to check results, and the problems a load can find in one. |
| **Certified build** | Holds the lowered artefacts of each machine and the certificate that names them by digest, as files. |
| **poly-runtime** | Verifies a certificate and loads only the artefacts it names, then dispatches actions on the polyrun kernel. |

**Deliberately not shown.** The language packages and the ledger, which admission does not touch.

#### The long read

Admission begins by running the pipeline again over the project and refusing if any machine or policy has a check not run or a vacuous property. The architecture document says such a stage is recorded in the certificate as notRun; the code refuses instead (PT12.5).

Findings can be accepted, but only by a person: Admission reads signed acceptances from Signed records and refuses a record signed with an agent key. It also reads back every promotion, proposal and refit record in the project and compares each with its source or map (PL6513, PL6520, PL6521). A build with policies is admitted only if the Polyaxion engine is the pinned one.

The Certificate format then binds the source and artefact digests, the checked instances, the toolchain versions and the handler closure, and the issuer signs the digest. The certificate sits beside the Certified build.

At load, the runtime verifies signatures, re-hashes the artefacts and checks the toolchain. Any difference refuses the load with a diagnostic.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **vacuous**: A property whose antecedent is never true where it is judged. It holds for no reason the program gives, so it is INCONCLUSIVE and never CLEAN.
- **promotion**: Adding a mined rule that a person judged real to a program, under a marker, after checking the project, so that admission can read it back.
- **refit**: Fitting a new calibration map from a person's signed verdicts, written as a new file with a signed record and never edited in place.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.

### One effect, in order

**What happens, in order, to a single effect a machine emits?**

This is the one place poly joins two engines that did not know about each other: a kernel that runs effects at least once and a gate that mediates calls in two phases. The order in which the checks, the gate and the handler meet is the design.

The kernel records the step, the worker checks and proposes the effect to the gate, the handler runs only on allow, and the worker settles the result and completes the intent.

[Open the diagram](one-effect.sequence.html). 5 participants.

| Component | Responsibility |
|---|---|
| **Effect worker** | Takes each effect intent from the outbox, runs its checks and the gate, and calls the handler only on allow. |
| **Policy gate** | Proposes each effect to the Polyaxion engine against the emitting step's snapshot and settles the observed result. |
| **Polyaxion** | Compiles and hardens a policy, and decides allow, deny or escalate on each proposal. |
| **Host handlers** | Performs an allowed effect for the application, at least once, and reports what it observed; an irreversible effect it performs twice is safe only if the checked guarantee holds. |
| **polygraph 8.4.0** | Explores a lowered module for invariants, effects and products, and runs the polyrun kernel and its store. |

**Deliberately not shown.** Denial and escalation paths, retries and the person's approval record, which branch from the verdict step.

In order:

*Propose*

1. **Effect worker → polygraph 8.4.0**: claim outbox row. Outbox rows claimed and dead-lettered, and the completion action dispatched after settle.
2. **Effect worker → Policy gate**: propose with snapshot. The effect with its labels and class, the emitting step's snapshot and its digest; allow, deny or escalate back.
3. **Policy gate → Polyaxion**: evaluate policy. A proposal as an action with labels; the engine's session state replays from recorded sequence numbers.
4. **Polyaxion ⇢ Policy gate**: allow, deny or escalate
5. **Policy gate ⇢ Effect worker**: decision

*Perform*

6. **Effect worker → Host handlers**: call handler on allow. The payload and an idempotency key, on allow only; at-least-once.
7. **Host handlers ⇢ Effect worker**: observed result

*Settle*

8. **Effect worker → Policy gate**: settle observed. The effect with its labels and class, the emitting step's snapshot and its digest; allow, deny or escalate back.
9. **Effect worker → polygraph 8.4.0**: completion action. Outbox rows claimed and dead-lettered, and the completion action dispatched after settle.

#### The long read

The runtime dispatches an action on the polyrun kernel. If the machine accepts it, the step commits with its outbox row and, in the same transaction, the ledger's step event.

The Effect worker claims the row. Before the policy engine is asked anything, the worker applies five refusals in a fixed order: the envelope origin, the memory and flow check, the budget, the grant and the mandate. Each is final whatever a policy says. Only an effect that passes them is proposed to the Policy gate, with the labels and class of the effect and the emitting step's snapshot.

The gate asks Polyaxion and returns allow, deny or escalate. The worker records the verdict in the ledger. On allow it calls the handler, which performs the effect at least once and reports what it observed. The worker settles that observation with the gate and dispatches the completion action to the kernel. On deny or escalate it dispatches the declared failure action instead, with the reason.

#### Terms used here

- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **outbox**: The table in which a step leaves its effect intents. The effect worker takes them out one at a time, at least once.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.
- **irreversible effect**: An effect whose result cannot be taken back once it has happened, such as a refund or a message sent. poly requires such an effect that may be attempted twice to say how it is kept from running twice.

### From what ran to the next rule

**How does a running program's history become a checked rule, workflow or calibration?**

A program that runs teaches its owner things the checker could not know. The loop lets that knowledge in without letting a tool or an agent decide: every step has a key, a floor and a check.

The feedback commands export the ledger as traces, a pinned tool proposes, a person signs a verdict, and the result goes back into the source and through the pipeline and admission like any edit.

[Open the diagram](loop.architecture.html). 9 components.

| Component | Responsibility |
|---|---|
| **Ledger** | Writes each step's events in the step's own transaction, chains them per run and signs heads and periodic anchors. |
| **Feedback commands** | Turns journals into a trace corpus, and a person's signed verdicts into promoted rules, proposals and refit calibration maps. |
| **poly-mine** | Starts polyx and polyness by path with a fixed argument vector and a fresh environment, after checking each pin. |
| **polyx** | Proposes rules from a trace corpus; run by path and never trusted until a person adjudicates a rule real. |
| **polyness** | Proposes a workflow for a step a person repeats, which poly reads by four text templates and never runs. |
| **Signed records** | Signs and verifies person records against a keyring, and refuses any record an agent key signed. |
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **Admission** | Admits a build only when every check ran and came out clean, then signs the certificate over its digests. |
| **Certified build** | Holds the lowered artefacts of each machine and the certificate that names them by digest, as files. |

**Deliberately not shown.** The runtime itself and the gate, which only produce the ledger the loop reads.

#### The long read

The Feedback commands read the Ledger through a journal reader and write a trace corpus: values for declared domains, a salted token for everything else, erased steps left out and counted.

poly-mine runs polyx on that corpus, or polyness on copied transcripts. Each is started by path with a fixed argument vector, a fresh environment and a pin checked first; polyness runs in a temporary home that is removed afterwards. poly reads polyness's rules by four fixed text templates and never runs its code.

Nothing the tools say is binding. A person signs a verdict on each candidate with a key that is not an agent key, and Signed records keeps it as a file. A rule judged real is promoted into the source under a marker, the pipeline checks the project, and the change is undone if the check refuses it. Admission reads every promotion back and compares it with the source, and the certificate lists them.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **witness**: The path of states and actions that shows a finding, exported as a test and kept so that a person can accept the finding.
- **vacuous**: A property whose antecedent is never true where it is judged. It holds for no reason the program gives, so it is INCONCLUSIVE and never CLEAN.
- **promotion**: Adding a mined rule that a person judged real to a program, under a marker, after checking the project, so that admission can read it back.
- **refit**: Fitting a new calibration map from a person's signed verdicts, written as a new file with a signed record and never edited in place.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.

### How an agent reaches poly

**How does a coding agent or an editor reach the checker and the runtime?**

poly is written for agents, which arrive through many hosts. The design keeps the core ignorant of every host so that a new host costs a configuration file and no code.

Through one command registry served three ways: the command line, an MCP server and a language server, plus a workflow server for work orders. A host adapter is a JSON file that launches one of them.

[Open the diagram](hosts.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Host adapters** | Tell a host such as Claude Code how to launch poly mcp, poly lsp and poly run --mcp, and nothing else. |
| **MCP server** | Serves the registry's commands as MCP tools and offers poly new through a host-supplied model. |
| **Language server** | Publishes diagnostics on open, change and save, running only the early stages on an edit. |
| **poly CLI** | Parses the command line and holds the one command registry that the MCP and language servers re-export. |

**Deliberately not shown.** The stages of the check and the internals of the runtime.

#### The long read

The command registry lives in poly-check beside the pipeline, and poly-agent re-exports it. The MCP server turns each command into a tool with the command's JSON schema; the language server runs the commands marked for it on open, change and save, and an edit asks for the early stages only.

The Workflow server is the third surface. It serves a project's workflows as work-order tools on poly-runtime, so an agent or a person can claim and report a step under the gate.

A Host adapter holds only a command and arguments for a host such as Claude Code. The boundary script accepts exactly three launches: poly mcp, poly lsp and poly run --mcp over the project, with no environment. poly new is offered through MCP using the host's own model, and its drafts go back through the pipeline.

#### Terms used here

- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **work order**: A unit of work that a workflow issues to an agent or a person, with a budget; the reservation is the cap.

### Which engines poly runs and which it checks itself

**Which checks come from the vendored engines, and which does poly do on its own?**

poly adds no new checking engine except its own model checker. The question is where the engines are relied on and where poly refuses to take their word.

The engines explore, validate and decide policy; poly-ref confirms or contradicts what they report and alone decides deadlock, liveness and configurations.

[Open the diagram](engines.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **sam-pattern 2.3.0** | Validates a lowered module against the strict profile and runs its acceptors. |
| **polygraph 8.4.0** | Explores a lowered module for invariants, effects and products, and runs the polyrun kernel and its store. |
| **Polyaxion** | Compiles and hardens a policy, and decides allow, deny or escalate on each proposal. |
| **polycheck** | Proves that a governed scope's effects stay inside the capability regions its labels allow. |

**Deliberately not shown.** The front end, lowering and admission.

#### The long read

The pipeline asks sam-pattern for strict validation and polygraph for the model check, the effects check and the product check. It asks Polyaxion to compile and harden each policy and polycheck for capability regions. poly-ref repeats the model check, the effects check and the composition check on its own and the two must agree, with PL2501 as the disagreement code.

At run time, the same engines are used another way. The runtime runs the polyrun kernel from polygraph, and the Ledger subclasses the kernel's store and uses polyflow's event format and verifier.

All of them are copied unchanged into vendor/ or peers/ and pinned by hash and commit. A test re-hashes each file.

#### Terms used here

- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **vendored engine**: An engine file copied unchanged into vendor/ and pinned by hash and commit, so poly relies on the Poly stack conceptually and not physically.

### What can refuse an effect before the policy

**What can refuse or escalate an effect before the Polyaxion engine is asked?**

A policy engine decides what a policy says. Several refusals do not depend on any policy, such as a stale retrieval or an exhausted budget, so they come first and cannot be overridden by an allow.

The worker applies origin, memory, budget, grant and mandate checks first, each from the runtime, and each final whatever a policy says.

[Open the diagram](before-gate.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **poly-runtime** | Verifies a certificate and loads only the artefacts it names, then dispatches actions on the polyrun kernel. |
| **Effect worker** | Takes each effect intent from the outbox, runs its checks and the gate, and calls the handler only on allow. |
| **Memory and flow** | Tracks the taint of each retrieved body and applies the flow rule and freshness check before an effect is proposed. |
| **Decisions and routing** | Runs a decision through a provider, applies the calibration map, and routes a call across tiers under a budget. |

**Deliberately not shown.** The engine itself and the ledger.

#### The long read

The runtime wires callbacks into the Effect worker when it loads a build. Memory and flow supplies the origin, one-item and freshness checks; Decisions and routing supplies the budget lookup and reservation; the grant and mandate checks read the live grants.

Because each check is final, a policy that would allow an effect cannot restore one of them. Only after all five pass does the worker propose the effect to the Policy gate.

Handler capabilities act after the gate. A handler receives only the wrappers its effect's labels and targets allow, bound to transports that poly-io supplies; poly-runtime itself imports no network module.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **outbox**: The table in which a step leaves its effect intents. The effect worker takes them out one at a time, at least once.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.

### Where poly starts a process or opens a socket

**Which parts may start a child process or touch the network?**

A checker that can call out can be talked into a verdict. The architecture limits the three kinds of outside reach, a model, a mining tool and a network, to three named places so that the check path stays closed.

Only poly-mine and poly-new start processes, and only poly-io opens sockets; the check path imports neither, and the scripts that enforce it run in CI.

[Open the diagram](seams.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **poly-mine** | Starts polyx and polyness by path with a fixed argument vector and a fresh environment, after checking each pin. |
| **poly-new** | Drafts a module with a model, checks each draft and stops at clean or after five rounds, never admitting it. |
| **polyx** | Proposes rules from a trace corpus; run by path and never trusted until a person adjudicates a rule real. |
| **Claude Code (headless)** | Answers poly new's drafting prompts when it is started in print mode. |
| **poly-io** | Holds the HTTPS, SMTP and ingress transports, the channel adapters and the credential vault, apart from every check. |
| **Channel providers** | Carry the messages poly-io sends and receives for email, Slack, SMS, WhatsApp and webhooks. |

**Deliberately not shown.** The runtime's own internals, which perform no network or process work.

#### The long read

poly-new calls a model through Claude Code in print mode, to draft source, and every draft goes straight back through the pipeline. poly-mine starts polyx and polyness, never a shell, never with the whole environment, and never the polyx command that calls a model.

poly-io holds the HTTPS, SMTP and ingress code. poly-runtime itself imports no network module; the host passes poly-io's transports to the runtime, which hands a handler only a wrapper bound to the targets its effect declares.

The import-boundary script reads every source and fails on any import that crosses these lines, on a socket global, and on a network module named in a string.

#### Terms used here

- **check path**: The packages that decide verdicts. None of them calls a model, opens a socket or imports poly-io.

### What the design names and the code does not build

**Which parts of docs/02-architecture.md have no code behind them at v1.1.0?**

The architecture document was last revised before any code existed. Reading it against the code at v1.1.0 shows which parts of its promise were built, which were built differently and which are still only a plan.

The version gate, the adequacy grade, the Polyx advisor and the Polytrion twin are not built, and the commands explain, grade, deploy and dispatch are listed as not built.

[Open the diagram](gaps.architecture.html). 6 components.

| Component | Responsibility |
|---|---|
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **Version gate (polyvers)** *(planned)* | Would classify a version change against the live fleet and gate it, with a migrate step. |
| **Effect worker** | Takes each effect intent from the outbox, runs its checks and the gate, and calls the handler only on allow. |
| **Polyx advisor** *(planned)* | Would answer recommend, warn or abstain when a work order is issued and when the gate receives a proposal. |
| **Ledger** | Writes each step's events in the step's own transaction, chains them per run and signs heads and periodic anchors. |
| **Polytrion twin** *(planned)* | Would simulate a program against a world built from its ledger; private and out of v1. |

**Deliberately not shown.** Everything that is built; the other questions cover it.

#### The long read

The pipeline stops at stage 5. Stage 7, the version gate with polyvers, and stage 8, replay with controls, are not stages of the pipeline; polyvers and polynv are not imported anywhere. The command list marks explain, grade, deploy and dispatch as not built, with the reason.

The Polyx advisor is not consulted. The runtime can append an advice event to a run, and the trace export counts advice events, but no code calls the method outside tests.

Polytrion is deferred by design: the document defers worlds to v2 and the grammar has no world declaration.

The source construct version N from M with a migrate block is not lowered: the machine header parses a version number, but no migrate.cjs is written.

#### Terms used here

- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **outbox**: The table in which a step leaves its effect intents. The effect worker takes them out one at a time, at least once.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **work order**: A unit of work that a workflow issues to an agent or a person, with a budget; the reservation is the cap.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.

### Why a retried refund runs once

**How does poly keep an effect that cannot be undone from running twice when a delivery is retried?**

A worker retries an effect when an answer is lost. For a read that costs nothing. For a refund the target may have done the work already, and a second request moves the money twice. The question is where in poly that is decided, and what is left to trust.

The check refuses an irreversible effect with two or more attempts that names no guarantee, and the runtime puts the same key on every attempt.

[Open the diagram](retry-safety.architecture.html). 8 components.

| Component | Responsibility |
|---|---|
| **Check pipeline** | Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report. |
| **poly-ref** | Re-evaluates the semantics from 04-semantics, compares the lowering with it, and decides deadlock, liveness and configurations. |
| **Retry safety** | Decides, from the semantics, that an irreversible effect which may be attempted twice names how its target is kept from running it twice, and that an effect which reaches outside declares its class. |
| **Standard library pins** | Pins the digest of each standard-library file, so that only an unedited library module may declare an effect idempotent by nature. |
| **Admission** | Admits a build only when every check ran and came out clean, then signs the certificate over its digests. |
| **Effect worker** | Takes each effect intent from the outbox, runs its checks and the gate, and calls the handler only on allow. |
| **Handler capabilities** | Gives a handler only the wrappers its effect's labels and declared targets allow, attaches a keyed effect's idempotency key to its writes, and audits any call outside them. |
| **Host handlers** | Performs an allowed effect for the application, at least once, and reports what it observed; an irreversible effect it performs twice is safe only if the checked guarantee holds. |

**Deliberately not shown.** The certificate and the vendored engines, which carry the finding and the outbox but do not decide it.

#### The long read

Retry safety is decided in poly-ref, from the semantics, with no code shared with the compiler. For every effect of class irreversible, poly-ref reads the number of attempts the effect declares (or the default of five). One attempt is at most once and needs no finding. Two or more need a guarantee: a keyed one, which names the header and a window longer than the retry horizon, or idempotent by nature, which only a pinned standard-library file may declare. Otherwise the check reports PL4003 with a path to the step that emits the effect and the delivery in which the target may execute twice. An effect that reaches outside without a class is PL6304.

The pipeline tells poly-ref whether the module is a pinned library file, by comparing its digest with std/PINS.json. Admission then refuses a build with such a finding unless a person has signed an acceptance.

At run time the worker retries the effect and the capabilities wrapper gives the handler an egress call that sets the key header, the intent id, on every write. A handler that supplies the header has it replaced, and the replacement is audited. A second write in one attempt is refused. This is why the rule is a rule about what runs: the manifest entry the runtime reads is compared with the same declarations by the read-back of artefacts.

Two things stay outside the check. The target must honour the key (K17) and an effect declared idempotent by nature must be (K18). And the key belongs to an intent, not to an order: a second request is a second intent. That is the lesson of the v1.3.0 concierge, and the reason v1.3.1 adds a ledger to the program itself.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **poly-ref**: poly's own model checker. It is written from the semantics and shares no code with the compiler.
- **gate**: The two-phase mediation of an effect: propose before the call, settle after it. The Polyaxion engine decides allow, deny or escalate.
- **outbox**: The table in which a step leaves its effect intents. The effect worker takes them out one at a time, at least once.
- **ledger**: The record of every step, advice, decision, outcome, gate verdict and effect of a run, hash-chained per run with signed heads and a periodic anchor.
- **witness**: The path of states and actions that shows a finding, exported as a test and kept so that a person can accept the finding.
- **vacuous**: A property whose antecedent is never true where it is judged. It holds for no reason the program gives, so it is INCONCLUSIVE and never CLEAN.
- **vendored engine**: An engine file copied unchanged into vendor/ and pinned by hash and commit, so poly relies on the Poly stack conceptually and not physically.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.
- **irreversible effect**: An effect whose result cannot be taken back once it has happened, such as a refund or a message sent. poly requires such an effect that may be attempted twice to say how it is kept from running twice.

### How the demo uses poly

**How does the refund demo run a checked program without being part of poly?**

The v1.3 demonstration shows the retry-safety rule to an audience. It would prove little if it used a private path into the runtime, so it uses the same admission and the same runtime as any program.

It admits a demo copy of the concierge through the ordinary admission, loads it on the ordinary runtime, and only supplies the room, the stand-in and the providers around it.

[Open the diagram](demo.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Refund demo** | Runs the three-act refund demonstration against the admitted concierge, with a local stand-in for Stripe, a signed-message room, and live model providers behind a spend cap. |
| **Admission** | Admits a build only when every check ran and came out clean, then signs the certificate over its digests. |
| **Certified build** | Holds the lowered artefacts of each machine and the certificate that names them by digest, as files. |
| **poly-runtime** | Verifies a certificate and loads only the artefacts it names, then dispatches actions on the polyrun kernel. |

**Deliberately not shown.** The checker, which has already decided before the demo starts.

#### The long read

The launcher builds the concierge's demo copy (generated, with the diff printed), checks and admits it with test anchors, and loads it on the runtime. Around it the demo supplies what a real deployment would supply from outside: a room page that signs each message as the WhatsApp Cloud API does, a staff panel, a local stand-in for Stripe, and live model providers on a transport that reaches the provider's host alone, under a spend cap of 10 dollars or less.

The demo is held to a rule of its own (rule 7 of the boundary check): no model SDK is imported, the provider's host is named in one file, a global fetch is used in two, and a process is started only by the replay driver, the scripts and the stand-in's key tool. So nothing in the demo can reach a model or a payment provider by a path the check did not see.

#### Terms used here

- **artefact**: A file produced by lowering a machine, such as the contract, the SAM v2 module or the effects manifest. The engines read artefacts and never the source.
- **certificate**: A signed record that binds a program's source and artefact digests to the checks that ran and their results. The runtime loads only what one names.
- **idempotency key**: A value sent with a write so that the receiver can recognise a retry of the same request and do the work once. In poly it is the intent id, and the runtime sets it.
- **stand-in**: A local program that behaves as an outside service documents, used so that a demonstration moves no real money and needs no key.

## Boundaries

A boundary is a claim about everything inside it.

### The compiler

*ownership boundary.* Code that turns source into artefacts; poly-ref imports none of it

Contains: poly-lang, poly-embed, poly-lower.

### Check path

*trust boundary.* No model decides a verdict; never imports poly-io

Contains: poly-core, poly-lang, poly-embed, poly-lower, poly-ref, Check pipeline, Admission, poly CLI, Signed records, Feedback commands, MCP server, Language server, Workflow server.

Crossed by:

- **poly-new → Check pipeline** over in-process call. A draft file; diagnostics go back to the model, and the check is never relaxed.

### Process seam (packages)

*process boundary.* Only these two packages may start a child process

Contains: poly-mine, poly-new.

Crossed by:

- **MCP server → poly-new** over in-process call. A description and a host-supplied model sampling function; the drafted source comes back unadmitted.
- **poly CLI → poly-new** over in-process call. A description; loaded by package name so the check packages never import the model seam.
- **Feedback commands → poly-mine** over in-process call. A corpus or copied transcripts, and a pin; one named tool's output text comes back.
- **poly-mine → polyx** over spawn. A trace corpus file on argv; candidate rules on stdout, capped in size and time.
- **poly-mine → polyness** over spawn. Copied transcripts in a temporary home that is removed afterwards; a proposal folder out.
- **poly-new → Claude Code (headless)** over spawn. A prompt holding the grammar and the last diagnostics; draft source text back.

### Vendored engines

*ownership boundary.* Copied unchanged from their own repositories and pinned by hash and commit

Contains: sam-pattern 2.3.0, polygraph 8.4.0, polyflow kernel and verify, Polyaxion, polycheck.

Crossed by:

- **Check pipeline → sam-pattern 2.3.0** over in-process call. The lowered next.cjs; a pass or the strict-profile violations (PL2001).
- **Check pipeline → polygraph 8.4.0** over in-process call. The lowered module and invariants; findings that poly-ref must confirm, and a state count that must agree.
- **Check pipeline → Polyaxion** over in-process call. One policy document per trust scope; compile, harden and coverage results.
- **Check pipeline → polycheck** over in-process call. Each governed effect as an action with the flags its labels map to.
- **poly-ref → sam-pattern 2.3.0** over in-process call. The lowered next.cjs, loaded in a vm context, so that its behaviour can be compared with the semantics.
- **Admission → Polyaxion** over in-process call. The engine's commit and file hashes; a build with policies is refused if they differ.

## Components

### Agent interface

**poly CLI**: Parses the command line and holds the one command registry that the MCP and language servers re-export.

- Source: `packages/poly-check/src/cli.ts:1`, `packages/poly-check/src/commands.ts:99`, `packages/poly-check/src/commands.ts:603`

**MCP server**: Serves the registry's commands as MCP tools and offers poly new through a host-supplied model.

- Source: `packages/poly-agent/src/mcp.ts:57`

**Language server**: Publishes diagnostics on open, change and save, running only the early stages on an edit.

- Source: `packages/poly-agent/src/lsp.ts:116`

**Workflow server**: Serves a project's workflows as work-order tools over MCP, on poly-runtime, for an agent or a person to claim.

- Source: `packages/poly-agent/src/workflows.ts:76`, `packages/poly-agent/src/index.ts:1`

**Host adapters**: Tell a host such as Claude Code how to launch poly mcp, poly lsp and poly run --mcp, and nothing else.

- Source: `adapters/claude-code/install.json`, `adapters/dsh/install.json`, `scripts/check-boundaries.mjs:65`

### Language

**poly-lang**: Reads the standalone syntax into the canonical AST and prints it back in canonical form.

- Source: `packages/poly-lang/src/parser.ts:64`, `packages/poly-lang/src/lexer.ts:8`, `packages/poly-lang/src/format.ts:22`

**poly-embed**: Reads and prints the embedded TypeScript surface over the same AST as the standalone syntax.

- Source: `packages/poly-embed/src/read.ts`, `packages/poly-embed/src/print.ts`

**poly-core**: Defines the AST with content digests, the type and domain checker, the diagnostic codes and the verdict fold.

- Source: `packages/poly-core/src/ast.ts`, `packages/poly-core/src/check/check.ts`, `packages/poly-core/src/diagnostics.ts:340`, `packages/poly-core/src/digest.ts:1`

### Lowering

**poly-lower**: Lowers a checked machine to the contract, the SAM v2 module, the invariants and the effect, policy and workflow files.

- Source: `packages/poly-lower/src/lower.ts:31`, `packages/poly-lower/src/policy.ts:19`, `packages/poly-lower/src/faults.ts:8`

### Check and admission

**Certificate format**: Defines the certificate that binds source and artefact digests to check results, and the problems a load can find in one.

- Source: `packages/poly-core/src/certificate.ts:12`, `packages/poly-core/src/certificate.ts:135`

**Signed records**: Signs and verifies person records against a keyring, and refuses any record an agent key signed.

- Source: `packages/poly-core/src/records.ts:46`, `packages/poly-check/src/records.ts:1`, `packages/poly-check/src/keyrings.ts:16`

**poly-ref**: Re-evaluates the semantics from 04-semantics, compares the lowering with it, and decides deadlock, liveness and configurations.

- Source: `packages/poly-ref/src/tv.ts:1`, `packages/poly-ref/src/explore.ts:1`, `packages/poly-ref/src/liveness.ts:1`, `packages/poly-ref/src/load.ts:10`

**Check pipeline**: Runs the stages in a fixed order over the engines and poly-ref, and folds their verdicts into one report.

- Source: `packages/poly-check/src/pipeline.ts:40`, `packages/poly-check/src/pipeline.ts:540`, `packages/poly-check/src/policies.ts:293`, `packages/poly-check/src/std-pins.ts:13`

**Handler lint**: Reads the handler files without running them, refuses reach for ambient authority and hashes the closure the certificate binds.

- Source: `packages/poly-check/src/lint.ts:1`, `packages/poly-check/src/handlers.ts:1`

**Admission**: Admits a build only when every check ran and came out clean, then signs the certificate over its digests.

- Source: `packages/poly-check/src/admit.ts:173`, `packages/poly-check/src/admit.ts:255`

**Feedback commands**: Turns journals into a trace corpus, and a person's signed verdicts into promoted rules, proposals and refit calibration maps.

- Source: `packages/poly-check/src/traces.ts:29`, `packages/poly-check/src/promote.ts`, `packages/poly-check/src/propose.ts`, `packages/poly-check/src/refit.ts`

**Certified build**: Holds the lowered artefacts of each machine and the certificate that names them by digest, as files.

- Source: `packages/poly-check/src/admit.ts:173`, `packages/poly-lower/src/layout.ts`

**Version gate (polyvers)** *(planned)*: Would classify a version change against the live fleet and gate it, with a migrate step.

**Adequacy grade (polynv)** *(planned)*: Would grade a build's tests by mutation and record the grade in the certificate.

**Retry safety**: Decides, from the semantics, that an irreversible effect which may be attempted twice names how its target is kept from running it twice, and that an effect which reaches outside declares its class.

- Source: `packages/poly-ref/src/retrysafe.ts:1`, `packages/poly-ref/src/check.ts:289`

**Standard library pins**: Pins the digest of each standard-library file, so that only an unedited library module may declare an effect idempotent by nature.

- Source: `packages/poly-check/src/std-pins.ts:1`, `std/PINS.json`, `scripts/pin-std-digests.mjs`

### Runtime

**poly-runtime**: Verifies a certificate and loads only the artefacts it names, then dispatches actions on the polyrun kernel.

- Source: `packages/poly-runtime/src/runtime.ts:178`, `packages/poly-runtime/src/runtime.ts:2081`, `packages/poly-runtime/src/load.ts:105`

**Effect worker**: Takes each effect intent from the outbox, runs its checks and the gate, and calls the handler only on allow.

- Source: `packages/poly-runtime/src/worker.ts:199`, `packages/poly-runtime/src/worker.ts:459`, `packages/poly-runtime/model/outbox-intent.poly`

**Policy gate**: Proposes each effect to the Polyaxion engine against the emitting step's snapshot and settles the observed result.

- Source: `packages/poly-runtime/src/policy-gate.ts:98`, `packages/poly-runtime/src/policy-gate.ts:257`, `packages/poly-runtime/src/policy-engine.ts`

**Handler capabilities**: Gives a handler only the wrappers its effect's labels and declared targets allow, attaches a keyed effect's idempotency key to its writes, and audits any call outside them.

- Source: `packages/poly-runtime/src/capabilities.ts:1`, `packages/poly-runtime/src/capabilities.ts:137`

**Decisions and routing**: Runs a decision through a provider, applies the calibration map, and routes a call across tiers under a budget.

- Source: `packages/poly-runtime/src/provider.ts:54`, `packages/poly-runtime/src/routing.ts:1`

**Memory and flow**: Tracks the taint of each retrieved body and applies the flow rule and freshness check before an effect is proposed.

- Source: `packages/poly-runtime/src/memory.ts:1`

**Host handlers**: Performs an allowed effect for the application, at least once, and reports what it observed; an irreversible effect it performs twice is safe only if the checked guarantee holds.

- Source: `examples/inbox/host/run.mjs`, `examples/inbox/host/drafts.mjs`

**poly-io**: Holds the HTTPS, SMTP and ingress transports, the channel adapters and the credential vault, apart from every check.

- Source: `packages/poly-io/src/net.ts:1`, `packages/poly-io/src/vault.ts`, `packages/poly-io/src/ingress.ts`, `packages/poly-io/src/index.ts:1`

**Polyx advisor** *(planned)*: Would answer recommend, warn or abstain when a work order is issued and when the gate receives a proposal.

### Ledger

**Ledger**: Writes each step's events in the step's own transaction, chains them per run and signs heads and periodic anchors.

- Source: `packages/poly-runtime/src/ledger-store.ts:1`, `packages/poly-runtime/src/ledger-store.ts:149`, `packages/poly-runtime/src/ledger.ts:12`, `packages/poly-runtime/src/journal.ts:133`

### Vendored engines

**sam-pattern 2.3.0**: Validates a lowered module against the strict profile and runs its acceptors.

- Source: `vendor/sam-pattern/PROVENANCE.md`

**polygraph 8.4.0**: Explores a lowered module for invariants, effects and products, and runs the polyrun kernel and its store.

- Source: `vendor/polygraph/PROVENANCE.md:1`

**polyflow kernel and verify**: Defines the hash-chained ledger event format and verifies a chain.

- Source: `vendor/polyflow/PROVENANCE.md`

**Polyaxion**: Compiles and hardens a policy, and decides allow, deny or escalate on each proposal.

- Source: `vendor/polyaxion/PROVENANCE.md`, `packages/poly-runtime/src/peers.ts:36`

**polycheck**: Proves that a governed scope's effects stay inside the capability regions its labels allow.

- Source: `peers/polycheck/PROVENANCE.md`

### Separate tools

**Channel providers**: Carry the messages poly-io sends and receives for email, Slack, SMS, WhatsApp and webhooks.

- Source: `packages/poly-io/src/adapters/email.ts`, `packages/poly-io/src/adapters/slack.ts`

**poly-new**: Drafts a module with a model, checks each draft and stops at clean or after five rounds, never admitting it.

- Source: `packages/poly-new/src/new.ts:1`, `packages/poly-new/src/providers.ts:84`

**poly-mine**: Starts polyx and polyness by path with a fixed argument vector and a fresh environment, after checking each pin.

- Source: `packages/poly-mine/src/index.ts:15`, `packages/poly-mine/src/index.ts:63`, `packages/poly-mine/src/index.ts:119`

**Claude Code (headless)**: Answers poly new's drafting prompts when it is started in print mode.

- Source: `packages/poly-new/src/providers.ts:84`

**polyx**: Proposes rules from a trace corpus; run by path and never trusted until a person adjudicates a rule real.

- Source: `packages/poly-mine/src/index.ts:36`

**polyness**: Proposes a workflow for a step a person repeats, which poly reads by four text templates and never runs.

- Source: `packages/poly-mine/src/index.ts:91`

**Polytrion twin** *(planned)*: Would simulate a program against a world built from its ledger; private and out of v1.

**Refund demo**: Runs the three-act refund demonstration against the admitted concierge, with a local stand-in for Stripe, a signed-message room, and live model providers behind a spend cap.

- Source: `demo/launch.mjs:1`, `demo/README.md`, `demo/stand-in/stripe/server.mjs`, `scripts/check-boundaries.mjs`

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| MCP server | poly CLI | in-process call | A command name and a JSON input checked against its schema; the result is the same JSON the command line prints. |
| Language server | poly CLI | in-process call | The commands marked lsp, run on open, change and save; an edit asks for stages 0 to 2 only. |
| MCP server | poly-new | in-process call | A description and a host-supplied model sampling function; the drafted source comes back unadmitted. *(crosses Process seam (packages))* |
| Workflow server | poly-runtime | in-process call | Workflow start, claim and report calls; a report carries the observed result and optional usage, never a gate decision. |
| poly CLI | Workflow server | in-process call | A project directory and a certified build; loaded by package name so poly-check does not depend on poly-agent. |
| poly CLI | poly-new | in-process call | A description; loaded by package name so the check packages never import the model seam. *(crosses Process seam (packages))* |
| Host adapters | MCP server | spawn | A command and arguments in a JSON file. No code and no hooks. |
| Host adapters | Language server | spawn | A command and arguments in a JSON file. |
| Host adapters | Workflow server | spawn | poly run --mcp over the project's workflows; no environment is set. |
| poly CLI | Check pipeline | in-process call | A target path and options; the report is written to .poly/report.json and returned as JSON. |
| poly CLI | Admission | in-process call | A project, a key file for the issuer and trust anchors. |
| poly CLI | Feedback commands | in-process call | A ledger store path, a certified build, a person's key file and verdict files. |
| poly CLI | Signed records | in-process call | A person's key file by path, never a key under version control; not offered over MCP. |
| Check pipeline | poly-lang | in-process call | Source text in; a canonical AST with node ids and digests out. |
| Check pipeline | poly-embed | in-process call | TypeScript text in; the same AST out. |
| Check pipeline | poly-core | in-process call | An AST in; typed declarations and diagnostics with codes out. |
| Check pipeline | poly-lower | in-process call | A checked module and a machine name; the artefact files as text out. |
| Check pipeline | Certified build | file | The files of each machine, each hashed as lowered, which every later stage reads back. |
| Check pipeline | sam-pattern 2.3.0 | in-process call | The lowered next.cjs; a pass or the strict-profile violations (PL2001). *(crosses Vendored engines)* |
| Check pipeline | poly-ref | in-process call | The source AST and the lowered files; poly-ref returns mismatches, findings and a state count. |
| Check pipeline | polygraph 8.4.0 | in-process call | The lowered module and invariants; findings that poly-ref must confirm, and a state count that must agree. *(crosses Vendored engines)* |
| Check pipeline | Polyaxion | in-process call | One policy document per trust scope; compile, harden and coverage results. *(crosses Vendored engines)* |
| Check pipeline | polycheck | in-process call | Each governed effect as an action with the flags its labels map to. *(crosses Vendored engines)* |
| Check pipeline | Handler lint | in-process call | The handler files poly.json names and every file they reach by relative import. |
| poly-lang | poly-core | in-process call | The AST node types and the node-id and digest functions. |
| poly-embed | poly-core | in-process call | The AST node types. |
| poly-lower | poly-core | in-process call | Checked declarations, effect classes and labels the artefacts are written from. |
| poly-ref | poly-core | in-process call | Type-only imports, erased at compile time; no function of the compiler crosses. |
| poly-ref | sam-pattern 2.3.0 | in-process call | The lowered next.cjs, loaded in a vm context, so that its behaviour can be compared with the semantics. *(crosses Vendored engines)* |
| Admission | Check pipeline | in-process call | A project report; any check not run or vacuous refuses admission (PT12.5). |
| Admission | Certificate format | in-process call | Source digests, artefact digests, check results and the issuer's ed25519 signature. |
| Admission | Certified build | file | The SHA-256 of each file on disk and the certificate file beside the build. |
| Admission | Signed records | file | A person's signed acceptance of a finding, by witness id; an agent-signed record is refused. |
| Admission | Feedback commands | file | Promotion entries, proposals with evidence files and refit records, each compared with its source or map. |
| Feedback commands | Admission | in-process call | AdmitError and personKey, so a refusal reads the same and a person's key is read the same way. |
| Admission | Polyaxion | in-process call | The engine's commit and file hashes; a build with policies is refused if they differ. *(crosses Vendored engines)* |
| Feedback commands | Check pipeline | in-process call | The edited project; the promotion is undone if the check refuses it. |
| Feedback commands | Ledger | database | Event chains read through a journal reader; values for declared domains, salted tokens for the rest. |
| Feedback commands | Signed records | file | Verdicts and refit records signed by a person's key, kept as files in the project. |
| Feedback commands | poly-mine | in-process call | A corpus or copied transcripts, and a pin; one named tool's output text comes back. *(crosses Process seam (packages))* |
| poly-mine | polyx | spawn | A trace corpus file on argv; candidate rules on stdout, capped in size and time. *(crosses Process seam (packages))* |
| poly-mine | polyness | spawn | Copied transcripts in a temporary home that is removed afterwards; a proposal folder out. *(crosses Process seam (packages))* |
| poly-new | Claude Code (headless) | spawn | A prompt holding the grammar and the last diagnostics; draft source text back. *(crosses Process seam (packages))* |
| poly-new | Check pipeline | in-process call | A draft file; diagnostics go back to the model, and the check is never relaxed. *(crosses Check path)* |
| poly-runtime | Certified build | file | Only the files the certificate names, each re-hashed; any difference refuses the load. |
| poly-runtime | Certificate format | in-process call | The certificate, the files on disk and trusted public keys; a list of problems. |
| poly-runtime | Signed records | in-process call | A person's signed approval of an escalated intent, verified against the keyring. |
| poly-runtime | sam-pattern 2.3.0 | in-process call | The certified next.cjs of each machine. |
| poly-runtime | polygraph 8.4.0 | in-process call | An instance, an action, data and an action id; accepted, rejected or unhandled comes back. |
| poly-runtime | Ledger | database | A SQLite path; the store the kernel then writes each step into. |
| poly-runtime | Effect worker | in-process call | The checks as callbacks: origin, memory, budget, grant and mandate. |
| poly-runtime | Policy gate | in-process call | The certified policies and the engine pin; an engine that is missing raises GateUnavailable. |
| poly-runtime | Memory and flow | in-process call | An intent's taints and item sets; a refusal, an escalation or proposal fields. |
| poly-runtime | Decisions and routing | in-process call | A question, the calibration map and a budget reservation. |
| poly-runtime | Handler capabilities | in-process call | The effect's declared targets and the host's transports. |
| Effect worker | Policy gate | in-process call | The effect with its labels and class, the emitting step's snapshot and its digest; allow, deny or escalate back. |
| Effect worker | Host handlers | in-process call | The payload and an idempotency key, on allow only; at-least-once. |
| Effect worker | polygraph 8.4.0 | database | Outbox rows claimed and dead-lettered, and the completion action dispatched after settle. |
| Effect worker | Ledger | database | Events keyed by the step's action id, committed with the step. |
| Policy gate | Polyaxion | in-process call | A proposal as an action with labels; the engine's session state replays from recorded sequence numbers. |
| poly-io | Handler capabilities | in-process call | HTTPS and SMTP transport functions; poly-runtime itself imports no network module. |
| poly-io | poly-runtime | in-process call | The adapter interface from @poly/runtime/adapters, as types. |
| poly-io | Channel providers | https | Signed webhooks in, provider sends out; credentials stay in the vault and never reach a handler. |
| Ledger | polygraph 8.4.0 | in-process call | The kernel's journal insert and step commit, so that ledger rows share the step's transaction. |
| Ledger | polyflow kernel and verify | in-process call | Canonical JSON and digests for the chain; polyflow's verifier accepts the poly kinds. |
| Effect worker | Polyx advisor | in-process call | A proposal in; recommend, warn or abstain out, recorded and never able to change a decision. |
| Check pipeline | Version gate (polyvers) | in-process call | A previous build or live snapshots, to classify a version change. |
| Admission | Adequacy grade (polynv) | in-process call | Mutation runs and a ledger of dispositions, recorded in the certificate. |
| Ledger | Polytrion twin | file | Traces and snapshots for a simulation world; deferred to v2. |
| poly-ref | Retry safety | in-process call | The effect declarations of the machine model and the explored graph in; findings PL4003 to PL4005 and PL6304 with a witness, the retry-safe line of each effect and the assumptions K17 and K18 out. |
| Check pipeline | Standard library pins | file | A source path in; whether its digest equals the one in std/PINS.json (isStd) out, which decides whether the module may declare an effect idempotent by nature. |
| Refund demo | Admission | in-process call | The concierge's demo copy and test anchors in; a certified build or a refusal out. |
| Refund demo | poly-runtime | in-process call | The certified build, the stand-in's transport and the signed room messages in; replies and the audit of each effect out. |
| Handler capabilities | Host handlers | in-process call | The egress, vault and content wrappers the effect's labels allow in the handler's hands; on a keyed effect every write carries the intent id as the idempotency header, set here and not by the handler. |

## Doctrines, guarantees and trade-offs

### Doctrines

- **The semantics is the definition, and every check compares the lowering with it** 04-semantics defines what a program means; translation validation runs the lowered module and poly-ref on every reachable state and refuses any disagreement
- **An effect meets five refusals before the policy engine decides** origin, memory, budget, grant and mandate each refuse or escalate finally whatever a policy says; only then does the Polyaxion gate propose
- **The core is host-neutral and a host adapter is configuration only** no package names a host or imports a host SDK; an adapter is JSON and markdown that launches poly mcp, poly lsp or poly run --mcp, so a new host adds no code

### Guarantees

- **A check that did not run or hit a bound is never CLEAN** the verdict fold ranks INCONCLUSIVE and UNDERPOWERED apart from CLEAN, vacuous properties are INCONCLUSIVE, and admission refuses a build with any check not run
- **An agent key never signs a person record** approvals, acceptances, verdicts and adjudications are the owner's decisions; the signature check at admission and at the runtime refuses an agent key, whatever the transport
- **The runtime executes the artefacts the checker checked** the certificate binds each file by digest and load refuses any mismatch, so the checked program is the running program over its check domains
- **A step and its ledger events commit together or not at all** the ledger store subclasses polyrun's and writes the step event inside the dispatch transaction, so the kernel's atomicity covers the ledger
- **An irreversible effect that may be attempted twice is not admitted unless it names how its target is kept from running it twice** poly-ref reports PL4003 with a witness (a delivery in which the target may execute twice) unless the effect is keyed (an idempotency header and a window that holds the retry horizon) or idempotent by nature in the pinned standard library. The runtime sets the key on every write in a capability the handler cannot bypass. What poly does not verify are the assumptions K17 (the target honours the key) and K18 (an effect declared idempotent by nature is), which a certificate names when an effect declares them

### Constraints

- **poly-ref shares no code with the compiler** a checker written from the same code would agree with its bugs; poly-ref may import only node builtins, sam-pattern and type-only imports of core
- **No check package imports poly-io** network code lives in poly-io alone, so nothing on a check path can open a socket
- **No language-model call decides a verdict or a gate decision** a verdict must be a function of the program and the semantics. The one way to a model is poly new, which the CLI and the MCP server load by name; its drafts go back through the pipeline and are never admitted by it.
- **In packages/, only poly-new and poly-mine may start a process** every child process of the product is then one of three named tools, started with a fixed argument vector, a fresh environment, a pin check, a timeout and an output cap. The demo is outside packages/ and starts a process in three places only (the replay driver, its scripts and the stand-in's key tool), which rule 7 names
- **Engines are copied unchanged, never forked** poly relies on the Poly stack conceptually, not physically; a change an engine needs is made in its own repository and copied in again, and a test re-hashes every vendored file

### Trade-offs

- **A check not run blocks admission instead of being recorded in the certificate** the architecture document has the certificate carry a notRun list; the code refuses to admit instead, so no certificate ever says a check was skipped, at the cost that a build whose optional stage cannot run cannot be admitted at all

### Risks

- **Nothing in the packages records advice** the runtime can append an advice event, but no package calls it and no advisor is consulted at issue or at the gate; only tests call it. The architecture document describes the advisor as part of the runtime.
- **The key proves a retry runs once; it says nothing about a second request** The key is the intent id, so a second request is a second intent with a second key. The concierge of v1.3.0 refunded twice for that reason, and v1.3.1 fixes the program with a refund ledger in the Desk (per customer thread, because the order's identity is opaque). The checker's model cannot tell the order, so this class of defect is shown by the room, not decided by the check; per-order identity is proposed for v2.0

