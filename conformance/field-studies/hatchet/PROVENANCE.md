# Provenance: hatchet

The hatchet workflow-status field study (osssm/polygraph-hatchet; not a git repository, so the hashes below pin it).

| Item | Value |
|---|---|
| Source path | `osssm/polygraph-hatchet` (under the owner's code root) |
| Source commit | not a git repository |
| Upstream project | hatchet-dev/hatchet (https://github.com/hatchet-dev/hatchet), DeriveWorkflowRunStatus. The traces were captured through internal/statusutils/trace_capture_test.go added to a local clone (not upstream); see REPORT.md. |
| Upstream commit | `df47a7b7d85ddc0f85aafed49a162eba166968f4` |
| Licence | MIT for hatchet-dev/hatchet (osssm/hatchet/LICENSE). The study directory carries no licence file of its own. |
| Positive control | `specs/reference.js` |
| Negative control | `specs_broken/reference.js` |

These are data for the M0 gate (PT18): the traces, contract and hand-written controls of the study. No engine code is copied. `scripts/sync-corpora.mjs` re-verifies every hash below against the copies, and against the local source when it exists.

| File | SHA-256 |
|---|---|
| `REPORT.md` | `74affe7f4f0cf7365b1681690ae096a16a8ef7620473842f42a6c565cab2c236` |
| `contract.json` | `028b0f62ad6b9b536b376c01e7f535f3f59aeee1f1463dec2abe7eee372b0dd8` |
| `invariants.mjs` | `d04e95c0097c2614c0afa36809693583215519902abd627de35180e337634ffd` |
| `traces/s1_all_succeed.ndjson` | `333373fd203df3ba5206988dd7f5d89151e985f870268f54961c4cd1c2eda202` |
| `traces/s2_one_fails_dominates.ndjson` | `647f25debcdb5fe7d94026f869c39eee172bfcb734c3a965428cf53f89b16ade` |
| `traces/s3_partial_cancel_with_completed.ndjson` | `d8da863182a7e213da7a168b171def3665d8278acadca7e53ddf7f8c7027677a` |
| `traces/s4_evicted_counts_as_running.ndjson` | `007a4c3d3cc20605602f0d21030cf22056cf1514ad7a8f3621edcdc7f8eef481` |
| `traces/s5_cancel_beats_queued_alone.ndjson` | `9dceef0484a1bb55cfed823ed4193d55de8f5dd10e886a08d1a208d0f77b97df` |
| `specs/reference.js` | `e4911fc217a7642de9ac8c1afae367fc3b2a47330bdc842468874077559e781c` |
| `specs_broken/reference.js` | `b6c72f07ba833634f67b18c85cd4785fb043abf4b90801057bf35c89d705aaa4` |

## Conclusion

The copies are pinned by their hashes. A change to a corpus is a new copy with a new provenance record, never an edit in place.
