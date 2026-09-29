# Review: poly specification set, draft v0.1

*Peer review of `README.md`, `docs/01-functional-spec.md`, `docs/02-architecture.md` and `docs/03-technical-spec.md`. Written in a deliberately blunt register at the author's request. 29 September 2026.*

## Verdict

**NAK as written.** The idea is good. Its core is sound: one source compiled to artefacts that engines with a track record already read. But the documents keep saying "thin" while specifying a thick system, and the one experiment that could kill the idea is scheduled last. Fix the ordering, cut the scope, and fix the three semantic holes below. Then I will read it again.

## 1. Stop saying "adds no new engine"

The architecture calls itself thin, and then specifies all of the following:

- a parser;
- a formatter with canonical hashing;
- a type and domain checker;
- eight lowering targets;
- a verdict fold;
- a diagnostic model with ten code ranges;
- typed source edits;
- a certificate format;
- a gate hook with a new Σ extension;
- a new proposal kind;
- a unified ledger that replaces two existing journals;
- an MCP server;
- a language server;
- a Claude Code plugin;
- a world DSL with its own distribution syntax.

That is not thin. That is a compiler, a runtime integration and a toolchain. It is fine to build all of that. It is not fine to describe it as "four layers of its own" in the conclusion of 02. Anyone who reads section 12 of 02 and then PT9 and PT16 will stop trusting the rest of the document.

**Fix.** Replace the thinness claim with a scope table: new code, changed code in each engine, unchanged code. Let the reader judge.

## 2. The experiment is in the wrong place

PT18 puts the experiment at M7, after the runtime, the governance, the MCP server, the plugin, mining and worlds. That is backwards. The whole project rests on two claims that nobody has measured:

1. A coding agent can write poly at all, with no poly in its training data.
2. Checking at compile time reduces escaped defects compared with checking after the fact.

If claim 1 is false, M3 to M6 are wasted.

Neither claim needs the runtime. Both need only M0 to M2: the language core, effects, and diagnostics with witnesses.

**Fix.** Move a reduced PT13 to right after M2. Use the lowered artefacts with the existing polygraph and polyrun tools, and no new runtime. Gate M3 on its result. That is the stack's own doctrine ("controls before trust"), and the plan ignores it.

## 3. "The checked program is the running program" is only true modulo the check domains

PT3.4 says a runtime value outside the check domain is accepted and flagged `outsideCheckDomain`. So the certificate certifies a program over `{10, 20}`, and production runs it over every integer. That can be a reasonable engineering trade. But PA0.2 states it as an absolute, and it is not one.

**Fix.** Either:

- state the principle with its condition, "over the declared check domains, and drift is journaled"; or
- give the author a per-field choice: `check … strict` rejects out-of-domain input at dispatch; `check … disclosed` accepts and flags.

Offer both, and default to `strict` for fields that feed an irreversible effect. The compiler already knows which fields those are.

## 4. The gate reading application state is a race you have not specified

PT8.3 lets a policy read `machine("orders.Order").status`. PT9.3 mirrors snapshots into Σ "on each committed step". The gate decides at outbox time. Between commit and outbox claim, the instance can take more steps. So which snapshot does the gate see?

- **The snapshot at emission.** The decision is about a state that may no longer exist.
- **The latest snapshot.** The decision is about a state the effect was not emitted from, and replay must then reproduce worker timing, which it cannot.

Both are defensible, but the choice has to be made in the spec, not left to the implementer.

**Fix.** The proposal must carry the `seq` and state digest of the emitting step, which PT9.1 already has, and the gate must evaluate against exactly that snapshot. Say so in PT9.3, and add a replay requirement: the gate decision is a function of (policy digest, Σ at proposal, snapshot at emitting seq). Then PF8.6 holds.

## 5. One hash chain per runtime is a global lock

PT16 says "one append-only ledger per runtime", hash-chained. polyrun's whole concurrency model is a single writer per instance. A per-runtime chain serialises every step of every instance through one `prev` pointer. That is the first thing that falls over under load.

The polyflow platform ledger it copies is already keyed by `run`.

**Fix.** Chain per run (per instance). Periodically anchor the heads in a runtime-level Merkle root, if you need a global statement. Put a throughput target in PT9.6 next to the latency one.

## 6. Four expression languages in one file

A `.poly` file contains:

1. the TypeScript-subset expressions in handlers;
2. PX, which is three-valued, in policies;
3. path predicates (`count`, `before`) in emission invariants;
4. a distribution language in worlds (`lognormal(mean 200ms, sd 80ms)`, `ok p 0.97`).

PT2.3 promises the compiler will reject cross-contamination. Good. But the same `==` means two-valued equality in one block and Kleene equality ten lines lower. That is exactly what confuses agents with little training data, and the risk table in 01 admits it.

**Fix.** Make the context visible in the syntax, not only in the checker. Two options:

- a different operator set in policies (`is`, `is not`, `unknown`);
- or keep policies in their own file type (`.policy.poly`).

Keep worlds out of v1 entirely. Nobody needs them to test claims 1 and 2.

## 7. Grammar bugs

- **`map<E, T>` has no operations.** PT3.1 declares the type. PT2.2 gives no indexing, update or iteration. An agent can declare a map and can never read it.
  - Either add `m[k]` and `m' = m with [k] = v`, with the obvious lowering,
  - or delete the type.
