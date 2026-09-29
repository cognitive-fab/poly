# Handoff prompt: build poly, milestone M0

*Paste the text below into Claude Code, started in `C:\Users\jjdub\code\poly`.*

---

You are building **poly**, a programming language and runtime for the stateful core of software written by coding agents. The specification is complete (draft v0.6, five peer reviews). There is no code yet. Your job in this session is **milestone M0** of the implementation plan, and nothing beyond it.

## Read first, in this order

1. `CLAUDE.md`: standing rules, engine locations, house style and commit rules. Follow them exactly.
2. `docs/04-semantics.md`: what a program means. It wins every disagreement.
3. `docs/03-technical-spec.md`, especially:
   - PT1 to PT5 (files, grammar, types, handlers, properties);
   - PT12 (diagnostics);
   - PT17 (layout);
   - PT18 (the plan and M0's gate).
4. `docs/02-architecture.md` §2a (scope), §4 (lowering map) and §5 (pipeline).
5. `docs/research/primitive-inventory.md`: the exact SAM v2 strict-profile and polygraph formats you will lower to.
6. `docs/reviews/evidence/`: five Python scripts whose outputs are acceptance tests.

Then write a short plan in `docs/plan-m0.md` before writing code: packages, files, the order of work, and how each part of the gate will be tested. Stop and show me the plan.

## M0 scope (PT18)

1. **`packages/poly-core`:** the AST with stable node ids and the RFC 8785 digest (PT1.4, PT1.4a). Also:
   - types: `bool`, integer ranges, `int` and `string` with `check` domains in `strict` or `disclosed` mode, enums, tagged unions with payloads, `map<E, T>`, and `Ref<M>` as a type only;
   - the `Bool` and `Tri` truth types (PS8.0);
   - the diagnostic model (PT12.1, with node-addressed fixes and preconditions).
2. **`packages/poly-lang`:** lexer, parser and canonical formatter for the standalone syntax.
   - Grammar: PT2, with the precedence of PS12.
   - The formatter parenthesises `implies` when it is mixed with `&&` or `||`.
3. **`packages/poly-lower`:** lowering of `state`, `action`, `on` (with `require`, `let`, `if`, `match`, primed writes and map updates), `guard`, `terminal`, `invariant`, `step property` and `reject property`. The outputs are `contract.json`, a SAM v2 strict `next.cjs` and `invariants.mjs`.
   - Frames are derived (PT4.2).
   - Unions are flattened with `shape:` invariants (PS9.1b).
   - Automatic `domain:` invariants (PT3.5).
   - The compile errors of PT12.2 that apply to these constructs.
4. **`packages/poly-ref`:** poly's model checker, written **directly from 04-semantics** and importing nothing from the three packages above except the AST types. It provides:
   - exploration of the checked instance (PS4);
   - translation validation against the lowered module (PS9.2, PS9.3; `PL2501`);
   - invariants, step properties and reject properties (PS5);
   - the deadlock check (PS5.6).

   Liveness, configurations and possibility checks come in M1 and M2. Design the explorer so they fit.
5. **A minimal `poly check` CLI.** It runs:
   - parse, type and lower;
   - strict `validate()`;
   - translation validation;
   - polygraph's model check on the lowered module;
   - poly-ref's deadlock check.

   It prints the verdict with its checked instance (PT12.3a) and exits with the codes of PT12.3.

## The M0 gate (all must pass)

- **Field-study corpora.** The turnstile (`polygraph/examples/turnstile-v2`), raft-roles (`osssm/polygraph-raft`) and hatchet-status (`osssm/polygraph-hatchet`) machines and their negative controls (`specs-mutant` or `specs_broken`), rewritten in poly, give the same pass or fail **on every window** as the hand-written controls: turnstile 12/12 and 9/12, raft 54/67 and 44/67, hatchet 19/19 and 18/19. Use polygraph's replay for this, not a reimplementation. The corpora are read from copies in `conformance/field-studies/` (PT17).
- **Strict validation.** Every lowered `next.cjs` passes strict `validate()` from `@cognitive-fab/sam-pattern`.
- **Translation validation.** It agrees on every transition of every conformance case. A deliberately broken lowering (for example, a lowering that drops the derived frame) is caught with `PL2501`.
- **Evidence scripts.** poly-ref reproduces the single-machine evidence:
  - the hello-world turnstile from `README.md`: 7 states, `PL3201 DEADLOCK` with the witness `Coin, Coin, Coin, Push`; with `Empty` added, no deadlock;
  - `OutboxIntent` in its union form (PT9.7): 17 reachable states, no deadlock;
  - `OutboxIntent` in its v0.3 five-field form (`evidence/outbox_check.py v0.3`): 33 states, 40 accepted steps, no deadlock;
  - `OutboxIntent` in its v0.2 form, AC9's variant (`evidence/outbox_check.py v0.2`): 35 states, deadlocked at `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)`.

## Constraints

- **Stack.** TypeScript on Node 22 or later, ESM, and npm workspaces under `packages/`. Tests use `node --test` or vitest; choose one and keep it.
- **Engines are dependencies.** Use `@cognitive-fab/polygraph` and `@cognitive-fab/sam-pattern` from npm, or `npm link` to the local sources listed in `CLAUDE.md`. Never copy engine code into this repository. If an engine needs a change, stop and tell me what and why.
- **Import boundary.** poly-ref must not import from `poly-lang` or `poly-lower`. Add the check to CI at the start, not at the end.
- **Mismatches.** When the spec is ambiguous or wrong, do not guess silently. Write the question and your proposed resolution in `docs/plan-m0.md` under "Spec issues", and ask me before changing a spec file.
- **Commits.** One per coherent step, in the house style, committed as `kizo-core`. Do not push.

## Done means

- The M0 gate passes, in one command: `npm test` at the root.
- `docs/plan-m0.md` records what was built, every spec issue found and how it was resolved, and the measured numbers (states, times) for each gate item.
- A short summary for me: what passed, what surprised you, and what M1 will need that M0 does not yet provide.

## Conclusion

M0 proves the foundation: poly source becomes artefacts the engines accept, those artefacts behave exactly as the semantics says, and poly's own checker agrees with the independent evidence. Build nothing beyond that until the gate is green.
