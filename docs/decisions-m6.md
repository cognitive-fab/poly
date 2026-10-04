# poly · Decisions for milestone M6

*Cognitive Fab · October 2026 · the owner's rulings on `plan-m6.md`, recorded on branch `m4`*

## The plan's issues, S164 to S171

| Issue | Ruling |
|---|---|
| **S164** Which runtime runs a workflow | **Accepted, with the limit stated.** For M6 a workflow is checked and lowered by poly and run by polyflow. PT10 says so, and the certificate lists every workflow as `ungated: polyflow runtime`, so it never reads as covered by the gate (PA0.4): G5 says every effect crosses the gate, and workflows run on polyflow are an exception. Running workflows on `poly-runtime` is added to PT18 as a named item before the v1 release, at the latest with M8, since channels need the gate. E9 stays optional. |
| **S165** A workflow's files and bounds | **Accepted.** |
| **S166** Workflow checks | **Accepted**, with the codes `PL6801` to `PL6803`. The v1 proposal's channel codes move in its next revision; that is the owner's, not M6's. |
| **S167** The host-neutral core | **Accepted.** |
| **S168** The language server and the two surfaces | **Amended.** M3's report applied the surface rule, and the answer was embedded (`docs/m3/report.md`, section 2.1, "The surface rule"). The language server gives full support on both surfaces: diagnostics, formatting where it applies, and code actions for typed fixes. If the typed fixes for embedded modules (S70) do not exist yet, they become M6 work, tested first. Whether the standalone surface stays in v1 is a separate decision, not M6's. |
| **S169** `poly new` and the model | **Amended: no per-token API spend.** MCP sampling (the client's model) is the primary provider. The second is a command-line provider that runs Claude Code headless under the user's own login (the Max subscription), as the M3 runs did. An Anthropic API provider may exist behind the interface, but it is not the default, is configured nowhere in the repository, and is used by no test and not by the gate. No provider reads, logs or records an API key or the environment. Tests use the recorded provider only. Five rounds: accepted. |
| **S170** Two hosts in the gate | **Accepted.** M6 may close on the Claude Code half. The DeepSeek Harness half is listed as waiting until the owner declares its plugin API stable. |
| **S171** Commands through the language server | **Accepted.** |

## Changes to the plan

- **Step 0.** `main` is already merged (34305c8, which contains `m4`'s merge), and `m4` is at it; the merge is dropped from the step.
- **The M3 runner test risk** is removed from the plan's risks: it is fixed (`plan-m5.md` section 11).
- **A measurement step** for the two findings left open from M5: memory per file checked in one long process, and the 53-second program. Measure first. If a leak is confirmed, fix it with a test that fails first; otherwise record the measurements. M6's close does not depend on a speed-up.

## Recorded with the rulings

- **Embedded typed fixes exist.** `poly fix` already applies a typed fix to an embedded module: the edit is made on its AST and the changed node is reprinted and spliced in at its span (`packages/poly-check/src/fixes.ts`, M3-3). M6's language server offers them on both surfaces, and its tests cover each surface; a fix kind found missing on the embedded surface becomes M6 work, tested first.
- **PT10 and PT18** now state S164's limit and the named item.

## Conclusion

M6 is ruled: workflows run on polyflow with their limit stated and its removal scheduled, the agent interface is one host-neutral core, the language server serves both surfaces fully, `poly new` spends no per-token API money, and M6 closes on the Claude Code half.
