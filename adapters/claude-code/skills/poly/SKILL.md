---
name: poly
description: Write, check and fix poly programs (.poly files and embedded TypeScript modules), and run poly workflows through polyflow. Use when the task is the stateful core of a program, a workflow, or a policy written in poly.
---

# Writing and checking poly

poly is a language for the stateful core of a program: machines with finite state, actions, handlers, effects, properties, configurations, workflows and policies. A program is admitted only when `poly check` reports it `CLEAN`.

## The loop

1. Write or edit the module. A standalone module is a `.poly` file; a policy is a `.policy.poly` file; an embedded module is a `.ts` file built from poly's combinators.
2. Check it with the `poly_check` tool (`target`: the file or the project directory). The verdict is `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED` or `INCONCLUSIVE`; never treat anything but `CLEAN` as done.
3. Read each diagnostic: its code (`PLxxxx`), its line, and its witness when it has one. Export a witness with `poly_witness` (`kind`: `trace` or `test`) to see the path that breaks a property.
4. Apply a typed fix with `poly_fix` when the diagnostic offers one; it is refused (`PL0201`) when the module changed since the check, so check again first.
5. Format a standalone module with `poly_fmt`.
6. Repeat until the verdict is `CLEAN`.

The language server shows the diagnostics of stages 0 to 2 as you edit, and every stage when the file is saved.

## Workflows

A `workflow w runs M { input A  key "…" where f matches "…"  tool "kind" -> t target "…" why "…" }` block maps each effect kind of machine `M` to the agent tool that fulfils it. `poly check` lowers it for polyflow and runs polyflow's own admission. A workflow's machine needs at least one path property (`PL6804`). Since M8a workflows run on poly-runtime, under poly's gate (S173 to S175): `poly run --mcp` serves the workflow tools, each work order is proposed to the gate before it is issued, and the certificate lists each workflow as `gated: true`.

## What never to do

- Never accept a finding, approve an escalation or admit a program on a person's behalf: those need a person's key, and the tools do not offer them.
- Never weaken a property or a check domain to make a check pass. Fix the program, or report the finding.
