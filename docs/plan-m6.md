# poly · Plan for milestone M6, agents

*Cognitive Fab · October 2026 · plan, written before any M6 code · on branch `m4` in the worktree `poly-m4` · from PT18's M6 row and the M6 planning list in `decisions-m5.md`, after M5b's record (section 11 of `plan-m5.md`)*

This plan covers milestone M6 of PT18: workflow lowering, the MCP server, the language server, the Claude Code plugin and `poly new`, with AC5 as the gate. It follows the ruling in `decisions-m5.md` that the MCP server and the language server are host-neutral, that the Claude Code plugin is one thin adapter over them, and that a DeepSeek Harness plugin is a second adapter, built once its plugin API is declared stable. It fixes what was found before planning, the packages touched, the order of work, how each gate item is tested, how the two-host claim is shown without a model call on a check path, and the spec issues found, numbered from S164. The owner ruled on it in `decisions-m6.md`; this version carries those rulings.

## 1. What was read, and what was found before planning

The documents read: `CLAUDE.md`; PT18's M6 row; `decisions-m5.md` (the M6 planning list, the S162 ruling and the conditions for closing M5b); PF5, PF9 and AC5 of `01-functional-spec.md`; PT10, PT12, PT14 and PT17 of `03-technical-spec.md`; section 5 of `02-architecture.md` and its scope table; the polyflow and polycrew sections of `research/primitive-inventory.md`. The engines were read at their sources: polyflow at `C:\Users\jjdub\code\polyflow` (5170add, 0.4.2), polycrew beside it, and the polygraph checkout's skills.

| Finding | Where | Consequence |
|---|---|---|
| poly has no workflow front end. `workflow` is in the parser's `LATER_TOP_LEVEL`, so a `workflow` block is skipped with `PL0901`. PT10's syntax is not in the lexer, the AST or the embedded surface. | `poly-lang/src/parser.ts` | M6 starts with a grammar, a checker and a lowering for `workflow`, on both surfaces (PT2.5). |
| polyflow's core is Apache-2.0. Only its Temporal plugin, certificate signer and platform CLI are BUSL, and poly already vendors two Apache packages of that platform. | `polyflow/package.json`, `LICENSE`; `vendor/polyflow/PROVENANCE.md` | The polyflow server and library can be vendored as the other engines are, without a licence ruling (unlike S145). |
| A polyflow workflow is a directory: `polyflow.workflow.json` and five machine files. The descriptor may name each file (`contract`, `machine`, `effects`, `manifest`, `effectInvariants`, `invariants`); the defaults name the module `machine.cjs`. | `polyflow/src/library.mjs` `_read` | poly's lowered `next.cjs` can be named in the descriptor (`"machine": "next.cjs"`), so the machine files need no renaming. |
| polyflow imports `effect-invariants.mjs` unconditionally when it certifies a workflow. poly writes that file only when the machine has path properties. | `library.mjs` `certify`; `poly-lower/src/lower.ts` | A workflow's lowering must always write it, with an empty list when there are no path properties (S165). |
| polyflow admits a workflow only if `check-effects` over the contract's domain finds no violation and is not bounded, at depth 12 and 50,000 paths. A bounded run is a refusal. | `library.mjs` `certify` | A workflow poly reports `CLEAN` could still be refused by polyflow if poly's effects stage ran at other bounds. The workflow's stage must use polyflow's bounds (S165). |
| polyflow runs workflows on polyrun, resolved from `POLYFLOW_POLYRUN`, `@cognitive-fab/polygraph`, or a sibling checkout. It starts a run by creating the instance with the descriptor's `inputAction` and the input as data, and derives the run key from the key template. | `polyflow/src/polyrun.mjs`, `daemon.mjs` | `POLYFLOW_POLYRUN` can point at `vendor/polygraph`, which holds `polyrun/src/index.mjs`. The input action is a creation action, so poly's checker can require one. |
| polyflow's MCP server is stdio JSON-RPC written by hand, with no SDK. It serves six tools (`workflow_list`, `workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal`, `workflow_journal`), each with an `outputSchema`. Its installer prints entries for Claude Code, Kiro, Hermes, DeepSeek Harness (`dsh`, through `dsh-mcp-client` in `cordis.yml`) and NeMo. | `polyflow/src/mcp.mjs`, `tools.mjs`, `bin/polyflow-install.mjs`, README | poly's MCP server can follow the same shape and add no dependency. DeepSeek Harness validates `structuredContent` against `outputSchema`, which PF9.2's published schemas give. |
| polyflow's descriptor carries a `certified` field that it only lists. It does not verify a poly certificate. | `library.mjs`, `tools.mjs` | Under polyflow, polyflow's own `certify` is the admission gate. poly's certificate can be recorded in the descriptor but is not checked there (S164, E9). |
| A workflow run under polyflow runs on polyflow's daemon, not on `poly-runtime`: no poly gate, ledger, claims or lineage applies to it. | PT10, AC5 | AC5 ("unchanged polyflow tools") is met on polyflow's runtime. What poly's governance adds to a workflow is a later question (S164). |
| poly has one command-line entry, `poly` in `poly-check`, and no MCP server, language server or plugin. The root `package.json` has no runtime dependency. | `packages/poly-check/package.json`, `src/cli.ts` | The host-neutral core is new. It is written without an SDK, as polyflow's server is, so no dependency enters. |
| polygen is a Claude Code skill and agent in the polygraph plugin that drafts SAM modules, not poly source. | `polygraph/skills/polygen`, `agents/` | `poly new` cannot call polygen and keep its output: it follows polygen's method (draft, check, repair) with `poly check` as the oracle (S169). |
| The language server's split is fixed by PT14: stages 0 to 2 on every edit, stages 3 and later on save or on request. | PT14; architecture section 5 | The server reuses `checkFile` with a stage limit. |
| `poly-check`'s M3 runner test failed on this machine because the isolated M3 account held `plugins` and `skills` directories. | `test/m3-runner.test.mjs`; `plan-m5.md` section 11 | Fixed in M5b: the test loads the runner with a stand-in home, and the gate no longer reads the account. |

