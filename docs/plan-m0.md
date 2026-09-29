# poly · Plan for milestone M0

*Cognitive Fab · September 2026 · plan, written before any code*

This plan covers milestone M0 of PT18 and nothing beyond it. It fixes the packages, the files, the order of work and how each part of the gate is tested. The spec issues found while reading are listed at the end, each with a proposed resolution. None of them is resolved in the spec files until the owner answers.

## 1. What was read, and what was measured before planning

The documents were read in the order of the handoff. The engines and corpora were read from source:

- `@cognitive-fab/polygraph` 8.3.0 (`scripts/check.mjs`, `replay.mjs`, `sam-tv.mjs`, `load-spec.mjs`, `sam-adapter.cjs`);
- `@cognitive-fab/sam-pattern` 2.2.1 (`lib/sam-instance.js`, `docs/MIGRATION.md`);
- the three field-study corpora.

Baselines, measured with polygraph's own `replaySpecResults` on the hand-written controls:

| Corpus | Windows | Reference | Negative control |
|---|---|---|---|
| turnstile (`polygraph/examples/turnstile-v2`) | 12 | 12/12 | mutant 9/12 |
| raft roles (`osssm/polygraph-raft`) | 67 | **54/67** | broken 44/67 |
| hatchet status (`osssm/polygraph-hatchet`) | 19 | 19/19 | broken 18/19 |

Evidence scripts, run with Python 3.12:

| Script | Output |
|---|---|
| `turnstile_check.py` | 7 states, deadlock `(Locked, 3)`, witness `Coin, Coin, Coin, Push`; with `Empty`: 7 states, no deadlock |
| `outbox_sum_check.py` | 17 reachable, 24 accepted edges, no deadlock, no fair violation |
| `outbox_check.py` (v0.3 five fields) | 33 states, 40 accepted edges, **no deadlock** |
| same, with `SettleFailed` always returning to `Allowed` (the v0.2 machine, AC9) | 35 states, deadlocks `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)` |

The raft baseline and the v0.3 result each contradict the gate as written. They are spec issues S1 and S2.

## 2. Stack

- TypeScript 5.x, compiled by `tsc -b` with project references, ESM output, Node 22 or later (measured on 24.12).
- npm workspaces under `packages/`. Package names are `@poly/core`, `@poly/lang`, `@poly/lower`, `@poly/ref` and `@poly/check`. They are private until publishing is decided.
- Tests use `node --test` on the compiled output. No other test runner.
- Engines: `@cognitive-fab/polygraph` `~8.3.0` and `@cognitive-fab/sam-pattern` `~2.2.1` from npm. polygraph has no `exports` map, so its `scripts/check.mjs` and `scripts/replay.mjs` are imported by path. Nothing is copied from either engine.
- RFC 8785: a small canonicaliser in `@poly/core`. The AST holds only strings, safe integers, booleans, null, arrays and objects, so the number rule of RFC 8785 reduces to integer printing. It is tested against the RFC's own vectors for those types.
- `npm test` at the root runs, in order: build, the import-boundary check, then every test file. It is the single gate command.

## 3. Packages and files

### 3.1 `packages/poly-core` (AST, types, diagnostics, static checks)

| File | Contents | Ids |
|---|---|---|
| `src/ast.ts` | Node types for modules, type declarations, machines, fields, actions, handlers, statements, expressions, properties. Every node has `id` and `span`. | PT1.4, PT2 |
| `src/ids.ts` | Node ids from the node's path (`machine:Gate/on:Coin/stmt:1`), named where the grammar names things, indexed in blocks. `n:` plus 16 hex digits of SHA-256. | PT12.1 |
| `src/jcs.ts`, `src/digest.ts` | RFC 8785 canonical JSON; module digest over the AST with ids and spans stripped (trivia never enters the AST). Node digests for fix preconditions. | PT1.4, PT1.4a |
| `src/types.ts` | `bool`, ranges, `int` and `string` with `check` domains and a mode, enums as payload-free unions, tagged unions, `map<E, T>`, `Ref<M>`. Finite enumeration of every finite type. | PT3, PS1.4 |
| `src/truth.ts` | `Bool` and `Tri`, Kleene `not`/`and`/`or`, the PS8.2 rule table as a pure function. | PS8.0 to PS8.2 |
| `src/diagnostics.ts` | `poly.diagnostic/1`, the code catalogue, severity, stage, node-addressed fixes with `pre` digests, verdicts and exit codes, the fold. | PT12 |
| `src/check/*.ts` | Name resolution, type checking (`Bool` only in machines, `PL1203` on `Tri`), domains (`PL1101`), `match` exhaustiveness (`PL1501`), terminal on control field (`PL1401`), per-path analysis (`PL2101`, `PL2102`, `PL2201`), reads of primed fields. | PT2.2, PT4.1, PT4.4, PS2.3, PS2.4 |

