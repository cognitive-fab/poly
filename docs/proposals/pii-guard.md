# poly · A personal-data guard with edgepii (S587): plan

*Cognitive Fab · November 2026 · on branch `pii-guard`, cut from main at 67c37744 (v1.5.1 plus finding 34) · from the owner's brief of 2026-11-04, edgepii 0.3.1 (read from its wheel), PT6, PT6.5, PT8, PT10j, PT10k, PS1.4a, PS17.4a, PD4.3 and the examples' layout*

Status: approved (section 11a), ruled as S587 in `docs/history/decisions-pii.md`. The specification is `docs/examples/pii-guard.md`. Nothing is tested, installed or built: the tests and the code wait until `risk-tags` passes its tests and is merged, so the example can carry real risk tags.

## 0. What this covers and the ids it uses

An agent wants to send a document out: to an external model, or by email. A poly policy decides from facts that edgepii supplies about the document's personal data. edgepii runs locally, in a small Python process, and only types, counts and offsets cross from it into the host; no value of personal data crosses into poly or the journal.

| Prefix | Meaning | Proposed here |
|---|---|---|
| S | spec ruling | **S587**, the next free number in sequence (S586 is risk-tags); S600 if the owner prefers a new block (Q10) |
| docs/examples | an example's specification, written before its tests | `docs/examples/pii-guard.md` |
| PT, PS | technical spec, semantics | none in the recommended design (section 9); **PT35** and **PS24** are free if Q1 makes the process adapter a poly concept |
| PL | diagnostics | none expected; **PL6850** is the first clean code if one is needed |
| PG | acceptance criteria of this example | PG1 to PG14 (section 10) |

## 1. What was read, and what decides the design

1. **edgepii 0.3.1** (PyPI, Apache-2.0, Python 3.11 or later, wheel SHA-256 `620f9b3c47491e337dc51d2265480625e743563de42e7ff9b324827853e2b52f`). Its API is `Locator.preset(name).locate(text, types=...)`, which returns `LocateResult { taxonomy_version, preset, revision, dropped, spans, quasi }`, each span `{ type, start, end, text, score, detector_id, raw_label }`, and `redact(text, spans) -> (masked, vault)`. The slice check `source[start:end] == text` is its contract: a span that fails it is dropped and counted in `dropped`. Six releases, 0.1.0 to 0.3.1, were all published on 2026-11-04, so the API is young and the pin must be exact.
2. **What the `rules` preset finds.** Rules and checksums find `EMAIL`, `PHONE` (libphonenumber), `PAYMENT` (card after Luhn, IBAN after MOD-97), `IP_ADDRESS` and `SECRET` (password, key, token). **`GOV_ID` is a rule type whose patterns are opt-in and absent from the `rules` preset**, so the preset never finds one. `PERSON`, `ADDRESS` and `USERNAME` need a model lane; `DATE_OF_BIRTH` and `ORG` are of the class `quasi`, excluded unless asked for. The model presets (`en-bert`, `en-closed`, `multi-open`, `phi-open`, `zh-schema`) pin a Hugging Face revision each and need `torch`; `multi-open` (`fastino/gliner2-privacy-filter-PII-multi` at `1cb4166`) is the multilingual one.
3. **`redact` returns a vault** of the original values for reversible types (secrets are masked irreversibly and never enter it). The vault must never leave the Python process.
4. **edgepii logs** each span's detector, type and offsets at `info`, and its text only when `EDGEPII_LOG_TEXT=1`.
5. **A policy never reads a handler's result.** A fact reaches a policy only as machine state, set by a completion (`ok(r) -> A(p: r.x)`) with a finite domain, and read as `machine("m.M").f` (PT8.3), or as a decision's fields (PD4.3).
6. **A handler cannot store a body**, and cannot start a process: `child_process` is `PL6401`, and `exec.run(command, args)` takes no stdin. A decision whose answer is a `Content` stores the provider's text and completes with its digest, with digests only in its record (PT10j). So the redacted text comes back as the `Content` answer of a decision.
7. **No adapter of poly is a separate process.** Channel, vault and source adapters are in-process objects of the certified `@poly/io` (`madeHere`, `PL6408`). The only pinned external process is polyx, started with `execFileSync`, no shell, a timeout and a pin file of its digest.
8. **No fact table exists** in poly today. The facts are the answer type of a decision, and the table that derives them is host code.
9. **Python in the suite.** `test/checkout.test.mjs` finds `python3`, `python` or `py` and skips with a message when none is found. Python 3.12 is installed on this machine.

