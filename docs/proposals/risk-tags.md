# poly · Risk and control tags on policy rules, and a risk report from the journal (S586)

*Cognitive Fab · November 2026 · on branch `risk-tags`, cut from `retire-tree-guard` (152804f9, v1.5.0 plus findings 32 and 33 plus S585) · from PT8, PS8, PT12.2, PT12.3a, PT12.5, PT14, the journal (PT16, `packages/poly-runtime/src/ledger.ts`, `worker.ts`, `policy-gate.ts`), Polyaxion's policy format v2 (`vendor/polyaxion/packages/polyaxion/src/core/policy.mjs`) and `poly cost` (PT24.4)*

Status: a plan for the owner's review. Nothing is specified in the spec documents, no test is written and no code is changed. When the owner rules, the text of sections 2 to 6 becomes the spec commit of rule 7a (PS8.10, PT8.7, PT34 and the rows of PT1.2, PT12.2 and PT14), committed alone.

## 0. What this covers and the ids it uses

A policy rule says which AI risk it mitigates and which control it implements. `poly check` refuses an unknown tag and warns on an untagged rule. A project may list the risks it considers itself exposed to. A new command, `poly report risks`, reads the verified journal and says, for each risk, what each tagged rule did. It answers the finding of MIT FutureTech's working paper *Unmitigated? How are the world's largest companies responding to AI risks?* (October 2026) that a mitigation is rarely linked to the risk it addresses, and it gives a buyer the audit trail the ITX guide asks for.

| Prefix | Meaning | Proposed here |
|---|---|---|
| S | spec ruling | **S586** (the next free number in sequence: S584 is on `proposal-extensions`, S585 on `retire-tree-guard`) |
| PS | semantics | **PS8.10** Tags never change a decision |
| PT | technical spec | **PT8.7** the tag clauses; **PT34** catalogs, exposure, the report; rows in PT1.2, PT12.2, PT14 |
| PL | diagnostic codes | **PL6506** `POLICY_TAG_UNKNOWN`, **PL6507** `EXPOSURE_TAG_UNKNOWN`, **PL6508** `CATALOG_UNPINNED` (free slots of PL65xx, checked against `packages/poly-core/src/diagnostics.ts`) |
| RT | acceptance criteria of this feature | RT1 to RT14 (section 9) |

## 1. What was read, and what was found before planning

Six facts decide the design. Each was read in the code, not assumed.

1. **Polyaxion already carries tags.** Its policy format v2 accepts `tags: string[]` on every obligation (`core/policy.mjs:184`) and copies them into the plan (`compile/plan.mjs:62`). No decision reads them. So the tags can be lowered into the document the engine already loads, with no engine change, and a tag cannot reach a decision through the engine.
2. **A tag in the source is signed.** A person signs each policy scope over `{ scope, sequence, document, sources, engine }` (PT12.5, `policy-sign.ts:53`). A tag changes the source and the lowered document, so a tagged policy needs a new signature, and the signer of the rule is the signer of its tags. That is the property a buyer wants: someone with a key in the `people` ring attested what the rule is for.
3. **An allow names no rule.** On allow Polyaxion's `reason` is null and its `checked` is only a count (`runtime/gate.mjs:258-260`). A refusal names one rule (`wrong-state:<doc>::<policy>.<obligation>`, with `:escalate` for an escalation), the first that refused. So the journal can say which rule refused or escalated a proposal, and cannot say which rules let one through.
4. **Some refusals are not a rule's.** Origin, memory, budget, grant, `outside-mandate`, `stale-allow` and `escalation-timeout` are decided by the runtime with no engine record (`worker.ts:449, 480-483, 555, 657`). They belong to no tag.
5. **A decision taken on unknown input is a rule of its own.** The `on unknown` branch lowers to the id `<policy>.<obligation>.unknown` (`poly-lower/src/policy.ts:133`), so the journal says when a rule decided because its condition could not be read.
6. **The journal names no certificate.** No event carries `certificate.digest`. A step's `machineVersion` is a module digest the certificate lists (`poly.moduleDigests`), and a gate record's `policySet` is Polyaxion's digest over the loaded policies (`gate.mjs:54`). A run can be matched to a certificate through those, not read from it.

