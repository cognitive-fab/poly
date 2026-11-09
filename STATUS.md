# Status

The one record of work in flight (W7, `docs/history/decisions-process.md`). Read it first when resuming. Each open branch has its state and next action; each open item has a destination. Updated last in any multi-step operation (W10).

*Updated 2026-11-09, after the v1.7.0 release.*

## Released

- **`main` = `origin/main`**, with **v1.7.0** tagged and published on GitHub (2026-11-09): `poly guide`, `poly rules`, the refund-twice example, finding 38. Notes: `docs/release-notes-v1.7.md`.
- The release run was the first on the AMD box (W4). Three M3 files and pii-guard's PG12 need the laptop until the box has Claude Code 2.1.287 and edgepii (see *Open items*).

## Branches not merged into `main`

Each is kept, none is in progress in this checkout, and each next step is the owner's.

| Branch | Last commit | What it holds | Next |
|---|---|---|---|
| `agentlab` | `7219ba50`, 2026-11-04 | The Agent Lab demo: P1 and P3 done, P2 step 1 (the gateway adapter's design note). Not deployed. | The owner's call on pushing it and on P2, P4 and P5. |
| `proposal-extensions` | `4633e41b`, 2026-10-31 | Proposal 28 for v2.0, its questions decided (S584). | Waits for v2.0. |
| `v1.4` | `1989ef7f`, 2026-11-05 | The VS Code adapter (PT14) and `docs/proposals/v2.0-ideas.md`, never merged. | The owner's call: merge `v2.0-ideas.md` into `main` so v2.0 ideas live there, or keep the branch. |
| `public-ready` | `4edc6e72`, 2026-10-21 | LICENSE and the v1.3.1 skill trimmed for publication. | Superseded in part by later work; the owner's call to merge what remains or drop the branch. |
| `archlens` | `f5327687`, 2026-10-27 | An older line from before v1.4. | The owner's call to drop it; nothing on it is known to be needed. |
| `aside-measure-verdicts` | `f388efc0`, 2026-10-10 | A measurement of verdicts on the examples. | The owner's call to drop it. |
| `cleanup` | `9a9c539b`, 2026-10-24 | A test path fix (S115). | Check whether `main` has the same fix, then drop. |

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

Everything shipped is on `main` and in v1.7.0. Nothing is in progress in this checkout. Seven older branches wait for the owner's call, and every open item above has a destination or names the owner's decision it waits for.