Nothing was measured while planning. M6's first measurements are the M5 findings' (step 1).

## 2. Engine changes, for the owner's list

| Id | Engine | Change | Needed for | Without it |
|---|---|---|---|---|
| E1, E2, E5, E8 | polyrun, polyflow, polyaxion | As listed for M4 and M5. | K4; one verification tool; S141; escalated discharge | Unchanged. |
| **E9** (optional) | polyflow | Verify a poly certificate named in the descriptor (`certified`) before registering a workflow: signature, artefact digests, and the workflow's descriptor digest. | S164: poly's admission as polyflow's gate | polyflow's own `certify` admits the workflow, and poly's certificate is recorded but not checked by polyflow. M6 does not need it. |

No other engine change is proposed. polyflow's server and library are copied unchanged into `vendor/polyflow` from 5170add, beside the two platform packages already there, each file pinned by hash. The checkout has uncommitted edits in `bin/`; files are taken with `git show 5170add:<path>`, as before.

## 3. A host-neutral core with thin host adapters

The ruling asks for one core that knows no host and adapters that hold only a host's configuration. The plan makes the boundary checkable.

- **The command registry.** Each command of PT14 is defined once: its name, its input schema, its output schema, and a function from input to a JSON result. The CLI, the MCP server and the language server are three projections of the registry. Human-readable output is rendered from the JSON (PF9.2).
- **The MCP server** (`poly mcp`) serves the registry's commands as tools over stdio, with `outputSchema` and `structuredContent`. Commands that take a person key (`poly approve`, `poly accept`) are not exposed, as PT14 says.
- **The language server** (`poly lsp`) publishes diagnostics, formats, offers the typed fixes of PT12.1 as code actions guarded by their digests, and serves every registry command through `workspace/executeCommand` (PF9.1).
- **Adapters.** An adapter is a directory of host configuration: the Claude Code plugin (`adapters/claude-code`) and, when ruled, the DeepSeek Harness entry (`adapters/deepseek-harness`). Each names `poly mcp` and `poly lsp` as commands to launch. An adapter holds no code beyond a launcher of a few lines, if its host needs one.
- **Enforced.** The import-boundary check gains three rules: the core imports no host name or host SDK; an adapter imports nothing from `packages/` except through the `poly` binary; and only `poly-new` may import a model client, and nothing on a check path imports `poly-new`.

## 4. Packages and what changes in each

| Package | M6 changes |
|---|---|
| `poly-core` | AST for `workflow` (machine, input action, key template and fields, tool map); codes for the workflow checks (S166). |
| `poly-lang` | Grammar and formatter for PT10's `workflow` block. |
| `poly-embed` | The `workflow(…)` combinator, so both surfaces keep one AST (PT2.5). |
| `poly-lower` | `polyflow.workflow.json`, naming `next.cjs` as the machine; `effect-invariants.mjs` always written for a workflow's machine (S165); broken variants for the new artefact. |
| `poly-ref` | Read-back of the descriptor against the source (name, input action, key, tools, file names), under the standing rule for artefacts. |
| `poly-check` | The workflow stage: the effects stage at polyflow's bounds for a workflow's machine (S165); the CLI rewired over the registry, with its output unchanged. |
| `poly-agent` (new) | The command registry, its published JSON schemas (PF9.2), the MCP server and the language server. No dependency. |
| `poly-new` (new) | `poly new`: a provider interface, the draft-check-repair loop with `poly check` as the oracle, and a recorded provider for tests (S169). The only package that may call a model. |
| `adapters/claude-code` (new) | The Claude Code plugin: manifest, MCP server entry, language server entry, and a skill that tells the agent how to write and check poly. |
| `adapters/deepseek-harness` (new, when ruled) | The `dsh-mcp-client` entry for `cordis.yml`, printed by `poly install --host dsh` as polyflow's installer prints its own (S170). |
| `vendor/polyflow` | The server and library (`src/`, `bin/polyflow-mcp.mjs`), unchanged, beside the platform packages. |
| `scripts/check-boundaries.mjs` | The three rules of section 3. |
| `test/` | One file per gate item (section 6); the fault lists gain the descriptor's broken variants. |

