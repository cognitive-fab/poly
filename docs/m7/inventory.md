# M7.0 · Inventory

Status: step M7.0 of `docs/history/plan-m7.md`. Read at 02c33db1 (main v1.0.1 plus the plan). Nothing is built. The reviewer rules on section 8 before M7.1 starts.

Sources read: the poly code and specs in this worktree; `polyx` (`@cognitive-fab/polyx` 0.1.1) and its lens package `@cognitive-fab/polyx-lens` 0.3.0; `polyness` 0.0.1. No suite and no mining ran, and no real corpus or transcript was opened.

## 1. Findings that change the plan's assumptions

1. **The release examples have no committed journals.** `examples/concierge` and `examples/inbox` hold source only. The AC27 and IAC9 journals are produced inside tests (`test/after/ex-concierge-e2e.test.mjs`, `test/ex-inbox-drafts.test.mjs`). The inbox README states 65 runs. No instance or step count is written anywhere for the concierge. M7.1 and M7.2 need a fixture step that keeps a store from those tests.
2. **The journal has no label, no consequence and no `outsideCheckDomain`.** PT3.4 (docs/03:253) says a disclosed action is journaled with the flag, and says `poly export traces` surfaces it. No file under `packages/` contains the word `outsideCheckDomain`. The compiler knows `disclosed` (check.ts:1583), the runtime journals nothing about it. Labels and consequences live in the effects manifest and in the program, not in step events.
3. **`requires-prior`, `implies-prior` and `at-most` are not language forms.** They appear only in docs/02-architecture.md:249-254 and the plan. The language has three obligation forms (rule, machine, invariant; ast.ts:199). A rule obligation can read `history.any(a => ...)` over effects (docs/03:678, PS8.0), and closed history predicates are lifted into counters (docs/03:720). So the targets exist, but at the level of effects and labels, while polyx mines over typed events.
4. **polyx is not what the plan's table assumes.** It has six patterns, not five (section 4). It has no `Port` interface of its own: a port is a lens `Observer`, and the `jev` port is a network text annotator (needs a key, calls an outside service), not a corpus reader. Corpora enter through lens adapters. Adjudication verdicts are `real | not_real | narrowed`, with no `defer`, stored in SQLite. There is no promote command and no rule export.
5. **polyness `propose` writes four files, not six, and no machine.** It writes `contract.json`, `effect-invariants.mjs`, `polyflow.workflow.json` and `NOTES.md`. The machine, effects module and effects manifest are authored by polygen. The `verified-push` proposal in `proposals/` is hand-written to the six-file shape. `examples/verified-push/run.mjs` is synthetic (fifteen inline sessions). Rules in the proposal are JavaScript predicate functions in `effect-invariants.mjs`, not data. The structured rule objects live in polyness's mined store.
6. **The `advice` ledger kind is unused.** `Runtime.advise()` (runtime.ts:1828) appends an event with no schema; only tests reference it. Serving is out of M7 (Q-M7-6). Nothing here blocks M7.
7. **S450 to S499 is the examples session's reserved range** (decisions-v1.md). S500 onward is free. The highest S-number used is S463.

## 2. `poly export traces` (PF10.1)

### Needs

A corpus of episodes with: action, label, consequence, pre and post state as declared values, gate decision, outcome, the domain-drift flag, digests for bodies, erased subjects left out with a count. It must replay.

### Exists

- `poly journal export --db --run` (journal.ts:104): one run, raw ledger events `{events, heads, bodies}`. `bodies` carries the step `data`, `pre` and `post` bodies from `poly_kept`. It never reads `poly_content` (erasable Content bodies), so it holds no Content body. It filters nothing and has no corpus, episode or count concept.
- Steps (ledger-store.ts:339): `seq, action, actionId, machineVersion, data/pre/post/claims/evidence/lineage` as digests, `stepKind`, `rejectReason`, and the hash of an attached `decision` event.
- Gate decisions: a separate `verdict` event `{stage:'gate', intent, outcome, reason, session, sseq, action, proposal, snapshot, stateBefore, stateAfter}`; not part of the step.
- Outcomes: a `kind 'outcome'` event `{decision, outcome:'Correct'|'Wrong', decisionEvent}`, only for adjudicated decisions.
- Forgetting: `poly forget` signs a record; `rt.forget` erases bodies and appends a `verdict {stage:'forget', subject: hmac digest, erased:[digests]}` on the runtime's content run. Steps are not altered. Replay lists them as `forgotten` (replay.ts:44, PS11.3a). `rt.forgottenBodies()` gives the erased set.
- The polygraph trace window format `{pre, action, data, post}` ndjson (primitive-inventory.md:94, :522) is the stack's "universal currency" and is what polyvers replays.

