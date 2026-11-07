# poly v1.6.0 · Release notes (risk tags, and the risk report)

Not tagged. This document is the draft for the owner's approval; the tag and the push wait for it.

## What v1.6.0 is

v1.6.0 lets a policy rule say which AI risk it mitigates and which control it implements, and adds `poly report risks`, which reads the verified journal and says, for each risk, what each rule that names it did (S586, PT8.6, PT34). It adds the pii-guard example (S587). It fixes findings 34 to 37 of `docs/examples/language-findings.md`.

It is a minor release, not a bug fix, for two reasons:

- it adds a command, a `poly.json` field, two diagnostic codes and a certificate field;
- **a certificate admitted by v1.5.1 or earlier is refused at load** (finding 35, below).

**How it was built.** On `main` from v1.5.1 (`493b183c`), with the work of branches `risk-tags`, `pii-guard`, `finding-35-machine-reads`, `pt34-uncovered-per-build`, `concierge-store-erase`, `finding-36-dry-run-dates` and `finding-37-spaces` merged in. Every change followed rule 7a: the spec first, committed alone; then tests by a separate writer who had read only the spec; then the code. Three departures are named where they occur.

## Upgrading: admit again

Each `poly.policies` entry of a certificate now records `singletons`, the service machines its policies read (PT8.3, finding 35). `load` refuses an entry without it:

```
refused at load: scope <scope>: the certificate lists no singletons, the service machines its policies read (PT8.3, finding 35); it was admitted before they were certified: run poly admit again
```

Run `poly admit` again for every project before it runs on v1.6.0. The owner ruled the refusal on 2026-11-06. Reading an old certificate the old way, or as reading no service machine, would decide on a value PT8.3 does not give.

The certificates kept under `docs/examples/risk-report/` were admitted before the field existed. `poly report risks` reads them and does not load them, so the kept reports are unchanged.

## Risk and control tags, and the risk report (S586, PT8.6, PT34)

- **Tags on policy items** (PT8.6). A rule writes `mitigates mit:7.3` and `implements iso:A.9.2, nist:MAP-3.5`. Tags never change a decision (PS8.10): poly-ref checks that tagged and untagged policies give the same outcome, reason and witness on every row of a `never` decision table.
- **Three bundled catalogs** (PT34.1), in `std/catalogs/`, pinned in `std/PINS.json`, each with its provenance:
  - the MIT AI Risk Repository's Domain Taxonomy, Version 4 (2025-12-04), CC BY 4.0, with its attribution line;
  - NIST AI 100-1 (AI RMF 1.0);
  - ISO/IEC 42001:2023 Annex A, ids and poly's own labels only.
- **The check** (PT34.2).
  - An unknown tag is **`PL6506 POLICY_TAG_UNKNOWN`**, and the verdict is `REFUSED`.
  - A project opts in when `poly.json` declares `exposure` or any item carries a tag. A project that does not opt in gets output byte-identical to v1.5.1's.
  - In a project that opts in, three warnings, none in the verdict: `untagged:`, `no control:` and `uncovered:`.
- **`exposure` in `poly.json`** (PT1.2): `{ "risks": ["mit:2.1", ...] }`, MIT subdomains only. Any other id is **`PL6507 EXPOSURE_TAG_UNKNOWN`**. The schema is `schemas/manifest/exposure.json`.
- **Lowering and the certificate** (PT34.3). Each tagged obligation of the Polyaxion document carries `tags`. An untagged one carries none, so its document, digest and signature are unchanged. A build that opts in records `poly.risk`. Translation validation reads the tags back; `policy-tag-dropped` and `policy-tag-moved` are new toolchain faults.
- **`poly report risks`** (PT34.4), and `poly_report_risks` over MCP, read-only.
  - It verifies every run as `poly journal verify` does, and matches each run to a certificate given with `--certificate`.
  - It counts, per risk and item: refusals, escalations (approved, timed out or open), and decisions on unknown input.
  - Allows are counted per scope, since an allow names no rule. A refusal is counted for one item, the first that refused.
  - The runtime's own refusals are counted by reason. An `escalate-once` denial is counted as the runtime's escalation, by its `escalatedBy` cause (finding 34).
  - The first line says the counts are evidence the rules were applied, not proof a risk was reduced.
  - It prints no body and no address, and gives the same bytes for the same inputs.
  - Its exit is `CLEAN` when every run with a gate record is counted, `INCONCLUSIVE` otherwise.
- **"Exposed and not covered" is worked out per counted build** (PT34.4, ruled 2026-11-06). A risk is listed when a build the report counts declares it and no item of that build mitigates it.
- **The examples** (PT34.5).
  - The refunds desk's policy is tagged and declares an exposure it leaves uncovered.
  - A new `examples/airline-desk`, written for these docs.
  - Kept stores, certificates and reports for both, and for pii-guard, are under `docs/examples/risk-report/`, made by `scripts/risk-report-examples.mjs`.
- **No body and no address in a kept store** (PT34). The concierge's scripted day now erases its bodies and addresses (S205) and the store is vacuumed before it is kept, as pii-guard's was. Regenerated: every count of its report is the same; only the certificate's digest changed.

