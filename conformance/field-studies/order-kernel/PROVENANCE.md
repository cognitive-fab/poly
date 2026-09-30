# Provenance: order-kernel

Corpus (b) of S24: the OMS order's sixteen scenarios, **generated from the hand-written artefacts**, not captured from a running system. `scripts/record-oms-corpus.mjs` replays the action sequence of each trace file of corpus (a) (`conformance/field-studies/order/machines/order/traces`) through polyrun's own kernel, against the hand-written order, shipment, mapper and manifest copied in `conformance/field-studies/order/`, and exports each order's journal as polyrun exports traces (accepted steps only).

| Item | Value |
|---|---|
| Generator | `scripts/record-oms-corpus.mjs`, with the kernel vendored in `vendor/polygraph` (polygraph 583b82c) |
| Inputs | the copies in `conformance/field-studies/order/`; SHA-256 of the order and shipment modules, mapper, manifest and contracts together: `faba64c2154a23d154c8b06f0a0e8fcf6495a580e3dbaedce570975ac86efed4` |
| Completions | a SHIPMENT_COMPLETED for a live shipment is produced by driving the shipment (SHIP then DELIVER, or CANCEL_SHIPMENT) so the kernel delivers it; any other step is dispatched as corpus (a) records it |
| Determinism | fixed clock and action ids; `test/oms.test.mjs` re-records into a scratch directory and compares the bytes |
| Licence | Apache-2.0, as the inputs (polygraph/LICENSE) |

| File | SHA-256 |
|---|---|
| `traces/all_shipments_failed_partial_rollup.ndjson` | `1b1ed55dc0ad0f7858d4dcd13e53eb28c7b71aaecbd210c78fd424b3b670a93a` |
| `traces/amend_resets_rollup_then_completed.ndjson` | `79ce206c748846781c6c7a497a8d71959079d47a28213bdbbd233a0666cf3dce` |
| `traces/amend_window_expired_cancelled.ndjson` | `e00bfad0b1ec5941fc85e639a3aa3403fdd6e3f127359d1304399521da2f8eb4` |
| `traces/cancel_blocked_then_fulfilling_blocked_then_completed.ndjson` | `9a007587685756f5afa3f3c616338f7243fecd350fcd2dd7402ae6d6bd6dafa1` |
| `traces/cancel_from_awaiting_amend.ndjson` | `f5de9272b0a389f8d6fa50f44d867acd9ec0c4798831cd8f88720dd44a2060ee` |
| `traces/cancel_from_fraud_check_with_submit_noop.ndjson` | `785e5b914886b652629aa32d39c98f2ef2af57c04de5b5a871d7bb0d8dea60ce` |
| `traces/cancel_from_pending_with_late_submit.ndjson` | `9c590d435b3d79f0783748942b0321274ddf21cedd89870ac62578a437f7466d` |
| `traces/duplicate_charge_retries_then_partial.ndjson` | `7db568b06ea482c5ad3e34b686a5845fb4fa7f075f614488dcf694131ba33aa6` |
| `traces/fraud_rejected_with_stale_charge.ndjson` | `2352db5f50194f4746bae9bda50d38c83f3640d289cf429d79827ff1b1388251` |
| `traces/happy_path_two_shipments_completed.ndjson` | `a57a75ea48b0ffbef1b657be71ac1e9b5b5d158b686cd2a370d97a0b9179ae2b` |
| `traces/late_completions_after_terminal.ndjson` | `9a007587685756f5afa3f3c616338f7243fecd350fcd2dd7402ae6d6bd6dafa1` |
| `traces/partial_delivery_mixed_rollup.ndjson` | `3daeb6c8ad5395431c363e6b4f73202c5a3356226b423b583143871bfe8194a7` |
| `traces/payment_declined_with_cancel_blocked.ndjson` | `38430e5f2c2f8ae55ccb9b7bb63875a73b8cc62a50322dcc86d15fafbb64b531` |
| `traces/payment_timeout_with_cancel_blocked.ndjson` | `1bcde9784d2d2cd18b4845e5c96b8680cc494862fc1bb3f8125f64cb5afa8c98` |
| `traces/single_shipment_completed_rollup.ndjson` | `9a007587685756f5afa3f3c616338f7243fecd350fcd2dd7402ae6d6bd6dafa1` |
| `traces/stale_completions_before_submit_then_completed.ndjson` | `9a007587685756f5afa3f3c616338f7243fecd350fcd2dd7402ae6d6bd6dafa1` |

## Conclusion

The poly order must replay this corpus at 100% (S24). It is regenerated only by the script, never edited by hand, and the hashes pin it.
