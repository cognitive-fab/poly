# poly: working notes for an agent

poly is a language and runtime for the stateful core of software written by coding agents. It lowers to the artefacts the Poly stack engines already read, and it has its own model checker, `poly-ref`, for how machines relate over time. `README.md` says what it is. The specifications are the source of truth:

| Document | Ids | Role |
|---|---|---|
| `docs/04-semantics.md` | `PS` | What a program **means**. Wins every disagreement. |
| `docs/03-technical-spec.md` | `PT` | Grammar, formats, lowering, diagnostics, plan (PT18). |
| `docs/02-architecture.md` | `PA`, `AD` | Layers, principles, decisions, scope table (§2a). |
| `docs/01-functional-spec.md` | `PF`, `AC` | Requirements and acceptance criteria. |
| `docs/research/primitive-inventory.md` | | The engines' formats, read from source. Check it before assuming a format. |
| `docs/reviews/` | | Five reviews and responses. Read before changing a design decision. |

Cite requirement ids in code comments and commit messages (`PS2.3`, `PT9.8`, `AC10`).

## Standing rules, and what enforces each

| Rule | Enforced by |
|---|---|
| The semantics is the definition. `poly-ref` is written from `04-semantics.md` and shares **no code** with the compiler (`poly-core`, `poly-lang`, `poly-embed`). | an import-boundary check in CI |
| No language-model call on any check or decision path. Only `poly new` and optional explanation text may call a model. | the same import-boundary check |
| Handlers are total and pure over the pre-state; primed fields are write-only (PS2.3); requires precede writes on every path (PT4.1). | the compiler, with diagnostic codes from PT12.2 |
| No silent clean. A check that did not run, or hit a bound, is `INCONCLUSIVE` or listed as not run. Every verdict prints its checked instance (PT12.3a). | verdict-fold tests |
| The evidence scripts in `docs/reviews/evidence/` are acceptance tests. poly-ref must reproduce every number and witness they print. | `test/evidence.test.*` |
| Every artefact the runtime reads is checked: compared by translation validation, or read back and compared with the source (contract, effects manifest, path and compose invariant modules). A new artefact enters the build only with its round-trip check and a broken variant in the explicit list of toolchain faults. | `packages/poly-ref/src/artefacts.ts` inside translation validation, and `test/tv.test.mjs` over the faults in `test/toolchain-faults.mjs` |
| Engines are vendored, never forked. poly relies on the Poly stack conceptually, not physically: the engine files it runs are copied unchanged into `vendor/`, each pinned by hash and commit in its `PROVENANCE.md`. A change an engine needs is made in that engine's repository and copied in again. | `test/vendor.test.mjs` |

If you find yourself working around one of these rules, stop. The rule is the product.

## Engines and where they live

- **SAM v2 strict profile:** `@cognitive-fab/sam-pattern` 2.3.0, vendored in `vendor/sam-pattern` from sam-lib 3047024. Local source: `C:\Users\jjdub\code\sam\sam-lib`.
- **polygraph, polyrun, polyvers and polynv:** `@cognitive-fab/polygraph` 8.3.2; the files poly runs are vendored in `vendor/polygraph` from polygraph 4949de4 on branch `m3-sendto` (S87). Local source: `C:\Users\jjdub\code\polygraph`.
- **Polyaxion, polyman and polysec-core:** vendored in `vendor/polyaxion` from polyaxion c37c60e, copied out of history with `scripts/vendor-polyaxion.mjs` (the owner's instruction of 2026-10-06). Local source: `C:\Users\jjdub\code\polyaxion`.
- **Polytrion:** private and hosted. Not needed in v1 (worlds are deferred).

Conformance corpora already exist and are referenced by the M0 and M1 gates:

- turnstile: `polygraph/examples/turnstile-v2` (contract, reference spec, mutant, traces);
- raft roles: `osssm/polygraph-raft` (contract, invariants, `specs`, `specs_broken`, traces);
- hatchet status: `osssm/polygraph-hatchet` (the same layout);
- order: `polygraph/examples/polyrun-oms/machines/order`.

## Style

- House style in every file, including comments and commit messages: **no em dashes**, short declarative sentences, parentheses and colons instead of dash asides.
- Never use the words "honest", "honesty" or "honestly".
- Documents end with a conclusion; READMEs end with a glossary.
- Comments explain *why*, cite the requirement id, and record what was measured. They do not narrate the code.
- Never state how long work took.

## Commits

One change, one commit, with a message that says why. Match the existing messages: a short title, then a paragraph or two. Commit as `kizo-core <kizo-core@users.noreply.github.com>`. **Nothing is pushed by an agent.**

On Windows, a heredoc under Git Bash corrupts backslashes and backticks. Use the file-edit tools, or write a script to a file and run it.
