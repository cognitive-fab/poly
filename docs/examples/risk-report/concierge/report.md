# Risk report

*These counts are evidence that each rule was applied to the decisions recorded in the journal. They are not proof that a risk was removed or reduced.*

Risk domains and subdomains: MIT AI Risk Repository, Domain Taxonomy, Version 4 (2025-12-04), airisk.mit.edu, licensed under CC BY 4.0.

- Period: 2026-09-21 to 2026-09-21 (the first and last day of the counted events, UTC)
- Store: `docs/examples/risk-report/concierge/store.db`
- Runs: 9 with a gate record; 9 counted, 0 not verified, 0 with no certificate identified, 0 with two
- Keys trusted: test-risk-report-concierge, test-risk-report-concierge-ledger
- Certificate `docs/examples/risk-report/concierge/certificate.json`: build cert-eb1690537e84, sha256:7c90d52015f7ca0a6847d91beac78343352203ec5dcde594bfe2ba2715d0c354, signed by test-risk-report-concierge; 9 run(s) matched
- Catalog iso: ISO/IEC 42001:2023, sha256:21a639a86dac23f5e7e3c347a57166e81cc2556d6374f62d6e75fca00351d47f
- Catalog mit: Version 4 (2025-12-04), sha256:503c636b68d4ef49c8abe6b1c7af71a4e344d9155adaf7ad396c34b42d4a5c1b
- Catalog nist: AI RMF 1.0 (NIST AI 100-1, January 2023), sha256:a811732633116a5d4ef0648befe26d5f18d8b66441236d2e80f12cfe039c67dc

## mit:2.1 Compromise of privacy by obtaining, leaking or correctly inferring sensitive information

*no decision in the period*

| Item | Kind | Controls | Signer | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |
|---|---|---|---|---|---|---|---|---|---|
| refunds.customer-decisions | rule | nist:MEASURE-2.10 | ops (key-ops), sequence 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| refunds.staff-decisions | rule | nist:MEASURE-2.10 | ops (key-ops), sequence 1 | 0 | 0 | 0 | 0 | 0 | 0 |

## mit:4.3 Fraud, scams, and targeted manipulation

| Item | Kind | Controls | Signer | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |
|---|---|---|---|---|---|---|---|---|---|
| refunds.large-refund-reviewed | rule | iso:A.9.2, nist:MAP-3.5 | ops (key-ops), sequence 1 | 0 | 1 | 1 | 0 | 0 | 0 |

- refunds.large-refund-reviewed: approved 1 time(s) by ops (key-ops)

## mit:7.3 Lack of capability or robustness

| Item | Kind | Controls | Signer | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |
|---|---|---|---|---|---|---|---|---|---|
| refunds.large-refund-reviewed | rule | iso:A.9.2, nist:MAP-3.5 | ops (key-ops), sequence 1 | 0 | 1 | 1 | 0 | 0 | 0 |

- refunds.large-refund-reviewed: approved 1 time(s) by ops (key-ops)

## Allowed in each scope

An allow names no rule, so allows are counted per scope and no item is credited with one.

| Scope | Allowed |
|---|---|
| concierge | 24 |
| concierge.staff (open: no policy governs it) | 5 |
| concierge.support (open: no policy governs it) | 9 |
| concierge.triage (open: no policy governs it) | 4 |

## Refused by the runtime (no rule)

None in the period.

## Escalated by the runtime (no rule)

None in the period.

## Exposed and not covered

Listed as an exposure, and named by no item in mitigates:

- mit:3.1 False or misleading information

## Rules that name no risk

None.

## Runs not counted

None: every run with a gate record verified.

## How the counts are made

- Every run of the store is verified as `poly journal verify` verifies it; a run that does not verify is not counted.
- A run is counted under the certificate whose machine versions and policy set it recorded, and its tags come from that certificate, never from the sources on disk.
- Allows are counted per scope: an allow names no rule, so no item is credited with one.
- One item per refusal: the engine reports the first item that refused a proposal, so another item that would also have refused it is not credited.
- An escalation is followed through the intent's later events in the period: approved, refused at its timeout, or open at the end of the period.
- An escalation the runtime made, which rule 2 of PT9.7 then denied escalate-once, is counted under its cause, never as a refusal and never for an item.
- The period is selected by the event's UTC day.