The static checker lives in core, not in `poly-lang`, because both surfaces must pass through it (PT2.5). `poly-embed` is M2.

### 3.2 `packages/poly-lang` (standalone surface)

| File | Contents |
|---|---|
| `src/lexer.ts` | Tokens, `//` comments kept as trivia with their positions, string and integer literals, the prime as a postfix token on an identifier. |
| `src/parser.ts` | Recursive descent for declarations and statements; a precedence-climbing expression parser with the nine levels of PS12 (`implies` right-associative, levels 5 and 6 non-associative, `is` at level 5). Errors are `PL0001 SYNTAX` with the node path so far. |
| `src/format.ts` | The canonical printer, `format(ast, trivia)`. The parser returns comments in a side table keyed by node id (leading and trailing comments per statement or item); they never enter the AST, so they never reach the digest (PT1.4a). The printer's layout is a function of the AST alone, one text per AST, and the side table only adds comment lines at their nodes. Parenthesises `implies` whenever it is mixed with `&&` or `||`, and only minimally elsewhere. |

### 3.3 `packages/poly-lower` (construct to artefact)

One module per row of the lowering map (02 §4) that M0 covers:

| File | Artefact |
|---|---|
| `src/flatten.ts` | Union fields to a tag field plus nullable payload fields, and the `shape:<field>` invariants (PS9.1b). |
| `src/contract.ts` | `contract.json`: `stateKeys` (control field first), `initState`, `actions` with `dataFields`, `dataDomain`, `terminalStates`, `invariants`. |
| `src/module.ts`, `src/emit-expr.ts` | `next.cjs`: `createInstance({ strict: true })`, sealed `modelShape`, named intents with schemas and domains (the check domains), keyed acceptors, guards as one leading `'*'` acceptor, frames derived per path (PT4.2). Exports `{ instance, init, actions, getState, setState }`. |
| `src/invariants.ts` | `invariants.mjs`: `stateInvariants` (declared, `domain:`, `shape:`), `transitionInvariants` (step properties, guarded to accepted steps, issue S8), `rejectionInvariants`. |
| `src/faults.ts` | Test-only fault injection for the broken-lowering gate: `drop-frame`, `swap-reason`, `off-by-one`, `invert-require`, `skip-guard`. Reachable only through an explicit option that `poly check` never sets. |

`lowerMachine(ast)` returns `{ files: { 'contract.json', 'next.cjs', 'invariants.mjs' } }`. Writing to `.poly/build/<module>.<Machine>/` is the CLI's job (PT1.5, PT17).

### 3.4 `packages/poly-ref` (the model checker, from 04-semantics)

poly-ref imports from `@poly/core` with `import type` only. It resolves names, enumerates domains and evaluates expressions itself, from the AST, following 04-semantics. It shares no runtime code with the compiler.

