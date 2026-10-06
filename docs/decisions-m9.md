# M9 decisions

Rulings on `plan-m9.md`, in the order they are made. Each entry names who ruled.

## plan-m9.md ruled (owner, 2026-10-06)

The plan is accepted, with one change to S194 and conditions on four other issues. Commit `plan-m9.md` with this file. Code starts with the first step once both are committed.

### S194 (Q8): accepted, with the keyring closed

A person signs every policy, as proposed: a `policy` record by a key of the `people` keyring over `{ scope, document, sources, engine }`, written by `poly sign policy`, never served over MCP, refused at admission and at load with `PL6409 POLICY_NOT_SIGNED`, and the two certificate faults `omit-policy-signature` and `stale-policy-signature`.

**The gap to close first.** The `people` keyring is a list in `poly.json`, certified at admission. An agent that can edit `poly.json` and holds the admission key can add its own public key under `people`, then sign its own policy. Q8 then protects nothing. So:

1. **A change to `people` or `agents` is itself signed.** A keyring that differs from the last certified one is admitted only with a `keyring` record (a fifth kind) signed by a key already in the last certified `people` ring, over the new rings' digest. Otherwise it is refused at admission (a new code) and at load (`PL6405 KEYRING_CHANGED`, as now).
2. **The first ring is anchored outside the project.** The project's first `people` ring is pinned by a trust anchor the owner keeps outside the repository, `file:` only, as the admission key's location is today: the digest of that first ring. Admission refuses a project whose first certified ring does not match the anchor.
3. **Tests.** An agent key added to `people` without a `keyring` record is refused. A `keyring` record signed by the new key itself is refused. A ring changed after admission is refused at load. A policy signed by a key added that way is refused.
4. **Test keys.** The helper the twenty test files use generates its keys in the test and never writes the private key to disk. A test trust anchor is an API option for tests only, as M8's `std` option was: no command-line flag and no `poly.json` field carries it.

### S195 to S198 (PD6): accepted

PD6's text goes into `04-semantics.md` before any code. Ages are computed by the runtime's clock at the decision and recorded in the verdict, so replay never reads the clock. A scope is a conjunction of allowed actions, allowed values or upper bounds per field, and an expiry. The refresh of stale claims has its own retry bound, defaulting to Recheck's.

### S199 (E11): accepted, fail closed

poly-runtime checks the grant and the mandate itself, in PT22.4's order, before the policy runs. Both must allow: a refusal by the runtime check is final whatever the policy says, and the policy still runs only on what the check allowed. A missing, expired or unverifiable grant or mandate refuses the effect and journals the refusal. Settle E11 by test as E10 was, including the fail-closed case: a policy reading the `credential` field on a proposal without it denies or is refused at load.

### S200 (vault adapters): accepted, with one condition

The adapters live in `poly-io` and are certified like the channel adapters. The KMS-wrapped store takes the owner's wrap and unwrap functions at load, so no cloud SDK enters poly. The reference provider is generic OAuth 2.0 from the RFCs, with a Stripe Connect profile, tested against recorded traffic only.

**Condition.** The development keychain is for development only. The certificate names the vault each credential uses, and a build marked for production refuses the development keychain at admission. Access and refresh tokens live only in the vault: never in the journal, the ledger, a certificate, a log or a test's output. The canary scan covers them.

### S206 (S192) and S207 (S193): measure first, then rule

Both can change existing verdicts. For each, build behind a switch that is off, run the 147 measured files and the concierge with it on, and bring the list of changed verdicts and state counts to the owner. The change is ruled on that list and turned on only after the ruling. S207's joint configuration is measured on the cross-channel application; if its state space does not fit within the checker's bounds, bring the numbers and a proposal.

### Q9: accepted

Generated host types (PT28.1) at the start of M10, and `poly try` (PT28.2) at the start of M11.

### Carried items: accepted as planned

E13 has its own step and blocks M9's gate. S191 is folded into the erasable content store (S205). The certificate test moves to a smaller application, with the same faults caught. `frozenCommit` is fixed with a test that fails first. `agent.mjs` stays as frozen M3 evidence, and its finding is recorded as a known defect.

## Step 3, first part: the keyring closed (S194), built

PT12.5's text came first (c2599a8). A change to the `people` or `agents` ring is admitted only through `keyrings/history.json`, whose first rings have the digest the anchor holds and whose every later entry carries a `keyring` record (the fifth kind) over `{ parent, rings }` by a key of the previous `people` ring. Admission refuses anything else with `PL6410 KEYRING_NOT_SIGNED`, before the check runs; load refuses rings that differ from the certified ones with `PL6405`, as before. The certificate binds `poly.keyringChain` (the anchor's digest and the last rings' digest); its read-back recomputes both, and the fault `stale-keyring-chain` joins the explicit list. `poly anchor keyrings` and `poly sign keyrings` are the owner's commands, never over MCP.