### Missing

- The trace corpus format, and the command (`export` is `NOT_BUILT`, mcp `poly_export`).
- Label and consequence for each step (derivable from the certified program's effects and the manifest; not stored).
- The `outsideCheckDomain` flag (not journaled today; can be computed at export from the certificate's `domains`, or journaled at run time, which is a runtime change).
- A rule for which declared field values may leave as values and which go as digests. A state snapshot holds every field, including strings, `Principal`, `Ref`, `Content` and `Items`.
- Subject attribution: a step names no subject. An erased-subject filter has to work from "the step's data names an erased body" (replay.ts:113), which the plan's "a forgotten owner's steps are absent" needs stated.
- Gate decision and outcome joins (by `intent`, `session`/`sseq`, `decisionEvent`).
- Fixtures: a retained store from AC27 and IAC9, and a canary. The two tests contain no canary (IAC7 and IAC8 do, in separate tests).

### Spec gaps (proposed)

- **S500 · The trace corpus format.** One episode per run (the run is the instance chain, seq 0 starts it). A step record: `seq`, action name, `stepKind`, rejection reason, label set, consequence, pre and post as declared values, data as declared values or digest (S501), gate decision (outcome and reason), `outsideCheckDomain`, decision and outcome events as a nested record. Also: whether `advice` events are omitted (proposed: omitted, counted), whether runtime runs (ingress, content, grant) are exported (proposed: no, counted), and whether the file is polygraph ndjson windows with an episode wrapper (proposed: yes, so polyvers and polygraph read it).
- **S501 · What leaves as a value and what as a digest.** By value: `bool`, ranges, enums, unions of those, and `int` or `string` with a `check` clause (the S400 domains). By digest only: `Content`, `Items`, `Principal`, `Ref`, `Key`, unrestricted `string`, and any record holding one. State the linkage rule: a digest of a low-entropy value can be guessed, so say whether digests are salted per export. The canary test covers every exported field, not only bodies.
- **S502 · Erasure in the export.** A step is left out when its data, pre or post names a digest in the erased set, or when its run is owned by a forgotten subject. The export reports the count of left-out steps and runs, and never their digests. A run that loses a step is marked `gapped` so a miner cannot read it as a complete episode. Without this, mining would read a run missing a step as if the step never happened.
- **S503 · Label and consequence.** Where each comes from (the certified program and effects manifest, read through `--build --certificate` as `replay` does), and what the consequence values are. polyx's four (`none | reversible | compensable | irreversible`) are the candidate. Open: whether poly effects declare reversibility anywhere. If not, M7 needs a declaration, which is a language change.
- **S504 · `outsideCheckDomain`.** Journal it at run time (a step field, a runtime and certificate-replay change) or compute it at export from the certificate's `domains`. The second needs no runtime change and works on journals written before M7. Proposed: the second.
- **S505 · What "replays" means for an export.** A trace holds digests for non-domain data, so it cannot be refolded through the transition function. Proposed test: each episode's steps chain (post of step n equals pre of step n+1), every post equals the journal's post digest, and the declared-value steps refold under poly-ref where the data is a declared value. Also the command shape: `poly export traces --db --build --certificate --out`, a file written to disk and never returned over MCP (the corpus is private).
- **S506 · Episode, interaction and outcome.** polyx mines `no-X-without-prior-Y` over an interaction (the contact) and the others over an episode. A poly instance run is one episode. An interaction that spans runs (a message and its todo) needs a stated grouping, or the rule is mined per run only. Interaction outcome in polyx is one label; poly outcomes exist only for adjudicated decisions. Proposed: interaction is the run, outcome is absent unless a decision outcome exists.

### Dependencies

M7.1 builds on `journal export` internals only through `@poly/runtime` dynamic import (journal.ts:37), as the boundary check requires.

## 3. The polyx port (Q-M7-1 a)

### Needs

polyx must see, from an export: typed events (`kind`, `type`, `slots`, `result`), instance identity per type, state events carrying `state` slots bound by identity, consequence per type (an alphabet YAML), and interactions with episodes.

### Exists

- lens `Interaction {id, corpus, actor, startedAt, events, outcome?, facts?}` and `Event {seq, at, episode, kind, type, slots, result}`.
- lens `Alphabet {eventTypes: [{id, kind, match, consequence, recommendable, slots, identity, state, label}], outcomes, redaction, version}`, as YAML.
- A `synthetic` adapter whose JSON is `{corpus, interactions:[{id, operator, team, agent, startedAt, outcome, turns:[{speaker, button|event|intent, slots}]}]}`, and a worked eligibility fixture (`synthetic-state`).
- Corpora are registered in `polyx.config.json` with `adapter`, `source`, `alphabet`.
- Mining makes no model call and is deterministic. Only `annotate` and `serve` call the network, and only with a key.

### Missing

- Any poly code on this path. polyx has no integration with poly.
- A proof that the `synthetic` adapter can carry system-kind state events, `result` and `consequence`. If it cannot, the port needs a lens adapter, which is a change to polyx's lens and breaks the ruling (a).
- An alphabet derived from a program: every handled action as an `action` type with its label and consequence, every machine state field as a `system` type with `identity` and `state`. A poly program has this typed information, so the derivation can be mechanical.
- A way to run polyx. It is BUSL-1.1 (lens is Apache-2.0), TypeScript, with a `yaml` dependency. poly's rule: engines are vendored, pinned by hash, never forked; its boundary check allows only `typescript`, `@poly/*` and `@cognitive-fab/*` npm imports.

### Spec gaps (proposed)

- **S507 · How poly runs polyx and polyness.** Options: vendor each (with `PROVENANCE.md`, hash, commit, and a vendor test), or call a separately installed tool by path and record its name, version and manifest hash in the candidate. polyx is BUSL-1.1 and polyness is private and unscoped (`polyness`, not `@cognitive-fab/`): vendoring needs the owner's licence ruling. This is the first decision M7.2 and M7.3 depend on.
- **S508 · The poly port.** The trace corpus becomes polyx's corpus file plus an alphabet YAML plus a config entry. Define the mapping from S500 episodes and the program's actions, effects and state fields to lens `Event`, `EventType`, identity and state. Define how the operator and actor fields are filled (proposed: a digest of the principal, never the principal).

## 4. `poly mine` and promotion (PF10.2, PF4.4, PF4.5)

### Needs

Mined rules as poly obligation source; candidates with evidence and counter-evidence; a person's signed verdict; a promotion that is checked (PS8.6) and admitted; a certificate that names the rule and its adjudication.

### Exists

- polyx patterns (`src/mine/patterns.ts`, `eligibility.ts`): `X-implies-prior-Y` (episode), `no-X-without-prior-Y` (interaction), `at-most-one-X` (episode), `exactly-one-Y-per-X` (episode), `no-X-without-prior-Y-same-S` (interaction, needs identity slots), `no-X-unless-state` (eligibility, interaction). Thresholds: `minInstances` 5 (per operator), `ownSupport` 0.6, `impliesSupport` 0.9, `guardSupport` 0.4, `maxGuardRules` 3.
- Rule output (lens `Rule`): `id` (sha256 of family, pattern, bindings, conditions, window, first 16 hex; stable across re-mines), `pattern`, `bindings`, `window`, `support {holds, of}`, `counterexamples` as `InstanceRef {interactionId, episodeId, seq}`, `provenance {own|borrowed|neither}`, `alphabetVersion`, `minedAt`, `text`, `evidence`. No numeric confidence. Reports go to `.polyx/reports/<runId>.mine.json`; rules and adjudications to `.polyx/polyx.db`.
- Eligibility: bindings `{subject, slot, fact:'target.<state>', allowed, from}`. The target state is the latest state event in the session whose identity slot matches; unknown state is excluded from both counts.
- PS8.6 and `PL6501` (diagnostics.ts:186, policies.ts:260) check dischargeability and name the minimal conflicting subset. The text names "promoted Polyx rules" in the deletion order and docs/03:746 says the finding lists "the Polyx rule id and its adjudication record". No code carries a promoted rule.
- Records: `{v:1, kind, subject, by, at, sig}` with ed25519; `RecordKind` is `approval | acceptance | invocation | keyring | policy | revocation | grant-request | verify | forget`. `verifyRecord` refuses an agent key (records.ts:62). Policies are signed per scope (`poly sign-policy`), re-verified at admission.
- Certificate (certificate.ts): `boundAccepted[{by, record}]` is the only person-record citation. No field for a rule, its source or an adjudication.

### Missing

- A mined-rule exporter, the candidate artefact, the adjudication record kind, the promotion step, the certificate field.
- Obligation forms for the patterns (finding 3). The pattern table in the plan maps to names that are not language forms.
- A polyx pattern with no row in the plan's table: `exactly-one-Y-per-X`, `no-X-without-prior-Y-same-S`.

### Spec gaps (proposed)

- **S509 · Rule to obligation mapping.** Say what each pattern becomes in poly source: a `rule` obligation reading `history.any(...)` for `no-X-without-prior-Y` and `X-implies-prior-Y`; an `invariant` or counter for `at-most-one-X`; a machine obligation for `exactly-one-Y-per-X` (or declare it not promotable). Settle the level: polyx rules are over typed events, policy history is over effects and labels. Proposed: a rule is promotable only when X and Y are effects (or labelled), and a rule over a pure machine action is promoted as an invariant over the machine. Others are listed `not promotable`, never dropped silently.
- **S510 · The eligibility mapping (new text).** "Do X only while the thing X names is in state A" becomes a machine obligation guard over the declared state of the machine instance X acts on, or a rule `when X require machine(m).f in A`. State what happens when the state is unknown (polyx excludes it; PS8.2 turns `U` into the `on unknown` handling, so the generated rule needs an explicit choice, proposed `escalate`).
- **S511 · The candidate record.** Rule id, pattern, proposed source text, support `{holds, of}`, counter-evidence list, episode references (as S500 episode ids and seqs, never bodies), alphabet version, the tool's name and version (S507), the corpus digest, and a `corpusKind` of `recorded` or `synthetic`. Not part of any program. Serialised with canonical JSON like records.
- **S512 · The rule adjudication record.** A new `RecordKind` `adjudication`, signed by a person key (PF9.6 and PT12.5 apply; extend the text, since PF9.6 names only acceptance and approval). Verdicts `real | spurious | defer`. Subject: candidate digest. polyx's `not_real` maps to `spurious`; polyx's `narrowed` (a condition added) has no poly equivalent and is refused as a verdict in M7 (proposed). Only `real` proceeds. Is this a record the runtime reads (artefact rule)? Proposed: no, the promoted policy is what the runtime reads, so the round-trip check and toolchain fault belong to the policy artefact and its promotion list.
- **S513 · Promotion.** A promotion appends the proposed obligation to the scope's policy file, which changes the policy and so needs a new `poly sign-policy`. Define the promotion list (id, record digest, order) that PS8.6's "promotion order" refers to, where it is stored, and the certificate field (`promoted: [{rule, adjudication, candidate}]`). Refused at that moment with `PL6501` and the minimal subset (the subset's source shows the rule id and record digest, as docs/03:746 says).
- **S514 · Thin evidence and synthetic corpora.** The floor is five instances per operator. A synthetic corpus is allowed only if the candidate says `synthetic` (S511) and the certificate cites it as such. Decide whether a promotion from a synthetic corpus is allowed at all (proposed: allowed for tests, refused outside a `source: "test"` certificate).

## 5. `poly propose` (PF10.3)

### Needs

Agent journals in; a proposal as poly source out: a workflow machine, the mined rules as obligations, the effect surface as labelled effects; checked like any source; refused with finding and witness if it has one.

### Exists

- polyness (`src/propose.mjs`, `bin/polyness.mjs`): `propose <step> [project]`, output under `.polyness/proposals/<slug>-checked/`. Reader `src/reader.mjs` reads Claude Code JSONL under `$HOME/.claude/projects` only. The normalised record is `{id, at, project, session, episode, kind, tool, arg, outcome, files, branch, git}`. Four patterns (`at-most-one-per-run`, `no-without-a-prior-verify`, `implies-a-prior`, `exactly-one-when-started`). Rule object: `name, pattern, predicate (source string), support{holds,of}, window, runSupport, exceptions, why, evidence`. Thresholds: `minInstances` 5, `ownSupport` 0.6. Only `own` rules are proposed. No model call; local only; regex redaction of secret shapes; prompts are carried onto episodes.
- Effects are labelled by a free-text `why` and a `tools[kind]` match. There is no irreversibility field.
- Proposal files carry no format version.
- poly's work orders exist (worker.ts, `orderToolOf`): an effect proposed to the gate and journaled by digest.

### Missing

- A poly-source emitter, and any machine derivation: polyness does not produce a machine.
- A reader for poly's work-order journals (polyness reads Claude Code shapes only; its README calls the reader an interface, but there is no formal one).
- A rule carrier: the four files hold rules only as JavaScript predicates. Structured rules are in `.polyness/` state files (`version: 1`, internal).
- For M7-AC2's refusal case: a check that a rule is supported by the proposal's own history. The poly pipeline sees no history, only source.
- A decision on how to execute polyness (S507). It depends on `polyflow` through a GitHub tarball at one commit.

### Spec gaps (proposed)

- **S515 · Inputs and privacy of propose.** Under Q-M7-2 (b): the work-order journal path needs a poly-side reader that writes polyness's normalised records (or Claude-Code-shaped JSONL) from S500 exports; the transcript path reads the owner's own `.claude/projects`. State what from a transcript may appear in a proposal or in poly source: tool kinds, step names and counts, never a prompt, an argument or a path. polyness's `contract.json` carries `provenance.mined_from` (a project name) and `NOTES.md` carries `why`/evidence; both are screened or dropped by the emitter. The privacy rule of section 4 of the plan extends to propose.
- **S516 · The workflow machine and effect surface.** Who writes the machine. A language-model call is allowed only in `poly new`, so the machine must be derived deterministically. Proposed: the emitter builds a linear workflow from the mined step order (verify, stage, commit, push), each step an action with a success completion and a failure end, taken from the contract's per-step `completes-into` and `failure-ends-the-run` rules, and each effect labelled. Say where the consequence label comes from (S503) given that polyness records none.
- **S517 · The refusal case.** A rule "its own history does not support" is refused by a new check on the proposal: the emitted obligation carries `support {holds, of}` and `provenance`, and admission refuses a proposed rule below the own-evidence floor or with provenance other than `own`, with a diagnostic code from PT12.2 and the numbers as witness. Without this, M7-AC2's variant is not a pipeline refusal. Also state the other refusal path: a rule the proposed machine itself violates is a normal checker finding (a counterexample trace).
- **S518 · The input format polyness is read from.** With no change to polyness (Q-M7-1 a), poly must read either the four files (rules as JS predicates, not data) or `.polyness/` state (internal, versioned `1`, not documented as an interface), or call polyness's modules as a library. Pick one and record the version it was read at. Proposed: the mined store, pinned by polyness commit, with a test that fails when its shape moves.

## 6. Adjudications and the calibration refit (M7.4)

### Needs

A person-signed verdict on a decision's answer, journaled against the decision; an `ask adjudicate` surface in the inbox host; `poly journal fit` turning adjudications into a new map per tier; the new map signed and admitted; the inbox `CLEAN` with it and raising no calibration warning.

### Exists

- The language form `adjudicate Correct|Wrong` (ast.ts:584, `PL6203`) and the `outcome` ledger event (runtime.ts:371), written by a host machine, not signed.
- `poly journal fit --decision --model [--version] [--out]` (evaluate.ts:19-96): joins `decision` events to `outcome` events by `decisionEvent`, filters by `model.reported ?? model.id`, runs isotonic regression over `(round(raw*1000), Correct)`, outputs `{decision, version, fittedFor, points, digest}`. It throws on no samples. `eval` replays recorded questions to a candidate provider and scores agreement and Brier.
- Map semantics: monotone, identified by `{decision, version, fittedFor, digest}`, a step function (PD1.6a-d in docs/proposals/pd-model-decisions.md:95; PT24).
- `calibrationWarning(map)` (routing.ts:10): a band of more than 100 consecutive raw values above raw 0 that map to 0, or a diagonal-looking map more than 100 thousandths from identity somewhere. The inbox's maps were given a dense low range for this in v1.0.1 (ddaa7fb5).
- `PL6842 MODEL_WITHOUT_REFITTED_MAP` (PT24.5, S355): a tier's model must equal its map's `fittedFor`.

### Missing

- A signed adjudication record for a decision answer and its collection by a host (`ask adjudicate` does not exist; no host collects them).
- "The correct answer when known": the `outcome` event holds only Correct or Wrong.
- A fit rule for sparse data. Isotonic fit over few samples produces a step function with a wide band mapping to 0, which the calibration warning flags. The acceptance needs a stated minimum sample count or a smoothing floor.
- Naming: the plan says "the tier swap rule (PD1.6)"; the implemented rule is PL6842 and PD1.6 appears in docs/04 only as PD1.6a at PS18.2, with the full text in a proposal file.

### Spec gaps (proposed)

- **S519 · The decision-answer adjudication record.** A `RecordKind` `adjudication` with a subject kind `answer` (or a second kind; coordinate with S512), fields: decision event hash, verdict (`right | wrong`), the correct answer when known (finite, in the decision's answer type), signer. Journaled as an `outcome` event citing the record. Person key only. Whether `fit` accepts unsigned `outcome` events from host machines (proposed: only signed ones count).
- **S520 · The refit.** Minimum sample count and per-bin floor; behaviour below it (refuse to fit, listed as not run, never a silent identity map); the new map's version and `fittedFor`; that the old map is never changed in place; that a refit with the same model is a map swap, not a tier swap, so `PL6842` does not fire, but the certificate re-binds the map digest and so needs re-admission. Align the plan's "PD1.6" wording with PL6842 and PT24.5.
- **S521 · `ask adjudicate` and the digest.** The host's surface: one decision shown once for a verdict, what the digest shows (never a body: the question and answer are digests unless the owner reads the body through the capability of PS17.4a), and how a person's key signs from a host.

## 7. Work orders with budgets (S359, M7.5)

### Needs

A work order that names a budget; a reservation at claim time; usage reported by the participant, treated as weaker evidence; refusal at the gate when a workflow's orders exceed the budget; release of the reservation on a failed order.

### Exists

- Text only in proposals: PT24.6 (docs/proposals/v1-technical-spec.md:451: `budget b` on a work order, usage reported in `workflow_report`, settled against a reservation made at claim time, certificate lists such budgets as `self-reported`), PF14.7. S359 is deferred to M7 (decisions-m11.md:18).
- Runtime budget machinery for decisions only: `Budget` instances (run, scope, period caps), reserve, settle, release as `verdict {stage:'budget'}` events (routing.ts:227); PS18.3 reservation formula; PS18.4 and PS18.4a; S360 (max input tokens, worst-case reservation); S361 (unpriceable usage); K15 ("a provider's usage report is the usage it bills").
- Work orders as effects (worker.ts, runtime.ts ~366).

### Missing

- `budget` on a workflow or work order in the grammar; no `workflow_report` anywhere in the code; no claim-time reservation; no `PT24.6` in docs/03 (its as-built section is PT10r).

### Spec gaps (proposed)

- **S522 · Work-order budget syntax and meaning.** Where `budget b` is written (workflow, order, or the participant's tool), what unit a work order spends (decision budgets are micro-units of currency from a price table; a work order has no price table), what the reservation is at claim time (the cap, since usage is unknown), and how it is released.
- **S523 · Self-reported usage.** How the budget treats usage the participant reports (PT24.6 says weaker evidence): proposed that the reservation is the bound, a report above the reservation is an overrun and ends the order, a report below releases the difference, and a missing or unpriceable report settles the whole reservation (S361 applied). K15 is amended: provider-billed usage and participant-reported usage are two kinds, and the certificate lists the second. The check-time claim "a workflow whose orders exceed the budget is refused at the gate" needs a rule: a gate proposal for an order whose worst-case cost does not fit the remaining budget is denied with a reason, at the same step in the order of checks as docs/03:1173.
- **S524 · Poly-ref and the artefact rule.** The reservation table and the budget rows are read by the runtime, so S522 and S523 add a decision-table row in poly-ref and a broken variant in `test/toolchain-faults.mjs`, per the standing rule.

## 8. For the reviewer to rule, in order

| # | Proposed | Needs a ruling because | Blocks |
|---|---|---|---|
| S507 | Vendor or external tool; licences | BUSL-1.1 and a private package; touches the vendoring rule | M7.2, M7.3 |
| S503 | Consequence source; does poly declare reversibility | May be a language change | M7.1 |
| S504 | Compute `outsideCheckDomain` at export (no runtime change) | Runtime vs export | M7.1 |
| S501, S502 | Value/digest tiers; erasure and gapped runs | Privacy, the plan's main risk | M7.1 |
| S500, S505, S506 | Format, replay meaning, episode grouping | New spec text | M7.1 |
| S508 | Port through the `synthetic` adapter | If insufficient, the port needs a lens change, which Q-M7-1 (a) forbids | M7.2 |
| S509, S510 | Pattern mapping, the unmapped patterns, eligibility | The language has no `requires-prior` form | M7.2 |
| S511 to S514 | Candidate, adjudication kind, promotion, certificate field, synthetic corpora | New record and certificate field | M7.2 |
| S515 to S518 | Inputs, machine derivation, the refusal check, polyness input format | Machine derivation is deterministic only | M7.3 |
| S519 to S521 | Answer adjudication, refit floor, host surface | Sparse fit raises the calibration warning | M7.4 |
| S522 to S524 | Work-order budget syntax and settlement | PT24.6 is proposal text only | M7.5 |

Three questions the plan does not list, which an answer would shorten:

1. Is a mined rule over a machine action (not an effect) promotable in M7 (S509)?
2. May the M7-AC1 and M7-AC2 acceptance runs use a corpus made for the purpose (S514, risk 1)? The inbox's 65 runs may not give five instances for any rule.
3. Does the machine of S516 count as "poly source written by polyness" for M7-AC2, or must polyness change (Q-M7-1 (a) says no)?

## 9. Conclusion

Most of M7 is translation, as the plan says, but three things the plan treats as present are not: labels and consequences in the journal, a corpus reader in polyx, and a machine in a polyness proposal. The privacy rules (S501, S502) and the first-run decision on how poly executes the two other tools (S507) come first. Twenty-five S-numbers, S500 to S524, are proposed; none is built, and nothing is built until the reviewer rules.

## 10. Glossary

- **Candidate.** A mined rule as proposed poly source with its evidence, before any person has judged it (S511).
- **Gapped run.** A run that lost a step to erasure, marked so a miner does not read it as complete (S502).
- **Promotion list.** The ordered record of promoted rules in a scope, the order PS8.6 uses to find a minimal conflicting subset (S513).
- **Synthetic corpus.** A corpus made for a test, labelled so in the candidate and the certificate (S514).
- **Trace corpus.** The export of journals: episodes of steps with labels, states, outcomes and digests, never bodies (S500).
