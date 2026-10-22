---
name: poly
description: Write, check and fix poly programs (.poly files and embedded TypeScript modules), and run poly workflows through polyflow. Use when the task is the stateful core of a program, a workflow, or a policy written in poly.
---

# Writing and checking poly

poly is a language for the stateful core of a program: machines with finite state, actions, handlers, effects, decisions, properties, configurations, workflows and policies. A program is admitted only when `poly check` reports it `CLEAN`.

## The loop

1. Write or edit the module. A standalone module is a `.poly` file, a policy is a `.policy.poly` file, and an embedded module is a `.ts` file built from poly's combinators.
2. Check it with `poly_check` (`target`: the file or the project directory). The verdict is `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED` or `INCONCLUSIVE`. Anything but `CLEAN` is not done.
3. Read each diagnostic: its code (`PLxxxx`), its line, and its witness when it has one. Look the code up in `findings.md`. Export a witness with `poly_witness` (`kind`: `trace` or `test`) to see the path that breaks a property.
4. Apply a typed fix with `poly_fix` when the diagnostic offers one. It is refused (`PL0201`) when the module changed since the check, so check again first.
5. Format a standalone module with `poly_fmt`.
6. Repeat until the verdict is `CLEAN`.

`poly_edit_check` checks an edit in memory before you write it.

## Which file to read

- `syntax.md`: before you write a construct you have not written in this session, and after a `PL0001` or `PL1xxx` diagnostic. One checked example per construct and per kind of property.
- `findings.md`: whenever `poly_check` prints a code. Its meaning and the usual fix.
- `patterns.md`: when an irreversible effect can end uncertain, when a second request could repeat it, when a model's answer must cite its sources, or when you write a property about paths.
- `host.md`: when you write or change a handler, call `rt.dispatch`, or see `PL6836`, `PL6401` or `PL6406`. Types, capabilities, and what a handler returns.

## Workflows

A `workflow w runs M { ... }` block maps each effect kind of machine `M` to the agent tool that fulfils it. Its machine needs a path property (`PL6804`). `poly run --mcp` serves its tools through the gate.

## What never to do

- Never accept a finding, approve an escalation, sign a policy or admit a program on a person's behalf. Those need a person's key, and the tools do not offer them.
- Never weaken a property, a check domain or a bound to make a check pass. Fix the program, or report the finding.
- Never read `INCONCLUSIVE` or "not run" as clean. Say what did not run.
- A toolchain or runtime code (`PL2001`, `PL2501`, `PL2401`, the load codes) is not yours to edit around. Report it with the code, the file and the witness.

## Glossary

- **Diagnostic:** one finding or refusal, with a code, a line and sometimes a witness.
- **Verdict:** the result of a check, folded from all stages. Only `CLEAN` admits.
- **Witness:** the steps that break a property.
- **Typed fix:** an edit to one syntax node, refused if the node changed.
- **Admit:** check a project and, when it is `CLEAN`, write its certificate, signed with the owner's admission key.
