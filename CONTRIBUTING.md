# Contributing to poly

Thank you for looking. This file says how to report a bug, propose a change to the language, ask for a feature and send a patch. Read `README.md` first, then `CLAUDE.md` (the standing rules).

## The specifications are the source of truth

| Document | Ids | Role |
|---|---|---|
| `docs/04-semantics.md` | `PS` | What a program means. It wins every disagreement. |
| `docs/03-technical-spec.md` | `PT` | Grammar, formats, lowering, diagnostics, plan. |
| `docs/02-architecture.md` | `PA`, `AD` | Layers, principles, decisions. |
| `docs/01-functional-spec.md` | `PF`, `AC` | Requirements and acceptance criteria. |

When code and a specification disagree, one of them is a bug. Say which you think it is, and cite the id (`PS2.3`, `PT9.8`, `AC10`).

## Reporting a bug

Open an issue with:

1. **The program.** The smallest `.poly` source that shows it, or the command line and inputs.
2. **The command.** For example `poly check hello.poly`, with the version (`git rev-parse --short HEAD` or the release tag) and Node version.
3. **What you got.** The verdict and diagnostic code, with the checked instance the verdict prints (PT12.3a).
4. **What you expected,** and the requirement id that says so, if you know it.

Reports that matter most:

- **A silent clean.** A check that said `CLEAN` when it should not have, or did not run and did not say so. These are the worst class of bug here.
- **A disagreement between `poly-ref` and the compiler,** or between a verdict and a witness that does not replay.
- **A running program that does something the checked program could not.**

Do not report a security issue in a public issue. See `SECURITY.md`.

## Proposing a change to the language

A change to what a program means starts in `docs/04-semantics.md`, not in code. Open an issue titled `spec: <short name>` that gives:

- the problem, with a program that cannot be written or checked today;
- the proposed rule, in the style of the `PS` sections (states, steps, what is rejected);
- the lowering it needs (`PT`), and the diagnostic codes it adds or changes (PT12.2);
- what it does to existing guarantees. Check `docs/reviews/` first: five reviews and their responses record why several decisions went the way they did, and a proposal that reopens one should say what has changed.

A language change is accepted when the semantics, the technical spec, the checker and the tests agree. A patch that changes only code for a new rule will be asked for the spec text.

## Requesting a feature

Open an issue titled `feature: <short name>`. Say who needs it, what they are trying to do, and what they do today instead. A request that names the failure it would prevent (a defect an agent wrote, a program that could not be checked) is easier to place than one that names a mechanism.

Features that touch the standing rules below are unlikely to be accepted as asked. For example, a check that calls a language model is not a feature poly will take.

## Sending a patch

- Open an issue first for anything larger than a small fix.
- Build and test: `npm ci`, then `npm test` (Node 22 or later). The suite includes the import-boundary check and the evidence scripts under `docs/reviews/evidence/`.
- Add a test with the change. A fix for a bug starts with a failing test.
- Cite requirement ids in code comments and in the commit message.
- One change, one commit, with a message that says why: a short title, then a paragraph or two.

## Standing rules

These are enforced by tests or by CI. A patch that works around one will not be merged.

- `poly-ref` is written from `04-semantics.md` and shares no code with the compiler (`poly-core`, `poly-lang`, `poly-embed`). An import-boundary check enforces it.
- No language-model call on any check or decision path.
- Handlers are total and pure over the pre-state. Primed fields are write-only (PS2.3). Requires precede writes on every path (PT4.1).
- No silent clean. A check that did not run, or hit a bound, is `INCONCLUSIVE` or listed as not run.
- Every artefact the runtime reads is checked, and a new one enters the build with its round-trip check and a broken variant in `test/toolchain-faults.mjs`.
- Engines are vendored, never forked. A file under `vendor/` is copied unchanged and pinned by hash in its `PROVENANCE.md`. A change an engine needs is made in that engine's repository and copied in again.

## Style

- No em dashes. Short declarative sentences. Parentheses and colons instead of dash asides.
- Comments explain why, cite the requirement id and record what was measured. They do not narrate the code.
- Documents end with a conclusion. READMEs end with a glossary.

## Licence of contributions

poly is licensed under Apache-2.0 (`LICENSE`). By sending a contribution you agree that it is licensed under the same terms. Vendored engines keep their own licences (`NOTICE`).

## Conclusion

Report a bug with a program, a command and a verdict. Propose a language change as semantics first. Send a patch with a test and a requirement id. The rules in `CLAUDE.md` are the product, so a change that bends one needs the rule changed first, in the open.