## Finding 34: an `escalate-once` denial says what it replaced (PT9.7 rule 2)

The `denied` event of an `escalate-once` now records `gateDecision: "escalate"` and `escalatedBy`, the reason of the escalation it replaces (for example `stale-items`). Before, the cause appeared in no event of the intent. The entry was first read as a lost `sseq`. A separate writer's probes showed the engine never escalates an approved proposal, so it was narrowed before it was fixed. A budget-triggered `escalate-once` has no test, for lack of a fixture.

## The pii-guard example (S587)

`examples/pii-guard`: a document goes to an external model or by mail only after edgepii, a local detector in a pinned Python process, has scanned it. Whenever a fact is not ruled out, it goes through a verified redaction. Only types, counts and offsets cross into the host. It checks `CLEAN` with its policy; its defect is `PL3002`. Its README states first what edgepii cannot find: no national id, and under the `rules` preset no name.

## Fixes

- **Finding 35: a policy read only a certified service machine's latest snapshot** (PT8.3). The runtime answered `machine("m.M")` with the snapshot of any machine that had one instance in the store. Admission now certifies each scope's `singletons`. The gate host reads a latest snapshot only for those. Every other machine, except the emitter, is unknown for an effect, a send and an approved re-proposal alike.
- **Finding 36: the inbox's dry run expired** (`examples/inbox/README.md`). Its recorded mail was dated October and checked against today's clock, so since 2026-11-04 every decision escalated `stale-items`. `dry-run/fixtures.json` now names `recordedAt`. The fake Google moves every `internalDate` it serves by the run's clock minus that instant. The runtime's clock stays real. Fixtures with no valid `recordedAt` are refused, and the host exits 64.
- **Finding 37: seven tests failed under a path with a space.** Each cause was in a test: a shell command line built from an unquoted path, and a README command filled with one. No shipped code builds a command line from a path. The inbox README now says to quote a path with a space. **Departure:** no separate writer; the failing tests were the existing ones.
- **DF15.5 named `/tmp/log.txt`**, which is `C:\tmp` on Windows, and `--log` refuses a folder that does not exist. The two tests now use the OS temporary folder. A test-only fix, made directly on `main`.
- **Finding 14's confinement names one script** (ruled 2026-11-06). `test/ex-accept-findings.test.mjs` allows `scripts/risk-report-examples.mjs` to use `acceptFindings`, since it runs only with the test anchors. It failed on `main` since pii-guard's A5. **Departure:** the ruling and the test change, no separate writer.
- **DB3** (`ba69a88e`). The demo baseline's poly reference rewords the refund rule S586 added to the spec.

## The test runs on v1.6.0

To be filled in from the release run on the laptop, with nothing else heavy running, on Node 24.12.0: the main group, then the serial after group, each run whatever the other gave.

## Known limits

The limits of v1.5.1 hold (`docs/release-notes-v1.5.1.md`). New, or still open:

- **A Slack post's provider id stays in the concierge's journal.** Slack builds it from the staff channel's id and a timestamp. It is the record of the effect, not a body, and nothing marks it erasable. The risk report's README names it as the one trace left.
- **Finding 35, not built:**
  - a test with a poisoned instance of a service machine;
  - PT9.7's comparison for a non-service machine after an allow;
  - a send verdict's `reads`.
  Two questions are left to the specification: whether a service machine that is also the emitter is listed under `singletons`, and whether the runtime should let two instances of a service machine exist.
- **Finding 33, the part left open.** `(c1)` to `(c3)` of `test/demo-driver-hygiene.test.mjs` wait on the wall clock and can fail under load.
- **The dry run's `expired` pass** asks for mail after the newest recorded date, so it would find none once the dates move. The dry run replays only `initial`.
- **Risk reporting.** No exposure by sector or by role. No rule is credited with an allow. A refusal two items would make is counted for the first.

## Conclusion

v1.6.0 lets a policy say what it is for, in the terms of three published catalogs. It also gives a reader the counts of what each rule did, read from a journal they can verify, worded so the counts are not taken for more than they are. The same release closes a gap between PT8.3 and the runtime: a policy now reads only the machines the semantics lets it read. The price is that every project is admitted again. The inbox's dry run works again, whatever the date. The remaining open items are listed above, and the tag waits for the release run and the owner.

## Glossary

- **Risk tag:** `mitigates <catalog>:<id>` on a policy item, naming a risk of the MIT catalog.
- **Control tag:** `implements <catalog>:<id>`, naming a NIST or ISO control.
- **Exposure:** the risks a project lists in `poly.json` as the ones it considers itself exposed to.
- **Uncovered:** an exposed risk that no item of a counted build mitigates.
- **Singletons:** the service machines a policy scope reads, certified per scope; the only machines besides the emitter whose snapshot a policy reads.
- **Kept store:** a store committed with the docs, so its report can be regenerated byte for byte.
- **`recordedAt`:** the instant the dry run's recorded traffic stands for.
- **Rule 7a:** the order of work: the specification first, then tests from someone who has read only it, then the code.
