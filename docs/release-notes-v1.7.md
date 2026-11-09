# poly v1.7.0 · Release notes (poly guide, poly rules, and a before and after)

Not tagged. This document is the draft for the owner's approval; the tag waits for the release run.

## What v1.7.0 is

v1.7.0 puts what poly already checks where an agent and a reader meet it first. It adds two read-only commands and one example, and fixes the two flaws a review found in the risk report's code. No format, verdict or certificate of v1.6.0 changes, so a project admitted under v1.6.0 loads as it was.

- **`poly guide`** (S588) prints a guide written for a coding agent. poly's README gives the four lines to put in a project's `AGENTS.md` or `CLAUDE.md`.
- **`poly rules`** (S589) lists every rule of a program on one page. With `--check`, it says which rules a change added, removed or changed.
- **`examples/refund-twice`** (S588) shows one mistake twice: a TypeScript desk whose own tests pass and which refunds an order twice, and the same desk in poly, where `poly check` refuses the mistake with the two steps that pay twice.

The idea came from Bend's landing page (bend-lang.com), which makes the same case for a different kind of program: a person keeps the rules, and an agent's change that breaks one does not merge.

**How it was built.** On `main` from v1.6.0 (`185a1552`). The branches `finding-38-report-cleanup`, `guide-before-after` and `rules-index` were merged in, 24 commits, and the release adds its own. The new features followed rule 7a: a plan the owner approved, the spec committed alone, tests by a separate writer on the session's model that failed first, then the code. Each departure is marked **Departure** where it occurs.

## `poly guide` (S588, PT14)

- `poly guide` prints `packages/poly-check/GUIDE.md` byte for byte and exits 0. Any argument is a usage error (64). Over MCP it is the tool `poly_guide`, which returns `{ "text" }`. It reads no project and writes nothing.
- The guide has eight sections, in a fixed order: what poly is, the loop, the verdicts, where the rules live, what never to do, before committing, where to read more, and a conclusion. A test holds that every command, verdict and diagnostic code it names exists.
- The Claude Code skill keeps its front matter and tells the agent to run `poly guide` before anything else, so the two cannot drift apart.
- poly's README gains *Using poly with a coding agent*, with the four lines for `AGENTS.md` or `CLAUDE.md`. No command writes them.

## `poly rules` (S589, PT14)

- `poly rules [<file.poly> | <project dir>] [--format md | json] [--check <file>]` reads the sources and nothing else. It runs no check stage, calls no engine, verifies no signature and writes no file. Over MCP it is the tool `poly_rules`.
- **What it lists:**
  - each machine and configuration property: `invariant`, `step`, `reject`, `path`, `compose`;
  - each `never … emit` statement and each liveness property;
  - each policy item.

  Each rule comes with its id, kind, module, owner, file, line, and its text as `poly fmt` prints it, with no comment and with its common indentation removed. A policy item also has its tags, and what its scope's signature file states (signer and sequence), or `not signed`.
- **The output.** JSON in a fixed order, so two runs give the same bytes, and a Markdown page rendered from it in a fixed layout.
- **`--check RULES.md`** compares a committed page with the sources. It exits 0 with `up to date: <n> rules`. Otherwise it exits 1 and names each rule `added`, `removed` or `changed`, ordered by id. A page edited by hand, with no rule changed, gets one line saying so.
- **What it does not do.** It stops nothing. A program without a rule still checks `CLEAN` and is admitted. The index makes the removal visible where `RULES.md` is committed and checked in review or CI. Signing a project's rules, so that admission refuses one that drops a signed rule, is planned for v2.0 (`docs/proposals/signed-rules.md`). The owner has ruled it opt-in, one way once taken, and limited to machine and configuration rules.
- poly-lang gains `ruleText`. The policy printer now prints one item at a time for it; the text of a whole module is unchanged.

## The refund-twice example (S588)

- **The before**, `examples/refund-twice/before/`, is TypeScript run by Node 24 with no build step.
  - The desk pays through an in-memory Stripe stand-in, then writes its ledger, and never reads the ledger first.
  - Its four tests pass, so `npm test` is green.
  - `twice.test.ts` is the test nobody wrote. It shows one order refunded twice with two idempotency keys, and it passes by asserting the bug.
