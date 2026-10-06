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

## Conclusion

M9 starts from an accepted plan. The one change closes the path by which an agent could sign its own policy: keyring changes are signed by a person already trusted, and the first ring is anchored outside the project. The two issues that can change existing verdicts are measured before they are ruled.
