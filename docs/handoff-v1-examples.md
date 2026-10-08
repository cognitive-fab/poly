# Handoff · the v1 examples session

You are the builder of poly's v1 examples: the concierge (the release example) and the inbox assistant (the owner's own application). The owner's reviewer (a Cowork session) writes the specs and rules; you build, test and record. The owner relays messages and holds every key.

## Start

1. Create the worktree: `git worktree add ../poly-ex -b ex m4` from the main repository, and work only there.
2. Read, in this order: `docs/plan-v1.md` (steps E1 to E3), `docs/proposals/example-inbox.md` (Part A and Part B, Q-I1 to Q-I5 ruled), `docs/proposals/v1-functional-spec.md` (the concierge, AC15 to AC30), `docs/decisions-v1.md` (S402, which E1 waits for), and the M8 to M11 decisions files for channels, credentials, memory and routing.
3. Record every step, result and decision in `docs/decisions-ex.md`.

## How to work

- **Plan first.** Write `docs/plan-ex.md`: the machines, policies, adapters and fixtures of each example, its acceptance criteria, and its measured risks. Report it for the reviewer's ruling before you build.
- **Tests first.** Each acceptance criterion gets a test that fails before the code that meets it. Recorded traffic only: no test calls a live Gmail account, AWS or a model.
- **The inbox assistant as ruled:** Gmail through the history API by polling, with M9's Google provider profile and the read and draft scopes only (no send scope); SES through SQS and S3; each inbox its own audience; drafts only; the digest on the local page.
- **Adapters are host code** in this branch. If an example needs a change in the core (grammar, checker, runtime, std), stop and bring it with a proposal; never change the core yourself.
- **Rebase on v1** after every commit the release session reports that changes PS or PT text. E1 starts after S402 (V3) lands.
- **One suite at a time** on the machine: check that the release session runs none before you start one.
- **Polywatch findings:** mark each real or false in the decisions file, with the reason.

## Stop list

Stop and report only for: a needed change in the core; a change of semantics or security; a choice the plan does not cover. Everything else: decide, record, carry on.

## Rules that do not change

- Commit as kizo-core. Never push. Never read, write or echo a key, token or secret: OAuth and AWS credentials are set by the owner, through the vault and the environment, never in a project file (PL6825).
- No environment values or real email content in any record or fixture. Fixtures are synthetic.

## Report format

What was committed (hashes), the suite line with its log path, each example's check verdict, findings with their verdicts, and what is next.