Also found, outside this feature: on an escalate-once refusal the worker replaces the gate result and drops the engine record (`worker.ts:501-503`), so the decision loses its `session`, `sseq` and `engineReason`. That is read from the code, not run. It is proposed as finding 34 and is not fixed here; the report counts such a refusal as the runtime's (fact 4) until it is.

## 2. The syntax (PT8.7)

Two optional clauses after an item's quoted text, before its body:

```
obligation large-refund-reviewed "A refund above 100 is issued only after a person approves it."
  mitigates "mit:7.3", "mit:4.3"
  implements "nist:MAP-3.5", "iso:A.9.2"
  rule {
    when proposal.kind == "effect" && effect.kind == "payments.refund" && machine("concierge.Desk").large
    require false else escalate
    on unknown escalate
  }

never merge-is-never-allowed "No merge is ever allowed." mitigates "mit:7.1" implements "nist:MANAGE-2.4"
  : allow when effect.kind == "github.merge"
```

The grammar change to PT8.1:

```ebnf
PolicyItem  = "var" Ident ":" Type "=" Expr
            | "obligation" Name String [ Tags ] ( RuleBody | MachineBody | "invariant" "{" Expr "}" )
            | "recalled" Name String [ Tags ]
            | "never" Name String [ Tags ] ":" "allow" "when" Expr ;
Tags        = [ "mitigates" Tag { "," Tag } ] [ "implements" Tag { "," Tag } ] ;   (* PT8.7, S586 *)
Tag         = String ;                                                             (* "<catalog>:<id>" *)
```

- **Why strings.** The ids have dots and dashes (`7.3`, `MANAGE-2.4`, `A.6.2.8`) that the lexer reads as numbers and dashed names. A string is one token, and the check gives it its meaning. The precedent is an effect's `kind "payments.refund"`.
- **Why these words.** `mitigates` takes risks and `implements` takes controls, so a reader sees which is which without a prefix rule. Both are contextual: they are keywords only in this position, so no existing name becomes reserved.
- **Order and duplicates.** The formatter writes `mitigates` before `implements` and each list sorted and without repeats; a repeat in the source is accepted and removed by `poly fmt`, as for labels.
- **What a tag may be.** A risk is a subdomain of the MIT taxonomy (`mit:7.3`), never a domain alone (`mit:7` is `PL6506`), so coverage is exact. A control is a NIST AI RMF 1.0 subcategory (`nist:MANAGE-2.4`) or an ISO/IEC 42001 Annex A control (`iso:A.9.2`). `mitigates` takes only `mit:` ids and `implements` only `nist:` and `iso:` ids.
- **Where tags go.** On every policy item that has a text: rule, machine and invariant obligations, `recalled` items and policy `never` statements. A `recalled` item is unenforced, so its tags are reported as declared, with no decisions (section 6). A policy `never` is proved, not run, so it is reported with its check verdict. Machine `never emit` and machine actions are not tagged in v1 (question Q1).

## 3. The catalogs (PT34.1)

Three catalogs ship in `std/catalogs/`, one JSON file each, with one `std/catalogs/PROVENANCE.md`. They are pinned in `std/PINS.json` like the rest of `std`, and the certificate records the digest of each catalog the build's tags use.

| File | Source | Version pinned | What is stored | Licence |
|---|---|---|---|---|
| `mit-ai-risk.json` | MIT AI Risk Repository, Domain Taxonomy (airisk.mit.edu) | the version current when it is bundled (the site shows Version 4), with the download date and the SHA-256 of the downloaded file | the 7 domains and their subdomains, number and name (24 in the April 2025 taxonomy, 7.6 Multi-agent risks among them; the count is taken from the file, not from this plan) | CC BY 4.0: names may be copied with attribution |
| `nist-ai-rmf.json` | NIST AI 100-1, AI Risk Management Framework 1.0 (January 2023), from the Core as NIST publishes it (the AI RMF Playbook data, checked against NIST AI 100-1) | 1.0 | the 4 functions, their categories and the subcategory ids written `FUNCTION-n.m` (NIST writes `MANAGE 2.4`), with NIST's text | a work of the US government, not under copyright in the US |
| `iso-42001.json` | ISO/IEC 42001:2023, Annex A | 2023 | the 38 control ids from `A.2.2` to `A.10.4` under their 9 objectives, each with **our own short label**, never the standard's text or titles | the standard is copyrighted: only the ids, which are facts, and labels we wrote |