| File | Written from |
|---|---|
| `src/values.ts` | Structured values: integers, booleans, strings, `(Ctor, record)` pairs, maps. Canonical keys for the visited set. (PS1.2, PS1.4) |
| `src/domains.ts` | `D(f)` and `D(a)` from the declared types and check clauses. (PS1.1, PS4.2) |
| `src/eval.ts` | Expressions over the pre-state and data; PS12 operators; integer `/` and `%` per issue S12. (PS2.3, PS2.5) |
| `src/step.ts` | Guards, then the body; `accept(w, E) | reject(r)`; the relation of PS3.2 including the terminal and strict-domain rows. (PS2.2, PS3.2) |
| `src/explore.ts` | Breadth-first exploration of the checked instance into a graph: states, and every labelled edge, including rejected and unhandled stutters. Parent pointers give shortest witnesses. (PS4) |
| `src/properties.ts` | Invariants, step properties (accepted edges only), reject properties (every edge). (PS5.1 to PS5.3) |
| `src/deadlock.ts` | Reachable, non-terminal, no accepting `(a, d)`; the witness and the rejections in that state. (PS5.6) |
| `src/alpha.ts` | The abstraction `α` from flat SAM states to structured states, written from PS9.1b, not from `poly-lower`. |
| `src/tv.ts` | Translation validation: drives the lowered `next.cjs` through `@cognitive-fab/sam-pattern` on every `(s, a, d)` with `s` in `Reach(I)` and `d` in `D(a)`, compares verdict kind, reason and next state through `α`, then evaluates the lowered `invariants.mjs` on every reachable state and edge and compares with PS5. Any difference is `PL2501 LOWERING_MISMATCH`, verdict `REFUSED`. (PS9.2, PS9.3) |

**Designed for M1 and M2.** The explorer works over an interface `{ initial, successors(state) → labelled edges, key(state) }`. A single machine is one implementation of it. A configuration (PS13) will be a second implementation over `(σ, μ)`, and the graph it returns already carries what PS6.4 needs: labelled edges with verdicts, so rejected stutters count as edges, and per-state enabledness of each action group. Liveness then adds a Tarjan pass over the same graph; it does not touch exploration. Bound hits are recorded on the graph (`boundHits`), so PL3901, PL5301 and PL5302 share one path to `INCONCLUSIVE`.

### 3.5 `packages/poly-check` (pipeline and the minimal CLI)

PT17 names this package `poly-check`. It holds the pipeline, the verdict fold and the `poly` binary. For M0 the binary has one command, `poly check <file.poly>`, which runs:

| Stage | Engine | On failure |
|---|---|---|
| 0 parse, type, domains | `@poly/lang`, `@poly/core` | `REFUSED`, later stages listed as not run |
| lower, write `.poly/build/<module>.<Machine>/` | `@poly/lower` | `REFUSED` |
| 1 strict `validate()` | `@cognitive-fab/sam-pattern` | `REFUSED` |
| 1b translation validation | `@poly/ref` | `PL2501`, `REFUSED` |
| 2 model check of the lowered module | polygraph `check()` | `PL3001`, `PL3002`, `PL3003`, `PL3102`, `FINDINGS`; cap hit is `PL3901`, `INCONCLUSIVE` |
| 2b deadlock | `@poly/ref` | `PL3201`, `FINDINGS` |

The verdict is the fold of 02 §5. It is printed with its checked instance (domains, state count, kernel assumptions K7 and, for anything that runs, K1, K2 and K4), and the exit code is the one of PT12.3. A stage not run is listed with its reason. `--json` prints the diagnostics in `poly.diagnostic/1` form.

### 3.6 Examples, conformance and gate tests

```
examples/hello/hello.poly, hello-empty.poly          README turnstile, with and without Empty
examples/evidence/outbox-union.poly                  PT9.7
examples/evidence/outbox-v03.poly                    v0.3 five-field form (from the v0.3 spec)
examples/evidence/outbox-v02.poly, outbox-union-escape.poly   the AC9 variants
examples/field-studies/{turnstile,raft,hatchet}/<name>.poly, <name>-broken.poly
conformance/m0/*.poly                                one case per construct: require, let, if, match,
                                                     primed write, map update, guard, terminal, union
                                                     write, invariant, step property, reject property
conformance/m0/errors/*.poly                         one source per compile error code M0 raises
test/gate/*.test.mjs                                 the M0 gate, one file per gate item
test/evidence.test.mjs                               the evidence numbers (named in CLAUDE.md)
scripts/check-boundaries.mjs                         the import-boundary check
.github/workflows/ci.yml                             build, boundary check, npm test
```

## 4. Order of work

