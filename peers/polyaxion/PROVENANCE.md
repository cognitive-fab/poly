# Polyaxion, polyman and polysec-core, an optional peer dependency

The gate engine poly-runtime hosts in process (PT9, S146), and the admission engine poly-check runs over policies (PT8.4). The three packages are BUSL-1.1, so they are **not vendored** into this repository (S145): they are resolved from a sibling checkout, `../polyaxion` beside the repository or the directory `POLY_POLYAXION_DIR` names. Each file poly runs is pinned here by the SHA-256 of its bytes at the pinned commit, exactly as a vendored engine is pinned. A checkout may hold CRLF where the commit holds LF, so a pin reads CRLF as LF (`pinDigest` in `poly-runtime/src/peers.ts`).

- Source: `C:/Users/jjdub/code/polyaxion`, commit `c37c60e` (`c37c60e0adef7116f3dd2d27c57787927a4ea788`, "docs/architecture: re-rendered at 64bffcb — the licence box says BUSL 1.1, polygraph 8.3.0, and the install is 7 packages and 3.1 MB").
- Selection: the runtime files of the three packages: `src`, `package.json` and `LICENSE` of each, with polysec-core's `labels` and polyman's `vendor` (its copy of sam-pattern). polyman is loaded from its TypeScript source, as Polyaxion's own resolver prefers in a checkout.
- Licence: BUSL-1.1, in each `LICENSE`. poly's own licence is the owner's open decision (S145).
- Not pinned: polysec-core's `harden` imports `@cognitive-fab/polygraph` from the checkout's own install (8.3.0). It runs at policy admission only, never on the step path.
- Polyaxion loads polysec-core package first (`runtime/deps.mjs`). The peer is refused unless the first `node_modules/@cognitive-fab/polysec-core` Node finds from the engine is the pinned `packages/polysec-core` itself, or there is none (review A2).
- Where the checkout is absent, or a file differs from its pin, every check that needs the engine is listed as not run, and `load` refuses a build with policies (no gate is assumed).

`test/vendor.test.mjs` re-hashes every file against this table, and compares each with the commit.

