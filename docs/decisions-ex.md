# poly v1 · Decisions for the examples

Steps, results and rulings of the examples branch `ex` (E1 the concierge, E2 the inbox assistant), in the order they happen. Each entry names who ruled.

## Set-up (2026-10-08)

- **Worktree.** `poly-ex` on branch `ex`, cut from m4 at fec4337f with `git worktree add ../poly-ex -b ex m4` from the main repository. The handoff (`handoff-v1-examples.md`) is on m4 only, not on main. Branch `v1` has no commit beyond m4 yet, so there is nothing to rebase on.
- **Plan.** `docs/plan-ex.md`, written before any code, reported for the reviewer's ruling. It brings S450 (the thread's principal), S451 to S454 (four core changes the inbox needs), S455 (a Gmail draft token can send) and Q-EX1 to Q-EX5. No example code is written until it is ruled, apart from E2.0, which depends on none of them.

## plan-ex ruled (owner's reviewer, 2026-10-08)

**Where the core changes are built.** S450, S451, S454 and S455's core half change semantics or security, so they are built by the release session on `v1`, after S402 and in this order, with PS and PT text first and tests written from the text alone. `ex` rebases on each as it lands. Nothing on `ex` changes the core.

- **S450, accepted.** A channel may declare `principal from <claims field>`: the thread's principal comes from the verifier adapter's verified claims for the sender, never from message content. Without it the recipient keeps no principal, as now. PS15.0a and PS17.3 are amended. Test: the concierge's reply citing customer A's orders reaches A; the AC22 variant sending them to B is a finding at check and denied at run time.
- **S451, accepted.** Mail is a source owned by its account's principal. A retrieval may add one equality on a key the source declares (message id, thread, correspondent); key values are opaque, compared only for equality, so renaming invariance (PS4.1c, PS4.1f) holds. Test: IAC3, mail of one account never reaches a draft of another.
- **S452, ruled.** poly-io's adapters are certified host code, not semantics. `ex` may add new adapter kinds to poly-io, additive only: new files, a registry entry each, a provenance file, recorded-traffic tests. No change to an existing kind or to the loader. A registry conflict at rebase is resolved by keeping both entries.
- **S453, deferred to after v1.** No new credential kind in v1. SES ships after the release with an `aws_sigv4` kind and its own ruling. Q-EX5 is accepted: Gmail only for the v1 gate.
- **S454, accepted.** An unrouted decision may name a budget; its call reserves its worst-case cost like a tier call (PS18.4, S360, S361 apply unchanged). Test: drafts and titles stop at the monthly cap of IF3.5.
- **S455, accepted, both halves.** On `ex`: two credentials, `gmail.readonly` for polling and `gmail.compose` for drafts, so the polling token cannot send. In the core: an effect target may be written `exact "<url>"`, matched on the whole URL; the inbox's draft effect uses it, so `.../drafts/send` is outside the gate. The release notes say that Google's compose scope permits sending and that the exact target is what prevents it.
- **Q-EX1 to Q-EX4, accepted as recommended:** two routed enum decisions for triage, due dates as buckets; snooze of 1d, 3d and 1w; SES read-only when it comes; the digest a view computed by the page from checked state, local only (Q-I4).
- **Id range S450 to S499, accepted.** The three calls recorded in the plan (the Notice machine, opaque account labels, person-signed approvals only) are accepted.
- **Google OAuth.** Confirm from Google's documentation: refresh tokens of an app in Testing expire after seven days, and `gmail.readonly` and `gmail.compose` are restricted scopes, which may require verification for an app In production. Bring the facts to the owner; the owner sets the Google project and its keys.

**Start now:** recorded traffic, the MIME reader (kept for SES after v1), the synthetic corpus, the Gmail adapter kind (S452), and the concierge parts that do not need S450. Then E1 after S402 and S450 land, E2 after S451, S454 and S455.

## Conclusion

The branch exists and holds the plan. Building starts on the reviewer's ruling.
