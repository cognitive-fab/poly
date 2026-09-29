# Provenance: turnstile

The turnstile example of the polygraph engine: a reference SAM v2 module, its mutant, and a hand-written trace corpus.

| Item | Value |
|---|---|
| Source path | `polygraph/examples/turnstile-v2` (under the owner's code root) |
| Source commit | `6f260f0cedc12bab20b585dd60fea4bcb44a3c5b` |
| Upstream project | cognitive-fab/polygraph (https://github.com/cognitive-fab/polygraph), examples/turnstile-v2. The traces are hand-written for the example; no third-party code produced them. |
| Upstream commit | `6f260f0cedc12bab20b585dd60fea4bcb44a3c5b` |
| Licence | Apache-2.0 (polygraph/LICENSE) |
| Positive control | `specs/reference.js` |
| Negative control | `specs-mutant/mutant.js` |

These are data for the M0 gate (PT18): the traces, contract and hand-written controls of the study. No engine code is copied. `scripts/sync-corpora.mjs` re-verifies every hash below against the copies, and against the local source when it exists.

| File | SHA-256 |
|---|---|
| `README.md` | `9651c1f2814f1068a9f1f576cdb02267522f99d03852a6f7a857979eead85073` |
| `contract.json` | `4032f01209a80f911100b6005c9f3c5ddfb36e501be581809da19a03a30fc2b3` |
| `traces/s1_normal.ndjson` | `070adbcb117725af05cb5ca61ec64bcc876dfdd7f18e06b1946125ea86c04dcc` |
| `traces/s2_noop_and_extra_coin.ndjson` | `1405804590894098a08db4b751f1ce3f58b46f1a043338ba0114354c42bac717` |
| `traces/s3_noop.ndjson` | `563fd26f78e9ab8430222f10123a65ec84a0460d08784dc2a06f54998409a0c9` |
| `specs/reference.js` | `6dfee56b006da74b90d5eed4c398d70f38b80b69118b32e0757d0714bb94278e` |
| `specs-mutant/mutant.js` | `6095d6d7e38be1e6554080ea66f87a967a9a147e806a155a55483fb4e00b39fd` |

## Conclusion

The copies are pinned by their hashes. A change to a corpus is a new copy with a new provenance record, never an edit in place.
