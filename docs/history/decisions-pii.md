# poly · Decisions: the personal-data guard with edgepii

*Cognitive Fab · November 2026 · rulings on `docs/proposals/pii-guard.md`, on branch `pii-guard`*

## S587 A personal-data guard with edgepii, as an example (owner, 2026-11-04)

**The plan is accepted** (`docs/proposals/pii-guard.md`, with the owner's answers in its section 11a). The specification is `docs/examples/pii-guard.md`, with the acceptance criteria PG1 to PG15. Nothing in `03-technical-spec.md` or `04-semantics.md` changes: the adapter and the fact table are host code, and the example uses decisions, `Content`, policies and `never` statements as they are.

**The rulings on the plan's questions.**

| Question | Ruling |
|---|---|
| Q1 A process adapter in poly, or host code | Host code. |
| Q2 Decisions or an effect for the scan | A decision. The specification states that the `rules` preset is deterministic and needs no calibration, and that a model-detected type is never `Absent`, so no confidence is relied on. |
| Q3 Which preset runs the demo | `rules` for the live tests; `multi-open` as an optional lane. |
| Q4 GOV_ID under `rules` | Enable edgepii's opt-in GOV_ID patterns for a US SSN and the French NIR, pinned in the adapter's configuration. If 0.3.1 has no such pattern for those locales, keep the stated limit and put it first in the README. |
| Q5 Proving "a new recipient always gets a person's approval" | The rule and a test; the v2.0 idea is logged in `docs/proposals/v2.0-ideas.md`. |
| Q6 Where "new recipient" comes from | A host table of approved recipient digests; an unknown recipient is new. |
| Q7 The venv's place | The shared venv, outside the repository. |
| Q8 Pinning a library this young | 0.3.1 exactly; any upgrade is its own change. |
| Q9 The masked text and taint | No: a verified redaction does not lower the taint. |
| Q10 Ruling number | S587. |

**Order of work (rule 7a).** The specification, committed alone and before risk-tags is merged (owner, 2026-11-05); then the tests, by a separate writer on the session's model who has read only the specification, failing first; then the code. The tests and the code wait until `risk-tags` passes its tests and is merged, so the policy can carry real risk tags. Only the new test files and the files the change touches are run; the full suite only at the owner's word, with nothing else heavy on the machine.

## Q4 checked against edgepii 0.3.1 (2026-11-05)

The wheel `edgepii-0.3.1-py3-none-any.whl` was downloaded again and its SHA-256 compared with the plan's (`620f9b3c...2b52f`). **It ships no GOV_ID pattern, for any locale**, so there is no SSN or NIR pattern to enable:

- `RuleDetector.locate` (`edgepii/detectors/rules.py`) has branches for email, phone, card and IBAN, IP and secret, and none for a GOV_ID label;
- `Locator.preset(name)` takes no pattern argument;
- the taxonomy `2026.11` declares `GOV_ID` with `prefer: rule` and no rule; the README's type table says "Patterns stay opt-in";
- `eval/corpora.yaml` says of national schemes that taxonomy 2026.11 "leaves to GOV_ID patterns that are opt in per country. No pattern ships in v1."

The ruling's fallback applies: the limit is kept and is the first paragraph of the README's limits (PG15). A detector of our own given to `Locator.from_detectors` would be poly writing the patterns, not enabling edgepii's; it is not part of S587 and would be its own change.

The same reading found three facts the plan did not have, now in the specification: the phone rule's default regions are `US`, `CN`, `HK` and `GB`, so a French number in national form is not found; the IBAN pattern admits no spaces; and the placeholders are `<EMAIL_1>` and `<SECRET>`, not `[EMAIL_1]`.

## The specification's differences from the plan (2026-11-05, for the owner's review)

`docs/examples/pii-guard.md` lists them in its section "Differences from the plan". In short: the state keeps six facts (not `ip` and `org`); `Redaction` gains `Redacting` and `Recipient` gains `Unchecked`, with a property `mail-recipient-checked`; each property is two `never` statements, one per effect; the redaction is issued by `Scanned`; `hello` reports a digest of edgepii's installed source, since the venv keeps no wheel; the redaction's counts are checked and not journaled; the policy is named `outbound`; and no send at run time is unredacted, since `govId` is never `Absent`. They are not ruled yet.

## Conclusion

S587 adds an example and no language: a pinned local detector, a fact table that never reads silence as absence, and a machine and policy that send only after a scan the host could read. Q4 was answered by reading the library rather than assuming it: edgepii 0.3.1 has no national id pattern to enable, so the guard's first stated limit is that it cannot see one.
