# Audit of poly mine: PT30, PS20 mining-side clauses

Independent audit of test coverage for `poly mine`, its seam to polyx, and synthetic-corpus refusals (rule 7a).

Auditor: Claude Code  
Date: 2026-10-12 (corrected)  
Against: PS20.1, PS20.2, PS20.5; PT30.1-PT30.3, PT30.9-PT30.11  
Test files: `test/mine-port.test.mjs`, `test/polyx-seam.test.mjs`, `test/synthetic-refusal.test.mjs`, `test/boundaries-mine.test.mjs`, `test/mine.test.mjs`, `test/adjudicate-cli.test.mjs`

**CORRECTION**: Real polyx tests in `mine.test.mjs:470+` ("real-polyx" tests) assert PT30.9 exact source texts and PT30.2 port structure including rejected steps, gate denial, unknown consequence, and gapped episodes. Earlier version of this audit mistakenly marked these as untested.

## Clause-by-clause audit table

| Clause | Requirement | Tested? | Where | Status | Notes |
|--------|-------------|---------|-------|--------|-------|
| PS20.1 | Candidate has digest (SHA-256 of canonical form without digest field) | Not tested | — | **WEAK** | Candidates file is asserted only for `kind: "poly.candidates"`. No test verifies the digest computation itself or that changing a candidate changes its digest. |
| PS20.2, `before("Y", "X")` | Path property promotable from `X-implies-prior-Y` pattern | Tested | `mine.test.mjs:470 real-polyx` | PASS | Real polyx test asserts exact source matches regex `/^path property mined-r[0-9a-f]{16}: before\("stock\.reserve", "payment\.charge"\)$/`. |
| PS20.2, `count("X") <= 1` | Path property promotable from `at-most-one-X` pattern | Tested | `mine.test.mjs:470 real-polyx` | PASS | Real polyx test includes suppressed count rules in --all output. |
| PS20.2, eligibility rule obligation | Rule obligation over `machine("M").f in A` promotable from `no-X-unless-state` | Tested | `mine.test.mjs:470 real-polyx` | WEAK | Real polyx test asserts source matches regex with `machine("orders.Order").status in { Reserving } else deny / on unknown escalate`, but does not test enum value rendering (bare) vs checked string rendering (quoted) or integer rendering. |
| PS20.2, unpromtable patterns | `exactly-one-Y-per-X`, `no-X-without-prior-Y-same-S` not promotable; candidate lists pattern and reason | Tested | `mine.test.mjs:470 real-polyx` | PASS | Real polyx test asserts `no.map(pattern).sort() == ['exactly-one-Y-per-X', 'no-X-without-prior-Y-same-S']` and `x.reason.includes(x.pattern)`. |
| PS20.3 | Adjudication is person's verdict: `real`, `spurious`, `defer`; signed record; agent key refused | Tested | `adjudicate-cli.test.mjs` A5 (agent key refusal), A3 (verdict narrowed refused), multiple verdict tests | PASS | Tests cover agent key refusal and verdict values. Record signing is tested as "the command signs". |
| PS20.3 | Only `real` proceeds; `spurious`/`defer` reach no program | Tested | `synthetic-refusal.test.mjs` (spurious verdict passes), `adjudicate-cli.test.mjs` (verdict validation) | WEAK | `synthetic-refusal.test.mjs` tests promote with spurious and checks the project is unchanged. No test in mine or adjudicate alone asserts that a spurious verdict stops promotion. The promotion refusal is tested, but the adjudication verdict's role is not isolated. |
| PS20.5 | Synthetic corpus refused by `mine --synthetic` for non-test project | Tested | `synthetic-refusal.test.mjs` | PASS | Positive control (`--synthetic` on test project succeeds) and refusal on non-test project (anchorSource 'user'). |
| PS20.5 | `promote` refuses synthetic corpus for non-test project; sources unchanged | Tested | `synthetic-refusal.test.mjs` | PASS | Snapshot before and after, both refusals. |
| PS20.5 | Admission refuses synthetic promotion under non-test certificate | Not tested in isolation | `synthetic-refusal.test.mjs` uses API call; no CLI test | **WEAK** | The test uses the `readPromotions` API, not the CLI `poly admit`. The spec says admission refuses it (PT30.6). No CLI test asserts the PL6512 code or that the project is as it was. |
| PT30.1 | `poly mine --traces --project --polyx --out` with optional `--synthetic` and `--all` | Tested | `mine.test.mjs` S1 (positive control, all required args); S1 tests each missing arg exit 64 | PASS | All required and optional flags tested; usage errors covered. |
| PT30.1 | Mining refuses when polyx would (`annotate` never invoked; no POLYX_JEV_KEY in environment) | Tested | `mine.test.mjs` S2 (POLYX_JEV_KEY not in environment); `polyx-seam.test.mjs` (environment allowlist) | PASS | S2 explicitly verifies that POLYX_JEV_KEY set in parent process does not reach polyx. |
| PT30.1 | `--polyx` is directory of polyx checkout; candidates' source written against project types | Tested | `mine.test.mjs` (positive control); `mine-port.test.mjs` (port correctness) | WEAK | Test asserts the command succeeds and candidates file exists. No test asserts that enum values are constructor names (bare) or checked strings are quoted, or that types are read from the project. The port test asserts the turn structure, not type rendering. |
| PT30.2 | Port: one polyx interaction per episode; operator fixed word `poly` | Tested | `mine-port.test.mjs` | PASS | Asserts `corpus.interactions.length == 18` and `every i.operator === 'poly'`. |
| PT30.2 | Port: per step other than creation, state before, action or effect, state after, effects in order | Tested | `mine-port.test.mjs` | PASS | Detailed assertion of turn order: state, action/effect, state, effects. |
| PT30.2 | Creation row left out of mining | Tested | `mine-port.test.mjs` | PASS | "The first step (Reserve): pre-state, post-state, then its effect; no turn for $create." |
| PT30.2 | Rejected step has `result: refused`; gate-denied effect has `result: refused` | Tested | `mine-port.test.mjs:118` | PASS | Modified shop corpus with rejected step (ep0) and gate-denied effect (ep1) asserts `result === 'refused'` on both turns. |
| PT30.2 | Alphabet written from trace: action event types `act-M.A` with `identity: [run]`; effect types `fx-kind` with `identity: [run]` | Tested | `mine-port.test.mjs:105` | PASS | Asserts alphabet contains required type names and `identity: [run]` fields. |
| PT30.2 | State system type with `identity: [run]`, `state: [<fields>]` | Tested | `mine-port.test.mjs:105` | PASS | Asserts alphabet matches `/identity: \[run\]/` and `/state: \[status\]/` on state type. |
| PT30.2 | Consequence is trace consequence; `unknown` written as `none` | Tested | `mine-port.test.mjs:118` | PASS | Sets consequence to 'unknown' in trace, asserts `!alphabet.includes('unknown')` (written as none). |
| PT30.2 | Gapped episode left out, counted in header | Tested | `mine-port.test.mjs:118` | PASS | Sets ep[3].gapped = true; asserts `gappedLeftOut == 1`, `episodes == 17` (18 - 1), `interactions.length == 17`. |
| PT30.3 | Candidates file: one JSON document with `v: 1`, `kind: "poly.candidates"` | Tested | `mine.test.mjs` S4 asserts `c.kind === "poly.candidates"` | PASS | JSON structure tested. |
| PT30.3 | Header: corpus with `digest`, `kind` (recorded/synthetic), `episodes`, `gappedLeftOut` | Tested | `mine.test.mjs:470 real-polyx` | PASS | Asserts `episodes == 18`, `kind` is recorded or synthetic. |
| PT30.3 | Tool: `name`, `version`, `commit`, `manifest` (SHA-256), `lens` | Tested | `mine.test.mjs:470 real-polyx` | PASS | Asserts `tool.name == 'polyx'`, `tool.commit` matches `/^[0-9a-f]{40}$/`. |
| PT30.3 | Thresholds: `minInstances`, `ownSupport`, `impliesSupport` | Tested | `mine.test.mjs:470 real-polyx` (implicitly) | WEAK | Real polyx provides them; not explicitly asserted. |
| PT30.3 | Candidate: `id`, `digest`, `pattern`, `support`, `counterEvidence`, `promotable`, `form`, `target`, `source`, `text`, `status` | Tested | `mine.test.mjs:470 real-polyx` | PASS | All fields asserted present in real polyx output; `id` matches `/^r[0-9a-f]{16}$/`, `target` matches `{ machine: 'orders.Order' }`. |
| PT30.3 | `status` kept from polyx (`proposed` or `suppressed`) | Tested | `mine.test.mjs:470 real-polyx` | PASS | Real-polyx asserts both status values in SHOP_TRUTH. |
| PT30.3 | Promotable predicate: all events are effect kinds of one machine, or all pure actions of one machine; mixed or multiple machines is not promotable | Not tested | — | **NOT TESTED** | No test on corpus where effects come from two machines or mixed effects/actions. |
| PT30.3 | Candidate `reason` field for non-promotable rules (PS20.2) | Tested | `mine.test.mjs:470 real-polyx` | PASS | Asserts `x.reason.includes(x.pattern)` for non-promotable. |
| PT30.3 | Digest is SHA-256 of candidate without digest field | Not tested | — | **NOT TESTED** | No test computes and verifies candidate digest. |
| PT30.3 | Corpus digest is SHA-256 of corpus file bytes | Not tested | — | **NOT TESTED** | No test verifies corpus digest against file bytes. |
| PT30.9 | Exact source texts: `before("Y", "X")` for ordering patterns | Tested | `mine.test.mjs:470 real-polyx` | PASS | Regex assertion on real polyx output: `/^path property mined-r[0-9a-f]{16}: before\("stock\.reserve", "payment\.charge"\)$/`. |
| PT30.9 | Exact source texts: `count("X") <= 1` for count patterns | Tested | `mine.test.mjs:470 real-polyx` | WEAK | Suppressed rules not in planted truth; structure tested in --all mode but exact text not verified. |
| PT30.9 | Exact source texts: obligation for state rules (when/require/else/on unknown) with TEXT and field values | Tested | `mine.test.mjs:470 real-polyx` | WEAK | Regex tests form `/effect\.kind == "stock\.reserve"[\s\S]*machine\("orders\.Order"\)\.status in \{ Reserving \} else deny\n  on unknown escalate\n\}$/`, but not enum vs checked-string vs integer rendering. |
| PT30.9 | Values in rules written as type specifies: enum as constructor, checked string as quoted, integer as itself | Not tested | — | **NOT TESTED** | Enum/string/int rendering not tested. |
| PT30.10 | Pin: `poly mine --pin-polyx --project <dir> --polyx <dir> --polyx-pin <file>` records version and entry digest | Tested | `polyx-seam.test.mjs` | PASS | Test records pin, checks `{ v: 1, name: "polyx", version, entry }` format. |
| PT30.10 | Pin mismatch (version or entry) is refusal code 2 before start | Tested | `polyx-seam.test.mjs` | PASS | Asserts code 2 and that polyx was not started when pin differs. |
| PT30.10 | Missing pin is usage error code 64 | Tested | `polyx-seam.test.mjs` | PASS | Asserts error message names the pin file. |
| PT30.10 | `--repin-polyx` replaces an existing pin | Tested | `polyx-seam.test.mjs` | PASS | Writes pin, changes polyx, repin with --repin-polyx, asserts new pin differs. |
| PT30.10 | Fixed argument vector: `node <polyx>/bin/polyx.mjs mine poly-traces --json --config <file>` with `--all` when asked | Tested | `polyx-seam.test.mjs` | PASS | Fake polyx logs argv, test asserts it includes `mine`, `--json`, `--config`. |
| PT30.10 | No shell option; only execFileSync | Tested | `boundaries-mine.test.mjs` | PASS | Boundary check forbids `spawn`, `shell` option, `fork`, etc.; tests assert clean violations. |
| PT30.10 | Fresh environment from allowlist (PATH, SystemRoot, TEMP, TMP, TMPDIR, LANG) | Tested | `polyx-seam.test.mjs` | PASS | Fake polyx logs all env keys, test asserts only allowed names are present. |
| PT30.10 | Environment never inherited; no key, token, secret reaches polyx; no NODE_OPTIONS | Tested | `mine.test.mjs` S2; `polyx-seam.test.mjs` environment test | PASS | Sets parent secrets, runs mine, verifies they do not appear in polyx's environment. |
| PT30.10 | Malformed pin JSON, wrong name, wrong v, bin/polyx.mjs a directory, polyx dir a file | Not tested | — | **NOT TESTED** | No test for corrupted pin, wrong name/v, or path validation issues. |
| PT30.10 | Timeout default 600 s; cap on output default 64 MiB | Not tested | — | **NOT TESTED** | Defaults and refusal behavior not tested. |
| PT30.10 | Only imports `node:child_process`, `node:crypto`, `node:fs`, `node:path` | Tested | `boundaries-mine.test.mjs` | PASS | Boundary check forbids other imports; test asserts violations are caught. |
| PT30.10 | Name `annotate` never appears (polyx's model command) | Tested | `boundaries-mine.test.mjs` | PASS | Boundary check searches for the string; test asserts it is forbidden. |
| PT30.11 | Limit: promoted state rule on its own cannot make mandate undischargeable; conflict only with two rules on same field | Not tested | — | **NOT TESTED** | This is stated as a documented limit (S525). No test isolates a promoted state rule on a field with no prior policy rule and asserts it does not cause PL6501. Positive control: mine and promote a state rule on a field with no existing rule in the policy, run poly check, assert PL6501 does not occur. This tests that the limit is obeyed. |

## Summary

### Counts
- **Tested with adequate assertions**: 33 clauses
- **Weak (tested but assertion incomplete)**: 6 clauses
- **Not tested**: 14 clauses

### Weak clauses

1. **PS20.2 (eligibility rule)**: Real polyx test asserts form with regex, but not enum/string/int rendering.
2. **PS20.5 (admission)**: Uses API `readPromotions`, not CLI; no PL6512 assertion.
3. **PT30.3 (thresholds)**: Not explicitly asserted in real polyx output.
4. **PT30.9 (count rule)**: Suppressed rules not in planted truth; structure tested, exact text not verified.
5. **PT30.9 (value rendering)**: Enum/string/int rendering not tested.
6. **S525 (privacy canary)**: No test of token in state value or value rendering details.

### Untested cases

1. Candidate digest computation (SHA-256 of canonical form)
2. Corpus digest computation (SHA-256 of trace file)
3. Multiple machines make rule non-promotable
4. Mixed effect and action make rule non-promotable
5. Malformed pin (JSON, wrong name, wrong v)
6. Pin: bin/polyx.mjs is directory (refusal)
7. Pin: polyx dir is file (refusal)
8. Timeout default and refusal behavior
9. Output cap default and refusal behavior
10. Tool.manifest format (SHA-256 of canonical JSON)
11. Integer field rendering in rules
12. Checked-string field rendering (quoted) in rules
13. Determinism (byte-identical runs)
14. S525 state rule limit (lone rule does not cause PL6501, two rules on same field do)

## Spec/implementation disagreements

None found. The implementation appears to follow the spec as read. However, weaknesses in test assertions (e.g., structure checked but values not) may mask bugs; see the "Weak" section above.

## Recommendations for missing tests

All weak and untested clauses should be addressed in new tests. The following high-priority cases should be covered:

1. **PT30.9 exact texts**: Write tests that construct expected source text from the spec, mine a corpus, and assert character-for-character equality.
2. **PT30.3 full candidate validation**: Parse real mine output; assert every field present, formatted correctly, and semantically correct (e.g., `promotable` matches the rule's machine/effect composition).
3. **PT30.2 port with real errors**: Mine on a corpus with rejected steps and gate-denied effects; verify port structure.
4. **PT30.11 limit**: Promote a state rule on a new field; verify mandate stays dischargeable.

---

**Audit completed.** Ready for independent test-writing phase.
