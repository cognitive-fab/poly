# Provenance of the synthetic secret values in the E3 tests

*Cognitive Fab, October 2026. Written before the first push of branch `e3`, after a scan of the 46 commits on it (and of every blob they introduce) with the secret scan M7 ran before its own first push. The scan matched 60 times. Each match was read, with its line, and belongs to one of the four classes below. No match is a credential.*

The values are made up for tests, or taken from a vendor's documentation. None was ever issued. None opens anything. The scan tests need them because a test of a credential scanner has to plant something that looks like a credential.

## The four classes

| Class | Value | Where | Why it exists |
|---|---|---|---|
| **A. The canary key** | a string shaped like an Anthropic key whose body is the word CANARY repeated and a run of digits and letters | `test/e3/e3-fake-api.mjs`, line 7 (`CANARY_KEY`); used by `e3-live-client`, `e3-live`, `e3-pilot`, `e3-staged` and `e3-live-clock` | The live driver reads its key from the environment and must never log, write or return it. The tests give the client this canary as its key and then search every error, log line, return value, report and request body for it. A key-shaped canary also exercises the scrubber's pattern for the vendor's key shape. It is not a key. |
| **B. The scrubbing sample** | the prefix of an Anthropic key followed by the letters A to P | `test/e3/e3-live-client.test.mjs` (the test of `scrub`), line 233 in the committed file and line 210 in its first revision | A test that the client's scrubber replaces a key of the vendor's shape even when it is not the key in use. A made-up run of letters. |
| **C. The planted credentials for the scan tests** | the shapes the credential scan looks for: an `sk-` key made of the letters a to x; the AWS documentation's example access key id (the one the AWS documentation itself uses as an example, ending in EXAMPLE); a `ghp_` token made of a run of letters and digits; a private-key block with a stub body (`MIIEow`) and no key; the JWT sample whose payload is `{"sub":"1234567890"}` with a truncated signature; bearer tokens made of a run of letters and digits; `api_key=abcdefgh12345678` | `test/e3/e3-handlers.test.mjs` (lines 140 to 145, 178, 184, 215 or 218), which was `test/e3-handlers.test.mjs` before the tests moved into `test/e3/`, so the same lines appear in several revisions of both paths | The test of the credential scan (HF3.5, S554) and of its redaction. The scan has seven shapes, and a test of each needs a string of that shape. The tests assert the scan finds each, that redaction removes each, and that a benign look-alike is not flagged. Each is invented or is a documentation example. |
| **D. The trajectories fixture** | the default argument `canary-0000000000000000000000ab` of `trajectories(secret = …)` | `test/fixtures/harness/trajectories.mjs`, line 58 (in several revisions) | The recorded trajectory in which a tool output carries a credential, so that a recorded run can show the scan flags it and the canary never reaches the store, the journal or a payload (AC18). The scan reads `secret =` followed by a quoted run of characters as an assigned secret; it is a canary string, not a secret. |

## What was checked, and what was not found

- **Every match in a listed class.** The 60 matches are: class A, 1 (the one file); class B, 2 (two revisions of the one test line); class C, 55 (11 matches of the shapes above in each of five revisions of the one test file, at its two paths); class D, 2 (two revisions of the one line). None is outside a class.
- **Not found:** a key of a vendor's real shape with a real body, a file named like a credential store, a `.env` or key file, a private key, a token in a report or in the decisions file, or an environment value in a committed file. The live run's key was read from the process environment only and is in no file of any commit. The pilot and live-run reports, and `docs/history/decisions-e3.md`, hold no match.
- **Environment assignments in the tests** (`process.env.ANTHROPIC_API_KEY = …`) assign class A or the string `canary-world-key`, inside a test, and restore the variable after it.

## Conclusion

Every value the scan matched in the commits of branch `e3` is a made-up string or a documentation sample, planted on purpose in a test of the credential scan or of the live driver's key handling, and each is listed here with its file and its reason. Nothing in these commits is a credential.
