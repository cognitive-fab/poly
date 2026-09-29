# Provenance: raft

The raft role-transition field study (osssm/polygraph-raft; not a git repository, so the hashes below pin it).

| Item | Value |
|---|---|
| Source path | `osssm/polygraph-raft` (under the owner's code root) |
| Source commit | not a git repository |
| Upstream project | hashicorp/raft (https://github.com/hashicorp/raft). The traces were captured from a live three-node cluster of a local clone, through trace_capture_test.go added to the clone (not upstream); see REPORT.md. |
| Upstream commit | `dd30865f162c68ee31130c7f8ee1047e9122f2ec` |
| Licence | MPL-2.0 for hashicorp/raft (osssm/raft/LICENSE). The study directory carries no licence file of its own. |
| Positive control | `specs/reference.js` |
| Negative control | `specs_broken/reference.js` |

These are data for the M0 gate (PT18): the traces, contract and hand-written controls of the study. No engine code is copied. `scripts/sync-corpora.mjs` re-verifies every hash below against the copies, and against the local source when it exists.

| File | SHA-256 |
|---|---|
| `REPORT.md` | `2c2aad3cdfc3840693d3503b29b1856b6f47c2497fbc95a7de07f9b65d2d3f86` |
| `contract.json` | `bcf66e7807107b548f180d3ec3af863a903630ab412b34f6033afce25bf01b97` |
| `invariants.mjs` | `bed8a2a0b100637fac599420f6485c8c3bc6847ad98911960a00249261c0a6ea` |
| `traces/s1_election_run0_node0.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s1_election_run1_node0.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s1_election_run2_node2.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s1_election_run3_node2.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s1_election_run4_node1.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s2_isolate_reconnect_run0_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s2_isolate_reconnect_run0_node1.ndjson` | `a7d0975de985020a6b91c4ac40a7ec9a4f6ee2c1fccd79c1eac9f5cc44d748d2` |
| `traces/s2_isolate_reconnect_run0_node2.ndjson` | `33b5e699d67bd9e88d6aa8cbd7cc5199724d9c89ac4db271660db9ccac161738` |
| `traces/s2_isolate_reconnect_run1_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s2_isolate_reconnect_run1_node1.ndjson` | `a7d0975de985020a6b91c4ac40a7ec9a4f6ee2c1fccd79c1eac9f5cc44d748d2` |
| `traces/s2_isolate_reconnect_run1_node2.ndjson` | `33b5e699d67bd9e88d6aa8cbd7cc5199724d9c89ac4db271660db9ccac161738` |
| `traces/s2_isolate_reconnect_run2_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s2_isolate_reconnect_run2_node1.ndjson` | `a7d0975de985020a6b91c4ac40a7ec9a4f6ee2c1fccd79c1eac9f5cc44d748d2` |
| `traces/s2_isolate_reconnect_run2_node2.ndjson` | `33b5e699d67bd9e88d6aa8cbd7cc5199724d9c89ac4db271660db9ccac161738` |
| `traces/s3_leadership_transfer_run0_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s3_leadership_transfer_run0_node1.ndjson` | `88719ba211b3c695a117e18b6d68b93e4095cd84eb6fd19659b34e4a52c21bcf` |
| `traces/s3_leadership_transfer_run0_node2.ndjson` | `b1474c81a964b3c3020cf0861b2330f485280d6fe22a5fa7539bac739926ff42` |
| `traces/s3_leadership_transfer_run1_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s3_leadership_transfer_run1_node1.ndjson` | `b1474c81a964b3c3020cf0861b2330f485280d6fe22a5fa7539bac739926ff42` |
| `traces/s3_leadership_transfer_run2_node0.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s3_leadership_transfer_run2_node2.ndjson` | `b1474c81a964b3c3020cf0861b2330f485280d6fe22a5fa7539bac739926ff42` |
| `traces/s4_shutdown_run0_node0.ndjson` | `3a1d5bea8b86ccfd7be31bc8968ef4cf054a7bd00132fb76b130f5a3099a835d` |
| `traces/s4_shutdown_run0_node2.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s4_shutdown_run1_node0.ndjson` | `a7d0975de985020a6b91c4ac40a7ec9a4f6ee2c1fccd79c1eac9f5cc44d748d2` |
| `traces/s4_shutdown_run1_node1.ndjson` | `c2a48c38bf402298ced09344ffe8b4760f5ed4ca215235252be840cebbdc9033` |
| `traces/s4_shutdown_run1_node2.ndjson` | `fa7fc4c11edce0c326182016807711ecf0b3583f0c462bcf26e4b6c7a3354d2d` |
| `traces/s4_shutdown_run2_node0.ndjson` | `89012ec187de34562bebcff7a9728c80be7690a4d03c9d09cc08d550dce2ea7e` |
| `traces/s4_shutdown_run2_node1.ndjson` | `3a1d5bea8b86ccfd7be31bc8968ef4cf054a7bd00132fb76b130f5a3099a835d` |
| `specs/reference.js` | `6f60163cd29337f64d84aaee80871fdced14148d31f793d5f5f0b123395fc948` |
| `specs_broken/reference.js` | `4ed3bae3b567bf894deb446f4061bc29a22dd5edc14f077ec7e8f81cacb99342` |

## Conclusion

The copies are pinned by their hashes. A change to a corpus is a new copy with a new provenance record, never an edit in place.
