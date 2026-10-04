# polyflow: the platform kernel and verifier, and the server, vendored

Two selections from polyflow, copied unchanged: the files of the platform's `kernel` and `verify` packages that poly's ledger uses (PT16, AD-3), and, for M6 (AC5), polyflow's MCP server and library with its own `customer-brief` workflow. poly relies on the Poly stack conceptually, not physically: the engines are read here, and a change an engine needs is made in its own repository and then copied in again.

- Source: `C:/Users/jjdub/code/polyflow`, commit `5170add` (`5170addf46316c0f6cc07fedc63af906ab98ffe2`, "Merge platform/temporal-governance"). Uncommitted work in that checkout is not included: each file is taken with `git show 5170add:<path>`.
- Selection: the relative-import closure of `platform/packages/kernel/src/ledger.mjs` (the chain: `genesis`, `hashOf`, `openLedger`, `verifyChain`) and of `platform/packages/verify/src/verify.mjs` with `sink.mjs` (`verifyBundle`, `signHead`, `verifyHead`, `headMessage`). Paths keep their place in the source repository.
- Licence: both packages are Apache-2.0, in their `LICENSE` files. Nothing under the BUSL licence (the Temporal plugin, the certificate signer, the CLI) is vendored; poly signs certificates with `node:crypto` itself (S126).
- The second selection (M6 step 0): the relative-import closure of `bin/polyflow-mcp.mjs` (`src/daemon.mjs`, `tools.mjs`, `mcp.mjs`, `polyrun.mjs`, `library.mjs`, `broker.mjs`, `areas.mjs`), the root `LICENSE` (Apache-2.0), and `workflows/customer-brief/`, the hand-written workflow AC5 compares poly's against. The server finds polyrun at `vendor/polygraph` (its sibling-checkout candidate), and the tests name it with `POLYFLOW_POLYRUN`. Nothing of the installer, the adapters, the platform's Temporal plugin or its CLI is vendored.
- The three `package.json` files are written for poly and are not copies: the two platform packages' (name, exports, module type), and the server's, whose `version` (0.4.2, polyflow's at 5170add) the server reads and announces.
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
| `LICENSE` | `3b7209b4334d5430226dbcc74d5ec5cbab36a02149c030a9fab2158fe19d91aa` |
| `bin/polyflow-mcp.mjs` | `31a1e4856748615b55bcfeee1518552a12737d8c296c0142b6d0061b573bf154` |
| `src/areas.mjs` | `5118fb229bb8f9053d443a8697b46a2cee0d50af5b9341e68a823b08d9e095d1` |
| `src/broker.mjs` | `058c781053d1ae7d489abd50c2cda4a13ba3237da7b276ab1a334ac312005464` |
| `src/daemon.mjs` | `997d9c7101d74a27bfacc158e43d05254e1a9d0f42ba2fc5668ae1ad59d9e752` |
| `src/library.mjs` | `70a43c8934c33336d2b108a6ab27b9201217b4e9972a2540f74cb46c304c8162` |
| `src/mcp.mjs` | `871aaccfac7052d426523726dab4622cffb992599b45e991c157725e9f80d095` |
| `src/polyrun.mjs` | `e38d781ecc058bc3e049516582f253045930346059a7dc8ef0eb4c6086ab54d3` |
| `src/tools.mjs` | `070ea1f6630c002dacdfb40888cfedd2c691536e0dc38eb0352f0ebe97b5e739` |
| `workflows/customer-brief/contract.json` | `0f0d4f0ae0065830ca85c4b80ca4896bb8c6190686b96641630435c7a84c1d2e` |
| `workflows/customer-brief/effect-invariants.mjs` | `4174e2197f8c7082f77d09a636d85f4750581e726509a8b001fe861993720fc3` |
| `workflows/customer-brief/effects.cjs` | `b10a3ec806e18a242be27b1c4e200edf42c45ccdfa83e1aa3e28fc2d1796467e` |
| `workflows/customer-brief/effects.manifest.json` | `c108815d855624f795cb86687888143ea9b68fb50614d38707eb93e1cf24c02f` |
| `workflows/customer-brief/machine.cjs` | `0c3a665fc5836155c2185c5fc06c3ea4d7f08080a9974a7e82c07d8fe36ccb1b` |
| `workflows/customer-brief/polyflow.workflow.json` | `cdc6e58b8e039c5f3b1e5cc6b98123bfbf82927cee19f45fdab4638404bbf0d7` |

## Conclusion

These files are polyflow at 5170add, byte for byte. To take a newer polyflow (E2 first), copy the same selections from the new commit and update this table in the same commit.