Each step ends with a commit, and nothing after step 1 starts before the owner has answered the spec issues that block it.

1. **Scaffold.** Workspaces, `tsconfig` references, empty packages, `npm test`, the boundary check and the CI workflow. The boundary check is in place before any code it guards (handoff: "at the start").
2. **Core.** AST, ids, RFC 8785, digests, types and domains, `Bool` and `Tri`, the diagnostic model.
3. **Language.** Lexer, parser, formatter. Every example in the specs that is inside M0 parses and round-trips.
4. **Static checks.** Names, types, domains, and the M0 compile errors.
5. **poly-ref without lowering.** Interpreter, explorer, properties, deadlock. The evidence tests pass here, before any lowering exists, so poly-ref's numbers cannot be shaped by the compiler.
6. **Lowering.** Contract, module, invariants; strict `validate()` on every lowered module.
7. **Translation validation.** `tv.ts`, and the fault-injection tests.
8. **Field studies.** The six poly sources; replay through polygraph.
9. **`poly check`.** Pipeline, polygraph model-check stage, fold, instance line, exit codes.
10. **Results.** This document gains a "What was built" section with measured numbers.

## 5. How each part of the gate is tested

| Gate item | Test | Pass condition |
|---|---|---|
| Field-study replay | `test/gate/field-studies.test.mjs`: lower each poly rewrite, replay with polygraph's `loadWindows` and `replaySpecResults` | Per-window results identical to the hand-written reference: 12/12, 19/19, and 54/67 for raft with the same 13 windows failing (issue S1) |
| Negative controls | same file, the `-broken` rewrites | Identical per-window results to the hand-written controls: 9/12, 44/67, 18/19 |
| Strict validation | `test/gate/validate.test.mjs`: every lowered `next.cjs` in examples and conformance | `instance({}).validate()` from `@cognitive-fab/sam-pattern` returns `[]` and does not throw |
| Translation validation | `test/gate/tv.test.mjs`: every conformance case, example and field study | Zero `PL2501` over every `(s, a, d)` of `Reach(I) × D(a)` |
| Broken lowering caught | same file, each fault of `faults.ts` on every case where it applies | Each fault yields `PL2501` with the first differing transition as witness; a fault that no case exercises fails the test |
| Evidence | `test/evidence.test.mjs` | Hello: 7 states, `PL3201` at `Locked/3`, witness `Coin, Coin, Coin, Push`; with `Empty`: 7 states, clean. Union `OutboxIntent`: 17 states, 24 accepted edges, no deadlock. v0.3: 33 states, 40 accepted edges, no deadlock. v0.2 variant: 35 states, `PL3201` for exactly the two states the script prints. Union variant: `PL3102` (AC9). When Python 3 is present the test also runs the scripts and checks that they still print these numbers; when it is absent that half is reported as not run, never passed. |
| One command | root `npm test` | Exit 0 |
| CLI | `test/gate/cli.test.mjs` | Exit codes 0, 1, 2 and 64 on fixtures; every verdict line carries its instance |

Unit tests alongside: PS12 precedence table, formatter idempotence (`fmt(fmt(x)) = fmt(x)`), digest invariance under comments and formatting, node-id stability under reformatting, Kleene truth tables, one test per compile error code.

## 6. Spec issues

Each issue states what the spec says, what was found, and the resolution proposed. Issues marked **blocking** stop the step named until answered.

