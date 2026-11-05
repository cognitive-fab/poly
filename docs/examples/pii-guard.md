# Example spec: pii-guard

S587, from the plan `docs/proposals/pii-guard.md` and the owner's answers of 2026-11-04 (its section 11a). Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it. The tests and the code started before `risk-tags` was merged, at the owner's word (2026-11-05); the risk tags are added by an amendment when it is.

## Purpose

An agent wants to send a document out: to an external model, or by mail. A poly machine and its policy decide from facts that **edgepii** supplies about the document's personal data. edgepii runs locally, in a small Python process (the **adapter**), and only types, counts and offsets cross from it into the host; no value of personal data crosses into poly or the journal. The point of the example is **fail closed**: a document is sent only after a scan that the host could read, and only redacted when the scan found, or could not rule out, a sensitive type. The seeded defect is a mail send that checks that the redaction did not fail where it should check that it was verified.

No test calls a model, a mail server or the network. The external model and the mail server are recorded; the adapter is recorded too, except in the tests that run the real one and skip when it is absent.

## What edgepii 0.3.1 finds

Read from its wheel, `edgepii-0.3.1-py3-none-any.whl`, SHA-256 `620f9b3c47491e337dc51d2265480625e743563de42e7ff9b324827853e2b52f` (downloaded again on 2026-11-05 and the hash compared), Apache-2.0, Python 3.11 or later, depending on `phonenumbers>=8.13` and `pyyaml>=6`.

- The `rules` preset runs one detector, `RuleDetector` (`edgepii/detectors/rules.py`). It finds `EMAIL` (shape only), `PHONE` (libphonenumber, default regions `US`, `CN`, `HK` and `GB`, so a French number is found in its international form `+33 ...` and not in its national form `06 ...`), `PAYMENT` (a card after Luhn; an IBAN after MOD-97, written **without spaces**, since its pattern admits none), `IP_ADDRESS` and `SECRET` (a cue word such as `password` or `api_key`, then a value). It is deterministic: the same text gives the same spans.
- **GOV_ID (Q4).** The owner's answer was to enable edgepii's opt-in GOV_ID patterns for a US SSN and the French NIR, if 0.3.1 has them. **It has none, for any locale.** `RuleDetector.locate` has no branch for any GOV_ID label; `Locator.preset(name)` takes no pattern argument; the taxonomy (`taxonomies/2026.11.yaml`) declares `GOV_ID` with `prefer: rule` and no rule; the README's type table says "Patterns stay opt-in"; and `eval/corpora.yaml` says of national schemes: "taxonomy 2026.11 leaves to GOV_ID patterns that are opt in per country. No pattern ships in v1." So the answer's fallback applies: **the stated limit is kept and is the first paragraph of the README's limits.** Under `rules`, `GOV_ID` is never found. A detector of our own, given to `Locator.from_detectors`, would be poly writing the patterns, not enabling edgepii's; it is not part of this example and would be its own change.
- `PERSON` and `ORG` need a model lane. The optional lane is `multi-open` (`fastino/gliner2-privacy-filter-PII-multi` at revision `1cb4166094dc58fa8d836429f060d6c95f62b495`, extra `gliner2`, which needs `torch`). A model may also find `GOV_ID`.
- `redact(text, spans)` masks each span with a placeholder: `<SECRET>` for a secret (irreversible, never in the vault), `<TYPE_n>` for the others (`<EMAIL_1>`, `<PHONE_1>`, ...), and returns the vault of original values, which never leaves the adapter. It raises on overlapping spans.
- Spans carry `text`, a copy of the value, and `raw_label`; the adapter sends neither. Offsets are Python string indices (code points). The samples keep to the Basic Multilingual Plane, so a code point offset is also a UTF-16 offset in them, but the host never slices with an offset.
- edgepii logs to the logger `edgepii`, each span's detector, type and offsets at `info`, and its text only when `EDGEPII_LOG_TEXT=1`.

## Files

Under `examples/pii-guard/`. The names are fixed.