## 5. Order of work

Each step ends with a commit, and every defect gets a regression test that fails first. A confirmation test (one that cannot fail first, de66918) gets a seeded control that must fail.

0. **Vendoring.** `m4` is at `main`'s 34305c8, which already contains `m4`'s merge, so nothing is merged. polyflow's server and library vendored with provenance and hashes; a smoke test runs polyflow's own `customer-brief` workflow through the vendored server with `POLYFLOW_POLYRUN` set to `vendor/polygraph`, from `workflow_start` to a terminal state, by a scripted MCP client.
1. **The M5 findings, measured.** Memory per file checked, in one long process: the conformance and M3 run programs checked one after another, with the heap after each file. And the 53-second program, `experiments/m3/runs/T9-arm3-run4/deliveries/v3/src/system.poly`, stage by stage. If a leak is confirmed, it is fixed with a test that fails first; otherwise the measurements are recorded. M6's close does not depend on a speed-up.
2. **The workflow front end.** PT10's grammar on both surfaces, the AST, the formatter, and the checks of S166.
3. **The workflow lowering.** `polyflow.workflow.json` and the always-written `effect-invariants.mjs`; the read-back in poly-ref; the broken variants `workflow-tool` (a tool mapped to another kind) and `workflow-key` (a key field dropped) in the fault list; the workflow stage at polyflow's bounds; and the certificate's listing of every workflow as `ungated: polyflow runtime` (S164).
4. **AC5.** `customer-brief` written in poly (`conformance/m6/customer-brief.poly`), lowered, and loaded by the vendored polyflow server unchanged (section 6).
5. **The command registry.** Every PT14 command that exists, defined once with its schemas; the CLI over it; the schemas published under `schemas/` and checked against every command's output.
6. **The MCP server.** `poly mcp`, tested by a scripted client.
7. **The language server.** `poly lsp` on both surfaces, tested by a scripted client (S168).
8. **The Claude Code plugin.** `adapters/claude-code`, and `poly install --host claude-code`.
9. **`poly new`.** The provider interface, MCP sampling and the headless Claude Code provider, the loop, the recorded provider, the CLI command and the MCP tool (S169).
10. **The second host.** `poly install --host dsh` and the DeepSeek Harness adapter, if the owner has declared its plugin API stable (S170); otherwise listed as waiting.
11. **The M6 record**, the code review, and the gate from a clean build.

## 6. How each gate item is tested

Each test is written first and fails on the tree before its step.

| Gate item | Test | Fails first because |
|---|---|---|
| AC5 | `test/workflow-ac5.test.mjs`: `customer-brief` in poly is checked `CLEAN`, lowered, and its directory is loaded by the vendored polyflow server with no change to polyflow. A scripted MCP client lists it, starts a run for a date, takes each work order, reports each outcome, and reaches the terminal state; the same script against polyflow's hand-written `customer-brief` gives the same work orders, tools, targets and states, step for step, on the approve path and on the reject path. | No workflow front end. |
| AC5, controls | The same file: a poly workflow whose path property is violated is `FINDINGS` in `poly check` and is refused by polyflow's own `certify`; the broken lowerings `workflow-tool` and `workflow-key` are caught by the read-back. | No lowering to break. |
| S165 | `test/workflow-ac5.test.mjs`: a workflow whose effects exploration exceeds polyflow's bounds is `INCONCLUSIVE` in `poly check`, and polyflow refuses it as bounded; a workflow `poly check` reports `CLEAN` is admitted by polyflow. | No workflow stage. |
| PF9.1, PF9.2 | `test/agent-registry.test.mjs`: every command of PT14 that exists is in the registry, the CLI, the MCP tool list and the language server's command list, with the stated exceptions; every command's JSON output on the conformance corpus validates against its published schema. | No registry. |
| MCP | `test/agent-mcp.test.mjs`: a scripted client initialises `poly mcp`, lists tools, calls `poly_check` and `poly_fmt` on fixtures and receives `structuredContent` that validates; `poly_approve` and `poly_accept` are absent. | No server. |
| Language server | `test/agent-lsp.test.mjs`, on a standalone module and an embedded one each: a scripted client opens a module with an error and receives the stage 0 to 2 diagnostics of `poly check`, at the same ranges; a save runs the later stages; a formatting request returns `poly fmt`'s text where the surface has a formatter; a code action applies a typed fix and is refused when its digest no longer holds. | No server. |
| Thin adapters | `test/adapters.test.mjs`: each adapter's files are configuration that launches `poly mcp` or `poly lsp`; the boundary check refuses an adapter that imports a package. | No adapters. |
| PF9.3 | `test/poly-new.test.mjs`: with a recorded provider, `poly new` drafts a module, runs `poly check`, feeds the diagnostics back, and stops at `CLEAN` or after five rounds; the draft is never admitted; with a provider that drafts an invalid module every round, the command ends with the last diagnostics and writes nothing admitted. The default provider is MCP sampling, then headless Claude Code under the user's login; no provider reads, logs or records an API key or the environment, and a test checks that no key variable is read. No test calls a model. | No command. |
| S164 | `test/workflow-ac5.test.mjs`: the certificate of a project with a workflow lists it as `ungated: polyflow runtime`, and no gate coverage is claimed for its effects. | No workflows. |
| M5 findings | `test/check-memory.test.mjs`, written only if a leak is confirmed: it checks a run of files in one process and fails while the heap grows with the number of files. Otherwise the measurements are recorded in the M6 record. | Only if a leak is found. |
| Two hosts | Section 7. | No adapters. |