## 2. The adapter: `adapters/edgepii/`

**Files.** `adapter.py` (the process), `requirements.txt` (exact versions with `--hash` lines: `edgepii==0.3.1`, `phonenumbers`, `pyyaml`), `requirements-model.txt` (optional: `edgepii[gliner2]==0.3.1`, `gliner2==2.1.0` and a CPU `torch`, hashed), `PIN.json`, `setup.mjs`, `PROVENANCE.md`, `README.md`.

**The protocol.** JSON lines over stdin and stdout, one request and one answer per line, UTF-8, like poly's own stdio servers (`poly mcp`, `poly lsp`) but with poly as the client. Stderr is the adapter's log and carries no value.

```json
{ "v": 1, "id": 1, "op": "hello" }
{ "v": 1, "id": 1, "ok": true, "edgepii": "0.3.1", "taxonomy": "2026.11", "preset": "rules", "revision": "rules", "detectors": ["rules"], "wheel": "sha256:620f9b3c..." }

{ "v": 1, "id": 2, "op": "locate", "text": "...", "types": ["SECRET", "GOV_ID", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS", "PERSON"] }
{ "v": 1, "id": 2, "ok": true, "dropped": 0, "spans": [{ "type": "EMAIL", "start": 41, "end": 58, "detector": "rule", "detectorId": "rules.email" }] }

{ "v": 1, "id": 3, "op": "redact", "text": "...", "types": ["EMAIL", "PHONE", "PERSON"] }
{ "v": 1, "id": 3, "ok": true, "masked": "...", "redacted": { "EMAIL": 1, "PHONE": 1 }, "recheck": { "dropped": 0, "found": {} } }

{ "v": 1, "id": 4, "ok": false, "error": "malformed-request" }
```

