# Personal-data guard

An agent wants to send a document out, to an external model or by mail. Before anything leaves, a local detector, **edgepii**, says which types of personal data the document holds, and a poly machine and its policy decide from those facts: the document leaves only after a scan the host could read, and through a verified redaction whenever a fact is not ruled out. edgepii runs in a small pinned Python process on this machine; only types, counts and offsets cross from it into the host, and no value of personal data reaches poly or its journal. The spec is `docs/examples/pii-guard.md` (S587).

## Limits, first

- **No national id is found.** edgepii 0.3.1 ships no GOV_ID pattern for any country: its rule detector has no GOV_ID branch, and its own corpus notes say "No pattern ships in v1." Under the `rules` preset a US SSN or a French NIR is never found, so a verified redaction does not mask it. The scores below show `GOV_ID` recall 0 in both languages. The program treats GOV_ID as not ruled out, so every send is redacted, but the redaction cannot remove what was not found.
- **No name is found under `rules`.** A name needs a model lane, and the `rules` preset has none. A name therefore reaches the model inside the verified, masked text: the end-to-end test asserts that the name of `en-model.txt` is still in the body it posts.
- **A French phone number in national form is not found.** The phone rule's default regions are `US`, `CN`, `HK` and `GB`; `06 39 98 12 34` is not found, and `+33 6 39 98 12 35` is.
- **An IBAN written with spaces is not found as an IBAN**, since the pattern admits no spaces. On `en-ids.txt` its last three groups are found as a phone number instead.
- **The model lane is not packaged.** `multi-open` is pinned in `examples/pii-guard/adapter/PIN.json`, but its hashed dependency closure (`torch`, `gliner2`) is not written yet, so `setup.mjs --model` stops and its tests skip.

## What it shows

- **Facts from a local detector, read fail-closed.** The host maps edgepii's answer to one `Presence` per type (`host/facts.mjs`): `Found`, `Absent` only for a type a rule of the preset can find, and `NotRuledOut` otherwise. A span that carries text, a type the table does not know, a dropped span or a refused call fails the scan. The program reads two joined facts, `sensitive` (secret, national id, payment) and `personal` (name, email, phone).
- **A redaction checked by a second pass.** The adapter masks with edgepii's placeholders (`<EMAIL_1>`, `<SECRET>`), throws the vault away, and locates again on the masked text; the host accepts the masked text only when that pass finds and drops nothing.
- **Eight `never` statements**, one per property and effect: no send unscanned, none after a failed redaction, no sensitive or (for a model) personal fact out unredacted, no mail before its recipient is known. Each is tested, not vacuous.
- **A policy that holds the same at run time.** `outbound` denies a send whose snapshot is not scanned or not redacted, and escalates a mail to a recipient the host's table does not hold, for a person to approve.
- **A pinned process.** `PIN.json` fixes edgepii's version, the digest of its installed source, the taxonomy, the preset and the adapter's own digest; the client refuses an adapter that differs, before it starts and after `hello`.
- **A seeded defect.** `pii-guard-defect.poly` sends a mail when the redaction "did not fail", forgetting that it may not have finished. The check finds it (`PL3002` on `no-sensitive-mail`, 4 steps), and at run time the gate denies that mail.

## Run it

From the repository root, after `npm ci` and `npm run build`. The tests run without Python, on recorded answers; the live tests skip with their reason until the adapter is installed.

```sh
node examples/pii-guard/adapter/setup.mjs
node packages/poly-check/dist/src/cli.js check examples/pii-guard/pii-guard.poly
node packages/poly-check/dist/src/cli.js check examples/pii-guard/pii-guard-defect.poly
node --test test/ex-pii-guard.test.mjs test/pii-facts.test.mjs test/pii-adapter-live.test.mjs
node --test --test-concurrency=1 test/after/ex-pii-guard-e2e.test.mjs
node examples/pii-guard/host/record.mjs
```

