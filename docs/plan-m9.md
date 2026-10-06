# poly · Plan for milestone M9, credentials

*Cognitive Fab · October 2026 · plan, written before any M9 code · on branch `m4` in the worktree `poly-m4` · from PT27.3's M9 row and PT22 of `proposals/v1-technical-spec.md` (v0.2), PF12 and AC18 to AC21 of `proposals/v1-functional-spec.md`, PD6 (`proposals/pd6-freshness-delegation.md`), and the brief `handoff-m9.md`, after M8's close (`decisions-m8.md`)*

This plan covers milestone M9 of the v1 proposal: delegated credentials under the gate. Its scope, as PT27.3 sets it:

- PD6 ruled in: the freshness of claims, and mandates that only narrow (K12);
- `credential` and `uses` on both surfaces;
- the standard library machine `std.credentials.Grant`;
- vault adapters: a development keychain and a KMS-wrapped store;
- the authenticated capability `api`;
- the lint rules `PL6824` and the vault import under `PL6401`, and `PL6825` at load;
- `poly grant`.

The gate is AC18 to AC21, with the canary scan among the gate's standing tests. Before any of it, Q8 is ruled: a person signs every policy, because delegated credentials make policies more powerful (S194). M8's carried items each get a named step (section 3).

The plan sets out:

- what was found before planning;
- the engine changes, for the owner's list;
- what M9 does with each item carried from M8;
- the packages touched and the order of work;
- how each gate item is tested;
- the rules for secrets, on top of M8's;
- the spec issues found, numbered from S194, each with a proposal for the owner's ruling;
- the risks.

Nothing is built before the plan is ruled.

## 1. What was read, and what was found before planning

**Documents read:**