- **The after**, `examples/refund-twice/after/`, is the desk in poly, cut down from the concierge's Desk. It states `never no-reissue: emit refund while refund != None` once.
  - `poly check` reports `FINDINGS` on the unguarded desk: `PL3002` on `no-reissue`, with a two-step witness (a request pays, and a second request pays again while the first is pending), and `PL4002` on the same step.
  - The guarded desk is `CLEAN`, with 8 states.
- **What the README claims.** It shows both, with the witness as `poly check` prints it, and says the before was written by hand. It says the amount is explored at its cut `{0}`, that a refund made in Stripe's dashboard is not seen, and that the demo baseline is where a comparison is measured.
- **poly's README.** Its first screen no longer says "No code yet": its status line names the current release and links its notes. It gains *Before and after*. Test 8 of the example no longer pins a release number (amendment 2, `a995ec78`). **Departure:** that test was changed in the session, not by the separate writer.

## Fixes

- **Finding 38: two flaws in the risk report's code**, found by the owner's `/code-review max` over v1.5.1 to `438cacac`. Two of fifteen candidates held; the finding records why the others do not.
  - `itemOf` read a reason with no `::` as its last character. No report was wrong, since no item id is one character long.
  - `PolicyGate.policySets` and `replaySessions` each left a `poly-gate-*` folder in the temporary directory, and `replaySessions` never closed its engine. Both now open their gate in a folder of their own, and remove it whatever they ended with. On polywatch's review, a refused declaration now also closes its engine and removes the folder `open` made.
  - **Departure:** the test of the folders was written in the session, not by a separate writer, and no specification changed.
- **DB3: the demo baseline's poly arm does not get the README's before and after.** That section works through a refund issued twice, the baseline task's own case. The reference cuts it from the arm's copy, as it cuts the double charge. **Departure:** a fix to the reference, made after the test found it, with no separate writer.
- **The Slack provider id in the concierge's kept journal is accepted for now** (`docs/history/decisions-risk.md`, 2026-11-07). The ruling is reopened if a bot posts where a channel names a person.
- **Polywatch fixes to `poly rules --check`**, before the merge.
  - A rule moved to a renamed file is now `changed`, not read as a hand edit.
  - Two policies of one name in two files keep both entries.
  - **Departure:** no separate writer for either.

## The test runs on v1.7.0

To be filled in from the release run on the AMD box, at `f0dad748`: the main group, then the serial after group, each run whatever the other gave.

## Known limits

The limits of v1.6.0 hold (`docs/release-notes-v1.6.md`). New:

- **`poly rules` stops nothing.** It shows a removed rule only where its page is committed and checked. Signed rules are the v2.0 answer.
- **`poly rules` reads `.poly` sources only.** Embedded `.ts` modules are not read in this version.
- **`poly rules --check` calls a rule `changed` when only its line moved.** An entry includes its line, so a rule shifted by an edit above it is listed as changed.
- **The refund-twice before measures nothing.** It was written by hand; the demo baseline's kept runs are still to be made.

## Conclusion

v1.7.0 changes nothing poly checks, and changes where it is seen. An agent can learn poly from one command. A reviewer can see every rule of a program on one page and catch the change that drops one. A reader meets, on the first screen, one mistake that passes its own tests in TypeScript and is refused, with its path, in poly. The rules that matter can still be removed by the agent that broke them; signing them is the next step, and its plan is ruled.

## Glossary

- **Guide:** `GUIDE.md`, the text `poly guide` prints for a coding agent.
- **Rules index:** the page `poly rules` prints, every rule of a program from its sources.
- **`RULES.md`:** that page committed in a project, which `poly rules --check` compares.
- **Before / after:** the TypeScript desk with the mistake, and the poly desk where the check refuses it.
- **Signed rules:** the v2.0 plan in which a person signs a project's rules, and admission refuses a build that drops one.
- **Rule 7a:** the order of work: the specification first, then tests by someone who has read only it, then the code.
