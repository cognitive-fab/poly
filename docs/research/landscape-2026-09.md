# The landscape for poly: languages, verifiers, runtimes and governance for coding agents (September 2026)

Method: web search, plus page fetches of vendor docs, project pages and paper-summary pages. I did not read any paper's full text. Some figures come from secondary summaries (review sites and aggregators), and those are marked **[secondary]**. One arXiv HTML page was fetched by mistake (PCAS, ref 45).

---

## 1. State-machine and model-checkable languages

**P language (p-org, Microsoft origin, heavily used at AWS)**
- **What it is:** a language for modelling distributed systems as communicating state machines. Its checker explores interleavings of messages and failures.
- **What it checks:** safety and liveness specifications, written as monitor state machines.
- **New in P 3.0:** the "P Verifier" backend. It proves by induction that "the given model satisfies the given specification under the given assumptions". It checks that invariants are inductive, and it runs on UCLID5 with SMT solvers (Mora et al., OOPSLA '23). The announcement describes an industrial two-phase commit verified with it. [1][2]
- **AWS use:** "Systems Correctness Practices at Amazon Web Services" (CACM; also in ACM Queue) describes P alongside Dafny, Kani, Lean, property-based testing, deterministic simulation and fault injection. The authors are Marc Brooker and Ankush Desai, according to a secondary blog **[secondary]**. [3][4][5]
- **LLM relation:** the P docs reference "PeasyAI" as "AI for P". I found no published benchmark for it **[uncertain]**. P checks models, not the production code. [2][6]

**Quint (Informal Systems)**
- **What it is:** an executable specification language built on TLA's logic, with a typed, programmer-friendly syntax.
- **LLM relation:** this is explicit. "Reliable Software in the LLM Era" (Gabriela Moreira, 17 Nov 2025) positions the spec as the validation point "between English and code". It gives a four-step workflow: AI edits the spec, a human validates it by exploration, AI generates code, and model-based testing checks conformance. It reports refactoring Malachite's BFT consensus engine "in roughly one week". [7]
- **Tooling:** the open-source Quint LLM Kit ships analyzer, implementer and verifier agents, plus quint-lsp and quint-kb MCP servers. It targets Claude Code first, then Cursor, Copilot, Codex, Gemini CLI and others. [8][9]
- **What it guarantees:** only model-level checking. Code conformance comes from model-based testing (Quint Connect), not from proof.

**TLA+ / PlusCal, and TLA+ with LLMs**
- **What it is:** TLA+ remains the reference for model-checked design. TLC does explicit-state checking.
- **Evidence on LLMs:**
  - **SysMoBench** (Cheng, Tang, Ma, Hackett, He, Su, Beschastnikh, Huang, Ma, Xu). LLMs model 11 real systems in TLA+, including Asterinas locks, Etcd, RedisRaft and ZooKeeper FLE. Syntax passes about 100%. Runtime passes 30 to 92%. Conformance to real traces averages about 46%. Invariants pass 16 to 81%. The authors find that models "often recite textbook protocols rather than faithfully modeling actual implementations". [10][11]
  - **"Can LLMs Write Correct TLA+ Specifications? Evaluating Natural-Language-to-TLA+ Generation"** (Bisharat et al., ICSOFT 2026). 30 LLMs on 205 specs gave 26.6% syntactic and 8.6% semantic correctness. Code-specialised models underperformed. [12]
  - **Specula** (Cheng et al., July 2026, Microsoft Research page). LLM coding agents autonomously build TLA+ specs and invariants from system code. It found 249 bugs across 48 open-source projects. It won first place in the 2025 GenAI-accelerated TLA+ Challenge (TLA+ Foundation with NVIDIA). Second place went to grammar-constrained TLA+ generation (Andrew Helwer) and third to TLA+ spec to Rust code (Gregory Terzian). [13][14]
  - Also seen by title only: "TLA-Prover: Verifiable TLA+ Specification Synthesis via ...", "TLA+-Bench: An Execution-Grounded Benchmark and Dataset ...", and "Towards Language Model Guided TLA+ Proof Automation". [15]

**Alloy 6**
- **What it is:** a relational modelling language. Version 6 added mutable state (`var`) and linear temporal logic, including past operators, so behaviours can be model-checked over traces.
- **What it guarantees:** bounded checking through SAT solvers, with unbounded checking via external model checkers.
- **LLM relation:** I found no LLM-specific tooling in this search. [16][17]

**Stateright (Rust)**
- **What it is:** a model checker embedded in a Rust actor library. The same actor code is model-checked (BFS or DFS over states, including linearizability checks) and then run on a real network.
- **Why it matters here:** it is the closest existing analogue to "the checked program is the running program". It has no LLM or agent integration. [18][19]

**XState / Stately**
- **What it is:** statecharts and actors for JS/TS.
- **Agent relation:** `@statelyai/agent` (beta) lets an LLM agent choose among the events a machine allows in the current state. The machine constrains which events the agent can trigger.
- **What it guarantees:** structure only. There is no exhaustive property checking, and no invariants beyond the transition structure. [20][21]

---

## 2. Verification-aware languages used with LLMs

**Dafny**
- **What it is:** an SMT-backed language with first-class `requires`, `ensures` and `invariant`. It is currently the most LLM-friendly verification target.
- **Evidence:**
  - **"DafnyBench: A Benchmark for Formal Software Verification"** (Loughridge et al., TMLR 2025). Over 750 programs, about 53,000 lines. The best model and prompt reached 68% on regenerating verification hints. [22][23]
  - **"A benchmark for vericoding: formally verified program synthesis"** (Bursuc, Ehrenborg, Lin, ... Tegmark; Dafny workshop at POPL 2026). 12,504 specifications, 6,174 of them new. Success rates: Dafny 82%, Verus/Rust 44%, Lean 27%. The paper reports Dafny verification improving from 68% to 96% "over one year" on a subset. This is the source of the term "vericoding". [24][25][26]
  - **"Local Success Does Not Compose: Benchmarking Large Language Models for Compositional Formal Verification"** (DafnyComp, ICLR 2026). 300 multi-function Dafny programs. 13 models reached 99% syntax correctness but only 7% verification. Failure modes were:
    - specification fragility (39.2%);
    - implementation-proof misalignment (21.7%);
    - reasoning instability (14.1%). [27][28]
  - Titles seen only: "AxDafny: Agentic Verified Code Generation in Dafny" and "DafnyProver: Agentic Verified Code Generation in Dafny" (ICML 2026). [29][30]

**Verus (verified Rust)**
- **What it is:** a verifier for Rust. Microsoft Research runs the Verus Proof Synthesis Leaderboard.
- **Benchmarks:**
  - Verus-Bench: 150 algorithm-level tasks.
  - VeruSAGE-Bench: 849 repository-level tasks from real systems.
- **Related work:** "AutoVerus: Automated Proof Generation for Rust Code" (OOPSLA 2025) and "VeruSAGE: A Study of Agent-Based Verification for Rust Systems".
- The live leaderboard numbers did not render when fetched. [31][32]

**Lean 4**
- **Positioning:** Leonardo de Moura, "When AI Writes the World's Software, Who Verifies It?" (28 Feb 2026), argues that Lean should be the independent verification layer for AI-written code. His examples:
  - Claude converted zlib to Lean, with a machine-checked proof that decompression recovers the original data (Kim Morrison's team).
  - AWS Cedar is verified in Lean.
  - Microsoft SymCrypt verification is under way. [33]
- **Benchmarks:**
  - **"VERINA: Benchmarking Verifiable Code Generation"** (ICML 2025). 189 Lean tasks. The best model, o4-mini, got 61.4% correct code, 51.0% sound and complete specs, and 3.6% proofs at pass@1 **[secondary]**. [34][35]
  - **"CLEVER: A Curated Benchmark for Formally Verified Code Generation"**. 161 HumanEval-derived Lean problems. Only one problem (number 53) was solved end to end, at 0.621%. I did not verify the authors. [36]
  - **"AlgoVeri: An Aligned Benchmark for Verified Code Generation on Classical Algorithms"** (ICML 2026). 77 algorithms. Best rates: Dafny 40.3%, Verus 24.7%, Lean 7.8% **[secondary]**. [37]

**F\***
- **What it is:** a proof-oriented language with an effect system. Microsoft released FStarDataSet (V1 and V2) for neural proof synthesis ("Towards Neural Synthesis for SMT-Assisted Proof-Oriented Programming").
- I found no 2026 agent-level results. [38][39]

**Takeaway for this cluster:**
- LLM success falls steeply from SMT-automated verifiers (Dafny) to Verus to Lean.
- It collapses when specifications must compose across functions (DafnyComp: 7%).
- It collapses when models must match real stateful implementations rather than textbook protocols (SysMoBench conformance: about 46%).

---

## 3. Languages and DSLs for LLMs, or designed for agents to write

These LLM-calling languages have no model-checked state or invariants:
- **BAML (BoundaryML)** markets itself as "the programming language for agents". It provides typed prompt functions, one-line model swapping, multi-language code generation, and "schema-aligned parsing" of LLM output. It guarantees types at the LLM boundary, not workflow state, invariants or durability. [40][41]
- **DSPy** lets you declare LM programs as signatures and modules, then compile them with optimizers. It targets prompt and weight quality, not correctness guarantees. [42]
- **LMQL** and **Guidance / llguidance** constrain decoding: regex, grammar, type and length constraints on token generation. The guarantee is syntactic validity of each output. [43][44]
- **Microsoft POML** (Prompt Orchestration Markup Language) is HTML-like markup for structuring prompts. [45]

Languages explicitly designed for AI or coding agents:
- **Vercel Labs "Zero"** (introduced 15 May 2026 by Chris Tate; InfoQ report dated 6 Aug 2026).
  - An experimental systems language whose primary audience is agents.
  - The compiler emits JSON diagnostics with stable codes (for example NAM003) and typed repair IDs.
  - Effects are explicit through a `World` capability parameter.
  - Since v0.3.0 it is "graph-first": a binary `zero.graph` is the compiler input, and `.0` text files are projections. Agents edit through `zero query` and `zero patch`, and patches are guarded by graph hashes.
  - It is the clearest example of a language designed for agents. It has no state-machine semantics, no model checking and no runtime governance. [46][47]
- **MoonBit** claims an "AI-native" toolchain:
  - a flattened, linear code layout;
  - mandatory top-level type signatures;
  - an AI sampler that checks syntax locally and semantics globally, with backtracking;
  - a dedicated code agent, MoonBit Pilot.
  - Its guarantees are compile-level only. [48][49]
- A February 2026 practitioner survey (akitaonrails) ranks Lean 4, F\* and Idris 2 as closest to an "LLM-native" ideal, with Dafny in the next tier. It builds a toy "PACT-Lang" that compiles to Rust. This is opinion, not evidence. [50]

**What this cluster lacks:** none of these define programs as state machines with contracts checked before execution.

---

## 4. Durable execution runtimes and agent runtimes

| System | State machine? | Replay / journal | Determinism constraint on workflow code | Source |
|---|---|---|---|---|
| **Temporal** | No (imperative code) | Event History; a worker replays the code and compares the Commands it produces against history | Yes: the workflow must produce "the same Commands in the same sequence given the same input"; side effects go in Activities. OpenAI Agents SDK integration exists | [51][52] |
| **Restate** | Virtual objects (keyed, stateful handlers) | A journal records each step; on recovery "completed steps are replayed from the journal (no re-execution)" | The docs page I read did not state a rule; in practice non-determinism is wrapped in `ctx.run()` | [53] |
| **DBOS** | No | Checkpoints in Postgres; resumes from the last completed step | Yes: a workflow "must be deterministic: if called multiple times with the same inputs, it should invoke the same steps with the same inputs in the same order" | [54][55] |
| **Inngest** | No | Step results are memoized; the function re-runs and completed steps are injected | Non-deterministic logic "must be placed within a `step.run()` call" | [56] |
| **AWS Step Functions** | **Yes** (Amazon States Language) | Execution history | Declarative states; no user-code determinism rule. Aug 2026: a "Copy agent prompt" feature sets up Claude Code, Kiro, Cursor and others with an MCP server and an ASL skill | [57] |
| **AWS Lambda durable functions** | No | Checkpoint and replay model | A replay model like Temporal's (details not verified here) | [58] |
| **Cloudflare Workflows** | No | Durable steps, `step.sleep` and `waitForEvent`. "Dynamic Workflows" (May 2026) lets "an agent literally write its own run(event, step) function as a durable plan" | Step-based | [59][60] |
| **LangGraph** | Graph of nodes (Pregel-style supersteps) | Checkpointers per thread; time travel | Side effects should be wrapped in tasks (not verified here) | [61] |
| **Microsoft Agent Framework** | Graph workflows (executors and edges) | Checkpoint at the end of each superstep. Since Python 1.13.0, entry and response checkpoints make runs "fully replayable" | Not stated | [62] |
| **Google ADK** | Sequential, Loop and Parallel agents | Event-sourced resume | Tools run "at least once, and may run more than once" when a workflow resumes; the developer must make them idempotent | [63] |
| **OpenAI Agents SDK** | No | Sessions; durability via the Temporal integration | Guardrails on input, output and tools, with tripwires | [52][64] |
| **Claude Agent SDK** | No | n/a | Permission pipeline: hooks, then deny rules, then ask rules, then permission mode, then allow rules, then the `canUseTool` callback. A `PreToolUse` hook deny applies even in bypass mode | [65] |

A related critique: Diagrid (Yaron Schneider, 25 Feb 2026), "Why Checkpoints Aren't Durable Execution". It argues that LangGraph, CrewAI and Google ADK save state but leave failure detection and guaranteed completion to the developer. [66]

**Takeaway for this cluster:**
- Determinism is enforced by convention and replay checks at runtime (Temporal's non-determinism errors).
- No runtime here checks invariants over the workflow's state space before running.
- Only Step Functions is a true declared state machine, and it has no invariants or model checking.

---

## 5. Agent governance and policy runtimes

- **AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents** (Haoyu Wang, Christopher M. Poskitt, Jun Sun; ICSE 2026).
  - A DSL of rules made of triggers, predicates and enforcement actions.
  - Prevents over 90% of unsafe code-agent executions, with overhead in milliseconds. [67]
- **Invariant Labs Guardrails** (17 Apr 2025; Invariant was later associated with Snyk). A contextual rule language over agent traces, with flow rules such as `(call: ToolCall) -> (call2: ToolCall)`, for example get_inbox followed by send_email. It is deployed as an MCP and LLM gateway proxy. [68][69]
- **Dogwood** (AWS; Marc Brooker, Joseph Tassarotti, Jean-Baptiste Tristan; 6 Aug 2026).
  - A superset of Cedar with temporal conditions over tool-call event traces: `formerly`, `count_within`, `count_distinct_within`, `sum_within`.
  - Any valid Cedar policy is a valid Dogwood policy.
  - It uses runtime verification at the tool-call boundary. This is the closest match to "sequence rules as policy as code". [70]
- **Policy Compiler for Secure Agentic Systems (PCAS)** (Palumbo, Choudhary, Choi, Chalasani, Jha). Datalog-style policies over a causal dependency graph of agent events, enforced by a reference monitor. It reports 1.68 to 2.93 times better compliance than baseline LLMs. [45 note: fetched page]
- **Microsoft Agent Governance Toolkit** (2 Apr 2026, MIT). Seven packages (Agent OS policy engine, Mesh identity, Runtime, SRE, Compliance and others). Policies can be YAML, OPA Rego or Cedar. It claims <0.1 ms p99 enforcement and coverage of the OWASP Agentic top 10. [71]
- **NVIDIA OpenShell.** A sandboxed runtime:
  - Landlock limits the filesystem;
  - hot-reloadable policies control the network;
  - seccomp limits processes;
  - credential scoping restricts secrets.
  - Policies are declarative YAML. It explicitly runs Claude Code, Codex, OpenCode and Copilot CLI. [72]
- **NVIDIA NeMo Guardrails / Colang 2.0.** An event-driven flow language with "multiple parallel flows and advanced pattern matching over the stream of events", aimed at conversational rails. [73]

**Takeaway for this cluster:**
- These systems enforce policy on the trace at runtime, by allow, deny or halt.
- None of them check policies against a declared program model before execution.
- None of them tie the policy to the program's own state machine.

---

## 6. Evidence on how coding agents fail on stateful code

- **SysMoBench** (above): agents model textbook behaviour, not the implementation. Conformance averages about 46%. [10]
- **DafnyComp**: composition of contracts is the failure point, with 7% verification across 13 models. [27]
- **"CONCUR: Benchmarking LLMs for Concurrent Code Generation"** (Jue Huang, Tarek Mahmud, Corina Pasareanu, Guowei Yang; 2026). 43 textbook concurrency problems plus 72 mutants, 115 in total. It reports "limitations of current models"; I did not obtain its numbers. [74]
- **"SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks"** (Orlanski et al., 25 Mar 2026). 20 problems and 93 checkpoints.
  - No agent solved any problem end to end across 11 models. The best checkpoint solve rate was 17.2%.
  - Verbosity rose in 89.8% of trajectories and structural erosion in 80%.
  - Agent code was 2.2 times more verbose than 48 human repositories. [75]
- **"SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios"**. 48 tasks averaging 21 files. GPT-5 with OpenHands scored 21%, against 65% on SWE-bench Verified **[secondary]**. [76]
- **"Evaluating Agentic Code Repair Capabilities in Distributed Systems"** (Yan et al., 2026). DDBench has 60 historical bugs from 13 distributed systems. Model performance spans 61 points. Debugging context (logs, traces, runtime state) adds 18.1 points in aggregate. [77]
- Other benchmarks seen by title only: SWE-CI, FeatureBench, RoadmapBench, and "Agora: Toward Autonomous Bug Detection in Production-Level Consensus ...". A 2026 audit raised quality concerns on SWE-bench Pro (about 30%, per KDnuggets **[secondary]**). [78][79]

---

## Gaps: what no single system combines

Based only on the items above:

1. **Program equals checked model.** Stateright comes closest, and it has no agent angle.
   - P, Quint, TLA+ and Alloy check a model that is separate from the code.
   - The Quint and Specula workflows bridge the gap with model-based testing or trace validation, after the fact.
   - None is a production runtime.
2. **Exhaustive pre-execution checking and a durable runtime.**
   - Temporal, DBOS, Restate, Inngest, Cloudflare and LangGraph journal and replay. They impose determinism by convention.
   - None of them check invariants over the workflow's reachable states before running.
   - Step Functions declares a state machine but has no contracts.
3. **Governance tied to program semantics.**
   - AgentSpec, Invariant, Dogwood, PCAS, AGT and OpenShell enforce rules on runtime traces or sandbox boundaries.
   - None of them verify policy against a declared program model ahead of time.
   - None share a journal that is also the replay log.
4. **A language designed for agents with verification.**
   - Zero and MoonBit optimise for agents (structured diagnostics, graph patching, a constrained sampler) with compile-level guarantees only.
   - The verification languages (Dafny, Verus, Lean) are not designed around agents or around stateful and durable execution.
5. **Evidence supports a finite, state-machine-scoped target.**
   - LLMs do well on SMT-automated, local proofs (Dafny 68 to 82 to 96%).
   - They do poorly on compositional specs (7%), on conformance to real stateful systems (about 46%), and on long-horizon evolution (SWE-EVO 21%; SlopCodeBench 0 end-to-end).
   - This is consistent with, but does not prove, the value of bounded, exhaustively checked state machines as the unit agents write.

---

## References

1. P repository. https://github.com/p-org/P
2. "Announcing the New Verification Backend for P". https://p-org.github.io/P/advanced/PVerifierLanguageExtensions/announcement/
3. "Systems Correctness Practices at Amazon Web Services" (CACM). https://dl.acm.org/doi/10.1145/3729175
4. "Systems Correctness Practices at AWS: Leveraging Formal and ..." (ACM Queue). https://queue.acm.org/doi/10.1145/3712057
5. "Do you need P? Systems Correctness Practices at AWS" (blog). https://sodkiewiczm.medium.com/do-you-need-p-systems-correctness-practices-at-aws-6140c2af6de2
6. P documentation. https://p-org.github.io/P/
7. "Reliable Software in the LLM Era" (Quint). https://quint.sh/posts/llm_era
8. quint-llm-kit. https://github.com/informalsystems/quint-llm-kit
9. Quint repository. https://github.com/informalsystems/quint/tree/main
10. "Can LLMs model real-world systems in TLA+?" (SIGOPS blog). https://www.sigops.org/2026/can-llms-model-real-world-systems-in-tla/
11. "SysMoBench: Evaluating AI on Formally Modeling Complex Real-World Systems". https://arxiv.org/pdf/2509.23130
12. "Can LLMs Write Correct TLA+ Specifications? Evaluating Natural-Language-to-TLA+ Generation". https://ai4fm.cs.luc.edu/papers/llm-tla-evaluation/
13. "Specula: Scaling formal specifications for autonomous model checking of system code". https://www.microsoft.com/en-us/research/publication/specula-scaling-formal-specifications-for-autonomous-model-checking-of-system-code/
14. "GenAI-accelerated TLA+ challenge" (TLA+ Foundation). https://foundation.tlapl.us/challenge/index.html
15. "TLA-Prover: Verifiable TLA+ Specification Synthesis via ..." https://arxiv.org/html/2606.06133v1 ; "TLA+-Bench" https://arxiv.org/pdf/2607.23425 ; "Towards Language Model Guided TLA+ Proof Automation" https://arxiv.org/pdf/2512.09758 (titles only)
16. Alloy 6. https://alloytools.org/alloy6.html
17. "Time" (Alloy documentation). https://alloy.readthedocs.io/en/latest/language/time.html
18. Stateright. https://github.com/stateright/stateright
19. stateright::actor docs. https://docs.rs/stateright/latest/stateright/actor/index.html
20. "AI Agents" (Stately docs). https://stately.ai/docs/agents
21. "XState v5 is here". https://stately.ai/blog/2023-12-01-xstate-v5
22. "DafnyBench: A Benchmark for Formal Software Verification" (TMLR 2025). https://mlanthology.org/tmlr/2025/loughridge2025tmlr-dafnybench/
23. DafnyBench PDF. https://namin.seas.harvard.edu/pubs/dafnybench.pdf
24. "A benchmark for vericoding: formally verified program synthesis". https://huggingface.co/papers/2509.22908
25. vericoding-benchmark. https://github.com/Beneficial-AI-Foundation/vericoding-benchmark
26. POPL 2026 Dafny workshop entry. https://popl26.sigplan.org/details/dafny-2026-papers/13/A-benchmark-for-vericoding-formally-verified-program-synthesis
27. DafnyComp. https://dafnycomp.github.io/
28. "Local Success Does Not Compose: Benchmarking Large Language Models for Compositional Formal Verification" (ICLR 2026). https://mlanthology.org/iclr/2026/xu2026iclr-local/
29. "AxDafny: Agentic Verified Code Generation in Dafny". https://arxiv.org/abs/2606.32007 (title only)
30. "DafnyProver: Agentic Verified Code Generation in Dafny" (ICML 2026). https://icml.cc/virtual/2026/82473 (title only)
31. Verus Proof Synthesis Leaderboard. https://microsoft.github.io/verus-proof-synthesis/
32. "AutoVerus: Automated Proof Generation for Rust Code". https://dl.acm.org/doi/pdf/10.1145/3763174
33. de Moura, "When AI Writes the World's Software, Who Verifies It?" https://leodemoura.github.io/blog/2026-2-28-when-ai-writes-the-worlds-software-who-verifies-it/
34. "VERINA: Benchmarking Verifiable Code Generation" (review). https://www.themoonlight.io/en/review/verina-benchmarking-verifiable-code-generation
35. Verina repository. https://github.com/sunblaze-ucb/verina
36. "CLEVER: A Curated Benchmark for Formally Verified Code Generation". https://openreview.net/pdf?id=pqNFDA2TFm
37. "AlgoVeri: An Aligned Benchmark for Verified Code Generation on Classical Algorithms" (review). https://www.themoonlight.io/en/review/algoveri-an-aligned-benchmark-for-verified-code-generation-on-classical-algorithms
38. microsoft/FStarDataSet. https://huggingface.co/datasets/microsoft/FStarDataSet
39. "Towards Neural Synthesis for SMT-Assisted Proof-Oriented Programming". https://arxiv.org/html/2405.01787
40. BAML. https://boundaryml.com/
41. "AI Agents Need a New Syntax" (BoundaryML, 24 Jan 2025). https://boundaryml.com/blog/ai-agents-need-new-syntax
42. DSPy. https://dspy.ai/current/
43. LMQL language reference. https://lmql.ai/docs/latest/language/reference.html
44. llguidance. https://github.com/guidance-ai/llguidance
45. POML. https://github.com/microsoft/poml ; PCAS, "Policy Compiler for Secure Agentic Systems" https://arxiv.org/html/2602.16708v2
46. "Vercel Labs Ships Zero: a Graph-First Language Built So Agents ..." (InfoQ). https://www.infoq.com/news/2026/08/vercel-ships-zero-ai/
47. zerolang releases. https://github.com/vercel-labs/zerolang/releases
48. "MoonBit: Exploring the design of an AI-Native Language Toolchain". https://www.moonbitlang.com/blog/moonbit-ai
49. "Introducing MoonBit Pilot". https://www.moonbitlang.com/blog/intro-moonbit-pilot
50. "AI Agents: What Would Be the Best Programming Language for LLMs?" https://akitaonrails.com/en/2026/02/09/ai-agents-best-programming-language-for-llms/
51. Temporal Event History (TypeScript). https://docs.temporal.io/encyclopedia/event-history/event-history-typescript
52. "Production-ready agents with the OpenAI Agents SDK + Temporal". https://temporal.io/blog/announcing-openai-agents-sdk-integration
53. Restate, "Durable Agents". https://docs.restate.dev/ai/patterns/durable-agents
54. "Why DBOS?" https://docs.dbos.dev/why-dbos
55. DBOS Workflows tutorial. https://docs.dbos.dev/typescript/tutorials/workflow-tutorial
56. "How Inngest Functions Execute". https://www.inngest.com/docs/learn/how-functions-are-executed
57. "Set up your AI coding agent to build with AWS Step Functions" (19 Aug 2026). https://aws.amazon.com/blogs/compute/set-up-your-ai-coding-agent-to-build-with-aws-step-functions/
58. AWS Durable Execution SDK, Key Concepts. https://docs.aws.amazon.com/durable-execution/getting-started/key-concepts/ (not fetched)
59. "Cloudflare Ships Dynamic Workflows ..." (InfoQ). https://www.infoq.com/news/2026/05/cloudflare-dynamic-workflows/
60. "Cloudflare Workflows is now GA". https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/
61. LangGraph Persistence. https://docs.langchain.com/oss/python/langgraph/persistence
62. "Microsoft Agent Framework Workflows - Checkpoints". https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
63. ADK "Resume Agents". https://adk.dev/runtime/resume/
64. OpenAI Agents SDK Guardrails. https://openai.github.io/openai-agents-python/guardrails/
65. Claude Agent SDK "Configure permissions". https://code.claude.com/docs/en/agent-sdk/permissions
66. "Why Checkpoints Aren't Durable Execution" (Diagrid). https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows
67. "AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents". https://ink.library.smu.edu.sg/sis_research/10278/
68. "Introducing Guardrails" (Invariant Labs). https://invariantlabs.ai/blog/guardrails
69. Invariant repository. https://github.com/invariantlabs-ai/invariant
70. "Introducing Dogwood: runtime verification for AI agents". https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/
71. "Introducing the Agent Governance Toolkit". https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/
72. "Overview of NVIDIA OpenShell". https://docs.nvidia.com/openshell/about/overview
73. NeMo Guardrails Colang 2.0 overview. https://docs.nvidia.com/nemo/guardrails/colang_2/overview.html
74. "CONCUR: Benchmarking LLMs for Concurrent Code Generation". https://awesomepapers.io/ai-for-code/papers/2603.03683
75. "SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks". https://huggingface.co/papers/2603.24755
76. "SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios" (review). https://liner.com/review/sweevo-benchmarking-coding-agents-in-longhorizon-software-evolution-scenarios
77. "Evaluating Agentic Code Repair Capabilities in Distributed Systems". https://awesomepapers.io/ai-agents/papers/2608.14863
78. "Top 10 Open-Source Benchmarks for AI Coding Agents in 2026" (KDnuggets). https://www.kdnuggets.com/top-10-open-source-benchmarks-for-ai-coding-agents-in-2026
79. "Agora: Toward Autonomous Bug Detection in Production-Level Consensus ..." https://arxiv.org/html/2605.29910 (title only)

---

## Glossary

- **Vericoding:** LLM generation of code together with a machine-checked proof that it meets a formal spec (term from ref 24).
- **Durable execution:** a runtime that persists step results (a journal or checkpoints) so a workflow resumes after a crash without redoing completed steps.
- **Replay determinism:** the constraint that workflow code, rerun against its history, issues the same steps in the same order (Temporal, DBOS).
- **Conformance (SysMoBench):** whether a spec's behaviours match traces from the real implementation.
- **Runtime verification:** checking a policy or temporal property against the live event trace, as opposed to model checking before execution.