- `CLAUDE.md` and `handoff-m9.md`;
- the v1 proposal at v0.2: PF12, AC18 to AC21, PT20.2, PT22, PT25, PT26, PT27 and PT28;
- PD6 (`proposals/pd6-freshness-delegation.md`), with its open questions;
- PT2.4c to PT2.4e (claims, the verifier adapter, revocation), PT6.5 (capabilities and the handler lint), PT9 (the gate, S147's singleton reads) and PT12.5 (signed records) of `03-technical-spec.md`;
- PS6 (liveness under fairness) and PS8 (policies) of `04-semantics.md`;
- `decisions-m8.md` and section 9 of `plan-m8.md`.

**Code read:**

- `poly-core/src/records.ts` (signed records and their kinds);
- `poly-core/src/certificate.ts` and `poly-check/src/admit.ts` (what a certificate binds, and its read-back);
- `poly-runtime/src/load.ts` and `runtime.ts` (policy loading, the engine pin, channels, `rt.receive`);
- `poly-runtime/src/capabilities.ts` (the egress capability);
- `poly-core/src/manifest.ts` (keys and the ledger signer);
- the vendored Polyaxion's gate, for a consult-by-message input.

| Finding | Where | Consequence |
|---|---|---|
| A policy is admitted on the admission key alone. Nothing a person signs binds it: the certificate lists each scope's policies, its lowered document by digest and the engine's commit, and an agent with the admission key can admit a policy it wrote. | `admit.ts`; `certificate.ts` (`poly.policies`, `poly.policyEngine`) | Q8 needs a person's signature on each scope's policies, bound by admission and checked again at load (S194). |
| Signed records exist for three kinds: `approval`, `acceptance` and `invocation`, each ed25519 over `poly-record\n<digest>`, by a key of the `people` keyring; an agent key never signs. | `records.ts` | A policy signature is a fourth record kind, with no new cryptography (S194). |
| Claims carry no time. The verifier adapter returns a claims record; nothing says when it was verified or how fresh its status was. | PT2.4c; `runtime.ts` `dispatch` | PD6.1's ages need `verifiedAt` and `statusAt` from the adapter, and a clock that computes ages at decision time (S196). |
| The gate reads a service machine's snapshot as of the emitting step (S147), and a singleton only. A grant is one instance per credential and holder, keyed, not a singleton. | PT9; Polyaxion's gate | PT22.4's grant check needs a keyed read: E11, or poly-runtime reading the `Grant` instance and passing the result as the proposal field `credential` (S199). |
| The egress capability is bound to an effect's declared target prefixes, with redirects checked hop by hop, and no credential. | `capabilities.ts` | `api` is a second capability of the same shape, whose transport is the vault adapter's `withToken` (S201). |
| The ledger signer is `file:` only, by S188's ruling; there is no KMS anywhere in poly. | `manifest.ts` | A "KMS-wrapped store" needs a wrapping interface the host supplies; no cloud SDK can enter poly-io under the boundary (S200). |
| Network code lives in poly-io alone, behind certified adapters, frozen when made, with claims only from their verify (M8b review). | `poly-io`; `scripts/check-boundaries.mjs` | The OAuth exchange and the vault's provider calls belong in poly-io, as a new adapter kind, certified the same way (S200). |
| Ingress takes a provider's webhook to its channel's adapter. An OAuth callback is a webhook of another kind. | `poly-io/src/ingress.ts`, `rt.receive` | The callback reaches the vault adapter through ingress, with the state parameter as its nonce (S202). |
| The content store keeps bodies by digest and never deletes one. | `ledger-store.ts` (`poly_content`) | S191 needs an erasable store: a body deleted, its digest kept (S205). |
| Twenty test files admit a program with policies. | `test/` | Q8 changes every one of them: each must sign its policies with the test person key (risk 3). |

Nothing was measured while planning.

## 2. Engine changes, for the owner's list

| Id | Engine | Change | Needed for | Status in this plan |
|---|---|---|---|---|
| **E13** | polyrun | `createInstance`, polygraph 8.4.0 (spec in `plan-m8.md`) | channels at run time; M9's gate, by the ruling that closed M8 | **The owner's.** When it lands: re-vendor by hash and commit, the seven waiting tests run and pass, and the `creation-unavailable` test skips itself (step 1). |
| **E11** | polyaxion | Consult-by-message as a declared input source | PT22.4's grant check | **Proposed not needed** (S199): poly-runtime reads the grant and passes it as the field `credential`, which a policy reads like `channel`; settled by test as E10 was. |
| E10 | polyaxion | Per-value taint | M10 | Unchanged. |
| E5 | polyrun | Create an instance at given initial values | S153 | Unchanged; not needed by M9. |
| E1, E2, E12 | polyrun, polyflow | As listed | | Unchanged. |

An engine item found while building gets the next id, E14, and is recorded the same day.

## 3. Carried over from M8

| Item | What M9 does | Step |
|---|---|---|
| **E13** | Re-vendored when it lands; the seven tests run and pass; `kernelCreatesInstances` turns on. Required before M9's gate. Until it lands, M9 builds everything else, and the gate waits. | 1, and the gate |
| **S191** | Addresses move to the erasable content store; thread keys, step data and ingress records carry the address's keyed digest; the send handler reads the address by digest. Planned with the secrets rules, since both say what the journal may keep (S205). | 9 |
| **S192** | The provider's clock of PS15.5 for every configuration (S206). | 10 |
| **S193** | One joint generated configuration, every conversation live, for an application bound to several channels: PS15.5's text first, the transit bound derived again, the state space measured on the cross-channel application (S207). | 10 |
| **The certificate test** | The adapter faults admit a one-channel application in place of the concierge, with the same three faults caught; the test's time is measured before and after. | 2 |
| **check-memory under load** | The count continues from 2 in 19 full runs. If the rate rises above one in five, the growth (about 97 `UncompiledData` objects per check) is investigated as its own step. | every step |
| **Out of scope: `experiments/m3/runner-mutant-assign/agent.mjs`** | Two polywatch findings: `runTurn` spawns the agent with no `error` listener, and the review read that file in place of its change. **Proposed disposition:** the file is frozen M3 evidence (`experiments/m3/FROZEN`) and is not changed; the first finding is recorded in `experiments/m3`'s known-defects list, since a spawn failure there throws out of the runner and ends the run, which no frozen result depends on; the second needs no action. | 2 |
| **Out of scope: `test/m4f-recheck.test.mjs`'s `frozenCommit`** | It takes the first hex token of `experiments/m3/FROZEN` for the commit, and turns every git error but one into a todo. **Proposed disposition:** fixed in M9 with a test that fails first: the commit is read from its labelled line, and any git error other than "not a git repository" fails the test instead of skipping it. | 2 |

## 4. Packages and what changes in each

| Package | Change |
|---|---|
| `poly-lang`, `poly-embed` | `credential c: oauth2 { provider, grant, scopes, holder }` and `uses c { s… } for p` in an effect, on both surfaces; `mandate` claims (PD6.2, S197). |
| `poly-core` | `PL6821`, `PL6822`, `PL6823`; the scope set as a finite power set; ages abstracted by the thresholds the policies mention (PT20.3); the record kind `policy` (S194). |
| `poly-lower` | Each credential's descriptor `credentials/<name>.json` (provider, grant type, scopes, holder, base addresses), with its read-back and broken variants; the manifest entry of an effect with `uses`. |
| `poly-ref` | Written from the semantics, sharing no code with the compiler: the scope sets, the read-back of the credential descriptor, the age intervals, and PS8's reading of `effect.credential` and of mandates. |
| `poly-check` | Admission binds each scope's policy signature and refuses an unsigned or changed one (S194); the certificate binds vault adapters as it binds channel adapters; `poly sign policy` and `poly grant` (not over MCP). |
| `poly-runtime` | `load` verifies the policy signatures; the `Grant` instances; the grant and mandate checks before the policy (S199); the field `credential`; `api`; `PL6825` at load; revocation from three sources; the canary-safe journal. |
| `poly-io` | The vault adapter kind: the OAuth 2.0 authorization code flow with PKCE and client credentials, `withToken`, `revoke`, the callback through ingress, the development keychain and the KMS-wrapped store over a host-supplied wrapping function (S200). |
| `poly-agent` | The registry picks up `credential` and `uses`; `poly grant` and `poly sign` are not exposed over MCP. |
| `std/` | `std.credentials` with the `Grant` machine and its `PROVENANCE.md` (RFC 6749, RFC 7636, RFC 7009, the provider's revocation and token lifetime documentation). |
| `scripts/check-boundaries.mjs` | A handler that imports the vault adapter's module is refused (with the lint's `PL6401`). |
| `test/` | One file per gate item (section 6); the fault lists gain the credential descriptor's and the policy signature's broken variants. |

## 5. Order of work

Each step ends with a commit. Every defect gets a regression test that fails first; a confirmation test gets a seeded control that must fail. The 147 measured files are compared at every step, and every difference reported.

0. **Rulings.** On this plan, S194 to S207 and Q9.
1. **E13**, when the owner's change lands: re-vendor, the seven tests, `creation-unavailable` skipping itself. This step moves in the order to when it lands; nothing else depends on it but the gate.
2. **Housekeeping from M8.** The certificate test on a smaller application; `frozenCommit`; the M3 known-defects entry.
3. **Q8: a person signs every policy (S194).** PT text first. The record kind `policy`, `poly sign policy`, admission's check and binding, load's check, the certificate fault and the twenty policy test files moved onto signed policies.
4. **PD6 (S195 to S198).** PS text first. Claims with `verifiedAt` and `statusAt`; `age` and `statusAge` in policies, abstracted by intervals and recorded in the `verdict` event; the escalation `stale-claims` with its bound; the mandate claims kind, the narrowing rule (K12) before the module, `mandate-widened`; revocation through the chain. PD6-A1 to A6 as tests.
5. **`credential` and `uses` (S203).** Both surfaces, `PL6821` to `PL6823`, the descriptor, its read-back and broken variants.
6. **`std.credentials.Grant` (S204).** The machine, checked under the gate like `OutboxIntent`: invariants, deadlock freedom, bounded refresh, and its liveness under its stated fairness (AC20). A seeded mutant of each rule.
7. **Vault adapters in poly-io (S200, S202).** The OAuth flow against recorded traffic of the reference provider, the callback through ingress, the two stores, `withToken` and `revoke`, and the adapter certified by package and digest.
8. **The gate decision and `api` (S199, S201).** The grant and mandate checks before the policy, the field `credential`, the deny reasons, `api` over `withToken`, the lint rules, `PL6825`, `poly grant`, revocation from its three sources.
9. **S191 with the secrets rules (S205).** The erasable content store; addresses out of the journal.
10. **S192 and S193 (S206, S207).** PS15.5's text first, then the code, the regression measured file by file.
11. **AC18 to AC21 end to end** on the concierge with a refund through the merchant's delegated credential; the canary scan joins the standing tests.
12. **The M9 record, the code review, and the gate** from a clean build on a quiet machine, compared file by file with M8b's.

## 6. How each gate item is tested

Each test is written first and fails on the tree before its step.

| Gate item | Test | Fails first because |
|---|---|---|
| AC18 | `test/credentials-canary.test.mjs`, and a standing test. The test vault issues tokens with a canary prefix generated in the test. After the concierge's credential suite runs, a scan of every output finds no occurrence of the prefix, plain, base64, base64url or URL-encoded: state snapshots, the journal and the ledger, the content store, gate proposals, decision inputs, handler results, logs, certificates and test output. A seeded control, a handler that returns the response header carrying the token, is found by the scan. | No vault, no scan. |
| AC19 | `test/credentials-scope.test.mjs`. An effect whose `uses` names an undeclared scope is `PL6821` at admission. A grant with fewer scopes than needed gives `insufficient-scope`. After the step that records `Revoked`, no intent using the grant starts; one already `Running` completes and is recorded as started before the revocation. | No `uses`, no `Grant`. |
| AC20 | `test/std-credentials.test.mjs`. `Grant` is CLEAN, free of deadlock, its refresh bounded (an invariant over `attempt`), and its liveness ("a refresh ends in `Granted` or `Expired`") holds under its stated fairness; each rule's seeded mutant gives a finding with a witness; `PROVENANCE.md` names a source and a date for every rule. | No standard library module. |
| AC21 | `test/credentials-mandate.test.mjs`. An action outside the innermost mandate is denied `outside-mandate` though the grant covers its scopes; an action outside the grant is denied `insufficient-scope` though the mandate covers it; on the tenth action as on the first (PD6-A5). | No mandates. |
| Q8 | `test/policy-signature.test.mjs`. A policy with a person's signature over its digest and the engine pin is admitted and loads. Unsigned, signed by an agent key, signed over another digest, or changed after signing: admission refuses, and load refuses a certificate whose signature does not match (a certificate fault). | Policies are admitted on the admission key alone. |
| PD6 | `test/pd6.test.mjs`: PD6-A1 to A6, each as the proposal states it. | No times, no mandates. |
| Read-backs | `test/tv.test.mjs` and `test/toolchain-faults.mjs`: the credential descriptor's broken variants (a scope added, the holder parameter changed, a base address widened) and the policy signature's (`omit-policy-signature`, `stale-policy-signature`) are caught. | No descriptor, no signature. |
| Boundaries and lint | `test/boundaries.test.mjs` and `test/lint.test.mjs`: a handler importing the vault module (`PL6401`), a handler reading `set-cookie` or `authorization` from a response (`PL6824`), a token-shaped string in adapter configuration at load (`PL6825`). | The rules as they stand. |

No test calls a provider or a model. Every vault test uses recorded OAuth traffic built from the provider's documented payloads, with every secret generated in the test and never written to disk. A live consent on a real provider account is the owner's demonstration, reported and not gated, as M8's live channel was.

## 7. Rules for credentials, on top of M8's

As the brief sets them, and as the gate's standing tests enforce them:

- **No secret in any record.** No journal row, ledger entry, certificate, log, test output, report or commit holds a secret value or the process environment. A credential is named by reference only. The canary scan is the test.
- **Tests never use real secrets.** Every test secret is generated in the test and never written to disk.
- **No agent handles a live key.** The owner sets keys in his own shell. No tool, test or script reads, prints or writes one. `poly sign policy` and `poly grant` are the owner's commands, never served over MCP.
- **Fail closed.** A missing, expired or unverifiable credential refuses the effect and journals the refusal. It never falls back to an ungated or anonymous path.

## 8. Spec issues

Numbered from S194. Each has a proposal and waits for the owner's ruling.

- **S194. Q8: a person signs every policy.**
  - *Proposal:*
    - **What is signed.** A signed record of a fourth kind, `policy`, by a key of the `people` keyring (never `agents`, PT12.5). Its subject is the digest of `{ scope, document, sources, engine }`: the lowered policy document of the scope (`.poly/build/policies/<scope>.policy.json`) by digest, the digest of each source file that declares a policy of the scope, and the engine pin (`polyaxion` and its commit). A change to any of them, the engine included, needs a new signature.
    - **Where it lives.** In the project, beside the sources, at `policies/<scope>.sig.json`, committed with them. `poly sign policy <scope> --key file:PATH` writes it: the owner's command, run in his shell, never served over MCP, reading the key from a file outside the project as the ledger signer is read.
    - **Admission** recomputes the subject, verifies the record against the certified `people` keyring, refuses an unsigned scope, a record by an agent key, and one over another subject (`PL6409 POLICY_NOT_SIGNED`, a new code), and binds the record into the certificate beside the scope. The read-back checks the bound record against the scope's document and the engine pin.
    - **Load** verifies each bound record again against the certified keyring, the policy document's bytes and the engine pin it runs, and refuses on any mismatch. A certificate written with the record omitted or stale is a certificate fault in the explicit list (`omit-policy-signature`, `stale-policy-signature`).
    - **The test.** A signed policy is admitted and loads. The same policy changed by one rule after signing is refused at admission; a certificate forged with the old record over the new document (the fault) is refused at load. An agent key's signature is refused at both.
  - *Alternative:* sign the source only. The lowered document is what the engine runs, so the signature would not cover the lowering; translation validation covers it, but the person would not have signed what runs.
  - *Cost:* the twenty test files that admit a policy sign it with the test person key, through one helper.
- **S195. PD6 is ruled in, as written, with three answers to its open questions.**
  - *Proposal:* PD6.1 and PD6.2 enter `04-semantics.md` as PS-text before any code, with K12. The three open questions are answered by S196 to S198.
- **S196. Whose clock computes ages.**
  - *Proposal:* the runtime's clock at decision time, the clock that already stamps every journal row, recorded in the `verdict` event with the ages it gave, so replay uses the recorded ages and never the clock (PS11). `verifiedAt` and `statusAt` are the adapter's, recorded with the claims digest and not trusted beyond K11. A claims record whose times lie after the decision time is unknown for every age rule.
- **S197. How expressive a scope is.**
  - *Proposal:* a scope is a conjunction of: a finite set of allowed actions; per field, a finite set of allowed values or an upper bound on an integer; an expiry. Subset is decided field by field, in time linear in the scope. Nothing else in M9 (no disjunctions, no lower bounds, no regular expressions).
- **S198. The `stale-claims` refresh bound.**
  - *Proposal:* its own bound, declared like `Recheck`'s and defaulting to the same value, so a policy can tighten one without the other; when it is spent the intent is denied `stale-claims`.
- **S199. Where the grant and mandate checks run (E11).**
  - *Proposal:* poly-runtime checks the grant (by reading the `Grant(c, p)` instance as of the proposal) and the innermost mandate before the policy, in PT22.4's order, and denies `insufficient-scope`, `credential-unavailable` or `outside-mandate` itself, journaled with the grant's `sseq`. The proposal carries the field `credential` (`{ name, holder: principalDigest, scopes, grantState, grantSseq }`) so a policy may escalate `reauthorize` or add its own rules. The certificate lists the grant and mandate checks as poly's, not the gate's (PT27.2's fallback). E11 is settled by test, as E10 was: a policy over `effect.credential` steps on the pinned Polyaxion, and the engine fails closed without the field.
  - *Alternative:* E11 in Polyaxion. It moves the check into the engine, at the cost of an engine change before M9 can close.
- **S200. The vault adapters and the KMS.**
  - *Proposal:*
    - A vault adapter is a runtime adapter in poly-io, made and certified as channel adapters are (frozen, bound by package and digest, taken only when made by the certified package).
    - **The store** keeps each token set encrypted under a wrapping key, by grant id, outside the project and outside the content store. The **development keychain** wraps with a key file outside the project (`file:` only, as the ledger signer); the **KMS-wrapped store** wraps with a `wrap`/`unwrap` pair the host supplies at load, so a cloud KMS is host code and no cloud SDK enters poly-io. Tests use a wrap pair over a key generated in the test.
    - **The reference provider** is a generic OAuth 2.0 provider written from RFC 6749, RFC 7636 (PKCE) and RFC 7009 (revocation), with one provider profile, Stripe Connect, as PT22.1's sketch names, recorded from its documented payloads.
  - *Alternative:* an OS keychain (Windows Credential Manager, the macOS Keychain) as the development store. It needs native code per platform.
- **S201. The authenticated capability.**
  - *Proposal:* `api` has the shape of the egress capability: requests only to the provider's base address and the effect's declared targets, redirects checked hop by hop, refusals `PL6406` audited. Its transport is the vault adapter's `withToken(grantId, request)`, so the token is attached inside the adapter and the response comes back with token-bearing headers removed. The handler never holds the token; under `isolation: openshell` the adapter runs outside the sandbox (as PT22.5 says, and still not enforced: S152's limit stands).
- **S202. The OAuth callback.**
  - *Proposal:* the callback is a webhook to `/credentials/<name>` through ingress. `poly grant request` generates the `state` value and the PKCE verifier; the state is the nonce, claimed once in the store with its expiry; the verifier is kept in the vault store, never in the journal. The callback's code is exchanged by the vault adapter; the runtime sees only the granted scopes, and dispatches `Callback(scopes)` to the `Grant` instance. The authorization URL is delivered to the holder by a work order, through a channel or the operator's console, as PT22.3 says; it carries no token.
- **S203. `credential` and `uses`, as PT22.1 writes them**, with `PL6821` to `PL6823` and these choices: the scope names are a checked domain (PS1); `for p` names a `Principal` parameter; the provider's base addresses come from the vault adapter's provider profile and are certified with it.
- **S204. The `Grant` machine.**
  - *Proposal:* PT22.2's states, with the refresh bounded by `attempt: 1..3`, the liveness "a refresh ends in `Granted` or `Expired`" under fairness of `RefreshOk | RefreshFailed`, and `Revoke()` from any state to the terminal `Revoked`. Its effects: `refresh` and `revoke`, run by the vault adapter. Each rule from RFC 6749 and RFC 7009 has a seeded mutant, as each conversation machine's rule had.
- **S205. What the journal may keep (S191 with the secrets rules).**
  - *Proposal:* the content store becomes erasable: `rt.erase(digest)` deletes a body and keeps its digest with an erasure record; a step whose `Content` names an erased body reads `content-missing`. A channel's address moves into it: thread keys, instance ids, step data and ingress records carry the address's keyed digest, and the send handler reads the address by digest. A token never enters it (PF12.3). The certificate's limit S191 is removed when the canary-style scan for a test address passes.
- **S206. S192: timers in declared configurations.**
  - *Proposal:* the provider's clock of PS15.5 for every configuration: the global state records every instance's armed timers, and the environment fires one only while it is armed. A declared input on a timer's target stays allowed, and offers the action as an input like any other. The regression is measured file by file before the code is committed; a changed verdict comes to the owner first.
  - *Alternative:* a new input form that fires a declared timer only while armed, so declared configurations change only when they use it. Narrower, and it leaves the timers of a configuration that does not declare them unexplored.
- **S207. S193: one joint configuration for several channels.**
  - *Proposal:* for an application bound to `n` channels, one generated configuration with every conversation live, named after the application, with the instance bound `1 + n` and the transit bound the sum of the conversations' `pending` bounds; the `n` per-channel configurations are replaced by it, and a reply on another channel is checked with that channel's receipts arriving. PS15.5's text first; the state space measured on the cross-channel application before the code is committed.
  - *Alternative:* keep the per-channel configurations and add the joint one only when the application sends on two channels from one handler. Smaller state spaces, and two rules to read.
- **Q9. Where generated host types and `poly try` go.**
  - *Proposal:* generated host types (PT28.1) at the start of M10, since memory adds the `Items` and taint types that host code passes and would otherwise build by hand; `poly try` (PT28.2) at the start of M11, where routes and budgets make stepping a decision without a model call most useful. Neither is needed for M9's gate.
  - *Alternative:* both in the v1 release milestone, with the extraction pattern.

## 9. Risks

1. **E13 is outside poly.** M9's gate waits on it. Everything else of M9 is built and tested without it, and the plan says so in the record.
2. **Recorded OAuth traffic.** The OAuth flow is tested only against documented payloads. A provider whose behaviour differs from its documentation is not caught until the owner's live demonstration.
3. **Q8 touches every policy test.** Twenty files sign their policies through one helper; a mistake there would hide a signature check behind a test helper, so the helper is itself tested with an unsigned and a changed policy.
4. **S206 and S207 change verdicts.** Every declared configuration with a timer may change, and a joint configuration may be large. Each is measured before its code is committed, and a change of verdict comes to the owner.
5. **The canary scan's coverage.** The scan finds only the encodings it knows. Each encoding is listed, and a token in an unknown encoding is a limit stated in the record.

## Conclusion

M9 puts delegated authority under the gate, and it starts by ruling who may change the rules that authority obeys: a person signs every policy, over its lowered document and the engine that runs it. Credentials then follow PT22 with PD6's freshness and narrowing mandates, a checked `Grant` machine, vault adapters in poly-io that never hand a token to a handler, and a canary scan that proves no secret reaches any record. M8's carried items each have a named step, and E13, the owner's, must land before the gate.

## Glossary

- **Policy signature:** a signed record of kind `policy`, by a person's key, over a scope's lowered policy document, its sources and the engine pin (S194).
- **Mandate:** a verified claim by which a principal authorizes an agent key to act within a scope until an expiry (PD6.2).
- **Narrowing rule (K12):** each sub-mandate's scope and expiry lie within its parent's.
- **Grant:** the standard library machine for one credential held by one principal (PT22.2).
- **Vault adapter:** the runtime adapter that holds token sets under a grant id, attaches a token inside itself, and never returns one (PT20.2, K13).
- **Authenticated capability (`api`):** the handler capability that calls a provider through the vault adapter (PT22.5).
- **Canary scan:** the standing test that plants a unique token prefix in the test vault and finds no occurrence of it in any record or output (PT22.7).
- **Wrapping key:** the key under which the vault store encrypts token sets: a key file for the development keychain, a host-supplied wrap function for the KMS-wrapped store (S200).