## 7. The same workflow under two hosts

The planning list says M6's gate "shows the same workflow running unchanged under both hosts". A host is an agent harness, and an agent run calls a model, which no check may do. The plan splits the claim in two (S170).

- **In the gate, with no model.** For each host, the test reads the host entry `poly install` prints (Claude Code's `.mcp.json` entry and plugin manifest; DeepSeek Harness's `dsh-mcp-client` entry), launches exactly the command and arguments it names, and drives the AC5 script through that process. The same workflow directory, byte for byte, gives the same run under both entries. This shows that nothing host-specific sits between the host's MCP client and the workflow.
- **Reported, not gated.** One agent run of `customer-brief` under each host, made by the owner as M3's runs were, with its transcript and polyflow journal kept in `docs/m6/`. It is a demonstration, and it is listed as such.

DeepSeek Harness's half waits on the owner's declaration that its plugin API is stable. Until then it is listed as waiting, and the Claude Code half stands alone.

## 8. Spec issues

Numbered from S164; S163 is the ruling on the M3 runs (`decisions-m5.md`). Each has its proposal and the owner's ruling.

- **S164. Which runtime runs a workflow.** AC5 runs a poly workflow through unchanged polyflow tools, so it runs on polyflow's daemon and polyrun: no poly gate, ledger, claims or lineage applies to its effects, and polyflow's `certify`, not poly's certificate, admits it. *Proposal:* accept this for M6 and say it in PT10: a workflow is checked and lowered by poly and run by polyflow. poly's certificate digest is written into the descriptor's `certified` field, where polyflow lists it; E9 would make polyflow verify it. Running workflows on `poly-runtime`, under the gate, is left for a later milestone. *Alternative:* host polyflow's library inside `poly-runtime`, which changes how polyflow is used and is not AC5's test. *Ruled (`decisions-m6.md`):* Accepted, with the limit stated: PT10 says so, the certificate lists every workflow as `ungated: polyflow runtime` (PA0.4, G5), and running workflows on `poly-runtime` is a named PT18 item before the v1 release, at the latest with M8. E9 stays optional.
- **S165. A workflow's files and bounds.** *Proposal:* for a workflow's machine the lowering always writes `effect-invariants.mjs` (an empty list when there are no path properties), and the descriptor names `next.cjs` as the machine. The effects stage runs `check-effects` at polyflow's bounds (depth 12, 50,000 paths) for a workflow's machine and reports a bounded run `INCONCLUSIVE`, so that `CLEAN` in poly means admitted by polyflow. *Ruled (`decisions-m6.md`):* Accepted.
- **S166. Workflow checks.** *Proposal:* `workflow w runs M` names a machine of the same module; `input A` names a creation action of `M` (`PL6801`); every key field is a parameter of `A` and its pattern is a valid regular expression (`PL6802`); every effect kind of `M` maps to exactly one tool, and every mapped kind is an effect of `M` (`PL6803`). An unmapped kind is refused, since polyflow would hand out a work order with no tool. The codes are in PL6xxx, the agent and capability range of PT12.2. *Ruled (`decisions-m6.md`):* Accepted, with `PL6801` to `PL6803`.
- **S167. The host-neutral core.** *Proposal:* the package `poly-agent` holds the registry, the schemas, the MCP server and the language server; `poly mcp` and `poly lsp` launch them; adapters are configuration (section 3); the boundary check enforces it. *Ruled (`decisions-m6.md`):* Accepted.
- **S168. The language server and the two surfaces.** M3 has not yet said which surface agents use (PF9.4a), and typed fixes on the embedded surface wait for that answer (S70). *Proposal:* the server serves `.poly` and `.policy.poly` files, and embedded modules (`.ts` files that import poly's embed module) for diagnostics only; code actions for fixes are offered on the standalone surface only until M3's answer. *Ruled (`decisions-m6.md`):* Amended: M3's report applied the surface rule and the answer was embedded (`docs/m3/report.md` section 2.1). The server gives full support on both surfaces, typed-fix code actions included; embedded typed fixes exist since M3-3, and any kind found missing is M6 work, tested first. Whether the standalone surface stays in v1 is not M6's decision.
- **S169. `poly new` and the model.** PF9.3 names polygen, which drafts SAM modules. *Proposal:* `poly new` follows polygen's method with poly as the target: a provider drafts poly source from the description and a short grammar reference, `poly check` checks it, its diagnostics go back to the provider, and the loop stops at `CLEAN` or after five rounds. The draft is written with a header saying it is not admitted. The CLI's provider is the Anthropic Messages API (model `claude-opus-5-5`, key from the environment); the MCP tool uses the client's model through MCP sampling when the client offers it, and otherwise the CLI's provider. Tests use a recorded provider. *Alternative:* `poly new` runs polygen and translates its SAM module back to poly, which loses the source's structure. *Ruled (`decisions-m6.md`):* Amended: no per-token API spend. MCP sampling first, then headless Claude Code under the user's login; an API provider may exist behind the interface but is not the default, configured nowhere, and used by no test or gate; no provider reads, logs or records an API key or the environment; tests use the recorded provider. Five rounds.
- **S170. Two hosts in the gate.** *Proposal:* the gate shows both host entries launching the same server and running the same workflow, with no model (section 7); the agent runs under each host are reported, not gated. The DeepSeek Harness adapter is built once the owner declares its plugin API stable, and is listed as waiting until then. *Ruled (`decisions-m6.md`):* Accepted. M6 may close on the Claude Code half; the DeepSeek Harness half waits on the owner.
- **S172. A workflow machine with no path property (raised at step 3).** S165 proposed writing an empty `effect-invariants.mjs` for such a machine, but polyflow's admission (polyrun's `check-effects`) refuses a module that exports no invariant, so the empty file would only be refused there. polyflow's doctrine is that a workflow is admitted on rules a person can approve. *Proposal:* a workflow whose machine declares no path property is `PL6804 WORKFLOW_UNCHECKED`, an error at check, so poly never reports CLEAN for a workflow polyflow refuses. *Ruled (`decisions-m6.md`):* accepted, with `PL6804 WORKFLOW_UNCHECKED`; the interim `ERROR` is gone.
- **S171. Commands through the language server.** LSP has no channel for a command's JSON output except `workspace/executeCommand`. *Proposal:* PF9.1's "through a language server" means every registry command is an executable command of the server, returning its JSON; `poly approve` and `poly accept` are on the command line only, as on MCP. *Ruled (`decisions-m6.md`):* Accepted.