- **Values never cross.** A `locate` answer carries `type`, `start`, `end`, `detector` (`rule` or `model`, from the detector's kind) and `detectorId`, never `text` or `raw_label`. A `redact` answer carries the masked text, which goes only into the decision's stored `Content` (section 6), and counts per type. The vault is discarded inside the process and never written.
- **No log of a value.** The adapter refuses to start when `EDGEPII_LOG_TEXT` is set, and sets edgepii's logger to `warning`.
- **The pin.** `PIN.json` holds `{ "edgepii": "0.3.1", "wheel": "sha256:620f9b3c...", "taxonomy": "2026.11", "preset": "rules", "revision": "rules" }` and, for the optional model lane, the preset's name and Hugging Face revision. The host sends `hello` first and refuses the adapter (the facts are then unknown, section 4) when any field differs. `setup.mjs` installs with `pip install --require-hashes --no-deps -r requirements.txt`, so a dependency is the pinned one or the install fails. `adapter.py` itself is pinned by its SHA-256 in `PIN.json`, as polyx is, and the host checks it before it starts the process.
- **How the host runs it.** The example's host (`examples/pii-guard/host/edgepii.mjs`) starts `python adapter.py` once with `spawn`, no shell, `env` limited to what Python needs, and a per-request timeout. This is host code, outside the check, like the examples' recorded providers; poly's handlers never start it (fact 6).

## 3. Python on Windows

- **Interpreter.** Python 3.11 or later. On this machine, `C:\Users\jjdub\AppData\Local\Programs\Python\Python312\python.exe`, found by `py -3.12`.
- **The venv.** Outside the repository, so every worktree shares one and no checkout holds a large `torch`: `%LOCALAPPDATA%\poly\venvs\edgepii-0.3.1\`. `node adapters/edgepii/setup.mjs` creates it (`py -3.12 -m venv`), installs `requirements.txt`, and with `--model` also `requirements-model.txt`. It is run by a person, never by a test.
- **How tests find it.** The environment variable `POLY_EDGEPII_PYTHON` (a path to the venv's `python.exe`), else the default path above. A test that needs the adapter checks that the file exists, that `hello` answers with the pinned fields, and otherwise skips with a message that names what is missing and the command to run, for example `not run: edgepii 0.3.1 is not installed at %LOCALAPPDATA%\poly\venvs\edgepii-0.3.1; run node adapters/edgepii/setup.mjs`. The model lane skips the same way when `requirements-model.txt` is not installed or the weights are not cached.
- **The home guard.** No test writes under the user's home; the venv is made by the setup script, and the weights are fetched by it with `--model` into the Hugging Face cache it names.

## 4. The fact table

The host's scan provider maps one `locate` answer to the decision's answer type, `Findings`, by a table that is data (`examples/pii-guard/host/facts.json`) and is tested on its own.

```poly
enum Presence { Absent, Found, NotRuledOut }
type Findings = { secret: Presence, govId: Presence, payment: Presence, email: Presence,
                  phone: Presence, ip: Presence, person: Presence, org: Presence }
```

| Fact | Type | Found by (preset `rules`) | Values it can take |
|---|---|---|---|
| `secret` | SECRET | rule | `Found`, `Absent` |
| `payment` | PAYMENT | rule (Luhn, MOD-97) | `Found`, `Absent` |
| `email` | EMAIL | rule | `Found`, `Absent` |
| `phone` | PHONE | rule | `Found`, `Absent` |
| `ip` | IP_ADDRESS | rule | `Found`, `Absent` |
| `govId` | GOV_ID | none in `rules`; a model in a model preset | `Found`, `NotRuledOut` |
| `person` | PERSON | a model | `Found`, `NotRuledOut` |
| `org` | ORG | a model | `Found`, `NotRuledOut` |

- **Certain and uncertain.** A type found only by rules is `Found` or `Absent`. A type a model finds, or that no detector of the preset can find, is `Found` or `NotRuledOut`, never `Absent`: the policy treats it as present.
- **A dropped span.** `dropped > 0` means a detector gave an offset that failed the slice check, so something may be unseen. The scan then fails (below); it is not mapped to `NotRuledOut`, since a dropped rule span would otherwise pass as `Absent` for nothing and could not be redacted.
- **Fail closed.** The adapter missing, its `hello` not matching the pin, a timeout, an `ok: false`, an answer that is not the protocol's shape, or a span with a type outside the table: the provider fails, the decision's `failed` completion sets `scan' = Failed`, and nothing is sent. Before a scan the machine's `scan` is `Pending`.

## 5. The machine and the policy: `examples/pii-guard/`

**The machine** (`pii.poly`, `module pii`), `machine Outbound`, one document per instance:

- State: `doc: Content`, `target: Target { Model, Mail }`, `scan: Scan { Pending, Done, Failed }`, the facts of `Findings`, `redaction: Redaction { None, Verified, Failed }`, `out: Content` (the document to send: `doc`, or the redacted copy), `recipient: Recipient { Known, New }` for mail.
- Actions: `Draft(doc, target)`, `Scanned(f)` and `ScanFailed()` (the scan decision's completions), `Redacted(c)` and `RedactFailed()` (the redaction decision's), `Send()`, which emits `model.call` or `mail.send` with `out`, and the completions of the sends.
- Decisions: `decision scan(doc: Content) -> Findings`, `decision redact(doc: Content) -> Content`, each with a host provider (section 6), and `decision recipient(to: Content) -> Recipient` for mail (Q6).
- Properties checked on the machine (`never ... while ...`, PS5.2a):
  - **no-sensitive-out**: `never emit send while (secret != Absent || govId != Absent || payment != Absent) && redaction != Verified`.
  - **no-send-unscanned**: `never emit send while scan != Done`, which covers a failed or missing detector result.
  - **no-send-unverified**: `never emit send while redaction == Failed`.
  - **model-redacted**: `never emit model.call while (person != Absent || email != Absent || phone != Absent) && redaction != Verified`.

**The policy** (`pii.policy.poly`, scope `pii`):

```poly
policy pii-out {
  scope "pii"
  obligation sensitive-redacted "No SECRET, GOV_ID or PAYMENT leaves unredacted."
    mitigates "mit:2.1" implements "nist:MEASURE-2.10"
    rule {
      when proposal.kind == "effect" && effect.kind in { "model.call", "mail.send" }
      require machine("pii.Outbound").scan == Done
        && (machine("pii.Outbound").redaction == Verified
            || (machine("pii.Outbound").secret == Absent && machine("pii.Outbound").govId == Absent && machine("pii.Outbound").payment == Absent))
      else deny
      on unknown deny
    }
  obligation model-redacted "A name, email or phone number is redacted before an external model sees it."
    mitigates "mit:2.1" implements "nist:MEASURE-2.10"
    rule {
      when proposal.kind == "effect" && effect.kind == "model.call"
      require machine("pii.Outbound").redaction == Verified
        || (machine("pii.Outbound").person == Absent && machine("pii.Outbound").email == Absent && machine("pii.Outbound").phone == Absent)
      else deny
      on unknown deny
    }
  obligation new-recipient-approved "A new external recipient gets nothing until a person approves."
    mitigates "mit:2.1" implements "nist:MAP-3.5"
    rule {
      when proposal.kind == "effect" && effect.kind == "mail.send" && machine("pii.Outbound").recipient == New
      require false else escalate
      on unknown escalate
    }
}
```

The tags are written once `risk-tags` is merged; until then the policy is the same without them. `poly.json` declares `exposure: { "risks": ["mit:2.1", "mit:2.2"] }`, so the report shows 2.2 (security attacks) as exposed and not covered, which is true of this example.

**Which property is proved where.**

| Property of the brief | Held by |
|---|---|
| No path sends a SECRET, GOV_ID or PAYMENT span out unredacted | the machine's `no-sensitive-out`, and the policy's `sensitive-redacted` at run time |
| An unknown detector result never leads to a send | `no-send-unscanned`, and `on unknown deny` with `scan == Done` in the policy |
| A new recipient always gets a person's approval | the policy's `new-recipient-approved` (escalate), tested; how to prove it is Q5 |

**Stated limit.** Redaction masks what was found. A `GOV_ID` or a name that no detector of the preset finds is not masked, and `NotRuledOut` forces the redaction step without proving the redaction complete. The README says so in the first paragraph of its limits.

## 6. The redaction and its contract

- **The redaction decision's provider** (`host/edgepii.mjs`) sends `redact` with the types to mask: `SECRET`, `GOV_ID`, `PAYMENT` for every send, and also `PERSON`, `EMAIL`, `PHONE` for a model call. The adapter locates, redacts, and **runs a second `locate` on the masked text, restricted to the redacted types**. Its answer's `recheck.found` must be empty and `recheck.dropped` zero.
- **The contract.** After redaction, a second detector pass finds none of the redacted types. The provider checks `recheck` itself, never trusting `ok` alone. A non-empty `recheck.found`, a `recheck.dropped` above zero, or any adapter failure makes the provider fail; the decision's `failed` completion sets `redaction' = RedactFailed`, `no-send-unverified` forbids a send from that state, and the policy denies one. The step stops there.
- **The placeholders.** edgepii's placeholders (`[EMAIL_1]` and the like) must not themselves be found by the second pass; a sample in the tests holds each type's placeholder.
- **What is journaled.** The decision event of PT10j: the digest of the masked `Content`, its taint, and the answer's counts per type. The masked text is stored as the decision's `Content`; the original is never copied.
- **How it is tested.** A fault double of the adapter that leaves one span in place makes the provider fail and the machine end in `RedactFailed` with no send; a double that reports `recheck.dropped: 1` does the same.

## 7. Demo data and French

- Synthetic text only, written for the example: no real person, number or address. Card numbers are test numbers that pass Luhn, IBANs are example IBANs that pass MOD-97, phone numbers are from reserved fictional ranges where one exists.
- English and French samples, each a pair of the text and its expected spans by type (the gold), under `examples/pii-guard/samples/`.
- The README records, per language and per type, the precision, recall and F1 that edgepii's own scorer (`edgepii.eval.score.exact_span_f1`) measures on our samples, for the `rules` lane live and for `multi-open` when installed, with the date, the versions and the revision. Whether edgepii handles French is answered by those numbers, not asserted: the rules for email, IBAN and IP do not depend on language, French phone numbers depend on libphonenumber's region handling, and names depend on the model lane.

## 8. Tests

- `test/ex-pii-guard.test.mjs`: the example checks with its expected verdict, the four properties hold, and the defect variant (`pii-guard-defect.poly`, a `Send` that skips the `redaction` guard) gives the expected finding with its witness.
- `test/pii-facts.test.mjs`: the fact table from recorded adapter answers (`examples/pii-guard/recorded/*.json`: types, offsets and detectors only), including model-found types, `NotRuledOut`, `dropped > 0`, a malformed answer and an unknown type, each failing closed.
- `test/pii-adapter-live.test.mjs`: the real adapter with the `rules` preset on the samples, for the rule types; it skips with its message when Python or edgepii is absent.
- `test/after/ex-pii-guard-e2e.test.mjs`: the runtime end to end with recorded adapter answers (a clean model call, a model call redacted, a SECRET refused unredacted then sent redacted, a failed re-check, a failed scan, a new recipient escalated and approved), and one test with the real adapter, skipped the same way. With risk-tags merged, `poly report risks` on its kept store.

Run only these files and the ones the change touches; the full suite only at the owner's word, with nothing else heavy alongside.

## 9. Spec sections and the ruling

- **S587**, in a new `docs/history/decisions-pii.md`: the owner's ruling on this plan and its questions.
- **`docs/examples/pii-guard.md`**: the example's specification, as the other examples have one, with the protocol of section 2, the fact table, the machine, the policy, the properties, the redaction contract and the acceptance criteria PG1 to PG14. Committed alone (rule 7a).
- **No change to `03-technical-spec.md` or `04-semantics.md`** in the recommended design: the adapter and the fact table are host code, and the example uses decisions, `Content`, policies and properties as they are. If Q1 makes a process adapter a poly concept, that is **PT35** (and **PS24** for what the runtime trusts of it), in a separate ruling.
- **Licence and pin** in `adapters/edgepii/PROVENANCE.md`: edgepii 0.3.1, Apache-2.0 (its wheel's `LICENSE` and PyPI's `license_expression`), the wheel's SHA-256, and each dependency's version, hash and licence; for the model lane, the model's repository, revision and licence as its card states it.

## 10. Acceptance criteria (proposed)

- **PG1** The example checks with its expected verdict, and the four machine properties hold.
- **PG2** The defect variant gives `no-sensitive-out` as a finding with a witness.
- **PG3** The adapter's answers carry no span text, no raw label and no vault value; the host refuses an answer that does.
- **PG4** A `hello` that differs from `PIN.json`, or an `adapter.py` whose digest differs, makes every scan fail.
- **PG5** Each failure of section 4 (missing, timeout, `ok: false`, malformed, unknown type, `dropped > 0`) ends in `scan == Failed` and no send.
- **PG6** A model-found type is `Found` or `NotRuledOut`, never `Absent`.
- **PG7** A SECRET, GOV_ID or PAYMENT found is never sent unredacted, at run time, and the policy denies it.
- **PG8** A model call with a name, email or phone number not ruled out is redacted first.
- **PG9** A redaction whose second pass finds a redacted type, or drops a span, ends in `RedactFailed` and no send.
- **PG10** A new recipient's mail is escalated and sent only after a person approves.
- **PG11** No body, span text or vault value is in the journal or the store outside the decision's `Content`.
- **PG12** The live adapter finds the rule types of every sample, and skips with its message when absent.
- **PG13** The README's French and English scores are those the scorer measures on the samples, with versions and date.
- **PG14** With risk-tags merged, `poly report risks` on the example's kept store counts its three rules under `mit:2.1` and lists `mit:2.2` as exposed and not covered.

## 11. Open questions

- **Q1. A process adapter in poly, or host code?** Recommended: host code for this example (section 2), as the recorded providers are. Making a pinned, handshaken process adapter a kind poly certifies (`poly.adapters`, `PL6408`) is a runtime change with its own ruling, PT35.
- **Q2. Decisions or an effect for the scan?** Recommended: decisions, since a decision's answer is a typed record the machine takes, a decision can return a stored `Content` (the redaction needs it), and replay reads recorded decisions with no provider (K10). To be checked in the spec: whether a local deterministic detector as a decision's provider must carry a calibration or a confidence (PL6841 applies to routed tiers). The fallback is an effect whose handler calls `exec.run` with a digest, the host's exec transport reading the body.
- **Q3. Which preset runs the demo?** `rules` finds no name and no GOV_ID, so every model call is redacted and every GOV_ID stays `NotRuledOut`. `multi-open` finds names in English and French but needs `torch` and a weights download. Recommended: `rules` for the live tests, `multi-open` as an optional lane for the e2e and the French measurements, with recorded answers in the suite.
- **Q4. GOV_ID under the `rules` preset.** It can never be found, so `NotRuledOut` forces redaction that cannot mask it. Recommended: accept with the stated limit of section 5. Alternatives: enable edgepii's opt-in GOV_ID patterns if 0.3.1 exposes them, or refuse every external send when the preset has no GOV_ID detector.
- **Q5. Proving "a new recipient always gets a person's approval".** A policy `never` treats an escalation a person can lift as an allow (PL6503), so it cannot state "only after approval", and the machine does not see approvals. Recommended: hold it by the rule's `escalate` severity and the e2e test, and log a v2.0 idea: a policy property "allowed only after approval" proved over poly-ref's decision table.
- **Q6. Where "new recipient" comes from.** Recommended: a host table of recipients a person approved, keyed by the store's recipient digest (`hmac-sha256`), read by the `recipient` decision's provider, unknown treated as `New`; an approved send adds its recipient. Alternative: a machine field set by an operator action.
- **Q7. The venv's place.** `%LOCALAPPDATA%\poly\venvs\edgepii-0.3.1\`, shared by the worktrees, or `adapters/edgepii/.venv\` in each checkout. Recommended: the shared one.
- **Q8. Pinning a library this young.** edgepii went from 0.1.0 to 0.3.1 on one day. Recommended: pin 0.3.1 exactly, with a bump as its own change that reruns the samples and the scores.
- **Q9. The masked text and taint.** The redacted `Content` keeps the original's taint class in PT10j (the join of the inputs). Should a verified redaction lower it, so a model call reads a lower audience? Recommended: no in this example; the policy reads `redaction == Verified` instead.
- **Q10. Ruling number.** S587 in sequence, or S600 to start a new block after E3's reserved S550 to S599.

## 11a. The owner's answers (2026-11-04)

The plan is approved. The specification commit and the code wait until risk-tags passes its tests.

| Question | Answer |
|---|---|
| Q1 | Host code. |
| Q2 | A decision. The specification states that the `rules` preset is deterministic and needs no calibration, and that a model-detected type is never `Absent`, so no confidence is relied on. |
| Q3 | `rules` for the live tests; `multi-open` as an optional lane. |
| Q4 | Enable edgepii's opt-in GOV_ID patterns for a US SSN and the French NIR, pinned in the adapter's configuration. If 0.3.1 has no such pattern for those locales, keep the stated limit and put it first in the README. |
| Q5 | The rule and a test; the v2.0 idea is logged in `docs/proposals/v2.0-ideas.md`. |
| Q6 | A host table of approved recipient digests; an unknown recipient is new. |
| Q7 | The shared venv. |
| Q8 | 0.3.1 exactly; any upgrade is its own change. |
| Q9 | No. |
| Q10 | S587. |

**Q4, checked on 2026-11-05.** edgepii 0.3.1 ships no GOV_ID pattern for any locale: its rule detector has no GOV_ID branch, `Locator.preset` takes no pattern argument, and its own corpus notes say "No pattern ships in v1." So the answer's fallback applies: the stated limit is kept and is first in the README. The evidence is in `docs/history/decisions-pii.md`.

**Where this plan is superseded.** The specification, `docs/examples/pii-guard.md`, wins where it differs, and lists each difference. Three of this plan's statements are wrong and are kept here as written: edgepii's placeholders are `<EMAIL_1>` and `<SECRET>`, not `[EMAIL_1]` (section 6); a French phone number in national form is not found at all, since the phone rule's default regions are `US`, `CN`, `HK` and `GB` (section 7); and no effect is named `send`, so each property of section 5 written `never emit send` is two statements in the specification, one per effect.

## Conclusion

The guard needs no change to poly's language or runtime. The detector runs as a pinned local process behind a small JSON protocol, the host turns its answer into a finite record of facts, and the machine and policy decide from those facts, failing closed on anything the host cannot read. What edgepii cannot find is the guard's limit, and the plan states it: the `rules` preset sees no name and no national id, so the policy treats both as present and redacts what it can, and the README measures, in English and French, how much that is.

## Glossary

- **edgepii:** an Apache-2.0 Python library by Raphaël Mansuy that returns exact character spans of personal data, found by rules and checksums or by a model.
- **Adapter (here):** the Python process `adapters/edgepii/adapter.py`, speaking JSON lines over stdin and stdout; host code, not a certified poly adapter.
- **Span:** a type and a half-open character range `[start, end)` on the source text.
- **Dropped span:** a span whose offsets failed edgepii's slice check; counted, never repaired.
- **Fact table:** the host's map from an adapter answer to the record `Findings`, one `Presence` per type.
- **NotRuledOut:** a type that a model finds or that no detector of the preset can find, when none was found; treated as present.
- **Redaction contract:** after masking, a second detector pass finds none of the masked types.
- **Fail closed:** any failure to obtain or read the facts ends in no send.