Each file is `{ catalog, version, source, retrieved, sourceDigest, entries: [{ id, label, parent? }] }`, sorted by id. `PROVENANCE.md` gives, per catalog, the URL, the version, the date it was read, the digest of what was read, the licence, and for ISO the statement that the labels are ours. A catalog is updated by a commit that changes the file, its pin and its provenance together, so a version change is visible in the certificate's digest and in every report (`PL6508` if a catalog's digest is not in `std/PINS.json`).

## 4. The check (PT34.2)

- **An unknown tag is an error.** `PL6506 POLICY_TAG_UNKNOWN` at the tag's position, for a tag whose catalog prefix is not `mit`, `nist` or `iso`, whose id is not in that catalog, whose kind is wrong for its clause, or which names a MIT domain alone. It is in the policy-types stage, so the verdict is REFUSED and the later policy stages do not run, as for a scope error.
- **An untagged item is a warning.** An obligation, `recalled` item or policy `never` with no `mitigates` clause gives the warning `untagged: <policy>.<item> names no risk it mitigates (PT8.7)`. It is a warning of PT12.3a: printed beside the verdict, never in it, not certified. One with risks and no controls gives `no control: …` the same way.
- **Declared exposure.** `poly.json` gains `exposure: { risks: ["mit:2.1", "mit:7.3", …] }` (PT1.2, schema `schemas/manifest/exposure.json`). An unknown id is `PL6507 EXPOSURE_TAG_UNKNOWN`. An exposed risk that no item of the project mitigates gives the warning `uncovered: mit:2.1 is listed as an exposure and no rule mitigates it`. The certificate records the exposure list, so a report reads the list the build was admitted with.

## 5. Lowering, signing and the toolchain checks (PT8.7, PT34.3)

- **Lowering.** Each lowered obligation gains `tags: ["risk:mit:7.3", "control:nist:MAP-3.5", …]` in the Polyaxion document, in the formatter's order. A policy `never` and its tags go into the policy build's own record (`never` is proved, not lowered), and the certificate's entry for the scope gains `tags: { "<policy>.<item>": { risks, controls } }`.
- **Signing.** No change to PT12.5: the tags are in the sources and the document, so they are in the signed subject. A tagged policy whose signature predates its tags is `PL6409`, as for any changed policy.
- **Translation validation.** `policy-tv` reads the lowered document back and compares each obligation's tags with the source's. The broken lowerings `policy-tag-dropped` and `policy-tag-moved` (a tag on the wrong obligation) join `test/toolchain-faults.mjs`, as the standing rule asks of any change to an artefact the runtime reads.
- **PS8.10, the semantic rule.** A policy's decisions do not depend on its tags: for every proposal, the policy with its tags and the policy with every tag removed give the same outcome, the same reason and the same witness. poly-ref checks it on the decision table it already builds for policy `never` statements, and a runtime test replays one journal with the tagged and the untagged build.

## 6. The report (PT34.4)

**The command.** `poly report risks --db <store> --build <dir> --certificate <file>… --trust keyId=pub… [--period YYYY-MM | YYYY-MM-DD] [--format md|json] [--out <file>]`. It reads only; it writes nothing to the store. `--certificate` may be given more than once, for a period that spans builds. MCP: `poly_report_risks`, read-only, with the same inputs (question Q5).

**What it reads, and in what order.**

1. Every run of the store is verified as `poly journal verify` does: chain, signed heads, closure, journal binding and anchor. A run that fails is not counted and is listed under *Runs not counted*, with its problem, as `poly cost` lists runs not summed. Without `--trust` no run verifies and the report says so: nothing is counted silently.
2. Each verified run is matched to a certificate: its steps' `machineVersion` must be in the certificate's `poly.moduleDigests`, and its gate records' `policySet` must be the one the certificate's policies give. A run that matches none is listed under *Certificate not identified* and not counted. One that matches two is listed under *Certificate ambiguous* and not counted.
3. The tags come from the matched certificate, never from the source on disk, so the report shows what was admitted and signed.

**What it counts, per rule.** For each gate decision of the period:

