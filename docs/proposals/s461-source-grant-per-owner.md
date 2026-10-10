# S461: an owned source's credential, with one grant per owner

Status: proposed by the examples session, for the release session. The owner's reviewer set its conditions on 2026-10-10. It amends PS17.0 and PT10j as S460 left them.

## The gap

Under S460 a source names a credential with no holder. That credential has one grant, one `Grant` instance and one handle, `rt.credentialHandle(c)`. The Gmail source sends each account's requests under that account's own read token, and one Google token reaches one mailbox. So under S460 a source reaches exactly one mailbox.

The inbox reads every configured account (IF2.1, IF4.1: "any number of accounts, each authorized once by the owner"), and IAC1 needs three accounts in one assistant. Its mail source is `owned`: each item has one owner, the account's principal (S451). There are three ways to read three mailboxes on v1 as it stands, and each loses something:

- **One source per account.** The accounts are fixed in the program, and each machine needs one retrieval per source.
- **One runtime per account.** The monthly budget is no longer shared.
- **A read vault the host keeps.** The runtime cannot revoke the grant, which is the gap Q-EX8 refused for the release.

## The proposal

An owned source's credential may name `holder Principal`. Its grants are then per owner, as an effect's credential held by a Principal already is (PS16.2, M9).

1. **The text.** `credential c` in an `owned` source may name a credential with `holder Principal`; `PL1201` keeps refusing a holder on a source that is not owned, and on a `memory` source. A source still names at most one credential.
2. **The grants.** Each owner gets one `Grant` instance, keyed by the owner's verified Principal (S450), and requested as an effect's held credential is: `rt.requestGrant(c, owner)`.
3. **The handle.** `rt.credentialHandle(c, owner)` returns a handle that sends only under that owner's grant: within the provider's base addresses (`PL6406`), and only while that grant is `Granted` (`credential-unavailable`).
4. **No crossing.** A request made for one owner's items never goes out under another owner's handle. The adapter is built with one handle per owner, and the runtime records each one with its owner. `rt.connectSource` refuses (`PL6408`) an adapter whose handles are not this runtime's handles for this credential. At run time a retrieval for owner `o` is refused when it is made through a handle that is not `o`'s. A test shows each refusal.
5. **Revocation.** Revoking one owner's grant (PS16.4) stops only that owner's requests, its sync included. A test shows the other owners' accounts still syncing.
6. **The checker.** Grants are treated per owner, as M9 already treats a credential held by a Principal. The state space gains nothing beyond one `Grant` per owner, which the instance already has.

## What it touches

| Part | Change |
|---|---|
| PS17.0, PT10j | the holder rule for an owned source, `rt.credentialHandle(c, owner)`, and the per-owner refusal |
| poly-core | `PL1201` accepts `holder Principal` for an owned source's credential |
| poly-runtime | handles keyed by credential and owner; `connectSource` checks each one; a retrieval for one owner uses only that owner's handle |
| poly-io | the adapters that take a handle take one per owner: `gmailSource` (examples branch, S452, additive) and `openSearchSource` |
| tests | the refusals in item 4, and the revocation in item 5 |

## What the examples branch does meanwhile

- **S460, one account.** The mail source names the holder-less `gmail_read`, and the Gmail source is built with `rt.credentialHandle('gmail_read')`. A test covers this and the revocation: `test/ex-inbox-read-grant.test.mjs`.
- **IAC1's three accounts.** They stay on the read vault the host keeps until S461 lands. The host vault is then deleted, and IAC1 runs on the per-owner grants.

## Conclusion

S460 closes the revocation gap for one mailbox, and S461 closes it for any number. The change follows the rule M9 already applies to an effect's held credential. It adds no state beyond one `Grant` per owner, and it makes the cross-owner refusal part of the runtime rather than of the host.
