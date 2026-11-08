# poly · `poly guide`, and a before and after: a refund issued twice (S588)

*Cognitive Fab · November 2026 · on branch `guide-before-after`, cut from `main` at `438cacac` (v1.6.0 and the Slack ruling) · from PT14, PT12.5, the Claude Code adapter's skill (`adapters/claude-code/skills/poly/SKILL.md`), the concierge (`examples/concierge`, DF19) and the demo baseline (`demo/baseline`)*

Status: **approved by the owner on 2026-11-08, with the defaults of section 6** (`examples/refund-twice`; TypeScript run by Node 24 with no build step; `packages/poly-check/GUIDE.md`; nothing else changed on the README's first screen). The spec is PT14's `poly guide` as built and `docs/examples/refund-twice.md`. The owner chose on 2026-11-08 what the before is (a TypeScript program), which bug it shows (a refund issued twice) and what `poly guide` does (it prints a guide). When the owner approves this plan, sections 2 and 3 become the spec commit of rule 7a, committed alone.

## 1. Why, and what was read

Bend's landing page (bend-lang.com, read on 2026-11-07) makes the case poly makes, for a different kind of program: a person keeps the rules, and a change from an agent that breaks one cannot merge. Two of its devices are worth taking. An agent learns the language from one command, `bend guide`, named in four lines of its `AGENTS.md`. And the page shows the same agent mistake twice, merged without the rules and refused with them.

poly has the parts and does not show them that way:

- **An agent's guide exists, in the wrong place.** The Claude Code adapter's skill (`adapters/claude-code/skills/poly/SKILL.md`) holds the loop (check, read the diagnostic, export a witness, apply a typed fix, check again), the verdicts and what never to do. An agent outside Claude Code, or one never given the skill, does not see it. No command prints it.
- **The README's first screen is stale.** It says "Status: specification, draft v0.6 (after five reviews). No code yet." poly has shipped every release from v1 to v1.6.0 since.
- **The before and after exists, but only inside a test.** The concierge's Desk guards each refund with `if refund == None` and states `never no-reissue: emit refund while refund != None` (DF19). The variant that keeps the ledger and does not consult it gives `PL3002` with a 10-step witness (`test/after/ex-concierge-ledger.test.mjs`, DF19 item 6). Nobody sees it without reading the test. The concierge is also too large for a first screen: its admission checks the whole program and takes minutes.
- **The measured comparison is not run.** The demo baseline (`demo/baseline`) gives one prompt to a TypeScript arm and a poly arm, under a pre-registration. Its pilots ran; its kept runs have not. The example here does not replace it and claims nothing it measures: it shows one mistake, written by hand.

## 2. `poly guide` (PT14)

- **The command.** `poly guide` prints `GUIDE.md` to standard output and exits 0. It takes no argument; any argument is a usage error (64). MCP: `poly_guide`, read-only, which returns the same text as `{ "text": … }`. It reads no project and writes nothing.
- **Where the text lives.** `packages/poly-check/GUIDE.md`, shipped in the package beside `dist/`. The skill is written from it: the adapter's `SKILL.md` keeps its front matter and says to run `poly guide` (or call `poly_guide`) first, so the two cannot drift apart.
- **What the guide holds, in this order.** Each is a heading of its own, and the guide ends with a conclusion.
  1. What poly is, in three sentences: the stateful core, checked before it runs, governed when it runs.
  2. The loop, from the skill: write, `poly check`, read each diagnostic and its witness, `poly fix` or edit, check again, until `CLEAN`.
  3. The verdicts: `CLEAN`, `FINDINGS`, `REFUSED`, `UNDERPOWERED`, `INCONCLUSIVE`, and that only `CLEAN` is done.
  4. Where the rules live: invariants and `never` statements in the machine, path properties, configurations, and policies in `*.policy.poly`. A policy a person signed is the person's: an agent never edits it to make a check pass.
  5. What never to do, from the skill: accept a finding, approve an escalation or admit on a person's behalf; weaken a property or a domain.
  6. Before committing: `poly check` on the project, and nothing but `CLEAN` is committed as done.
  7. Where to read more: `docs/04-semantics.md`, `docs/03-technical-spec.md` and the examples. (`poly explain` is in PT14's table and not built, so the guide does not name it.)
- **What the guide names is real.** Every command it names is a command of the registry (`packages/poly-check/src/commands.ts`), and every verdict and diagnostic code it names is one the toolchain defines. A test holds each to that.
- **The lines an owner pastes.** The README, under a new section *Using poly with a coding agent*, gives the block to put in `AGENTS.md` or `CLAUDE.md`, word for word:

  ```
  - Run `poly guide` to learn poly before writing any.
  - Keep the rules that must always hold in poly: invariants, `never` statements and signed policies.
  - Run `poly check` before committing; only `CLEAN` is done.
  - Never edit a signed policy or accept a finding: those are the owner's.
  ```

  No command writes these lines into a file (the owner's choice of 2026-11-08).

## 3. The example: a refund issued twice (`examples/refund-twice`)

**The scene.** A support agent issues refunds through Stripe. A customer asks for a refund of order 9011, and it is issued. The customer writes again ("I still don't see it, please refund me"). The second request is a new message, so it gets a new idempotency key, and Stripe's key does not stop it (the key of S526 covers the retries of one intent, not a second intent). A program that keeps a ledger of refunds and does not consult it before issuing pays the order twice.

**The before: `examples/refund-twice/before/`, TypeScript for Node 24.**

- `refunds.ts`: the handler as a coding agent could plausibly write it. It reads the order, calls a Stripe transport, and records the refund in a ledger after the call. It never reads the ledger before the call. About 60 lines, no dependency beyond Node.
- `refunds.test.ts`: the tests such an agent writes and stops at. A request for a known order issues one refund of its amount; an unknown order is refused; the ledger records the refund. They pass, so `npm test` is green and the change merges.
- `twice.test.ts`, kept apart and named as the test nobody wrote: the same customer asks twice and Stripe is called twice, for the full amount each time. It passes, because it asserts the double payment: it is the record of the bug, not a test the before should pass.
- Stripe is a stand-in transport that records each call. Nothing reaches the network.

**The after: `examples/refund-twice/after/`, poly.**

- `refunds.poly`: one module, one machine `Desk` per order, cut down from the concierge's Desk to the refund alone: a request, the refund effect, its completion, and `refund: Refund = None | Unknown | Issued`. It states the rule once: `never no-reissue: emit refund while refund != None`.
- `refunds-unguarded.poly`: the same mistake as the before, written in poly. The request emits the refund without consulting `refund`. `poly check` reports `FINDINGS` with `PL3002 no-reissue` and a witness: a request that pays, and a second request that pays again. (Drafted on 2026-11-08 before the spec: the shortest witness is two `Ask` steps, the second while the first refund is still pending, and the same step is also `PL4002`.) The README prints the witness as `poly check` prints it.
- `refunds.poly` guards the emit with `if refund == None`, as the concierge does, and answers the second request without paying. `poly check` reports `CLEAN`, and the property is not vacuous.
- The module is small enough to check in seconds, and its instance is printed with its verdict (PT12.3a).

**What the README says, and what it does not claim.**

- A side-by-side of the two files, the green `npm test` of the before, the before's twice test, and the `PL3002` witness of the after.
- It says that the before was written by hand to show the mistake, not taken from an agent's run, and points to the demo baseline for the measured comparison.
- It says what the check covers: `no-reissue` holds for every interleaving of requests and completions within the declared domains, and the instance is printed. It says what it does not: a refund made outside the program (in Stripe's dashboard) is not seen, and Stripe's own behaviour is the stand-in's.
- poly's README gains a short *Before and after* section on its first screen that links to it, and its stale status line is replaced by the current release (v1.6.0).

## 4. Tests, by a separate writer (rule 7a)

The writer reads sections 2 and 3 only, and works on the session's model.

- **The guide.** `poly guide` prints `GUIDE.md` byte for byte and exits 0; an argument is a usage error (64); `poly_guide` returns the same text; it reads no project and writes nothing. The guide has the seven headings in order and ends with a conclusion. Every `poly <command>` it names is in the registry, and every verdict and `PL` code it names is defined. The adapter's `SKILL.md` names `poly guide`. The README holds the four lines word for word. House style: no em dash, none of the banned words.
- **The before.** In `examples/refund-twice/before`, `npm test` (the agent's tests) passes. `twice.test.ts` passes and shows two Stripe calls for one order. No file of the before reaches the network.
- **The after.** `refunds-unguarded.poly` checks `FINDINGS` with `PL3002` on `no-reissue`, and its witness holds two refund emissions for one Desk. `refunds.poly` checks `CLEAN` with `no-reissue` proved, not vacuous. Each prints its instance.
- **The README.** The example's README holds both files' key lines and the witness as `poly check` prints it today (compared, so a change to the check's output fails the test), and says the before was written by hand.

## 5. Order of work

1. This plan, for the owner's review. Any ruling the owner makes is recorded under S588.
2. Spec: sections 2 and 3 enter PT14 (the command row, *`poly guide` as built*) and `docs/examples/refund-twice.md`, committed alone.
3. Tests by a separate writer on the session's model, failing first.
4. Code: `GUIDE.md`, the command and its tool, the skill's change, the example, the two READMEs.
5. The new test files and the files the change touches, on the AMD box with `box-test.sh`. The full suite only at the owner's word.

## 6. Questions for the owner

1. **The example's name.** `examples/refund-twice` is proposed. The concierge stays as it is.
2. **The before's language.** TypeScript compiled by Node 24's type stripping (`node --test` on `.ts` files, no build step), or plain JavaScript with JSDoc types. TypeScript is proposed, as the demo baseline's TypeScript arm uses.
3. **Where the guide's text lives.** `packages/poly-check/GUIDE.md` is proposed, so it ships with the command. The alternative is `docs/guide.md`, copied into the package at build time.
4. **The README's first screen.** The proposal replaces the status line and adds *Before and after* and *Using poly with a coding agent*. Anything else on that screen the owner wants changed at the same time.

## Conclusion

Both changes take what poly already has and put it where a reader and an agent meet it first. `poly guide` moves the loop and the rules out of one host's skill into a command every agent can run, and keeps the skill reading from it. The example puts the concierge's double refund on one screen: the same mistake in TypeScript, where the agent's tests pass and the money goes out twice, and in poly, where the check refuses it with the path that pays twice. It claims no measurement. The demo baseline stays the place where one is made.
