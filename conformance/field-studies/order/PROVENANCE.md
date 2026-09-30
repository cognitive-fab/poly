# Provenance: order

The OMS reference application of polyrun: the order machine, its shipment child, the effect mapper, manifest and effect invariants, and the order's sixteen hand-written trace files (corpus (a) of S24).

| Item | Value |
|---|---|
| Source path | `polygraph/examples/polyrun-oms` (under the owner's code root) |
| Source commit | `583b82cc68267888516743e048f7d5c36001d46a` |
| Upstream project | cognitive-fab/polygraph (https://github.com/cognitive-fab/polygraph), examples/polyrun-oms. The traces are hand-written for the example and predate the module's migration to next-state semantics (polygraph 22c676f), so every window has post equal to pre (S24). |
| Upstream commit | `583b82cc68267888516743e048f7d5c36001d46a` |
| Licence | Apache-2.0 (polygraph/LICENSE) |
| Positive control | `machines/order/next.cjs` |
| Negative control | `none: AC1 compares the poly order with the hand-written one` |

These are data for the M1 gate (PT18): the traces, contracts and hand-written controls of the study. No engine code is copied. `scripts/sync-corpora.mjs` re-verifies every hash below against the copies, and against the local source when it exists.

| File | SHA-256 |
|---|---|
| `README.md` | `6a5751a0daac9e62f94f76726ca30d1ad2babb4e045acdb4e0ddb8cae1a1d114` |
| `effects.cjs` | `ac1963f2aae1ce5b8bc7d063d28e35fb70db33d58aa81fa3453e20eea12515fc` |
| `effects.manifest.json` | `17f595d5001e7226eb1dca29a265522c2573ed95ed4ddc187201a52e05fc2cc6` |
| `effect-invariants.mjs` | `317e9f0903676ce0f9fe6d0ec6e524e5cda494551cbc5cd538222369fc426932` |
| `machines/order-contract.json` | `8311d9e50dda61f0d177cf3df3def28f114cb79b0ada5e1f159616d211b1bc5a` |
| `machines/order/contract.json` | `ee657efe674c39b0ce5a31dace6c231a0810c96dccbc6d2d2d7b1d44b522cbbd` |
| `machines/order/next.cjs` | `cbc61651566617cb159e63ae0b41adf991cba317a6596cd0be9e5556593371ff` |
| `machines/order/invariants.mjs` | `b85aa17be1fe24278d1ceacfb37b9bd5a6b51c519a5f1344639c8c91f0841c46` |
| `machines/order/traces/all_shipments_failed_partial_rollup.ndjson` | `e88d1e47b106b9a0c71e507d38065555008cd6bb7ab5c06cddcc83316635fb71` |
| `machines/order/traces/amend_resets_rollup_then_completed.ndjson` | `16592d9bdbc4672caddcbe37da5c7d0622c608f04cec64a85345b78f70f41b9e` |
| `machines/order/traces/amend_window_expired_cancelled.ndjson` | `9da381dc5c4cf4d850df8f2a9cda72ddd03ab8871c08e17748a21d771c6ac005` |
| `machines/order/traces/cancel_blocked_then_fulfilling_blocked_then_completed.ndjson` | `6abf549004125d7b22a9bcc4814bf6a245042c314dbe10e7d05e592cea20d3a3` |
| `machines/order/traces/cancel_from_awaiting_amend.ndjson` | `b8b52e526c3f6e03f4542989931f866385b4be39e58f0bed61d313074899fffb` |
| `machines/order/traces/cancel_from_fraud_check_with_submit_noop.ndjson` | `661df2c25f9f5371241fcb7fda0a6f9e1d70b28728b548be1df2cfba76d83536` |
| `machines/order/traces/cancel_from_pending_with_late_submit.ndjson` | `36a38d91582b465bee16138ec2d7f9781324f6835ec5c1cb3207c1ee73da0c39` |
| `machines/order/traces/duplicate_charge_retries_then_partial.ndjson` | `d3d6d521869804c06d8b8b792af43a67fd6f35184af74d92ce400ad1d3269e8f` |
| `machines/order/traces/fraud_rejected_with_stale_charge.ndjson` | `d9102dd1a6f0e9fd6b041df3a5c4cecaa941fb293511c0756787e19201790ced` |
| `machines/order/traces/happy_path_two_shipments_completed.ndjson` | `05d67817c88b146e2b1ad775e667b6e9325807abbb6d25c3a3def7a2d8678652` |
| `machines/order/traces/late_completions_after_terminal.ndjson` | `ff528e256a637e548dcbda10951aecf3778c4e0e824a86f2afeba85e878b6cc6` |
| `machines/order/traces/partial_delivery_mixed_rollup.ndjson` | `2e1efe4774bc6c06f77e9dc5de95b3538d1f1567670e756abfeb51563d89cd90` |
| `machines/order/traces/payment_declined_with_cancel_blocked.ndjson` | `e6ae9d465b7235cc289f524128c8bc88e51fd3967fd94e888d09bf5f2fb0541b` |
| `machines/order/traces/payment_timeout_with_cancel_blocked.ndjson` | `be8a69722cc29e1402ea9894ecac5d89fb938d3b95cf87fccc9f9b0a21f09d5e` |
| `machines/order/traces/single_shipment_completed_rollup.ndjson` | `d3bc7baa293ae35bab193694470d25ccc55630237d6d1208e6f7c6319d9a77fa` |
| `machines/order/traces/stale_completions_before_submit_then_completed.ndjson` | `5418f05d28946fa77bb427156dc64d5feed176879d4b87f20ee01e2cd42ce409` |
| `machines/shipment/contract.json` | `c413226ab7a195a3079f12e2ed5baa370117206de5b913d08505fa74ac6e90e0` |
| `machines/shipment/authoring-contract.json` | `5cd16a3acbccdbf09cbcb44bbed86cbf8043a1ccb3e9e9878123fdf81f10055b` |
| `machines/shipment/next.cjs` | `7af9493f25d8460d08868774afa6e9c896b0a9a4ab57fa17cc57cc315aaceb16` |
| `machines/shipment/invariants.mjs` | `2eab3d678d8dabeb6fa1f86e1edf74a70bda24cf362271aeca8db53b25310538` |

## Conclusion

The copies are pinned by their hashes. A change to a corpus is a new copy with a new provenance record, never an edit in place.
