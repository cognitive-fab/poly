# polyflow platform kernel and verifier, vendored

The files of the polyflow platform's `kernel` and `verify` packages that poly's ledger uses (PT16, AD-3), and nothing else, copied unchanged. poly relies on the Poly stack conceptually, not physically: the engines are read here, and a change an engine needs is made in its own repository and then copied in again.

- Source: `C:/Users/jjdub/code/polyflow`, commit `5170add` (`5170addf46316c0f6cc07fedc63af906ab98ffe2`, "Merge platform/temporal-governance"). Uncommitted work in that checkout is not included: each file is taken with `git show 5170add:<path>`.
- Selection: the relative-import closure of `platform/packages/kernel/src/ledger.mjs` (the chain: `genesis`, `hashOf`, `openLedger`, `verifyChain`) and of `platform/packages/verify/src/verify.mjs` with `sink.mjs` (`verifyBundle`, `signHead`, `verifyHead`, `headMessage`). Paths keep their place in the source repository.
- Licence: both packages are Apache-2.0, in their `LICENSE` files. Nothing under the BUSL licence (the Temporal plugin, the certificate signer, the CLI) is vendored; poly signs certificates with `node:crypto` itself (S126).
- The two `package.json` files are written for poly (name, exports, module type) and are not copies.
- **Engine change E2 is pending.** `KINDS` in `ledger.mjs` is frozen to six kinds, and `verifyChain` refuses `step`, `advice`, `decision` and `outcome`. Until E2 is made in polyflow and re-vendored here, poly hashes its events with this `hashOf` and `genesis`, and verifies its chains with its own verifier in the same format (S122).

`test/vendor.test.mjs` re-hashes every file against this table, and, where the source checkout exists, compares each file with the commit.

| File | sha256 |
|---|---|
| `platform/packages/kernel/LICENSE` | `3b7209b4334d5430226dbcc74d5ec5cbab36a02149c030a9fab2158fe19d91aa` |
| `platform/packages/kernel/src/canonical.mjs` | `2aadfc81d7087753da2415938d679e7f2323b728b2c34150a6429b5608793422` |
| `platform/packages/kernel/src/digest.mjs` | `78537af59ab3e496649c78f9b47eb269a070010e2f2425ef06061f52f89fb997` |
| `platform/packages/kernel/src/ledger.mjs` | `f8ee2556272aa14617213c4daec88014cfc52bcf84483fe5a5f9b822d0eb2675` |
| `platform/packages/kernel/src/sha256.mjs` | `e9350f2fb4833c625abaf6c922d4b9245d961db89ce8aae46fab2e1f85304acc` |
| `platform/packages/verify/LICENSE` | `3b7209b4334d5430226dbcc74d5ec5cbab36a02149c030a9fab2158fe19d91aa` |
| `platform/packages/verify/src/sink.mjs` | `3601df111be2336c44a15ca690e7fc2a27b6b45021912059a2eeac004b390701` |
| `platform/packages/verify/src/verify.mjs` | `ad8db4ad64ee7ed42ebd666a75823d169281e7fa83e985dca8a405bfedac57f9` |

## Conclusion

These files are the polyflow platform at 5170add, byte for byte. To take a newer polyflow (E2 first), copy the same closure from the new commit and update this table in the same commit.