- **The anchor's location.** As ruled, `keys.anchor` in `poly.json` names it, `file:` only, refused inside the project or inside a tree under version control. Its protection is the owner's: an agent that can rewrite `poly.json` and write a file outside the project can point the anchor at a file of its own. The anchor holds against an agent confined to the project; against one with the owner's file system, the owner's permissions on the anchor and on the certificate's trust are the control. Stated here for the owner's notice.
- **Tests first.** `test/keyrings.test.mjs`, seven tests, failed before the code: the anchored project admitted with its chain bound; no anchor, and an anchor of other rings, refused; an agent key added to `people` with no record, with a record it signs itself, and with a record over another subject, refused; a change signed by the previous ring's person admitted; rings changed after admission refused at load; the test anchor an `admit` option only (a `poly.json` field for it refused, an anchor inside the project refused); and the two commands, never over MCP, whose output admits. The ruling's fourth test, a policy signed by a key added that way, belongs to the policy signature (the next part of step 3).
- **Test keys.** The helper's people and agent keys are generated in the test and never written to disk; each helper project's anchor is a file in the test's temporary key folder, outside the repository. The CLI test writes the person key to that folder for `poly sign keyrings --key`, which reads a file, and deletes it after.
- **The regression check.** The 159 measured files (the 147 and the twelve since) are identical to M8's close. The full suite: 1,802 tests, 1,788 pass, 2 failures, 1 skipped and 11 waiting. Both failures were this change's: the error-source test, which now exempts `PL6410` (raised by admission, tested by `keyrings.test.mjs`), and the published schemas, regenerated for the two commands. Both files pass after the fix.

## Keyring change accepted, and how M9 to M11 run from here (owner, 2026-10-06)

**The keyring change (c2599a8, cc71c6b) is accepted**, with one hardening:

- **The anchor's location** is read from a per-user config outside the project (for example `~/.poly/anchor.json`), never from `poly.json`, which cannot override it. An agent confined to the project then cannot redirect the anchor. The remaining limit, an agent that can write that per-user config, is recorded: against it the owner's file permissions are the control.
- **The CLI test's temporary key file** is acceptable: the key is generated by the test, written outside the repository and deleted. `poly sign keyrings` may also take the key on stdin.
- **The pending test** (a policy signed by a key added without a keyring record is refused) is written with the policy signatures.

**How the work runs from here, for M9, M10 and M11.** The safeguards stay: the PS text before code, tests that fail first, the measured files compared, a review with every finding fixed or answered, and a closing gate from a clean build on a quiet machine.

1. **A ruled plan runs to its end without stopping.** The session goes through every step of a ruled plan, commits each step, records it in the milestone's decisions file and goes on. It stops and asks the owner only for:
   - a new spec issue that changes `04-semantics.md` or the security model (keys, signatures, credentials, the gate, what a record may hold);
   - a change of verdict or state count on a measured file;
   - an engine change, or anything that pushes;
   - a choice the plan did not foresee and the plan's rules cannot settle.

   Anything else is decided by the plan's rules, recorded with its reason, and read by the owner at the milestone's end.
2. **One reviewer.** The owner's Cowork session (this one) rules on M9 to M11. Rulings are written into the milestone's decisions file; the owner's message to the session only points to them. Rulings by any other session stop.
3. **The full suite once per step.** Targeted tests while building; the full suite at the end of each step, before its commit; the full gate at the milestone's close. A failure in the full suite is fixed and the suite is run again before the commit.
4. **Plan ahead.** M10 and M11 are planned while M9 is built (`handoff-m10.md`, `handoff-m11.md`), and their spec issues are ruled before M9 closes.
5. **M10 and M11 in parallel, after M9 closes.** Each in its own worktree and session. To keep the merge clean, M10 numbers its spec issues S300 to S349 and takes new codes from PL6833 to PL6839; M11 numbers S350 to S399 and takes new codes from PL6843 to PL6849. A change either needs to `04-semantics.md` or to a shared package is listed in its plan, and the two plans are ruled together so they do not collide. They merge before the v1 gate.

## Step 3, first part: the anchor hardened, as ruled, and four polywatch findings

