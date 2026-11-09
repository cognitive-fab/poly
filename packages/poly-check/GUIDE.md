# poly: a guide for a coding agent

You are about to write or change a poly program. Read this once before you start. `poly guide` prints it again at any time.

## What poly is

poly is a language for the stateful core of a program: machines with finite state, the actions they take, the effects they ask for, and the rules that must always hold. A program is checked exhaustively over its declared finite domains before it may run, and it runs under a gate that journals every effect and asks the project's signed policies before any of them leaves. You write the program; the check and the gate decide whether it is right.

## The loop

1. Write or edit the module. A standalone module is a `.poly` file, a policy is a `.policy.poly` file, and an embedded module is a `.ts` file built from poly's combinators.
2. Run `poly check <file or project dir>`. Read the verdict on the last lines.
3. Read each diagnostic: its code (`PLxxxx`), its line, and its witness when it has one. A witness is the shortest path of steps that breaks the property. Export it with `poly witness <id> --trace` or `--test` to replay it.
4. Change the program: apply a typed fix with `poly fix <id>` when the diagnostic offers one, or make an edit yourself. A fix is refused with `PL0201` when the module changed since the check, so check again first.
5. Check again. Repeat until the verdict is `CLEAN`.

`poly fmt <file>` formats a standalone module. `poly edit-check` checks an edit in memory before it is written.

## The verdicts

- `CLEAN` (exit 0): every check ran to the end over the declared domains and found nothing.
- `FINDINGS` (exit 1): a property is broken, and each finding carries a witness. Fix the program.
- `REFUSED` (exit 2): the program is not one poly can check, for example a type error or a handler that is not pure.
- `UNDERPOWERED` (exit 2): the evidence a check rests on is too thin to support a verdict.
- `INCONCLUSIVE` (exit 2): a check did not run, or it hit a bound (`PL3901`). Nothing is known about what it did not reach.

Only `CLEAN` is done. Never report a task finished on any other verdict.

## Where the rules live

- **Invariants** and **`never` statements** are written in the machine they govern. A `never` statement says what a step must never do, for example `never no-reissue: emit refund while refund != None`.
- **Path properties** say what must eventually happen, or must not happen along a path.
- **Configurations** put several machines together and check how they relate over time.
- **Policies** live in `*.policy.poly` files and govern effects at run time, through the gate. A policy a person signed is the person's: never edit it to make a check pass. If a policy refuses what you need, say so and let the owner decide.

## What never to do

- Never accept a finding, approve an escalation or admit a program on a person's behalf. Those need a person's key, and the tools do not offer them to you.
- Never weaken a property, delete a rule or narrow a check domain to make a check pass. Fix the program, or report the finding with its witness.
- Never treat a verdict other than `CLEAN` as done.

## Before committing

Run `poly check` on the project, not only on the file you changed. Commit nothing as done unless the verdict is `CLEAN`. If it is not, commit nothing, or commit with the verdict and its findings stated in the message.

## Where to read more

- `docs/04-semantics.md`: what a program means. It wins every disagreement.
- `docs/03-technical-spec.md`: the grammar, the diagnostics and the commands.
- `examples/`: complete programs, each with a README that says what is checked and what is not. `examples/refund-twice` shows one mistake in TypeScript and in poly.

## Conclusion

Write the program, check it, read the witness, fix the program, and stop only at `CLEAN`. The rules belong to the owner: keep them, add to them when asked, and never weaken them to make a check pass.