- **S1. The raft corpus cannot replay at 100% (blocking step 8).** PT18 and the handoff require 100%. The hand-written reference replays 54/67. Its `REPORT.md` shows that 13 windows observe the term on either side of a deferred bump behind pre-vote: no deterministic machine over `(role, term)` passes all 67. AC2 asks that controls "behave as they do today". *Proposal:* the gate for every field study is window-by-window identity with the hand-written controls (reference and broken). For turnstile and hatchet this is still 100%.
- **S2. `OutboxIntent` v0.3 has no deadlock (blocking step 5).** PT18 and the handoff say the v0.3 form shows "two deadlocked states". `outbox_check.py` prints 33 states and no deadlock. The two deadlocks belong to the v0.2 machine (`response-2026-09-29-formal.md`), which is also AC9's variant. *Proposal:* gate v0.3 at 33 states, 40 accepted edges, clean; gate the AC9 variant at the two deadlocked states; fix the PT18 row and the handoff text.
- **S3. Corpus field names are keywords (blocking step 8).** The turnstile corpus has a field `state` and the hatchet corpus a field `derived`. Both are reserved (PT2.1, PT2 `StateBlock`, `Field`). Replay compares by key, so the names must match. *Proposal:* `state`, `derived` and `internal` become contextual keywords, reserved only in the positions where the grammar uses them. Alternative: an external-name clause on fields.
- **S4. Hatchet state is an array (blocking step 8).** `taskStatuses` is a three-element JSON array. PT3.1 allows maps only with enum keys, and PS9.1b does not say how a map lowers. *Proposal:* allow `map<0..n, T>` with an integer-range key; it lowers to a JSON array when the range starts at 0, and a map with enum keys lowers to a JSON object keyed by constructor name. A map literal `{ k: v, … }` is part of the expression language (PT9.8 already uses one; PT2.2 omits it).
- **S5. Check domains on state fields have no exploration meaning (blocking step 5).** PS4.2 says `Reach(I)` is finite because fields are restricted to their check domains, but PS3.2 never restricts states. Raft's `term` and the turnstile's `coins` grow without bound in the real machines, so both need `int check a..b`. *Proposal:* a transition whose post-state leaves `D(f)` for an `int` or `string` field is a **bound hit**. The post-state is not explored, and the verdict is at best `INCONCLUSIVE` with `PL3901 BOUND_HIT` and the field. A write that leaves a declared **type** (a range) stays `PL3102 DOMAIN_ESCAPE`, a finding, as PT3.5 says. The out-of-type state is not in `S`, so poly-ref does not expand it. polygraph cannot stop at either kind of state, so `poly check` gives its stage a state cap computed from poly-ref's exploration and treats the cap hit as expected when poly-ref already reported the bound. The `strict`/`disclosed` mode of a state field (PT3.4 speaks only of dispatch) is recorded in the contract and the instance line, with no other effect in M0.
- **S6. polygraph ignores `terminalStates`.** Its explorer steps out of terminal states, which PS3.2 forbids, so its state count and invariant results would cover states outside `Reach(I)`. *Proposal (no spec change):* `terminal` lowers both to `terminalStates` and to the first `'*'` acceptor, which rejects with `"terminal"`. The module's relation is then `R_M` including the first row of PS3.2, and PS9.1a still holds, since the runtime's own check gives the same verdict first.
- **S7. An accepted step with no writes looks unhandled to SAM.** With every field framed by `unchanged`, `lastStep().classification` is `unhandled`, and polyrun journals `unhandled`. PS3.4 says such a step is accepted. In M0 there are no effects, so a path with no write and no reject is `PL2201 SILENT_NOOP`, made an error. *Proposal:* M0 treats `PL2201` as an error; M1 must settle how an emit-only step is classified. An action with no handler lowers to a keyed acceptor that calls `unchanged('*')`, which SAM classifies as `unhandled`, matching PS3.2.
- **S8. Step properties would see rejected and unhandled steps.** polygraph evaluates `transitionInvariants` on every transition. PS5.2 restricts step properties to accepted ones. *Proposal (no spec change):* the lowered predicate is `(pre, a, d, post, v) => (v && v.rejected) || UNHANDLED.has(a) || Q`, where `UNHANDLED` is the static set of actions with no handler.
- **S9. Flattened payload names can collide.** In PT9.7, `Running` and `Settled` both carry `attempt: 1..3`. PS9.1b gives one field `f_<payload>` per payload name. *Proposal:* one shared field when the types are equal; a new error `PL1601 PAYLOAD_TYPE_CONFLICT` when they differ.
- **S10. `if x == C { … }` is ambiguous.** `C { …` may start a constructor or the `if` block. *Proposal:* Rust's rule. In the condition of `if` and the scrutinee of `match`, an identifier followed by `{` is not a constructor; parentheses restore one.
- **S11. `reject "r"` is used but not in the grammar.** PT9.7 writes `_ => reject "not-proposable"`. `Stmt` has only `require … else reject`. *Proposal:* add `Stmt = "reject" String`, meaning `reject(r)` in PS2.2; a `reject` after a write on the same path is `PL2101`.
- **S12. Integer division is unspecified.** PT2.2 has integer `/` and `%` and calls division by zero a type error. *Proposal:* truncation toward zero, and `%` with the sign of the dividend (the TypeScript meaning, emitted as `Math.trunc(a / b)`). A divisor whose static range contains 0 is a new `PL1204 DIVISION_BY_ZERO`.
- **S13. The diagnostic catalogue has no codes for name and type errors.** *Proposal:* `PL1001 UNKNOWN_NAME`, `PL1002 DUPLICATE_DECLARATION`, `PL1201 TYPE_MISMATCH`, `PL1202 READ_OF_PRIMED_FIELD` (PS2.3 calls this a syntax error; a separate code makes the fix addressable), plus `PL1204` and `PL1601` above, and `PL0901 NOT_IN_MILESTONE` for constructs that parse but are not lowered yet (`emit`, `send`, `spawn`, timers, `Ref` fields, path, compose and liveness properties). `PL0901` refuses; it never passes a program silently.
- **S14. Handler parameter lists.** `on Pay(amount)` and `on AddItem` both appear, and the spec does not say whether the list binds, renames or may be omitted. *Proposal:* the list is optional; when present it must repeat the declared names in order (`PL1201` otherwise). Parameters are in scope in either case.
- **S15. What properties may mention.** PT4.5 shows `pre.`, `post.`, `action == Place` and `rejected("…")`. *Proposal for M0:* invariants read fields; step properties read `pre.f`, `post.f`, `action` and the action's parameters; reject properties read `pre.f` (or bare `f`), `action`, parameters and `rejected("r")`. A parameter not declared by the compared action is a type error, not `false`.
- **S16. Two SAM versions in one check.** polygraph's loader resolves `@cognitive-fab/sam-pattern` inside a spec to its vendored 2.2.0 bundle. Strict `validate()` and translation validation use npm 2.2.1. No behaviour difference is known. *Proposal:* record both versions in the instance line; no engine change. If they ever disagree, that is a polygraph issue, raised in its repository.
- **S17. Where the corpora live (blocking step 8).** The gate reads corpora from `C:\Users\jjdub\code\polygraph` and `C:\Users\jjdub\code\osssm`, outside this repository, so CI cannot see them. *Proposal:* copy the traces, contracts, invariants and hand-written controls (data, not engine code) into `conformance/field-studies/<name>/` with a `PROVENANCE.md` giving the source path and commit, plus a script that diffs them against the local sources when those exist.
- **S18. `Ref<M>` in M0.** The handoff says "as a type only". *Proposal:* parsed and type-checked, `none` and `==` included; a machine with a `Ref` field is refused at lowering with `PL0901` until M1.
- **S19. A parameter that shares a field's name hides the field (found at step 8; open).** The raft corpus names both `NewerTermSeen`'s datum and a state key `term`, and the handler must compare them (`data.term > model.term`). Names lower verbatim (PT2.1), so neither can be renamed, and nothing in PT2 or PS2 lets a handler name the field once the parameter shadows it. *Proposal:* in a handler, `pre.f` names the pre-state field `f`, as it already does in step and reject properties (PT5); a bare name resolves to the innermost binding (local, then parameter, then field), as in TypeScript. *Status:* implemented provisionally in the checker, the lowering and poly-ref, so the raft gate can run; the spec text is unchanged until the owner rules. The alternative, an error on any parameter that shares a field's name, would make the raft corpus inexpressible (AC2).