| File | sha256 |
|---|---|
| `packages/polyaxion/LICENSE` | `e218f53f0f0a5199b6ccbf88b49544145f7367fe7f8b912542d67e9479bc7bd4` |
| `packages/polyaxion/package.json` | `fc5f8c2ce0902e9952f6ba13df511128eaa19913677ab23c4126ad71dfd85767` |
| `packages/polyaxion/src/admission.mjs` | `3aec8843c6a683c15652c6dd78205582cfa6514946c81a452774144f32783ea9` |
| `packages/polyaxion/src/compile/bound.mjs` | `aa780734019b7cf9e814edb46291b0e4bdccbf0f9570c5253fa0d26d7ea0346e` |
| `packages/polyaxion/src/compile/discharge.mjs` | `68483037641071b0398f5bacd88d79eb9ec5900b2b844b6073961206746c37db` |
| `packages/polyaxion/src/compile/emit.mjs` | `62a2f2f4eb07821d233d4a77761d8bc0c02814df42be67a063879b3307ba31fb` |
| `packages/polyaxion/src/compile/index.mjs` | `086cb3e59486ee2f6160d83f04d982300fa2bf4d8be854943b97790c54c4c53c` |
| `packages/polyaxion/src/compile/plan.mjs` | `58c34ee7bf17f796b5c94ffac9374dfb629277a8e0cb447eb574718a4751375e` |
| `packages/polyaxion/src/compile/samples.mjs` | `7202497076bd1160ed19583d0fa9c4f8b82f2679042652b2d8758e614ef2c7f8` |
| `packages/polyaxion/src/core/action.mjs` | `aa3561407a6d57dbad2fcbebfa144ebf40630e9204f9ae61020f0b646bb6fc7b` |
| `packages/polyaxion/src/core/canon.mjs` | `e19bc9f96eced85541a86cddd4fed5e0b19de3675f9ea3b8ad3ed1af2c5a666a` |
| `packages/polyaxion/src/core/expr.mjs` | `e13d6e5be897f5a1c3be8fd3614eebe8efca763e76cc46460277e4a5afd8ce13` |
| `packages/polyaxion/src/core/index.mjs` | `1ec4cda5fbdb4724e1f0b353874e3565bc3cf986c95cefd556069e1ee61021a0` |
| `packages/polyaxion/src/core/policy.mjs` | `ca4017f3219c93cc28e304c7a97064c2134c70b98a8d5b22cf245e665fe47f63` |
| `packages/polyaxion/src/core/scope.mjs` | `c18d4b95391971402958c110d7c12ab77b5928dba6415e755a4d088c4727ff66` |
| `packages/polyaxion/src/core/step.mjs` | `754a4e03a54b3d4bb4764af0d87b5e7465adb65b33ba1d834826eaacf3727bb7` |
| `packages/polyaxion/src/core/witness.mjs` | `1819d89e029f043980c15ddcb2c6f97c5f5bcef2310ad6d753d04ab7b5cc0a0f` |
| `packages/polyaxion/src/daemon.mjs` | `cbef6eda302371a93eff1babd8246e726f4118a7c7ad2117d4a1631735e0ef8c` |
| `packages/polyaxion/src/engine.mjs` | `f1bb6e045d0988a8c912c82d16d98e4c1cbea1c6b6ddbe06771d515d10ae8380` |
| `packages/polyaxion/src/index.mjs` | `9fb1ef58f42812cbb670d58a123dbf8891b371d2a0a9a356ace4cfe224442a2d` |
| `packages/polyaxion/src/mcp/server.mjs` | `63405aaf7a91e9645f0b52e05681a8ab44ba1c98de899700f040a71e7c2968be` |
| `packages/polyaxion/src/mcp/tools.mjs` | `e9c0bcd657a1f097e1779404c3f3d77113ee070e1d7a62d0fcb89b6a7c0bb7cf` |
| `packages/polyaxion/src/mounts/claude-code/extract.mjs` | `e554f1e48b15012f55823cae05521e252531ae464a50426aac001dfedd473800` |
| `packages/polyaxion/src/mounts/claude-code/hook.mjs` | `26f19c3a9e61bc48ae36d8b83fe9c57542703d5af7fd23631d569192f5db287e` |
| `packages/polyaxion/src/mounts/claude-code/index.mjs` | `67fd0974de26f90c5638079e45da0dea5c08eeebc38e82fc1474c46221e9d07e` |
| `packages/polyaxion/src/mounts/claude-code/install.mjs` | `7d2abcdb68284cfe362603871a17aedf8005c849f7258a9fad01a3ba16945578` |
| `packages/polyaxion/src/mounts/sdk.mjs` | `37c71bc5e0bc85cfb066da103ab141d8598f402eb7b9ab3af69682ace34ecd1d` |
| `packages/polyaxion/src/runtime/catalogue.mjs` | `1c029f5c3964266ade20b5cc71403d823c2c44e1f2f9095e3cd5108eb7a1c263` |
| `packages/polyaxion/src/runtime/compat.mjs` | `c9ab4382212ad971a91b47f859856136fd6cab78d359ae707575518811b2cd91` |
| `packages/polyaxion/src/runtime/deps.mjs` | `f12ca550c16ff176de98880bbffda75a7300641d907a6d68258d09b50f43a785` |
| `packages/polyaxion/src/runtime/evidence.mjs` | `5375fd2a209f28da478364d0fb1d5627fbc7e2f9240522973cb65877d2e0ac20` |
| `packages/polyaxion/src/runtime/gate.mjs` | `6e36f2b00772c35b48f5a6ef3d05ecaeb25932269c76072b11c740a384b332cd` |
| `packages/polyaxion/src/runtime/labeler.mjs` | `412f68424462d9a89e8d621cd620982b1725cc0af44f1955b3e663e52b1d3dcd` |
| `packages/polyaxion/src/runtime/native.mjs` | `81e497097b0042368a2913ad36cc89397fd0866b143435e19ae01d2aed46bee7` |
| `packages/polyaxion/src/runtime/stores.mjs` | `854e53a0c897f37ffaf7f4dbf62f7086d7837fb90d28250202183335d00fd568` |
| `packages/polyaxion/src/runtime/witness.mjs` | `45dd035f1b200d14012bf99a9115ebae85ad1ebd9a4d8dbc08f4f3f13a1ded2c` |
| `packages/polyaxion/src/store/store.mjs` | `b0a370ca0d3407b3a6da02c6863836fcfcd4ec6c975235c419164361a3e818fd` |
| `packages/polysec-core/LICENSE` | `e218f53f0f0a5199b6ccbf88b49544145f7367fe7f8b912542d67e9479bc7bd4` |
| `packages/polysec-core/labels/catalogue.json` | `1cce4e7a2aa5601449a799b29601e1819b51f4c76de1ce5beec2c867b46290c1` |
| `packages/polysec-core/labels/catalogue.meta.json` | `296a6bba3c5d3b1c9194dfc03d7e0f122e1588dd9f8d6d9f88e92edaa8823d08` |
| `packages/polysec-core/package.json` | `0773197fbc8cf582b5cc95eab66f9746291c0874d21b8cc2521acb12e6b2361d` |
| `packages/polysec-core/src/polysec-canon.mjs` | `6b5525a7fa5e2ccbb7f7c11c78722941b505cfe6e475145f8d138abc77718b3a` |
| `packages/polysec-core/src/polysec-catalogue.mjs` | `3edd928a9ded453e61ccd04c6eee4d63cb4c0504896ac0da80e7d7acf8207396` |
| `packages/polysec-core/src/polysec-harden.mjs` | `33c13d6c684cbb89b8416857af73d4ac464e50c5edc45b3e7df6ea9165d10bd8` |
| `packages/polysec-core/src/polysec-lib.mjs` | `c8f470aaf34f904aba93a7df77398a76656946aa9c0fbd09d5eb30ca816f880c` |
| `packages/polysec-core/src/polysec-notary.mjs` | `fa8360abcfc3e4139ceb5b8192251f2bdae38a3fa0d9ddbce22f0fde80ad4418` |
| `packages/polysec-core/src/polysec-tool-labels.mjs` | `a2626cc434b4c2a4c9a61ea5d3b00ce06669bf7eb13784f40448c6b4a7c7e08a` |
| `packages/polysec/polyman/LICENSE` | `e218f53f0f0a5199b6ccbf88b49544145f7367fe7f8b912542d67e9479bc7bd4` |
| `packages/polysec/polyman/package.json` | `382779324c1b33d2c0624b76f2b7b0606181b39bdcffb51954616e35def71cd2` |
| `packages/polysec/polyman/src/config.ts` | `cee41924959bbc5242a01ef00135ba14fd39b3849ef774f072990ccf17b0b5d2` |
| `packages/polysec/polyman/src/defaults.ts` | `3be3bcde8222ff9713099db59685a32dbfcaec10e9a732be9e97e436d328a707` |
| `packages/polysec/polyman/src/engine.ts` | `ab23f184fee3d5b742a9f1cf41d513e4c8bcc5ec7a6a9c7f1633dd89fb37d3b4` |
| `packages/polysec/polyman/src/guard.ts` | `8d37bd9d0b5be2fd6706658ac31d15bb8b6de04144fa518f5d7bcd14334ed187` |
| `packages/polysec/polyman/src/index.ts` | `af6978cd04701ed072c2b5e19f5438581fd7418efa3d3772432ca6b00f47bd55` |
| `packages/polysec/polyman/src/journal.ts` | `d3d653e14cbeea6df9562b19d02751def702aefa96bb1be4f38512f98676ca50` |
| `packages/polysec/polyman/src/kernel.ts` | `1a79ffedd5999aa0298f4b45aa214a757c3f5b91589c386e7a44c1dd1600b0d8` |
| `packages/polysec/polyman/src/labeler.ts` | `82a5ff11340876dc3465828ed301c4dac9bad2518ca06312099989443a1aabc0` |
| `packages/polysec/polyman/src/load-machine.ts` | `9dc83fd32af49e5940f553176fc5d592a2414baf36e4f5d3fc04b8f992940c78` |
| `packages/polysec/polyman/src/mcp.ts` | `0169d3e5013658e81f2e08c1f31e67664d2edc33efc2f022a8e336c310ec1e61` |
| `packages/polysec/polyman/src/region.ts` | `9b54b14cf750ced5e2a7ea1ded9c4c5f95bfc52f506604f91c1258a21abf6b2d` |
| `packages/polysec/polyman/src/session-store.ts` | `bff24ff300aaa70aca8f8e93032e939c5df8926b2ab0e62938737f06c962a976` |
| `packages/polysec/polyman/src/types.ts` | `ffe1ae04e7dae9706aeb8eea38619a7e243dca1b61d4b9b51624c0a1308291db` |
| `packages/polysec/polyman/src/vercel.ts` | `e70f097483997838427c74970accb8d5cd8c69634751bd4077ae80ab2174d4be` |
| `packages/polysec/polyman/vendor/README.md` | `c2f184aa050249d0d4de66ef67fbc613cd6026df101d7aaacd21d5a7f54f6557` |
| `packages/polysec/polyman/vendor/sam-pattern.cjs` | `fdf1fe6df0826f24c3c2e076a05826aac884d800546d82f9ed1f82c48571ba87` |

## Conclusion

These are the files of the three packages at c37c60e, by hash. To move the pin, run `node scripts/pin-peers.mjs <checkout> <commit>` and commit the new table with the change that needs it.