| File | Content |
|---|---|
| `pii-guard.poly` | module `pii`, first line `// expected: CLEAN` |
| `pii-guard.policy.poly` | module `pii_policy`, policy `outbound`, scope `"pii"` |
| `pii-guard-defect.poly` | the program with the seeded defect, first line `// expected: FINDING PL3002` |
| `pii-guard-defect.policy.poly` | the defect's policy beside it; the same text as the program's |
| `host/handlers.ts` | the certified handler file; exports `callModel` and `sendMail` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/pii-guard` |
| `host/edgepii.mjs` | the adapter client: exports `defaultPython()`, `loadPin(file)`, `adapterStatus(opts)` and `startAdapter(opts)` |
| `host/facts.mjs` | the fact table: exports `loadTable(file)`, `factsOf(answer, table, preset)` and `FactError` |
| `host/facts.json` | the table, as data |
| `host/providers.mjs` | exports `SCAN_TYPES`, `redactTypes(target)`, `exposureOf(findings)`, `scanProvider(client, table)`, `redactProvider(client)`, `recipientProvider(recipients)` and `provideGuard(rt, opts)` |
| `host/recipients.mjs` | exports `recipientTable(key, digests)` |
| `host/recorded.mjs` | exports `loadRecorded(file)` and `recordedAdapter(fixture, opts)` |
| `host/record.mjs` | run by a person: writes `recorded/answers.json` from the live adapter over the samples |
| `recorded/answers.json` | the adapter's recorded answers for the samples |
| `samples/*.txt`, `samples/gold.json` | the English and French samples and their expected spans |
| `README.md` | what it shows, its limits first, how to run it, what is checked, what is not, the measured scores, a conclusion, a glossary |

Under `adapters/edgepii/`:

| File | Content |
|---|---|
| `adapter.py` | the adapter process (the protocol below) |
| `requirements.txt` | `edgepii==0.3.1`, `phonenumbers` and `PyYAML` at exact versions, each with its `--hash` lines |
| `requirements-model.txt` | optional: the full hashed closure of `edgepii[gliner2]==0.3.1`, `gliner2==2.1.0` and a CPU `torch` |
| `PIN.json` | the pin (below) |
| `setup.mjs` | run by a person, never by a test: creates the venv and installs |
| `score.py` | run by a person: scores the samples with `edgepii.eval.score.exact_span_f1` |
| `PROVENANCE.md` | edgepii's version, licence (its wheel's `LICENSE` and `License-Expression: Apache-2.0`), the wheel's hash, each dependency's version, hash and licence, and for the model lane the model's repository, revision and licence as its card states it |
| `README.md` | the adapter, the protocol, setup, a conclusion, a glossary |

A `.gitattributes` line marks `adapters/edgepii/adapter.py` `eol=lf`, so its digest is the same in every checkout.

Tests: `test/ex-pii-guard.test.mjs` (light), `test/pii-facts.test.mjs` (light), `test/pii-adapter-live.test.mjs` (the real adapter, skipped when absent) and `test/after/ex-pii-guard-e2e.test.mjs` (admission and runs). The shared helper is `test/ex-kit.mjs`. For decisions, an escalation and its approval, read `test/after/ex-support-drafts-e2e.test.mjs`; for a policy's decision table through poly-ref, `test/ex-concierge-policy.test.mjs`; for a stored `Content`, `test/after/ex-appointment-booker-e2e.test.mjs` (`rt.putContent`).

## The adapter

`adapters/edgepii/adapter.py`, started as `python adapter.py --preset <name>` (`rules` or `multi-open`). It builds `Locator.preset(name)` once, then reads one JSON request per line on stdin and writes one JSON answer per line on stdout, UTF-8 with `\n` line ends (it reconfigures stdin and stdout so on Windows). Stderr is its log and carries no value.

**At start.** It exits with status 2, before importing edgepii, when `EDGEPII_LOG_TEXT` is set to any value, with the message `EDGEPII_LOG_TEXT is set; the adapter does not log values` on stderr. It sets the logger `edgepii` to `WARNING`.

**Requests and answers.** Every request has `v: 1`, an integer `id` and an `op`; every answer has `v: 1` and the request's `id` (`null` when the request could not be read).

```json
{ "v": 1, "id": 1, "op": "hello" }
{ "v": 1, "id": 1, "ok": true, "edgepii": "0.3.1", "source": "sha256:6613...", "taxonomy": "2026.11", "preset": "rules", "revision": "rules", "detectors": ["rules"] }

{ "v": 1, "id": 2, "op": "locate", "text": "...", "types": ["SECRET", "GOV_ID", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS", "PERSON", "ORG"] }
{ "v": 1, "id": 2, "ok": true, "dropped": 0, "spans": [{ "type": "EMAIL", "start": 41, "end": 58, "detector": "rule", "detectorId": "rules.email" }] }

{ "v": 1, "id": 3, "op": "redact", "text": "...", "types": ["SECRET", "GOV_ID", "PAYMENT", "PERSON", "EMAIL", "PHONE"] }
{ "v": 1, "id": 3, "ok": true, "masked": "...", "redacted": { "EMAIL": 1, "PHONE": 1 }, "recheck": { "dropped": 0, "found": {} } }

{ "v": 1, "id": 4, "ok": false, "error": "malformed-request" }
```

- `hello`: `edgepii` is the installed version; `source` is the digest of edgepii's installed source (below); `taxonomy`, `preset` and `revision` are the `LocateResult`'s; `detectors` is the preset's detector list from `edgepii.presets.PRESETS`.
- `locate`: `Locator.locate(text, types=types)` with every other argument at its default. The answer's spans are sorted by `start`, `end`, `type`; each carries exactly `type`, `start`, `end`, `detector` (`"rule"` when its `detector_id` starts with `rules.`, otherwise `"model"`) and `detectorId`.
- `redact`: locates as above; when the result's `dropped` is above zero, answers `ok: false`, `error: "dropped"`; otherwise masks with `edgepii.redact`, discards the vault at once, and **locates again on the masked text with the same types**. `redacted` counts the masked spans by type; `recheck.dropped` is the second pass's `dropped`, and `recheck.found` counts its spans by type (empty when it found none).
- Errors: a line that is not JSON, or a request without the fields its op needs, or a `types` entry the taxonomy does not hold, is `malformed-request`; an unknown op is `unknown-op`; an exception from edgepii is `edgepii-error` with `kind`, the exception's class name, and never its message.
- **No value crosses.** No answer carries `text`, `raw_label`, `score`, a vault or a quasi row. `masked` crosses only into the redaction decision's stored `Content`.

**The source digest.** For each file under the installed package directory `edgepii/`, `__pycache__` excluded, the line `<path>\0<sha256 of the file, hex>\n`, where `<path>` is relative to the directory that holds `edgepii/`, with `/` separators; the lines sorted by path; the SHA-256 of their concatenation. Over the 32 files of the wheel it is `sha256:66137817a819d6fd751d5c2f0453a4a1cb648dd1bde29b36145da1cff80d65a9`. The venv keeps no wheel, so the source is what the adapter can measure of the code it runs.

**The pin.** `adapters/edgepii/PIN.json`:

```json
{
  "edgepii": "0.3.1",
  "wheel": "sha256:620f9b3c47491e337dc51d2265480625e743563de42e7ff9b324827853e2b52f",
  "source": "sha256:66137817a819d6fd751d5c2f0453a4a1cb648dd1bde29b36145da1cff80d65a9",
  "taxonomy": "2026.11",
  "adapter": "sha256:<the digest of adapter.py, written when it exists>",
  "presets": {
    "rules": { "revision": "rules", "detectors": ["rules"] },
    "multi-open": { "revision": "1cb4166094dc58fa8d836429f060d6c95f62b495", "detectors": ["rules", "gliner2"], "repo": "fastino/gliner2-privacy-filter-PII-multi" }
  }
}
```

The `wheel` is checked at install by `pip install --require-hashes --no-deps -r requirements.txt`; the rest at every start. Any upgrade of edgepii is its own change that reruns the samples and the scores (Q8).

**The venv (Q7).** Outside the repository, shared by the worktrees: `%LOCALAPPDATA%\poly\venvs\edgepii-0.3.1\` on Windows (`$HOME/.local/share/poly/venvs/edgepii-0.3.1/` elsewhere). `node adapters/edgepii/setup.mjs` finds Python 3.11 or later (`py -3.12`, `py -3.11`, then `python3`), creates the venv, installs `requirements.txt`, and with `--model` also `requirements-model.txt` and the model's weights at the pinned revision into the Hugging Face cache it prints. No test writes under the user's home.

## The adapter client (`host/edgepii.mjs`)

- `defaultPython()`: `process.env.POLY_EDGEPII_PYTHON` when set; otherwise the venv's `Scripts\python.exe` on Windows, `bin/python` elsewhere.
- `loadPin(file)`: reads and returns `PIN.json`; throws when a field above is missing.
- `adapterStatus({ python, pin, preset })`: `{ ok: true }`, or `{ ok: false, reason }` where `reason` is the exact skip message. When `python` does not exist: `not run: edgepii 0.3.1 is not installed at <python>; run node adapters/edgepii/setup.mjs`. For the model lane, when the start fails: `not run: the multi-open lane is not installed; run node adapters/edgepii/setup.mjs --model`. When `hello` differs from the pin: `not run: the adapter at <python> does not match adapters/edgepii/PIN.json (<field>)`. A test that needs the adapter calls it first and skips with `reason`.
- `startAdapter({ python, script, pin, preset = 'rules', timeoutMs = 10000 })`: resolves to a client, or rejects with a `FactError` (from `host/facts.mjs`) whose `code` is:
  - `pin-mismatch`, **before any process starts**, when the SHA-256 of `script` (default `adapters/edgepii/adapter.py`) differs from `pin.adapter`; and after `hello` when any of `edgepii`, `source`, `taxonomy`, or the preset's `revision` and `detectors`, differs from the pin;
  - `missing`, when `python` does not exist or the process cannot start;
  - `timeout`, when `hello` does not answer in time.
  It starts the process with `spawn`, no shell, and an environment limited to `SYSTEMROOT` (on Windows), `PYTHONUTF8=1`, `PYTHONDONTWRITEBYTECODE=1`, `HF_HUB_OFFLINE=1`, and `HF_HOME` when set; nothing else of the parent's environment is passed.
- The client is `{ preset, locate(text, types), redact(text, types), close() }`. Each call sends one request and resolves to the answer object. A call rejects with a `FactError`: `timeout` after `timeoutMs` (the process is then killed, and every later call is `missing`); `not-ok` for an answer with `ok: false`; `malformed` for a line that is not JSON, or an answer whose `v` is not `1` or whose `id` is not the request's; `missing` when the process has exited.

## The fact table (`host/facts.mjs`, `host/facts.json`)

The program declares `enum Presence { Absent, Found, NotRuledOut }`. The host's record `Findings` holds one `Presence` per type, in these fields (it is not a type of the program, A1):

```
{ secret, govId, payment, email, phone, ip, person, org }
```

`host/facts.json`:

```json
{
  "taxonomy": "2026.11",
  "fields": { "SECRET": "secret", "GOV_ID": "govId", "PAYMENT": "payment", "EMAIL": "email",
              "PHONE": "phone", "IP_ADDRESS": "ip", "PERSON": "person", "ORG": "org" },
  "ruledOut": { "rules": ["SECRET", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS"],
                "multi-open": ["SECRET", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS"] }
}
```

`ruledOut[preset]` lists the types whose absence the preset's rules establish. `GOV_ID`, `PERSON` and `ORG` are in neither list: no rule finds them, and a model's silence is not proof.

`factsOf(answer, table, preset)` returns a `Findings` object (one field per type, as in the record above, which is the host's and not the program's), or throws a `FactError` (an `Error` with a string `code`):

| Condition, checked in this order | `code` |
|---|---|
| `answer` is not an object, or `ok !== true` | `not-ok` |
| a top-level key outside `v`, `id`, `ok`, `dropped`, `spans`; `dropped` not an integer of at least 0; `spans` not an array; a span with a key outside `type`, `start`, `end`, `detector`, `detectorId`; `start` or `end` not an integer with `0 <= start < end`; `detector` not `"rule"` or `"model"` | `malformed` |
| a span whose `type` is not a key of `table.fields` | `unknown-type` |
| `dropped > 0` | `dropped` |
| `preset` not a key of `table.ruledOut` | `unknown-preset` |

Otherwise, for each type of `table.fields`: `Found` when some span has that type; else `Absent` when the type is in `table.ruledOut[preset]`; else `NotRuledOut`. So a span that carries `text` or `raw_label` is `malformed` (PG3), and a type a model finds, or that no rule of the preset can find, is never `Absent` (PG6). A dropped span fails the scan rather than being mapped to `NotRuledOut`, since it may hide a rule type that would otherwise read `Absent` and that nothing would redact.

`loadTable(file)` reads the table and throws when `fields` or `ruledOut` is missing.

**The exposure.** The program reads two facts, not eight (see the amendments). `exposureOf(findings)` (exported by `host/providers.mjs`) joins the fields of each group into one `Presence`: `sensitive` from `secret`, `govId` and `payment`; `personal` from `person`, `email` and `phone`. A group is `Found` when one of its fields is `Found`; else `NotRuledOut` when one is `NotRuledOut`; else `Absent`. `ip` and `org` are in no group. So a group is `Absent` only when every type of it was ruled out, and under `rules` neither group is ever `Absent`, since `govId` and `person` never are.

```poly
type Exposure = { sensitive: Presence, personal: Presence }
```

## Machine

`audience { public < personal }`. The host stores each document and each address with `rt.putContent(body)`, which takes no class: the body enters with the bottom taint, and declaring an audience is what makes the runtime keep that taint record, without which a decision over the body fails closed (PS17.4, S302).

One `machine Outbound` in module `pii`, one instance per document. Enums: `Target { Model, Mail }`, `Presence { Absent, Found, NotRuledOut }`, `Scan { Pending, Done, Failed }`, `Redaction { None, Redacting, Verified, RedactFailed }`, `Recipient { Unchecked, Known, New }`, `Phase { Empty, Open, Sending, Sent, Uncertain }`. The type `Exposure` as above.

State: `phase` (`Empty`), `target` (`Model`), `scan` (`Pending`), `sensitive`, `personal : Presence` (each `NotRuledOut`, so nothing reads as absent before a scan), `redaction` (`None`), `recipient` (`Unchecked`), `held : bool` (`false`), `doc`, `to : Content` (none). `doc` is the document to send: the draft, then its verified redaction. `terminal phase in { Sent, Uncertain }`. The eight types are in the scan decision's record (its provider's `Findings`), not in the state.

- `DraftModel(body: Content)`: `"drafted"` unless `Empty`. Goes to `Open` with `target` `Model`, sets `doc` to `body`, issues `decide scan(doc: body)`.
- `DraftMail(body: Content, address: Content)`: `"drafted"` unless `Empty`. Goes to `Open` with `target` `Mail`, sets `doc` to `body` and `to` to `address`, issues `decide scan(doc: body)` and `decide recipient(to: address)`.
- `Scanned(sensitiveIs, personalIs: Presence)`: `"not-scanning"` unless `Open` with `scan == Pending`. Sets `scan` to `Done` and the two facts. When `sensitiveIs` is not `Absent`, or the target is `Model` and `personalIs` is not `Absent`: sets `redaction` to `Redacting` and issues `decide redact(doc: doc, target: target)`.
- `ScanFailed()`: `"not-scanning"` unless `Open` with `scan == Pending`. Sets `scan` to `Failed`.
- `Redacted(text: Content)`: `"not-redacting"` unless `redaction == Redacting`. Sets `doc` to `text` and `redaction` to `Verified`.
- `Unredacted()`: `"not-redacting"` unless `redaction == Redacting`. Sets `redaction` to `RedactFailed`.
- `Checked(who: Recipient)`: `"not-checking"` unless the target is `Mail` and `recipient == Unchecked`. Sets `recipient` to `Known` when `who == Known`, otherwise to `New` (an answer `Unchecked` is read as new).
- `CheckFailed()`: same guard. Sets `recipient` to `New`: an unknown recipient is new (Q6).
- `Send()`: `"not-open"` unless `Open`. Then, **with an `if` and no `require`**, so that a `Send` from a state that may not send is accepted and sends nothing (which is what makes each `never` below tested, PS5.2a):
  - target `Model`: when `scan == Done` and either `redaction == Verified`, or `redaction == None` and `sensitive` and `personal` are both `Absent`: goes to `Sending`, sets `held` to `false` and emits `callModel(text: doc)`;
  - target `Mail`: when `scan == Done`, `recipient != Unchecked`, and either `redaction == Verified`, or `redaction == None` and `sensitive` is `Absent`: goes to `Sending`, sets `held` to `false` and emits `sendMail(text: doc, to: to)`;
  - otherwise sets `held` to `true` and stays `Open`. A handler path with no write, no effect and no rejection is `PL2201 SILENT_NOOP` (PT4.4), so the held `Send` writes `held`.
- `Delivered()`: `"not-sending"` unless `Sending`; `Sent`. `NotDelivered()`: same guard; back to `Open`. `DeliveryUncertain()`: same guard; `Uncertain` (a person looks).

## Decisions and effects

- `decision scan(doc: Content) -> Exposure`: provider `"edgepii"`, labels `read:private` (the detector is local: no egress label), timeout 30s; `ok(r)` to `Scanned(sensitiveIs: r.answer.sensitive, personalIs: r.answer.personal)`; `failed` to `ScanFailed()`.
- `decision redact(doc: Content, target: Target) -> Content`: provider `"edgepii"`, labels `read:private`, timeout 30s; `ok(r)` to `Redacted(text: r.answer)`; `failed` to `Unredacted()`.
- `decision recipient(to: Content) -> Recipient`: provider `"recipients"`, labels `read:private`, timeout 2s; `ok(r)` to `Checked(who: r.answer)`; `failed` to `CheckFailed()`.
- `effect callModel(text: Content)`: kind `"model.call"`, labels `egress:external, read:private`, target the exact URL `https://model.example/v1/complete`, class `irreversible`, retry `attempts 1, base 200ms, timeout 30s`; `ok` to `Delivered`, `failed` to `NotDelivered`, `exhausted` to `DeliveryUncertain`.
- `effect sendMail(text: Content, to: Content)`: kind `"mail.send"`, labels `egress:external, read:private`, target `https://mail.example/v1/send`, class `irreversible`, the same retry and completions.

**No confidence is relied on (Q2).** The `rules` preset is deterministic and needs no calibration: the scan provider answers one `Exposure` with probability 1, uncalibrated (PD1.6c), and no handler reads `r.conf` or `r.margin`. A type that a model detects is never `Absent` (the fact table), so a model's confidence never lowers what the policy requires. No completion of a decision emits an effect (the sends come from `Send`), so the decisions stage has nothing to gate (`PL6201` is judged on the completion step, S75). The decisions carry no egress label, so polycheck's regions do not reach them and the policy needs no rule naming them (`PL7001` is not expected).

## Properties

Eight `never` statements (PS5.2a), one per property and effect:

| Name | Statement |
|---|---|
| `no-sensitive-model` | `never no-sensitive-model: emit callModel() while sensitive != Absent && redaction != Verified` |
| `no-sensitive-mail` | the same with `sendMail()` |
| `no-unscanned-model` | `never no-unscanned-model: emit callModel() while scan != Done` |
| `no-unscanned-mail` | the same with `sendMail()` |
| `no-unverified-model` | `never no-unverified-model: emit callModel() while redaction == RedactFailed` |
| `no-unverified-mail` | the same with `sendMail()` |
| `model-redacted` | `never model-redacted: emit callModel() while personal != Absent && redaction != Verified` |
| `mail-recipient-checked` | `never mail-recipient-checked: emit sendMail() while recipient == Unchecked` |

Each is **tested**, not vacuous: `Send` is accepted from `Open` whatever the facts, and `Open` is reachable with `scan == Pending`, with a sensitive fact while `Redacting`, with `RedactFailed`, with a personal fact `NotRuledOut` (the initial value), and with `recipient == Unchecked`. The program and its policy check `CLEAN`, with deadlock freedom. The instance is printed; its state count is measured when the code exists and recorded in the amendments.

**Which property is proved where.**

| Property of the brief | Held by |
|---|---|
| No path sends a SECRET, GOV_ID or PAYMENT **that was found, or not ruled out**, without a verified redaction | `no-sensitive-model` and `no-sensitive-mail` at check time; `sensitive-redacted` at run time |
| An unknown or failed detector result never leads to a send | `no-unscanned-*` and `no-unverified-*`; the policy's `scan == Done` and `on unknown deny` |
| A model is not given a name, email or phone number not ruled out, unredacted | `model-redacted`; the policy's `model-redacted` |
| A new external recipient always gets a person's approval | the policy's `new-recipient-approved` (escalate) and the end-to-end test (Q5); `mail-recipient-checked` keeps a mail from going out before the recipient is known |

## Policy

Policy `outbound`, scope `"pii"`, in module `pii_policy`. Each rule is guarded by `proposal.kind == "effect"`. `M` below stands for `machine("pii.Outbound")`, written out in full in the file.

- `sensitive-redacted` "No SECRET, GOV_ID or PAYMENT leaves unredacted.": for `effect.kind in { "model.call", "mail.send" }`, `require M.scan == Done && (M.redaction == Verified || M.sensitive == Absent) else deny`, `on unknown deny`.
- `model-redacted` "A name, email or phone number is redacted before an external model sees it.": for `effect.kind == "model.call"`, `require M.redaction == Verified || M.personal == Absent else deny`, `on unknown deny`.
- `new-recipient-approved` "A new external recipient gets nothing until a person approves.": for `effect.kind == "mail.send" && M.recipient == New`, `require false else escalate`, `on unknown escalate`.

The policy is signed as a person signs it. The risk tags (`mitigates "mit:2.1"`, `implements "nist:MEASURE-2.10"` on the first two, `implements "nist:MAP-3.5"` on the third) and the project's `exposure: { "risks": ["mit:2.1", "mit:2.2"] }` are added when `risk-tags` is merged, by an amendment to this page; until then the policy is the same without them.

`govId` is never `Absent` at run time under either preset, so neither is `sensitive`, and `person` never is under `rules`, so neither is `personal`: **every send at run time goes through a verified redaction**. The unredacted branches of `Send` and of the two rules are reached only in the check's over-approximation, and by a future preset that has a GOV_ID rule. They are kept so that the program states the rule and not the limit of today's detector.

## Host code

**Providers (`host/providers.mjs`).**

- `SCAN_TYPES` is `["SECRET", "GOV_ID", "PAYMENT", "EMAIL", "PHONE", "IP_ADDRESS", "PERSON", "ORG"]`.
- `redactTypes(target)`: `"Mail"` gives `["SECRET", "GOV_ID", "PAYMENT"]`; `"Model"` gives those and `"PERSON", "EMAIL", "PHONE"`; anything else throws.
- `exposureOf(findings)`: the join above.
- `scanProvider(client, table)` returns a provider `(question, materials)`: it reads `materials.bodies.doc` (none throws), calls `client.locate(body, SCAN_TYPES)`, maps the answer with `exposureOf(factsOf(answer, table, client.preset))`, and returns `{ answer: exposure, distribution: [[exposure, 1]], usage: {}, reported: "edgepii-0.3.1/<preset>", latencyMs }`. Any throw fails the decision, so the machine takes `ScanFailed`.
- `redactProvider(client)`: reads `materials.bodies.doc` and `question.payload.target` (an enum argument reaches the provider as its variant's name, `"Model"` or `"Mail"`, as the concierge's `outcome` does in `examples/concierge/host/recorded.mjs`), calls `client.redact(body, redactTypes(target))`, and checks the answer itself, never trusting `ok` alone: top-level keys exactly `v`, `id`, `ok`, `masked`, `redacted`, `recheck`; `masked` a string; `redacted` an object whose keys are types of `redactTypes(target)` and whose values are integers of at least 1; `recheck.dropped === 0`; `recheck.found` an object with no key. Anything else throws a `FactError` (`recheck` for a non-empty `found` or a `dropped` above zero, `malformed` for the rest). It returns `{ answer: masked, distribution: [[masked, 1]], usage: {}, reported: "edgepii-0.3.1/<preset>", latencyMs }`. The runtime stores `masked` as the decision's `Content`, with the join of the taints it read (Q9: not lowered).
- `recipientProvider(recipients)`: reads `materials.bodies.to` and answers `"Known"` when `recipients.has(body)`, otherwise `"New"`.
- `provideGuard(rt, { client, table, recipients })`: registers the three with `rt.provide`: `scan` and `redact` with model `edgepii-0.3.1/<preset>`, `recipient` with model `recipients`, none with a calibration map.

**Recipients (`host/recipients.mjs`, Q6).** `recipientTable(key, digests = [])` returns `{ has(address), add(address), digests() }`. An address is held only as the lowercase hex HMAC-SHA256, under `key`, of the address trimmed and lowercased; `digests()` lists them sorted, for a host to keep. An approved send adds its recipient: the host calls `add` when a mail to a `New` recipient is `Sent`.

**Handlers (`host/handlers.ts`)**, with a type-only import from `../.poly/build/pii.Outbound/types.js`:

- `callModel(payload, caps, ctx)`: reads the text with `caps.content.read(payload.text)` (none throws with `permanent: true`) and posts `{ input: <text> }` through `caps.egress.post` to `https://model.example/v1/complete` with the header `idempotency-key` set to `ctx.idempotencyKey`.
- `sendMail(payload, caps, ctx)`: reads `payload.text` and `payload.to` the same way and posts `{ to: <address>, body: <text> }` to `https://mail.example/v1/send` with the same header.
- Both: status 200 or 201 returns `{ ok: true }`; a status from 400 to 499 other than 429 throws with `permanent: true`; any other status or a transport error throws with `ambiguous: true`, which, with one attempt, is delivered as exhausted.

## Recorded answers, samples and scores

**Samples.** Synthetic text only, written for the example: no real person, number or address. `samples/` holds at least `en-model.txt` (a name, an email and a phone number, for a model call), `en-mail.txt` (a password and a card, for a mail), `en-ids.txt` (a US SSN and an IBAN, written once compact and once with spaces), `fr-model.txt` (a name, an email, a phone number in its national and its international form), `fr-mail.txt` (an IBAN and a NIR), and `clean.txt` (no personal data). Card numbers are test numbers that pass Luhn; IBANs are published example IBANs that pass MOD-97; an SSN uses an area number the SSA never issues (900 to 999); a NIR is synthetic; phone numbers come from a range reserved for fiction where one exists. `samples/gold.json` is `{ "<file>": { "lang": "en" | "fr", "spans": [{ "type", "start", "end" }] } }`, with every personal value of the file, including those the `rules` preset cannot find (the SSN, the NIR, the names), so the scores show the limit instead of hiding it.

**Recorded answers.** `recorded/answers.json` is `{ "hello": <hello answer>, "documents": [{ "file": "<sample file>", "locate": <locate answer>, "redact": [{ "types": [...], "answer": <redact answer> }] }] }`: one `locate` per sample with `SCAN_TYPES`, and one `redact` per target's `redactTypes`. It is written by `node examples/pii-guard/host/record.mjs` from the live adapter with the `rules` preset, so it holds what the real adapter answered, and it holds no span text (the masked texts are of synthetic samples).

**The recorded adapter.** `recordedAdapter(fixture, { preset = 'rules', samplesDir, fault, hold = false } = {})` returns a client with the interface of `startAdapter`'s, a `calls` array of `{ op, types }` (never a text), and `release()`. With `hold`, each `redact` call stays pending until the test calls `release()`, which settles every held call with its answer; `locate` is never held. This is how a test keeps the redaction in flight while the scan and the recipient complete. It answers `locate` and `redact` for a text equal to a sample file's content, from that file's entry (for `redact`, the entry whose `types` equal the request's), and rejects with `FactError` `missing` for any other text. `fault` changes every answer:

| `fault` | Effect |
|---|---|
| `missing` | every call rejects `missing` |
| `timeout` | every call rejects `timeout` |
| `not-ok` | every call rejects `not-ok` |
| `malformed` | a `locate` answer without `spans` |
| `text` | each span of a `locate` answer also carries `text: "x"` |
| `unknown-type` | a `locate` answer with one more span of type `USERNAME` |
| `dropped` | a `locate` answer with `dropped: 1` |
| `recheck-found` | a `redact` answer whose `recheck.found` is `{ "EMAIL": 1 }` |
| `recheck-dropped` | a `redact` answer whose `recheck.dropped` is `1` |

**Scores.** `adapters/edgepii/score.py --preset <name>` scores each sample against its gold with `exact_span_f1` and prints, per language and per type, the precision, recall and F1. The README records the table for `rules`, and for `multi-open` when installed, with the date, edgepii's version and the preset's revision. Whether edgepii handles French is answered by those numbers. Expected from the rules, and measured rather than asserted: `GOV_ID` recall 0 under `rules` in both languages; an IBAN with spaces and a French phone number in national form not found.

## Seeded defect

`pii-guard-defect.poly` is the program whose `Send`, for the target `Mail`, requires `redaction != RedactFailed` where the program requires `redaction == Verified` (or `None` with nothing sensitive): the author checked that the redaction did not fail, and forgot that it may not have finished. A mail can then go out while its redaction is `Redacting`. The check rejects it with exactly one code, **`PL3002 STEP_PROPERTY`**, naming `no-sensitive-mail`, and no other property. Predicted witness: 4 steps, `DraftMail`, a completion of `recipient`, a `Scanned` with a sensitive fact, and `Send`, the completions in the order the check chooses; the last step emits `sendMail`. The amendments record the measured witness. The finding is the machine's: the policy does not change what the machine can emit. At run time the gate denies that send (end-to-end test).

## What the tests must show

Light test (`test/ex-pii-guard.test.mjs`):

- the program with its policy is `CLEAN`; the instance is printed; the program declares exactly the eight `never` statements of the table above, by name, and the report's `vacuous` and `notRun` lists name none of them (the report has no list of tested properties, so a property is tested when it is declared, the verdict is `CLEAN` and it is in neither list, PT12.3);
- the defect is `FINDINGS` with exactly `PL3002`, `no-sensitive-mail` named and no other property, and a witness whose last step is `Send`;
- the policy through poly-ref's decision table: `model.call` with `scan` `Done` and `redaction` `Verified` is allowed; with `scan` `Pending` or `Failed`, denied by `sensitive-redacted`; with `sensitive` `Found` and `redaction` `None` or `Redacting`, denied; with `sensitive` `NotRuledOut` and `redaction` not `Verified`, denied; with both facts `Absent`, `scan` `Done` and `redaction` `None`, allowed; with `personal` `NotRuledOut`, `sensitive` `Absent` and `redaction` `None`, denied by `model-redacted`; `mail.send` with `recipient` `New` and the send otherwise allowed is escalated by `new-recipient-approved`, and with `Known` allowed;
- `poly check --host` is `CLEAN`, and a handler with a wrong field is `PL6836`;
- the handlers: 201 ok; 422 permanent; 503 ambiguous and not permanent; header and body as above.

Facts test (`test/pii-facts.test.mjs`), with no Python:

- `factsOf` on recorded answers: a span of each type gives `Found`; no span gives `Absent` for the five rule types and `NotRuledOut` for `GOV_ID`, `PERSON` and `ORG`; a span found by a model of a rule type gives `Found`; each row of the error table gives its `code`, including a span with `text` or `raw_label`;
- `exposureOf`: each group `Found` when one field is, else `NotRuledOut` when one is, else `Absent`; `ip` and `org` change nothing;
- `scanProvider` over `recordedAdapter` answers the exposure of the recorded findings for each sample (under `rules`, neither fact is ever `Absent`), fails for each `fault` but `recheck-found` and `recheck-dropped`, and answers the same under those two, which change only a `redact` answer; `redactProvider` answers the masked text, fails for `recheck-found`, `recheck-dropped` and each failing call, and is given `redactTypes` of the payload's target;
- `startAdapter` with a `pin.adapter` that differs from the script's digest rejects `pin-mismatch` and starts no process; with a `python` that does not exist, `missing`;
- `recipientTable`: `has` after `add`, case and surrounding space ignored; `digests()` holds no address; two keys give different digests;
- `adapterStatus` with a missing `python` gives the exact skip message.

Live test (`test/pii-adapter-live.test.mjs`), skipped with `adapterStatus`'s `reason` when the adapter is absent: `hello` matches the pin; for each sample, the live `locate` and `redact` answers equal the recorded ones; no answer holds a key outside the protocol; the adapter started with `EDGEPII_LOG_TEXT=1` exits with status 2 and answers nothing; a malformed line answers `malformed-request` and the adapter keeps serving.

End-to-end test (`test/after/ex-pii-guard-e2e.test.mjs`, serial), over the recorded adapter, a recorded egress (`recordingEgress`) and `rt.putContent` for documents. Completions are dispatched by the runtime, never by hand.

- **model call, redacted:** `DraftModel` over `en-model.txt`, then `Send`: the scan finds the email and the phone, the redaction is verified, one POST to the model whose body holds `<EMAIL_1>` and `<PHONE_1>` and neither the sample's email nor its phone number; `Sent`. The sample's name is still in the body: `rules` finds no `PERSON`, so the redaction cannot mask it, and the test asserts that it is there, as the README's limits state;
- **mail with a secret, known recipient:** the recipient added to the table first; `DraftMail` over `en-mail.txt`, `Send`: the body holds `<SECRET>`, no escalation; `Sent`;
- **a send before the redaction finishes:** the recorded adapter with `hold`; once the scan has completed and the instance is `Redacting`, `Send` is accepted, nothing is posted, the instance is `Open`; after `release()` and `Redacted`, `Send` posts the masked text;
- **the gate refuses, then allows:** the defect program admitted with the program's policy, the recorded adapter with `hold`, a known recipient; `Send` for a mail while `Redacting` emits `sendMail`, which the gate denies (a `verdict` event with `outcome: "denied"` for `mail.send`; the worker delivers a denied effect's `failed` completion), so nothing is posted and `NotDelivered` returns the instance to `Open`; after `release()` and `Redacted`, `Send` posts the masked text;
- **a failed re-check:** with `recheck-found`, then with `recheck-dropped`: `RedactFailed`, `Send` posts nothing;
- **a failed scan:** with `missing`, then with `dropped`: `scan` `Failed`, `Send` posts nothing;
- **a new recipient:** `DraftMail` to an address not in the table, `Send`: escalated, nothing posted; the person's signed approval (`approvalFor`, `rt.approve`) releases it, one POST; `Sent`; the host adds the recipient; a second instance to the same address is `Known` and not escalated; a recipient decision that fails gives `New` and an escalation;
- **no value in the journal:** for every run above, the JSON of `rt.chain(id)` holds no value that the gold marks in the samples used, and no recipient address;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`);
- **the real adapter:** one model call over `en-model.txt` with `startAdapter`, skipped with `adapterStatus`'s `reason` when absent.

Run only these files and the ones a change touches; the full suite only at the owner's word, with nothing else heavy alongside.

## Acceptance criteria

- **PG1** The example checks `CLEAN`, and its eight `never` statements hold and are tested.
- **PG2** The defect gives `PL3002` naming `no-sensitive-mail`, and no other property, with a witness.
- **PG3** The adapter's answers carry no span text, raw label, score or vault value; the host refuses an answer that carries any key outside the protocol.
- **PG4** An `adapter.py` whose digest differs from the pin is refused before it starts, and a `hello` that differs from the pin makes the adapter unusable, so every scan fails.
- **PG5** Each scan failure (missing, timeout, `ok: false`, malformed, unknown type, `dropped > 0`) ends in `scan == Failed` and no send.
- **PG6** A type that a model finds, or that no rule of the preset can find, is `Found` or `NotRuledOut`, never `Absent`.
- **PG7** A SECRET, GOV_ID or PAYMENT that was found, or not ruled out, is never sent without a verified redaction, by the machine at check time and by the policy at run time.
- **PG8** A model call with a name, email or phone number not ruled out is redacted first.
- **PG9** A redaction whose second pass finds a redacted type, or drops a span, ends in `RedactFailed` and no send.
- **PG10** A new recipient's mail is escalated and sent only after a person approves, and the recipient is then known.
- **PG11** No body, span text or vault value is in the journal; the original and the masked text are only in the content store, as `Content`.
- **PG12** The live adapter's answers equal the recorded ones for every sample, and the live tests skip with their message when it is absent.
- **PG13** The README's English and French scores are those `score.py` prints on the samples, with the versions, the revision and the date.
- **PG14** With `risk-tags` merged, `poly report risks` on the example's kept store counts its three rules under `mit:2.1` and lists `mit:2.2` as exposed and not covered.
- **PG15** The README's limits begin with GOV_ID: edgepii 0.3.1 ships no GOV_ID pattern, so under `rules` a national id is never found and a verified redaction does not mask it; the measured `GOV_ID` recall of 0 is shown beside it. The second limit is names: under `rules` no `PERSON` is found, so a name reaches the model inside the verified, masked text.

## Differences from the plan

- **GOV_ID (Q4):** edgepii 0.3.1 has no opt-in pattern to enable, so the adapter has no GOV_ID configuration and the limit is kept, first in the README.
- **The state holds two facts, not eight:** `sensitive` and `personal`, each the join of three types; the eight stay in the decision's record. See the amendments.
- **`Redaction` gains `Redacting`, and `Recipient` gains `Unchecked`,** with the property `mail-recipient-checked`, so a mail cannot go out before its recipient is known. The plan's `Redaction { None, Verified, Failed }` and its `RedactFailed` are made one: `RedactFailed`. Each property of the plan is two `never` statements, one per effect, since a `never` names an effect the machine declares.
- **The redaction is issued by `Scanned`** when the facts call for it, not by a separate action.
- **`hello` reports the source digest, not the wheel's hash,** since the venv keeps no wheel; the wheel's hash is checked at install.
- **The placeholders are `<EMAIL_1>` and `<SECRET>`**, as edgepii writes them, not `[EMAIL_1]`.
- **The redaction's counts per type are checked by the provider and not journaled:** a provider's answer has no field for them, and the decision event holds the masked text's digest.
- **No unredacted send at run time:** the plan's "clean model call" is reached only in the check; the end-to-end test redacts every send.
- **The policy is named `outbound`**, not `pii-out`.

## Amendments made when the code existed

**A1 (2026-11-05), measured on the first draft of the program, before the tests were committed.** The body of this page already reads as amended; the change and its reasons are here.

- **Two facts, not six.** With six `Presence` facts in the state, `Scanned` has 3^6 = 729 labels per state. `poly check` on that program ran out of its 4 GB heap after two minutes, still in its first stages; with `out` removed it was still running at 150 seconds. With the two joined facts `sensitive` and `personal`, the program and its policy check `CLEAN` with 5,206 states. The properties are the same ones: each `never` and rule read the three types of a group joined by `||`, and the join reads them the same way. The host's fact table keeps all eight types (`factsOf` is unchanged), and `exposureOf` is the one new host function.
- **`out` removed.** A `Content` field adds a representative to every `Content` domain (PS4.1f). `Redacted` sets `doc` to the masked text, and both sends carry `doc`.
- **`held`.** A `Send` that may not send was to be "accepted and do nothing". A handler path with no write, no effect and no rejection is `PL2201 SILENT_NOOP` (PT4.4), and the check refused the program at stage 0. The held `Send` sets `held` to `true`.
- **The action parameters are `body` and `address`.** `DraftModel(doc)` and `DraftMail(doc, to)` were named after the fields they set, which shadows them (S19, a warning that becomes `PL1002` after v1). The decisions' parameters keep the names `doc` and `to`, so the providers still read `materials.bodies.doc` and `materials.bodies.to`.

Measured on the amended program, with `checkExample` as the light test runs it: the program with its policy is `CLEAN`, 5,206 states, 4 `Content` representatives and none, nothing vacuous and nothing not run, the policy `CLEAN`. The defect is `FINDINGS`: exactly `PL3002` on `no-sensitive-mail`, 7,006 states, the policy `CLEAN`, with the witness predicted above in this order: `DraftMail`, `Scanned`, `Checked`, `Send` (4 steps).

## Conclusion

The guard changes nothing in poly's language or runtime. A pinned local process answers in types and offsets, the host turns that answer into a finite record of facts, and the machine and its policy decide from those facts, failing closed on anything the host cannot read. What edgepii cannot find is the guard's limit, and this page states it first: edgepii 0.3.1 ships no national id pattern, and its `rules` preset sees no name, so the program treats both as present, every send is redacted, and the README measures in English and French how much a redaction masks.

## Glossary

- **edgepii:** an Apache-2.0 Python library that returns exact character spans of personal data, found by rules and checksums or by a model.
- **Adapter:** the Python process `adapters/edgepii/adapter.py`, speaking JSON lines over stdin and stdout; host code, not a certified poly adapter (Q1).
- **Span:** a type and a half-open range `[start, end)` of code points on the source text.
- **Dropped span:** a span whose offsets failed edgepii's slice check; counted, never repaired, and a reason to fail.
- **Fact table:** the host's map from a `locate` answer to the record `Findings`, one `Presence` per type.
- **Exposure:** the two facts the program reads, `sensitive` and `personal`, each the join of three of the `Findings`.
- **NotRuledOut:** a type not found, that a model finds or no rule of the preset can find; treated as present.
- **Redaction contract:** after masking, a second detector pass with the same types finds nothing and drops nothing.
- **Source digest:** the digest of edgepii's installed files, which the adapter reports and the pin holds.
- **Fail closed:** any failure to obtain or read the facts ends in no send.