## 9. Risks

- **polyflow's run differs from the hand-written one for a reason outside the workflow.** The AC5 comparison is step for step over work orders, tools and states; a difference in polyflow's own journal fields that poly does not produce (timestamps, ids) is excluded by name, never by tolerance.
- **The Claude Code plugin format.** Which entries a plugin may declare (an MCP server, a language server, skills) is read from the host's documentation at step 8; an entry the host does not read is left out and said so, never assumed.
- **DeepSeek Harness's API is not stable.** Its half of the two-host claim may wait past M6. The plan keeps it separate so that M6 can close on the Claude Code half, if the owner rules so.
- **`poly new` quality.** A drafted module may never reach `CLEAN`. That is reported as the command's result; the check is never relaxed to let a draft through.

## 10. Record of M6, as it is built

**Step 0** (e6f1730). polyflow's server, its library closure, its licence and its `customer-brief` workflow are vendored unchanged from 5170add, pinned in `vendor/polyflow/PROVENANCE.md`. A scripted MCP client drives `customer-brief` through the vendored server on the vendored polygraph to `posted` and to `denied`; the test failed first.

**Step 1, the two findings left open from M5** (b007835, 6f246c2).

- *Memory over many files.* One process checked 1,437 sources in a row, the M3 runs included (`scripts/measure-check-memory.mjs`), in 2,552 s. The resident set went from 109 MB to 2,921 MB, which reproduces the 2.9 GB of the stopped gate. It rose in three jumps, each at one file with a large check: `experiments/m3/runs/T10-arm3-run1/deliveries/v0` (334 to 511 MB), `T9-arm3-run1/deliveries/v3` (753 to 1,456 MB) and `T9-arm3-run4/deliveries/v3` (1,502 to 2,865 MB). The heap after a full collection stayed between 33 and 291 MB and ended at 93 MB. So the 2.9 GB is memory the process kept after its largest explorations, not memory held live.
- *Memory over one file checked again.* Checking `conformance/m5/refund.poly` 200 times in one process (`scripts/measure-check-repeat.mjs`) kept about 23 KB per check after a full collection: 36.8 MB after 25 checks, 40.8 MB after 200. That is a leak: each check imported its lowered ES modules under a new timestamped URL, and an ES module is never unloaded. Fixed with a test that failed first (`test/check-memory.test.mjs`): the URL now carries the digest of the file's bytes. The same run now holds 36.3 MB after 25 checks and 36.8 MB after 200.
- *The 53-second program.* `experiments/m3/runs/T9-arm3-run4/deliveries/v3/src/system.poly`, checked alone (`scripts/measure-check-stages.mjs`), took 61 s: 60 s in its configuration `three-nodes`, which explores 134,172 global states and 2,024,676 global steps; translation validation and the model check of its machine took 0.6 s each. The time is the configuration's state space. Nothing is sped up; M6's close does not depend on it. In the long pass the slowest file was `T9-arm3-run4/snapshots/v3/7` at 80 s.