| Journal | Counted as |
|---|---|
| `outcome: "denied"` whose reason names `<policy>.<item>` | refused by that rule |
| `outcome: "escalated"` whose reason names `<policy>.<item>:escalate` | sent to a person by that rule; then, from the same intent's later events, approved (with the approving person's key id and name), refused at the timeout, or still open at the end of the period |
| a reason that names `<policy>.<item>.unknown` | decided on unknown input by that rule, with the outcome it gave |
| `outcome: "allowed"` | allowed in the scope; an allow names no rule (fact 3), so it is counted per scope, never per rule |
| a refusal with no engine record | refused by the runtime, with its reason; no rule and no risk |

**Unknown outcomes.** For each intent a rule sent to a person and that was then approved, and for each intent allowed in a scope, the report counts the handler outcomes of PS23: `lost` and `lapsed` attempts and an `exhausted` completion are *outcome unknown*, listed by intent digest and effect kind, with the person's resolution if the machine has one (the concierge's `Resolve`). An unknown outcome is attributed to the rule that sent its intent to a person, or to the scope when the intent was allowed.

**What it never says.** The report states on its first line, and the JSON carries as `"meaning"`: *These counts are evidence that each rule was applied to the decisions recorded in the journal. They are not proof that a risk was removed or reduced.* A risk with rules and no decisions in the period says *no decision in the period*, not *mitigated*. An exposed risk no rule mitigates is listed under *Exposed and not covered*. Untagged items are listed under *Rules that name no risk*.

**Private values.** The report prints only what the journal holds: intent and record digests, effect kinds, rule ids, key ids and the names of the `people` ring. A recipient stays `hmac-sha256:…`. No body is dereferenced.

**Same bytes for the same journal.** The JSON is RFC 8785 (`canonicalize` of `@poly/core`), every list sorted by a stated key (risk id, rule id, intent digest), and nothing in it depends on the clock, the host or the order of the store's rows. The Markdown is rendered from the JSON alone. The period printed is the one asked for, or the first and last `at` of the counted events.

**A sample.** Illustrative numbers, not from a run.

```markdown
# Risk report: concierge

These counts are evidence that each rule was applied to the decisions recorded in the journal.
They are not proof that a risk was removed or reduced.

Period: 2026-11 (UTC). Store: 12 runs verified, 0 not counted.
Certificates: cert-3f9a1c0b2e7d (digest sha256:8c1e…), signed by key-admission.
Catalogs: mit-ai-risk v4 (sha256:41d0…), nist-ai-rmf 1.0 (sha256:9b2a…), iso-42001 2023 (sha256:c77e…).

## mit:7.3 Lack of capability or robustness

| Rule | Controls | Signed by | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |
|---|---|---|---|---|---|---|---|---|
| refunds.large-refund-reviewed | nist:MAP-3.5, iso:A.9.2 | owner (key-owner), sequence 4 | 0 | 3 | 2 | 1 | 0 | 0 |

Outcome unknown: 1 intent (payments.refund, sha256:a41f…), approved by key-owner, resolved `done` by owner.

## mit:2.1 Compromise of privacy (sensitive information)

| Rule | Controls | Signed by | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |
|---|---|---|---|---|---|---|---|---|
| refunds.customer-decisions | nist:MEASURE-2.10 | owner (key-owner), sequence 4 | 2 | 0 | 0 | 0 | 0 | 0 |
| refunds.staff-decisions | nist:MEASURE-2.10 | owner (key-owner), sequence 4 | 0 | 0 | 0 | 0 | 0 | 0 |

## Allowed in each scope

| Scope | Allowed | Outcome unknown after an allow |
|---|---|---|
| concierge | 41 | 0 |

## Refused by the runtime (no rule)

| Reason | Count |
|---|---|
| escalation-timeout | 1 |

## Exposed and not covered

- mit:7.6 Multi-agent risks

## Rules that name no risk

- none
```

The JSON has the same content: `{ v: 1, meaning, period, store: { verified, notCounted: [] }, certificates: [], catalogs: [], risks: [{ id, label, rules: [{ id, controls, signer, counts, unknownOutcomes: [] }] }], scopes: [], runtime: [], uncovered: [], untagged: [] }`.

## 7. The examples (PT34.5)