The owner's rulings are in [`decisions-m0.md`](decisions-m0.md). S9 to S15 were written into 03 and 04 in commit `7506a66`.

## 7. Progress and measurements

Steps 1 to 9 are done. poly-ref reproduces every single-machine evidence number before any lowering exists (`test/evidence.test.mjs`), and each script still prints the number it is compared with.

| Machine | poly-ref | Script | Check time |
|---|---|---|---|
| hello turnstile | 7 states; `PL3201` at `Locked/3`, witness `Coin, Coin, Coin, Push`, rejections `Coin: coin-box-full, Push: locked` | same | 6 ms |
| hello with `Empty` | 7 states, clean | same | 1 ms |
| `OutboxIntent`, union | 17 states, 24 accepted steps, 187 transitions, no deadlock | 17, 24 | 6 ms |
| `OutboxIntent`, union, AC9 escape | `PL3102` at `Allowed { attempts: 3 }` after `SettleFailed` | (AC9) | 4 ms |
| `OutboxIntent`, v0.3 | 33 states, 40 accepted steps, no deadlock | 33, 40 | 7 ms |
| `OutboxIntent`, v0.2 | 35 states, 40 accepted steps, `PL3201` at `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)` | same | 3 ms |

Times are single runs of `checkMachine` on Node 24.12, including exploration and every property.

