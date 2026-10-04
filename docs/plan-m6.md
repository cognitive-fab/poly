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
| polyflow runs workflows on polyrun, resolved from `@cognitive-fab/polygraph`, a sibling checkout, or `POLYGRAPH_DIR`. It starts a run by creating the instance with the descriptor's `inputAction` and the input as data, and derives the run key from the key template. | `polyflow/src/polyrun.mjs`, `daemon.mjs` | `POLYGRAPH_DIR` can point at `vendor/polygraph`, which holds `polyrun/src/index.mjs`. The input action is a creation action, so poly's checker can require one. |
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

0. **Vendoring.** `m4` is at `main`'s 34305c8, which already contains `m4`'s merge, so nothing is merged. polyflow's server and library vendored with provenance and hashes; a smoke test runs polyflow's own `customer-brief` workflow through the vendored server with `POLYGRAPH_DIR` set to `vendor/polygraph`, from `workflow_start` to a terminal state, by a scripted MCP client.
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
- **S171. Commands through the language server.** LSP has no channel for a command's JSON output except `workspace/executeCommand`. *Proposal:* PF9.1's "through a language server" means every registry command is an executable command of the server, returning its JSON; `poly approve` and `poly accept` are on the command line only, as on MCP. *Ruled (`decisions-m6.md`):* Accepted.

## 9. Risks

- **polyflow's run differs from the hand-written one for a reason outside the workflow.** The AC5 comparison is step for step over work orders, tools and states; a difference in polyflow's own journal fields that poly does not produce (timestamps, ids) is excluded by name, never by tolerance.
- **The Claude Code plugin format.** Which entries a plugin may declare (an MCP server, a language server, skills) is read from the host's documentation at step 8; an entry the host does not read is left out and said so, never assumed.
- **DeepSeek Harness's API is not stable.** Its half of the two-host claim may wait past M6. The plan keeps it separate so that M6 can close on the Claude Code half, if the owner rules so.
- **`poly new` quality.** A drafted module may never reach `CLEAN`. That is reported as the command's result; the check is never relaxed to let a draft through.

## Conclusion

M6 gives poly an agent interface and a second runtime target. Workflows get a front end and a lowering that polyflow loads without change, and AC5 is tested by driving polyflow's own server with a scripted client, step for step against the hand-written workflow. The commands are defined once and served three ways, by the CLI, an MCP server and a language server, none of which knows a host; the Claude Code plugin and the DeepSeek Harness entry are configuration over them. `poly new` is the only place a model is called, and it never admits what it drafts. No engine change is needed; E9 is offered so that polyflow could check poly's certificate. The eight issues are ruled: workflows run on polyflow in M6, listed as ungated until they move to `poly-runtime` before v1 (S164), the language server serves both surfaces fully (S168), `poly new` spends no per-token API money (S169), and M6 closes on the Claude Code half (S170).