**Step 2** (190f0e6). The workflow front end on both surfaces and the checks `PL6801` to `PL6803`.

**Step 3** (bb43d59). The descriptor, its read-back and the broken lowerings `workflow-tool` and `workflow-key`; the `workflow` stage, which runs polyflow's own admission; the certificate's listing of each workflow as `ungated: polyflow runtime`. S165's empty `effect-invariants.mjs` cannot be admitted by polyflow, so S172 is raised.

**Step 4, AC5.** `conformance/m6/customer-brief.poly` is polyflow's `customer-brief` written in poly. It is checked `CLEAN`, and the vendored polyflow server, unchanged, admits and runs its lowered directory. A scripted MCP client drives the same three scripts through it and through the hand-written workflow: approve (5 steps, ends `posted`), deny (4 steps, ends `denied`) and an empty brief (2 steps, ends `denied`). The catalogue entries and every step's work order (tool, target, arguments, why) and state are equal, with one difference named in the test: on the deny path the hand-written workflow writes the reporter's free text into `reason`, outside its own contract's declared domain for `DENIED` (`"not-ready"`), and poly, which keeps the declared domain, writes `"not-ready"`. The control removes the approval check: `poly check` reports `PL4001` on `no-post-without-prior-approval`, and the workflow stage reports that polyflow refuses the workflow.

**S172 and E12** (208ec5f). A workflow whose machine declares no path property is `PL6804 WORKFLOW_UNCHECKED`, as ruled. E12, the deny-path defect in polyflow's own example, is on the owner's engine list; the vendored copy is unchanged.

| Step | What was built | Commits |
|---|---|---|
| 5 | The command registry (`packages/poly-check/src/commands.ts`, re-exported by `poly-agent`, S167 amended): each command once, with its input and output schemas, published under `schemas/`; the command line runs over it | eab505c |
| 6 | `poly mcp`: the registry's commands as MCP tools, with `structuredContent`; `poly approve` and `poly accept` absent | 38baba2 |
| 7 | `poly lsp` on both surfaces: stages 0 to 2 on each edit, the rest on save, formatting on the standalone surface, typed fixes as code actions, the registry as `workspace/executeCommand` (S168, S171) | 9b96c38, a7ab9fb |
| 8 | The Claude Code plugin (`adapters/claude-code`), its marketplace entry, and `poly install --host claude-code`; validated in a stand-in Claude configuration, and listed as not run where `claude` is not installed | 34205a1, 24acb8b |
| 9 | `poly new`: MCP sampling first, then headless Claude Code under the user's login, refused while an API key or cloud-billing variable is present (checked by name); five rounds; never admitted; tests use recorded drafts and a stand-in `claude` only | 6654661, 4ecddf8, 196340d |
| 10 | The second host: **waiting** (S170). DeepSeek Harness has not declared its plugin API stable; `adapters/dsh/install.json` says so, and `poly install --host dsh` refuses with that reason | 34205a1 |
| 11 | The code review, this record, and the gate from a clean build | 7ad6bfb, ea4075c, 9190006, f29118d |

**Fixes found on the way, each with a test that failed first.** The gate after step 6 found the new scripts without the tree guard, and an account check that needed more than 10 minutes under load (1445bef); its two child runs are timed in every gate report, and it now runs after the suite (a7ab9fb). The M3 cleanup cap test failed under gate load, because the cap's clock started before the stand-in CLI had; it was reproduced with a suspended launcher (`test/fixtures/suspend.ps1`) and fixed by starting the clock at the stand-in's ready marker, with the assertion unchanged (344c1cb). Polywatch found the headless provider passing the prompt in its arguments and leaving its stdin without an error listener; both were fixed (4ecddf8) and tested with a stand-in `claude` that failed against the provider before the fix (196340d).