Step 6 is done. Every example and conformance source lowers to `contract.json`, `next.cjs` and `invariants.mjs`; each `next.cjs` passes strict `validate()` from `@cognitive-fab/sam-pattern` 2.2.1 (`test/validate.test.mjs`, 12 sources). As a probe before translation validation, polygraph's model check of each lowered module reached the same state count as poly-ref on all 12 (7, 7, 17, 33, 35, and 5 to 19 for the six conformance cases). The AC9 escape variant is the expected exception: polygraph explores past the out-of-type state until its cap (S5), which `poly check` will set from poly-ref's count at step 9. The probe found one lowering bug, a union tag read through `pre` inside a reject property, now fixed; step 7 makes such checks systematic.

Step 9 is done. `poly check <file.poly>` (`packages/poly-check`) runs stage 0 (parse, type, domains), the lowering into `.poly/build/<module>.<Machine>/`, stage 1 (strict `validate()`), 1b (translation validation), 2 (polygraph's `check()` on the lowered module) and 2b (poly-ref's deadlock check). It folds the verdict (02 §5), prints it with its checked instance (PT12.3a) and the engine versions (S16), lists every stage that did not run with its reason, and exits with the PT12.3 codes. `--json` prints the report with every diagnostic in `poly.diagnostic/1` form. `test/cli.test.mjs` covers each verdict and exit code.

| Source | Verdict | States | Translation validation | polygraph model check | Wall time, whole command |
|---|---|---|---|---|---|
| hello | `FINDINGS` (exit 1), `PL3201` | 7 | 6 ms | 3 ms | 107 ms |
| hello with `Empty` | `CLEAN` (exit 0) | 7 | 6 ms | 4 ms | 152 ms |
| turnstile | `INCONCLUSIVE` (exit 2), `PL3901 coins` | 7 | 8 ms | 5 ms | 134 ms |
| raft | `INCONCLUSIVE` (exit 2), `PL3901 term` | 38 | 21 ms | 18 ms | 151 ms |
| hatchet | `CLEAN` (exit 0) | 216 | 156 ms | 126 ms | 396 ms |
| AC9 escape (fixture, no liveness) | `FINDINGS` (exit 1), `PL3102` | 17 | 16 ms | 14 ms | 140 ms |

Single runs on Node 24.12. Wall time includes starting Node.

Two decisions made in the pipeline, recorded here for review:

- **polygraph's cap (S5).** polygraph cannot stop at a state outside the instance, so it is given poly-ref's state count plus the out-of-instance states plus one. When the instance has no such state, polygraph's count must equal poly-ref's, or the difference is `PL2501`. Inside a capped exploration poly-ref is authoritative, and any property it finds violated that polygraph did not reach is reported under poly-ref's name.
- **A lowered module that fails strict `validate()`** has no code in the catalogue. It is a toolchain fault, so `poly check` stops with exit 4 (error) and the engine's message. A code such as `PL2001 STRICT_VALIDATE` could be added; no source reaches this today.

