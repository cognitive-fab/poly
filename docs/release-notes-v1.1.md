# poly v1.1 · Release notes (M7, Feedback)

## What v1.1 is

v1 checks a program before it runs. v1.1 closes the loop the other way: what a running program did goes back, through a person's signed judgement, into the checked source. The pieces are commands, each with its own refusals, and none of them lets a model decide anything. Every verdict of every check still comes from the semantics (`docs/04-semantics.md`).

## What v1.1 contains

- **`poly export traces` (PS19, PT29).** The journals of a certified build as a trace corpus: values for declared domains, a salted token for everything else, erased steps left out and counted, the gate's decision for each effect, and each effect's declared consequence (`unknown` when none). It never goes over MCP.
- **`poly mine`, `poly adjudicate`, `poly promote` (PS20, PT30).** polyx, a separate tool you install and pin, proposes rules from a corpus. A person signs a verdict on each candidate (`real`, `spurious` or `defer`; an agent key never signs one), and `poly promote` adds a rule judged `real` to the program under a marker, checks the project, and undoes the change if the check refuses it. Admission reads every promotion back. **`poly promote --refine <file> --reason <text>`** promotes the person's own text in place of the candidate's when the rule is real and wrong as written; the marker and the record still cite the mined rule, and the entry keeps the reason and the miner's own text.
- **`poly propose` (PS21, PT31).** polyness, a second separate tool, proposes a workflow for a step you repeat. poly reads its rules by four fixed templates of text (it never runs polyness's JavaScript), derives the machine from the steps alone, and writes poly source and an evidence file. Every effect is declared `exec` with no class, so a person declares each consequence. Admission refuses a rule its own history does not support (`PL6520`, with the numbers) and evidence that does not describe the source (`PL6521`). `--runs` takes a store in place of transcripts, through the same export.
- **`poly verdict` and `poly refit` (PS22, PT32).** A person signs a verdict, right or wrong, on one recorded answer of a decision. A refit fits a new calibration map from those verdicts alone, refuses below 50 verdicts or when the map would earn the calibration warning, and says by how much. It writes a new file with a signed record beside it, never edits a map, and the old map stays in force until a person changes the route's path and the project is admitted again (`PL6513` for a record that does not bear out its map). The inbox host signs a verdict with `ask --do adjudicate`, and its digest lists the answers nobody has judged.
- **Work orders with budgets (PS18.7, K16).** A workflow may name a budget with `budget b prices "f" order cap usd 0.05`. The order cap is the reservation; every issued attempt spends it; nothing is released; a re-issued attempt reserves again. A participant's usage report is recorded and reconciled against the cap and never changes what was spent. K16 says so in the certificate.
- **The loop on the inbox.** The inbox example's README has a section on it.

## A defect the loop found, and its fix

The mined rule `count("gmail.createDraft") <= 1` was violated by the first version of the inbox example: a to-do could propose a second draft. The path was real. A creation whose outcome was ambiguous (a timeout or a dropped connection after Gmail may already have made the draft) was reported as a plain failure, retried by the runtime, and proposed again by the to-do, and Gmail drafts carry no idempotency key, so a second post could leave two drafts. **Fixed in this release:**
- the draft is attempted once;
- a definite refusal (400, 401, 403, 404, 429) lets the to-do propose again, and any other outcome puts it in a new `Uncertain` status that only the owner leaves, by looking in Gmail's Drafts and saying `found` or `missing`;
- a one-way `made` flag and the invariant `draft-created-once` hold that once a draft is created the to-do never proposes another.

Drafts are off by default (the host starts read-only), so no user has been exposed. The mined rule was adjudicated real and too strong as written (a definite refusal may be proposed again), and the invariant the person meant was promoted in its place as a refinement of it. An assumption stays and is stated: a person who answers `missing` when the draft does exist can get a second draft; the runtime cannot know.

## S526: retrying an irreversible effect without an idempotency key (a later release)

The runtime retries a non-permanent failure of an effect, up to 3 attempts by default, and nothing says that a given irreversible effect has no idempotency key. The inbox now declares one attempt itself. A scan of the shipped examples, conformance sources and standard library found 30 irreversible effects, 25 of which keep the default retry. A reading of the handlers: `concierge.refund` sends the stable `Idempotency-Key`, so its retries are safe; `oms.chargeCard` (6 attempts) and `orders.charge` (3) ship no handler, so their safety is the application's handler's; the channel sends (`email`, `slack`, `sms`, `whatsapp`, `webhook`) **can send a message twice** after an ambiguous failure, and `grant.revoke` is idempotent by its RFC. Nothing else is changed in this release. A checker warning on an irreversible effect that keeps the default retry, or a default of one attempt for the class `irreversible`, is a later release's decision.

## What the evidence showed, and what it did not

- **Mining the recorded inbox run proposed nothing.** polyx proposes only from at least five instances of an action, and the recorded run holds one draft instance. That is a real result about thin evidence: a handful of runs is not a history.
- **The inbox leg of the loop rests on a synthetic amplification** of that run (its to-do episode copied twelve times under fresh tokens), labelled synthetic in the candidates, the promotion entries and the certificate, and accepted only by a test certificate.
- **The conflict case comes from the shop** (`test/loop-shop.test.mjs`): a mined rule that contradicts a mandate is refused with the minimal conflicting subset. The inbox's policy has no mandate, and none was added to make one.
- **The proposal and the refit were shown on synthetic transcripts and verdicts**, written from polyness's own verified-push history and from a stated accuracy curve. No recorded session or recorded verdict is used, and the evidence files and refit records say `synthetic`.

## Stated limits

- **S525.** The consistency check of PL6501 treats a machine's state reads as free variables, so a single rule on one state field never makes a mandate undischargeable; two rules on one field that disagree do.
- **S527 (a later release).** Path properties count emitted effects (`count`, `before`) and cannot count a completion, so "a draft is created at most once" is an invariant over a flag, not a path property.
- **PS20.6 (a later release).** Ghost-flag rules are not promoted.
- **polyx and polyness are separate tools, pinned by digest.** poly runs each by path with a fixed argument vector, a fresh environment and a temporary home that holds only the copied transcripts and is removed afterwards. polyness's rules are read by four templates of text; a release of polyness that exports structured rules would replace that.
- **A work order's usage is the participant's word** (K16). The reservation alone bounds the spend, so a participant that under-reports gets no credit and one that over-reports is recorded.
- **`poly journal fit` is unchanged.** It still fits from the `outcome` events a program wrote itself; the refit is the command that takes a person's verdicts.
- **`workflow_report` has one field polyflow's does not**, the optional `usage` (S174 amended).
- **Verdicts are files of the project, not journal events**, so the commands that read the journal never write it.
- **`--runs` converts only kinds, order and the gate's decisions**; the outcome of an effect is its gate decision.

## Conclusion

v1.1 lets a person turn what a program did into a rule, a workflow or a better confidence, with a key, a floor and a check at each step, and it did so on its own example: the loop found a real defect in a shipped program, and the fix is in this release. What it cannot yet do is learn from little: five instances is the miner's floor, and fifty verdicts is the refit's.