### The code review of M6

Four reviewers read `e6f1730..d9c3f11` in four parts (workflows; the registry, the MCP server and `poly new`; the language server; the boundary check, the adapters and the vendored engines), and each reproduced every finding with a script under `.poly/review-m6-a` to `review-m6-d`. They found 26. Each was fixed with a test in `test/review-m6-a.test.mjs` to `review-m6-d.test.mjs` that failed on the tree before its fix.

| Findings | What was wrong | Fix | Commit |
|---|---|---|---|
| A-F1 | a workflow name such as `../../../victim` became a path, and the lowering removed a directory outside the build | `PL1201`; the lowering writes and removes only directly under `.poly/build/workflows` | 7ad6bfb |
| A-F2, A-F3 | `PL6802` tested some values of a key field only, took an empty value, and allowed two patterns for one field | every declared value tested (a range in full up to a million, an enum by member, a bool); an empty value and a second pattern refused | 7ad6bfb |
| A-F4, A-F5 | two workflows could map one effect kind two ways, and a name could be used twice across a project, though a project's workflows are one polyflow library | `PL6803` in a module and across a project; `PL1002` for a name used twice | 7ad6bfb |
| A-F6 | a renamed workflow left its descriptor, and a leftover directory stopped the workflow stage | stale descriptors removed; the stage reads its own workflow only | 7ad6bfb |
| A-F7 | a workflow in a module with a dotted name was not admitted | the machine is found by its full id | 7ad6bfb |
| B-F1 | the headless provider started while Bedrock or Vertex billing was switched on | refused, checked by name only | ea4075c |
| B-F2 | `poly new --into` could overwrite a module that was not its own draft | refused before any provider runs | ea4075c |
| B-F3, B-F4 | the MCP server did not answer a ping while a call waited on sampling, and replied to a client's response | ping answered at once; no reply to a response | ea4075c |
| B-F5 | the module was taken from the first fenced block of an answer | the `poly` block, read fence by fence | ea4075c |
| B-F6 | `poly bench gate` with bad sizes lost its usage text | the usage text again | ea4075c |
| C-F1, C-F2 | a header with no `Content-Length` wedged the language server; a request whose handler threw, or a body that was not JSON, got no reply | the header dropped; `-32603` and `-32700` (id null) | 9190006 |
| C-F3 | formatting, code actions, `poly fmt` and `poly fix` printed the parsed module and deleted a `world` or a migration the parser skips; an action's title cut the fix id | all four refuse a module with `PL0901`; the whole id in the title | 9190006 |
| C-F4 | two servers on one workspace built in one folder and deleted each other's lowerings | a folder per server process | 9190006 |
| C-F5 | the verdict, stages not run and vacuous properties never reached the editor | an information diagnostic `verdict` for any verdict other than CLEAN (PT12.3a) | 9190006 |
| C-F6 | a command with no root ran in the server's working directory | the workspace is the default root and project | 9190006 |
| C-F7 | a killed server left its folder behind; an `untitled:` buffer threw | folders named by process id and swept by the next server; untitled buffers checked under the server's folder | 9190006 |
| D-F1 | a host's name was missed with a space, in capitals or as `'claude'`, and a host SDK reached by a template or computed import passed | matched in any case and spelling, poly-new alone exempt; SDK names refused in strings; two lines of the core reworded | f29118d |
| D-F2 | rule 4 was bypassed by a subpath of `@poly/new`, a relative path, a name built at run time, and `getBuiltinModule` | each refused | f29118d |
| D-F3 | `.mts` and `.cts` sources were not checked | checked | f29118d |
| D-F4 | an adapter's JSON could launch any command or declare hooks | it launches `poly mcp`, `poly lsp` or polyflow's server (S164) only, and declares no hooks | f29118d |
| D-F5 | the `package.json` files written for poly were not pinned, so an added file or a redirected export passed the vendor test | a second table per `PROVENANCE.md`; every file under `vendor/` must be in one of the two | f29118d |
| D-F6 | the install test left its project in `.poly/` | named by its process and removed once its servers exit | f29118d |

**The gate, item by item.**

