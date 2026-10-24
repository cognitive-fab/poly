# M9 planning brief

M8 is closed (c539838 on m4, not pushed). This brief starts M9. The first deliverable is `docs/history/plan-m9.md`, for the owner's ruling. No code is written before the plan is ruled.

## 1. Scope

M9 is **Credentials**, as `docs/proposals/v1-technical-spec.md` sets it: PD6 ruled in (freshness and mandates, K12); `credential` and `uses`; `Grant`; vault adapters (a development keychain and a KMS-wrapped store); the authenticated capability; the lint rules; `poly grant`. Gate: AC18 to AC21, with the canary scan in the gate's standing tests.

## 2. Decisions needed before the plan is ruled

- **Q8 (v1 spec, PT27.5): a person signs every policy.** The spec says it is ruled before M9, because delegated credentials make policies more powerful. The plan proposes the mechanism: an agent drafts the policy, the checker proves it, a person signs it, and an unsigned or changed policy is refused at load. State where the signature lives, what it covers (the policy's digest and the engine pin), and how a test proves an unsigned change is refused.
- **Q9 (v1 spec): where generated host types and `poly try` go.** Propose a milestone for each.

## 3. Carried over from M8

| Item | What M9 does |
|---|---|
| **E13** | The owner changes polyrun (`createInstance`, polygraph 8.4.0, spec in `plan-m8.md`). When it lands: re-vendor by hash and commit, the seven waiting tests run and pass, and the `creation-unavailable` test skips itself. Required before M9's gate. |
| **S191** | A channel's journal holds correspondents' addresses. They move to the erasable content store. Plan it with M9's secrets handling, since both are about what the journal may keep. |
| **S192** | Declared configurations complete timers only through declared inputs. Propose the rule: the provider's clock of PS15.5 for every configuration, or an input form that fires only while its timer is armed. |
| **S193** | One joint generated configuration, every conversation live, for an application bound to several channels. PS15.5 text first, the transit bound derived again, the state space measured on the cross-channel application. |
| **The certificate test** | It went from 15 s to 424 s because each adapter fault admits the full concierge. Use a smaller application for the adapter faults, with the same faults caught. |
| **check-memory under load** | Keep the count (2 in 19 full runs). Investigate the growth (about 97 `UncompiledData` objects per check) if the rate rises. |
| **Out-of-scope findings** | The polywatch findings listed for the owner (`experiments/m3/runner-mutant-assign/agent.mjs`, `test/m4f-recheck.test.mjs`'s `frozenCommit`): list each in the plan with a proposed disposition. |

## 4. Rules for credentials, on top of M8's

- **No secret in any record.** No journal row, ledger entry, certificate, log, test output, report or commit holds a secret value or the process environment. A credential is named by reference only.
- **Tests never use real secrets.** Every test secret is generated in the test and never written to disk, as the M8 adapter tests do. The canary scan proves that a planted canary value never appears in any record or output.
- **No agent handles a live key.** The owner sets keys in his own shell. No tool, test or script reads, prints or writes one.
- **Fail closed.** A missing, expired or unverifiable credential refuses the effect and journals the refusal. It never falls back to an ungated or anonymous path.

## 5. How M9 runs

As M8 did: the plan with its S-issues (from S194), each ruled before its code; PS text before code; tests that fail first; the 147 measured files compared at every step; a review with every finding fixed or answered; a closing gate from a clean build on a quiet machine, compared file by file with M8b's. Rulings are recorded in `docs/history/decisions-m9.md`. Commits on m4 as `kizo-core`, never pushed.

## Conclusion

M9 gives poly delegated credentials under the gate. It starts from a plan, rules Q8 first because it decides who may change the rules credentials obey, and carries M8's limits forward with a named step for each. E13 is the owner's and must land before M9's gate.
