# Status

The one record of work in flight (W7, `docs/history/decisions-process.md`). Read it first when resuming. Each open branch has its state and next action; each open item has a destination. Updated last in any multi-step operation (W10).

*Updated 2026-11-09, after the old branches were settled.*

## Released

- **v1.7.0** is tagged and published on GitHub (2026-11-09): `poly guide`, `poly rules`, the refund-twice example, finding 38. Notes: `docs/release-notes-v1.7.md`.
- **`main` is ahead of `origin/main`, not pushed:** S590 (the working practice, `CLAUDE.md` W1 to W11, this file), the old branches' plan, the merges of `proposal-extensions` and `v1.4`, the licence files, and the VS Code grammar's two S586 keywords. The affected files pass on the AMD box (156 tests, 153 pass, 3 skipped: the vendored engines' source checkouts are not on the box). Waiting for the owner's word to push.
- The v1.7.0 release run was the first on the AMD box (W4). Three M3 files and pii-guard's PG12 need the laptop until the box has Claude Code 2.1.287 and edgepii (see *Open items*).

## Branches not merged into `main`

| Branch | Last commit | What it holds | Next |
|---|---|---|---|
| `agentlab` | `7219ba50`, 2026-11-04 | The Agent Lab demo: P1 and P3 done, P2 step 1 (the gateway adapter's design note). Not deployed. Pushed to GitHub on 2026-11-09 for safekeeping. | Waiting for the owner: P2, P4 and P5. |

The other old branches were settled on 2026-11-09 (`docs/history/decisions-process.md`). Each tip is kept as a tag `archive/<branch>`, pushed to GitHub. `aside-measure-verdicts`, `cleanup`, `archlens` and `public-ready` were deleted; `proposal-extensions` and `v1.4` are merged into `main`, and their branches can be deleted with `git branch -d`.

## Open items

| Item | Where | Destination |
|---|---|---|
| Signed rules: admission refuses a build that drops or changes a signed machine or configuration rule. | `docs/proposals/signed-rules.md` (owner's answers 2026-11-08) | v2.0. |
| Finding 33, the part left open: the hygiene file's waits are wall-clock, and `(c1)` to `(c3)` can fail under load. | `docs/examples/language-findings.md` | Left open by the owner on 2026-11-01; a margin on `quietMs` and `maxMs` would close it if the owner rules so. |
| Finding 34: a budget-triggered `escalate-once` has no test, for lack of a fixture. | finding 34 | The owner's call: a fixture and a test in a later release, or discarded as covered by the rule's text. |
| Finding 35, not built: a poisoned instance of a service machine; PT9.7's comparison of a non-service machine after an allow; a send verdict's `reads`. Questions: is a service machine that is also the emitter listed under `singletons`; may two instances of a service machine exist. | finding 35 | The owner's call: a ruling on the two questions first, then the tests under rule 7a. |
| The Slack provider id in the concierge's kept journal. | `docs/history/decisions-risk.md` | Ruling: accepted for now (owner, 2026-11-07, `decisions-risk.md`); reopened if a bot posts where a channel names a person. |
| `poly rules` reads `.poly` sources only; embedded `.ts` modules are not listed. `--check` calls a rule changed when only its line moved. | PT14, `poly rules` as built | A later release, if the owner asks. |
| The AMD box lacks Claude Code 2.1.287 (it has 2.1.19) and edgepii. | `C:\Users\jjdub\poly-box-tools\README.md` | Waiting for the owner, an action: installing Claude Code 2.1.287 (`claude install 2.1.287`) and edgepii on the box. Until then the M3 files and PG12 run on the laptop. |
| The demo baseline's kept runs (TypeScript and poly arms on one prompt) are not made. | `demo/baseline/README.md` | Waiting for the owner, an action: the kept runs, in the owner's own terminal (the README says how). |

## Conclusion

Everything shipped is in v1.7.0, and `main` holds the working practice, the merged branches and the licence, waiting to be pushed. Only `agentlab` remains unmerged, and every open item above has a destination or names what it waits for from the owner.