Step 8 is done. The corpora are copied into `conformance/field-studies/` with a `PROVENANCE.md` each (source path and commit, upstream project and commit, licence, SHA-256 of every file); `scripts/sync-corpora.mjs` verifies them, and CI reads only the copies. The six rewrites are in `examples/field-studies/`. Under polygraph's own replay (`replaySpecResults`), each gives the same result as its hand-written control on every window, in both directions:

| Study | Hand-written reference / broken | poly / poly broken | Windows that differ |
|---|---|---|---|
| turnstile | 12/12, 9/12 | 12/12, 9/12 | 0 |
| raft | 54/67, 44/67 | 54/67, 44/67 | 0 |
| hatchet | 19/19, 18/19 | 19/19, 18/19 | 0 |

The rewrites also pass strict `validate()` and translation validation: hatchet 216 states (the full 6³ space the study reports), 3,888 transitions; raft 38 states within `term ∈ 0..9`, 342 transitions; turnstile 7 states within `coins ∈ 0..3`. poly-ref reports `PL3901` for raft's `term` and the turnstile's `coins`, which grow without limit in the real machines (PS4.2a), so `poly check` will give those two `INCONCLUSIVE`, as designed. The raft rewrite depends on S19.

Step 7 is done. `translationValidate` in poly-ref drives each lowered `next.cjs` through its SAM surface on every `(s, a, d)` of `Reach(I) × D(a)`. It compares the verdict kind, the reason and the next state through its own α (`alpha.ts`, written from PS9.1b), and also compares the flat next state. It then evaluates the lowered `invariants.mjs` on every reachable state and every transition, and compares the results with PS5.

| Source | States | Transitions compared | Property evaluations compared | Mismatches |
|---|---|---|---|---|
| `OutboxIntent` union / AC9 escape | 17 / 17 | 187 / 187 | 255 / 255 | 0 |
| `OutboxIntent` v0.2 / v0.3 | 35 / 33 | 385 / 363 | 875 / 825 | 0 |
| hello / with `Empty` | 7 / 7 | 14 / 21 | 14 / 14 | 0 |
| conformance (six cases) | 5 to 19 | 25 to 76 | 10 to 143 | 0 |

Broken lowerings (`test/tv.test.mjs`): each fault is caught with `PL2501` on at least one source.

| Fault | Caught on | Equivalent on I |
|---|---|---|
| `drop-frame` | 8 sources | union outbox (both), `match-union`: there every frame it drops follows a `return reject(...)` and never runs |
| `swap-reason`, `invert-require` | all 12 | none |
| `off-by-one` | 10 (the other two have no integer literal in a write) | none |
| `skip-guard` | `guard-terminal`, the only source with a guard | none |
| `skip-terminal` | the 6 sources with a reachable terminal state | none |

A fault that changes the artefacts but not any transition of I is listed as equivalent, never counted as caught.

One consequence of S13 surfaced while checking the examples: the three `OutboxIntent` forms carry the `settles` liveness property as the spec writes it, so the checker refuses them with `PL0901` until M2. poly-ref ignores liveness and checks them. For steps 6 to 9, the lowering and `poly check` will see `PL0901` on these files; the gate items that need them lowered (translation validation) will use them with the liveness item removed, and the test says so.

## 8. Risks

- **The formatter and comments.** Keeping every comment in place while printing one canonical text is the fiddliest part of the front end. The test is idempotence and digest invariance over every example.
- **polygraph caps.** For raft and the turnstile, polygraph's exploration of the lowered module has no natural end (S5). The result is `INCONCLUSIVE` by design, and the time spent is measured and recorded.
- **The field-study rewrites differ from the hand references where poly adds a rule.** Raft gains `terminal role is Shutdown`, which changes reject reasons but not states, so replay (which compares states) is unaffected. The difference is written down in the example's header.

## Conclusion

M0 is five packages and one command. The order puts poly-ref's evidence tests before any lowering, so the checker's numbers are fixed before the compiler exists to influence them. Every gate item has a test that fails when the item fails. Eighteen spec issues were found. Six block work: S1 and S17 block the field-study gate, S2 and S5 block poly-ref's evidence tests, and S3 and S4 block the turnstile and hatchet rewrites. The others have a proposed resolution that needs no spec change, or a small one, and are listed so they are decided rather than guessed.