**Built, as ruled.** The anchor's location is read from the owner's per-user configuration, `.poly/anchors.json` under the home directory the operating system gives the account (`os.userInfo`, which reads no environment variable), mapping each project's name to `file:PATH` with an absolute path. `poly.json` cannot name it: `keys.anchor` is refused. `poly anchor keyrings --out PATH` writes the anchor and names it in that configuration. PT12.5 was rewritten first.

**Polywatch on the keyring change (review `mux14g12`).**

| Finding | Verdict | What was done |
|---|---|---|
| 1. An anchor that is a folder or unreadable threw a bare error out of the chain | real | read inside the chain's refusal: `PL6410` |
| 2. A malformed record in the history could throw past the chain | false: `verifyRecord` returns a refusal for a non-object, a missing field or a bad signature, and never throws | the history's shape is checked anyway, and the test of three malformed records stays as a regression test |
| 3. `poly sign keyrings`, with the history deleted, started a history from certified rings that were not the anchored first rings | real | it refuses unless the certified rings have the anchor's digest |
| 4. The test anchor, an `admit` option, let any caller bypass the owner's anchor | real | the test anchor is now a folder a test process names with `useTestAnchors(dir)`; a certificate admitted that way records `source: "test"`, and `load` refuses it unless the process called `acceptTestAnchors()`, as a witness certificate needs `allowWitness` (S139). A production runtime never calls it. |

The ruling allowed a test anchor as an API option for tests only; finding 4 showed nothing enforced "for tests only", and the load refusal is what enforces it, within the ruling (no new spec issue). Test child processes (the command line, `poly run --mcp`, the stand-in store holder) preload `test/fixtures/accept-test-anchors.mjs` with `node --import`; the command line has no flag for it.

**Tests.** `test/keyrings.test.mjs`, nine tests. The tests for findings 1, 3 and 4 were written with their fixes; each was confirmed by putting its defect back (the bare read, the missing anchor check, the missing load refusal): three of nine failed, each the finding's own, and all nine pass with the fixes.

**Polywatch, second round (review `mux44s5z`).** Both findings were real, and each test failed before its fix. (1) `poly sign keyrings` extended an existing history without checking it against the anchor: it now verifies the whole history first, and writes nothing on a refusal. (2) An anchor named `..anchor` inside a project was taken for one outside it (its relative path starts with `..`): only the parent itself, or a path through it, is outside now. `test/keyrings.test.mjs` has eleven tests.

## Polyaxion vendored at its pin (the owner's instruction, 2026-10-06)

The sibling checkout `C:/Users/jjdub/code/polyaxion` moved off the pin (to b9f17a0, with uncommitted edits that delete `packages/polysec-core` and change `packages/polysec/polyman`), so the engine-pin check failed and 77 tests that need the engine were listed as not run. By the owner's instruction, the 65 files poly runs of Polyaxion, polyman and polysec-core are now copied unchanged into `vendor/polyaxion`, out of the repository's history with `git show c37c60e:<file>` (`scripts/vendor-polyaxion.mjs`, which replaces `scripts/pin-peers.mjs`): neither the checkout nor its uncommitted edits were read or changed. `vendor/polyaxion/PROVENANCE.md` pins each by hash and commit, and its table is the old `peers/polyaxion` table, row for row; `peers/polyaxion` is removed. The runtime and the engine-pin check resolve the engine to the vendored copy (`peers.ts`); `POLY_POLYAXION_DIR`, used by one test to make the engine absent, still replaces it. `test/vendor.test.mjs` covers the copy as it covers the other vendored engines (hashes, no unpinned file, each file equal to the commit, tracked by git) and checks that the runtime resolves to it.

- **This replaces S145's sibling checkout.** S145 kept the three BUSL-1.1 packages out of the repository; vendoring them is the owner's decision of this day, recorded in the copy's `PROVENANCE.md`. poly's own licence stays the owner's open decision.
- **One difference from the peer.** polysec-core's `harden`, which runs at policy admission only, imports `@cognitive-fab/polygraph`; it now resolves to poly's vendored polygraph 8.3.2, where the checkout's own install held 8.3.0. The certificate's engine pin is unchanged (`polyaxion`, `c37c60e`), so no certificate changes.
- **Checked.** The 159 measured files are identical to M8's close. The full suite, after the keyring hardening, both polywatch rounds and the vendoring: 1,813 tests and one after the M3 runs, 1,801 pass, no failure, 1 skipped and 11 waiting (E1, E2, E5 and the seven of E13). The 77 tests the moved checkout had set aside all ran.

## Conclusion

M9 starts from an accepted plan. The one change closes the path by which an agent could sign its own policy: keyring changes are signed by a person already trusted, and the first ring is anchored outside the project. The two issues that can change existing verdicts are measured before they are ruled.