| Item | Status | Measured |
|---|---|---|
| AC5 | **passes** | `customer-brief` in poly runs through the unchanged polyflow server step for step as the hand-written one, on approve, deny and an empty brief, with the deny-path difference named (E12). |
| AC5, controls | **pass** | The approval check removed is `PL4001` and refused by polyflow's own admission; `workflow-tool`, `workflow-key` and `drop-timer-target` are caught by the read-back. |
| S164 | **passes** | Every workflow is listed in the certificate as `ungated: polyflow runtime`. |
| S165, S172 | **pass** | The workflow stage runs polyflow's admission at depth 12 and 50,000 paths; a bounded run is `INCONCLUSIVE`; a machine with no path property is `PL6804`. |
| PF9.1, PF9.2 | **pass** | Every command is in the registry, the command line, the MCP tool list and the language server's commands, with its published schemas, and its output validates against them. |
| MCP, language server | **pass** | Scripted clients, both surfaces, the review's protocol cases included. |
| Thin adapters | **pass** | Configuration only, launching the three allowed servers, no hooks; the plugin passes `claude plugin validate` in a stand-in configuration where `claude` is installed, and is listed as not run where it is not. |
| PF9.3 | **passes** | Recorded drafts only: CLEAN within five rounds, the last diagnostics after five, never admitted; the key and cloud-billing refusals tested by name with stand-in variables. |
| Two hosts | **Claude Code half passes; DeepSeek Harness half waiting** (S170) | The entries `poly install` prints are launched exactly as printed and run AC5's workflow. |
| M5 findings | **measured** | The leak over one file checked again is fixed (`test/check-memory.test.mjs`); the 2.9 GB is memory kept after the largest explorations, not held live; the 53-second program is its configuration's state space. |

**The gates.**

| Gate | Commit | Tests (suite and `test/after/`) | Passed | Failed | Skipped | Waiting | Total | Account check's child runs |
|---|---|---|---|---|---|---|---|---|
| After step 6, account check moved after the suite | a7ab9fb | 1,419 | 1,413 | 1 (the M3 cleanup cap test, fixed in 344c1cb) | 1 | 4 | | |
| After step 9 | 0b0a29e | 1,432 | 1,427 | 0 | 1 | 4 | 36 min 19 s | 964 s and 998 s |
| **Closing, from a clean build** | 9561785 | 1,464 | 1,459 | 0 | 1 | 4 | 16 min 5 s | 206 s and 206 s |

The closing gate ran from 20:22 to 20:38 on 4 October 2026, after `npm run clean`. Before it started, no other session's simulation or gate was running (the process list had no `run-strike.mjs`, no polysim process and no other test runner), and a watcher listed every node or python process every minute while it ran: none outside this gate's own process tree. The skipped test is S152's OpenShell enforcement (no gateway configured); the four waiting are E1's and E5's.

**Compared file by file with the gate after step 9.** The suite took 727 s against 1,107 s, `test/after/` 209 s against 1,024 s, and the summed time of every file 5,933 s over 119 files against 7,693 s over 115. Of the 115 files in both, 91 were faster. The largest drops are the files that ran while the other session's simulation did: `test/after/account-independence.test.mjs` 1,015 to 208 s, `standing` 745 to 381 s. So the rise reported after step 9 was the machine's load, as ruled, and none of it is attributed to code. Two files were slower by more than 20% and 5 s:
- `test/poly-new.test.mjs`, 32 to 60 s: it gained the three launcher tests of 196340d after the step-9 gate (12.5, 15.2 and 7.7 s), not a slower path.
- `test/detached.test.mjs`, 23 to 29 s: the test is unchanged, and the only change since on any path it runs is `check.ts`'s workflow checks, which run only for a module with a workflow, and none of its modules has one. One sample; nothing is attributed to code.

The ten slowest files: `m3-runner` 460 s, `outbox-intent` 387 s, `standing` 381 s, `m4f-recheck` 358 s, `m3-freeze-eol` 348 s, `m3-tasks` 333 s, `m3-o1r` 252 s, `account-independence` 208 s, `review-m2` 184 s, `m3-cleanup` 177 s.

**Limits, stated.**
- Workflows run on polyflow, outside poly's gate, until they move to `poly-runtime` before v1, at the latest with M8 (S164, PT18).
- The DeepSeek Harness half waits on its plugin API (S170). The agent runs under each host are a demonstration for the owner to make, not gated.
- The language server refuses to format, and offers no fix for, a module holding a construct the parser skips (`PL0901`), until that construct is lowered.

## Conclusion

M6 gives poly an agent interface and a second runtime target. Workflows get a front end and a lowering that polyflow loads without change, and AC5 is tested by driving polyflow's own server with a scripted client, step for step against the hand-written workflow. The commands are defined once and served three ways, by the CLI, an MCP server and a language server, none of which knows a host; the Claude Code plugin and the DeepSeek Harness entry are configuration over them. `poly new` is the only place a model is called, and it never admits what it drafts. No engine change is needed; E9 is offered so that polyflow could check poly's certificate. The eight issues are ruled: workflows run on polyflow in M6, listed as ungated until they move to `poly-runtime` before v1 (S164), the language server serves both surfaces fully (S168), `poly new` spends no per-token API money (S169), and M6 closes on the Claude Code half (S170).