- **The refunds desk.** `examples/concierge/concierge.policy.poly` and its copy `demo/concierge/concierge.policy.poly` (the copy test asks that they stay equal) gain tags on their three obligations, and `examples/concierge/poly.json` an exposure list. The policy is signed again.
- **A τ²-bench-style example.** None is in this repository. The poly-tau2 session's `translation/airline` (policy `airline_writes`, five obligations) is the candidate: copied into `examples/airline` with its provenance, tagged, with an exposure list (question Q4).
- **The generated reports.** For each example a script drives the example's runtime with a fixed clock over a scripted set of proposals, keeps the resulting store, certificate and trust file under `docs/examples/risk-report/<example>/`, and writes `report.md` and `report.json` beside them. A test regenerates both reports from the kept store and compares them byte for byte, and runs the report twice to show the same bytes. The store is kept, not regenerated, because the store's own HMAC key is random by design (M8, `poly_store_key`) and would change every recipient digest.

## 8. Spec sections and the ruling

- **S586** (in a new `docs/history/decisions-risk.md`): the owner's ruling on this plan, with the answers to section 10's questions.
- **PS8.10** in `04-semantics.md`: tags never change a decision (section 5).
- **PT8.1 and PT8.7** in `03-technical-spec.md`: the grammar and the tag clauses (section 2).
- **PT34** in `03-technical-spec.md`: PT34.1 catalogs, PT34.2 the check, PT34.3 lowering and the certificate, PT34.4 the report, PT34.5 the examples.
- **Rows:** PT1.2 (`exposure`), PT12.2 (`PL6506` to `PL6508`), PT12.3a (the three warnings), PT14 (`poly report risks`, and the MCP tool if Q5 says yes).
- **Not changed:** PT12.5 (signing already covers tags), the journal format (fact 6 is handled by matching, question Q6), Polyaxion (fact 1).

## 9. Order of work (rule 7a) and acceptance criteria