- **"No write precedes a `require` on any path" is ambiguous under `if`.** Is `if a { x' = 1 } require b else reject …` legal? The two readings are "per path" and "textually first". Pick one, write the rule down, and give it a code.
- **`Version` binds a `MigrateBlock` with no production.** The migration body uses primes (`status' = status`), which reads as a step, not a mapping from the old shape to the new. Use `new.status = old.status` in `migrate`. Primes mean "next state" everywhere else.
- **`after … as Ident` does not say what happens to a duplicate key.** Say whether a second `after` replaces the timer or is a compile error.
- **`Terminal = "terminal" Expr`, but the examples write `terminal status in { … }`.** Fine, but say whether a terminal state is a predicate or a set. polygraph's contract wants `terminalStates` as a list of states.

## 8. Typed fixes by line and column will rot

PT12.1 fixes are `{ line, col, len }` edits. The formatter is canonical, so any other fix applied first shifts every line. An agent applying two fixes in sequence breaks the second.

**Fix.** Address fixes by AST node id (you already hash the AST), with a precondition digest of the node. Reject the fix if the digest changed. That is what you do everywhere else in this stack, so do it here too.

## 9. Retry, deny and settle need a state table

PT9 gives the gate outcomes. PT6.1 gives retries. Nothing covers the interleavings:

- **Handler finishes, SETTLE fails.** The intent is retried with the same idempotency key. Is it proposed to the gate a second time? If yes, the second decision can differ (Σ grew), and you get "allowed, executed, then denied".
- **The gate denies on attempt 2 of 3,** after attempt 1 timed out and possibly executed.
- **An escalation is never approved.** `escalated` has no timeout. The polyflow platform policy has `escalation.timeoutMs`. Copy it.

**Fix.** Write the outbox intent as a state machine in poly, with states `pending`, `proposed`, `allowed`, `running`, `settled`, `denied`, `escalated`, `dead`. Check it with polygraph. You have the tool; eat your own cooking. This is the most dangerous code in the whole design, and it is the only part without a model.

## 10. The experiment is biased toward arm 3

PT13's oracle is hidden invariants plus traces from a hidden reference machine, written by a person in the same formalism. Arm 3 writes in that formalism and gets checked in it. Arm 1 writes TypeScript. The oracle is shaped like the treatment.

There are three further problems:

- ten tasks, and no statistical plan;
- no statement of how many runs per task;
- no pre-registered effect size that counts as a win.

**Fix.**

- Add oracle checks that are not state machines: end-to-end scenario tests written from the brief by someone who never saw the reference machine.
- State the runs per task.
- State the test and the minimum effect that counts as a win, before any run.
- Report tokens and wall time as primary measures, not secondary ones. If poly halves defects and triples cost, that is the headline.

## 11. Smaller items

- **`poly accept` and `poly approve` are "not exposed over MCP" to keep agents out.** That is theatre if the agent has a shell. Put the enforcement in the certificate signer: the key that signs an acceptance must belong to a person, and the check verifies it. Otherwise say plainly that it is a convention.
- **PF9.5 promises the same hash for the same formatted text,** but PT1.4 hashes the AST. Those differ as soon as comments exist. Say whether comments are in the AST.
- **AC2 cites "raft role-transition"**, but the raft field study found no defects. As a positive control it proves only expressibility. Say that.
- **The functional spec's positioning table is fair.** The citations marked "secondary" in the landscape note must not be quoted as numbers anywhere in the specs. Check that they are not.
- **The glossary defines "Gate" as the Polyaxion guarded merge,** but the polycheck runtime guard and the polygents gate also exist. Call this one "the effect gate".

## 12. What is good

- **The lowering map (02 §4)** is the best page in the set. Every construct maps to one artefact and a named engine. Keep it as the source of truth, and generate the conformance suite from it.
- **Frame derivation and require-before-write** remove two real classes of agent error (`SamFrameError`, `rejectAfterWrite`) by construction, not by documentation. That is the right kind of language design.
- **The double-charge example in PT4.5** is exactly the right demo. Put it first in the README, with the witness output, before any prose.
- **The rules "no silent clean" and "`INCONCLUSIVE` with the bound"** are correct, and most tools in this space get them wrong.
- **Mined rules that must be promoted and adjudicated before they enforce anything** is the right boundary between learning and governing.

## 13. What I would merge

A v0.2 that does the following:

1. Rewrites the scope claim as a table (item 1).
2. Moves the experiment to after M2 and gates the runtime on it (item 2).
3. Fixes the domain principle, the gate snapshot semantics and the ledger chaining (items 3, 4, 5).
4. Removes worlds from v1 and separates the policy syntax (item 6).
5. Fixes the grammar holes (item 7) and the fix addressing (item 8).
6. Specifies the outbox intent as a checked machine (item 9).
7. De-biases the experiment (item 10).

## Conclusion

The design is worth building because its core is sound: one source, lowered to artefacts that tested engines already read, and a certificate that binds what was checked to what runs. The documents oversell the thinness, leave the gate, retry and ledger interactions unspecified, and put the only falsifiable test at the end. Cut worlds, pull the experiment forward, and model the outbox with your own tools. Then this is a spec I would sign.