`setup.mjs` creates the shared venv outside the repository (`%LOCALAPPDATA%\poly\venvs\edgepii-0.3.1\` on Windows) and installs edgepii 0.3.1 and its two dependencies with every hash required. `record.mjs` rewrites `recorded/answers.json` from the live adapter; the live test compares the two.

## What is checked

| Check | Result |
|---|---|
| The program with its policy | `CLEAN`, 5,206 states, nothing vacuous or not run |
| The defect with the program's policy | `FINDINGS`: exactly `PL3002` on `no-sensitive-mail`, witness `DraftMail`, `Scanned`, `Checked`, `Send`; 7,006 states |
| The handlers (`--host`) | `CLEAN`; a wrong payload field is `PL6836` |
| The fact table and the providers | every error code, each recorded fault, the join into two facts |
| The live adapter | `hello` matches the pin; every live answer equals the recorded one |
| End to end | a redacted model call, a redacted mail, a held send, the gate's denial of the defect's mail, a failed re-check, a failed scan, a new recipient approved by a person, no value in the journal, replay without divergence |

## What is not checked

- What edgepii does not find (the limits above). The guard proves that a send goes through a verified redaction, not that the redaction removed every value.
- The model lane, which is not packaged.
- That a person approves a new recipient is held by the policy's escalation and an end-to-end test, not proved: a policy `never` counts an escalation a person can lift as an allow.

## Scores

`examples/pii-guard/adapter/score.py --preset rules` on the six samples, edgepii 0.3.1, preset `rules`, revision `rules`, measured on 2026-11-05 with edgepii's `exact_span_f1`:

| Language | Type | Gold | Found | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| en | EMAIL | 1 | 1 | 1.00 | 1.00 | 1.00 |
| en | GOV_ID | 1 | 0 | 0.00 | 0.00 | 0.00 |
| en | PAYMENT | 3 | 2 | 1.00 | 0.67 | 0.80 |
| en | PERSON | 2 | 0 | 0.00 | 0.00 | 0.00 |
| en | PHONE | 1 | 2 | 0.50 | 1.00 | 0.67 |
| en | SECRET | 1 | 1 | 1.00 | 1.00 | 1.00 |
| en | all | 9 | 6 | 0.83 | 0.56 | 0.67 |
| fr | EMAIL | 1 | 1 | 1.00 | 1.00 | 1.00 |
| fr | GOV_ID | 1 | 0 | 0.00 | 0.00 | 0.00 |
| fr | PAYMENT | 1 | 1 | 1.00 | 1.00 | 1.00 |
| fr | PERSON | 2 | 0 | 0.00 | 0.00 | 0.00 |
| fr | PHONE | 2 | 1 | 1.00 | 0.50 | 0.67 |
| fr | all | 7 | 3 | 1.00 | 0.43 | 0.60 |

The English phone's precision of 0.50 is the spaced IBAN read as a phone; the French phone's recall of 0.50 is the national form. Six short samples measure the rules, not edgepii in general.

## Conclusion

The guard changes nothing in poly. A pinned local process answers in types and offsets, the host reads that answer into facts that never take silence for absence, and the machine and its policy send only after a scan the host could read and a redaction a second pass confirmed. What edgepii cannot see is the guard's limit, and it is stated first: no national id and, under `rules`, no name.

## Glossary

- **edgepii:** an Apache-2.0 Python library that returns exact character spans of personal data, found by rules and checksums or by a model.
- **Adapter:** `examples/pii-guard/adapter/adapter.py`, the process that runs edgepii and speaks JSON lines; host code, not a poly adapter.
- **Preset:** a pinned set of edgepii detectors; `rules` is rules and checksums only.
- **Fact table:** the host's map from a locate answer to one `Presence` per type.
- **NotRuledOut:** not found, and not a type a rule of the preset can find; treated as present.
- **Exposure:** the two facts the program reads, `sensitive` and `personal`.
- **Redaction contract:** after masking, a second pass with the same types finds nothing and drops nothing.
- **Pin:** `examples/pii-guard/adapter/PIN.json`, the versions and digests the client checks.