1. **Spec commit, alone.** S586, PS8.10, PT8.1, PT8.7, PT34 and the rows above, with RT1 to RT14.
2. **Catalog commit.** The three files, `PROVENANCE.md` and their pins. Data, not code; the writer's tests read it.
3. **Tests, by a separate writer** on the session's model, who has read only the spec commit and the catalogs. They fail first. One commit, with the writer's list of what was read.
4. **Code**, in this order, each a commit: parser, formatter and AST (`poly-lang`, `poly-core`); the check and `PL6506` to `PL6508` with their `conformance/m0/errors/PL650x-*.poly` cases; lowering, the certificate entry and `policy-tv` with the two toolchain faults; PS8.10 in poly-ref (written from `04-semantics.md`, sharing no code with the compiler); the report in `poly-check`; the examples and their generated reports.
5. **Runs.** Only the new test files and the files the change touches (listed in the plan's record as they are found). The full suite only at the owner's word.

Acceptance criteria:

- **RT1** Every tag form of PT8.7 parses and formats back to itself; tags are sorted and deduplicated by `poly fmt`.
- **RT2** Each kind of unknown tag is `PL6506` at its position, and the verdict is REFUSED.
- **RT3** An untagged item and an item with no control give their warnings and change no verdict.
- **RT4** An unknown exposure id is `PL6507`; an uncovered exposure gives its warning.
- **RT5** A catalog whose digest is not pinned is `PL6508`.
- **RT6** Lowered obligations carry their tags; the certificate carries tags, exposure and catalog digests.
- **RT7** `policy-tag-dropped` and `policy-tag-moved` are caught by translation validation.
- **RT8** A tagged policy signed before its tags is `PL6409`.
- **RT9** PS8.10: the tagged and untagged builds give the same decisions, reasons and witnesses, in poly-ref and on a replayed journal.
- **RT10** The report counts each row of the table of section 6 from a journal built to contain it, and an allow is never counted for a rule.
- **RT11** A run that fails verification, matches no certificate or matches two is listed and not counted.
- **RT12** The report holds no value the journal keeps as a digest, and its first line and `meaning` are the exact sentence of section 6.
- **RT13** The same store gives the same bytes, twice, for both formats; `--period` selects by the event's UTC day.
- **RT14** The two examples' reports regenerate byte for byte from their kept stores.

## 10. Open questions for the owner

- **Q1. Tags on machine actions and machine `never emit`?** Recommended: not in v1. An action is not a decision of a policy, and the report counts decisions. A machine `never emit` is a proved property with no text and no runtime decision; a tag there would be a claim with no count beside it. If wanted later, tags on a machine's properties would be reported with their check verdict, as a policy `never` is here.
- **Q2. A date range?** Recommended: yes, as `poly cost` has it, `--period YYYY-MM` or `YYYY-MM-DD` in UTC, on the event's `at`. A range of several months is several reports, or `--from` and `--to` if the owner prefers; the bytes stay a function of the store and the arguments.
- **Q3. Exposure by sector or by role (deployer, developer), following MIT's tiered proposal?** Recommended: later. v1's exposure is one flat list per project. The format leaves room: `exposure: { risks, profile? }`, where a later `profile` names a bundled list by sector or role that the project's list extends.
- **Q4. Which τ²-bench-style example?** The poly-tau2 session's airline translation copied into `examples/airline`, or a new example written for this feature. Copying needs that session's agreement and its provenance; the airline policy's five obligations are a good spread of risks (confirmation, eligibility, reasons).
- **Q5. Serve the report over MCP?** It reads only, as `poly_cost` does. Recommended: yes.
- **Q6. Name the certificate in the journal?** The report matches runs to certificates (fact 6). Writing the certificate's digest into each run's first event would make it read, not inferred, but it changes the journal format and replay. Recommended: not in this feature; a proposal for the next one if matching proves ambiguous in use.
- **Q7. Allows per rule?** An allow names no rule (fact 3). Counting, per rule, the allows where its `when` held needs Polyaxion to return the obligations whose condition held, an engine change made in Polyaxion's repository and vendored again. Recommended: not in v1; the report says *allowed in the scope* and why.
- **Q8. Finding 34 (escalate-once drops the engine record).** Recommended: record it as a finding now and fix it under rule 7a before or with this feature, since the report then attributes those refusals to a rule.
- **Q9. Are the warnings opt-out?** A project with many untagged rules gets a warning per rule. Recommended: no option in v1; the warnings are printed, not certified, and the count is the point.

## 11. Risks

- **The concierge's policy changes.** Its digest, its signature and every demo admission change, and tests that pin them (the demo-copy test, the diagrams, the shared demo admission) must be found and updated with it. The demo's heavy files run long; they run as two commands, and only at the owner's word if they are the full serial group.
- **Catalog drift.** MIT revises its taxonomy (Version 4 now). A new version is a catalog commit; a tag valid in one version and not in the next is `PL6506` when the catalog is updated, which is the intended signal.
- **ISO labels.** Our labels must stay our words. A review of `iso-42001.json` against the rule "ids and our labels only" is part of the catalog commit.
- **Over-reading the report.** The wording rule (RT12) is tested, and the Markdown has no word such as *mitigated*, *covered* or *safe* next to a count.

## Conclusion

The tags cost little because the parts already exist. Polyaxion carries tags on obligations and ignores them, the signature already covers the source, translation validation already reads the policy document back, and `poly cost` already shows how to report from a verified journal and list what it did not count. What is new is three catalogs with their provenance, two clauses in the grammar, three diagnostics, one semantic rule that tags never decide, and a report that counts what each rule did and says plainly that a count is evidence of application, not proof of mitigation. Two gaps in the journal shape the report and are stated, not papered over: an allow names no rule, and a run names no certificate.

## Glossary

- **Risk tag:** `"mit:<subdomain>"`, a subdomain of the MIT AI Risk Repository's Domain Taxonomy, after `mitigates`.
- **Control tag:** `"nist:<FUNCTION-n.m>"` or `"iso:<A.x.y>"`, a NIST AI RMF 1.0 subcategory or an ISO/IEC 42001 Annex A control, after `implements`.
- **Catalog:** a bundled, pinned list of the ids a tag may name, with its source and version in `std/catalogs/PROVENANCE.md`.
- **Exposure:** the risks a project lists in `poly.json` as ones it considers itself exposed to.
- **Covered:** an exposed risk that at least one policy item names in `mitigates`; a statement about the tags, not about the risk.
- **Sent to a person:** an escalation: the intent waits for a signed approval from the `people` ring.
- **Outcome unknown:** a handler attempt `lost` or `lapsed`, or an `exhausted` completion (PS23).
- **Decided on unknown input:** a rule's `on unknown` branch, recorded as `<policy>.<item>.unknown`.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
