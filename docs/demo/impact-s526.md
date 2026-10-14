# poly · v1.3 Step 2, the impact of the retry-safety rule (S526, PS23, PT33)

*Cognitive Fab · October 2026 · produced by `scripts/scan-retry-safe.mjs` (read-only, no check run, no model) at the commit this file is committed with · replaces the counts of `proposals/demo-refund.md` section 2.5 and appendix A*

Status: for the owner's review. Nothing in the tree is changed by this scan. A source is read as text: effects are found by their `effect` declaration and its block, the class, labels, retry and completions by their clauses. The scan does not run the parser, so a construct it cannot read is listed as such at the end. Directories `node_modules`, `vendor`, `experiments`, `.git`, `.poly` and `dist` are skipped. The bound of an effect with no `retry` clause is the written-out default, 5 (`DEFAULT_RETRY`, `packages/poly-lower/src/lower.ts`).

## 1. Counts

`decisions-m7.md` recorded, over `examples/`, `conformance/` and `std/`: 30 irreversible effects, 25 on the default retry. This scan:

| Family | Irreversible effects | on the default retry | with `retry` and attempts 1 | with `retry` and attempts 2 or more | Effects with an egress label and no class |
|---|---|---|---|---|---|
| `examples/` | 4 | 1 | 1 | 2 | 1 |
| `std/` | 6 | 5 | 0 | 1 | 0 |
| `conformance/` | 20 | 18 | 0 | 2 | 16 |
| `test/fixtures/` | 17 | 16 | 0 | 1 | 44 |
| `examples/`, `conformance/`, `std/` together | 30 | 24 | | | |

The recorded counts (30 and 25) are reproduced: decisions-m7.md counted the inbox's createDraft on the default retry, before its fix (IT4.4), and it now declares `attempts 1`.

## 2. Every irreversible effect

"Today" is the guarantee the declaration gives (G1 when `attempts 1`, else none). "After" is the finding of PS23.5 on the declaration alone: `PL4003` when the bound is 2 or more and nothing guards it. The decision of the fix is the owner's at Step 6.

### `examples/` (4)

| File:line | Machine.effect | Kind | Attempts | Completions | Today | After | Proposed change |
|---|---|---|---|---|---|---|---|
| examples/concierge/concierge.poly:327 | Desk.refund | `payments.refund` | default (5) | ok, failed | none | `PL4003` | `idempotent header "Idempotency-Key" window …` (the owner reads the window from the provider's documentation) |
| examples/inbox/inbox.poly:458 | Todo.createDraft | `gmail.createDraft` | 1 | ok, failed, exhausted | G1 (attempts 1) | none |  |
| examples/oms/oms.poly:157 | Order.chargeCard | `chargeCard` | 6 | ok, failed, exhausted | none | `PL4003` | owner chooses at Step 6: `idempotent …` or `retry { attempts 1 }` |
| examples/orders/orders.poly:59 | Order.charge | `payment.charge` | 3 | ok, failed, exhausted | none | `PL4003` | owner chooses at Step 6: `idempotent …` or `retry { attempts 1 }` |

### `std/` (6)

| File:line | Machine.effect | Kind | Attempts | Completions | Today | After | Proposed change |
|---|---|---|---|---|---|---|---|
| std/channels/email.poly:174 | Conversation.send | `channel.send` | default (5) | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` (Q1) |
| std/channels/slack.poly:203 | Conversation.send | `channel.send` | default (5) | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` (Q1) |
| std/channels/sms.poly:179 | Conversation.send | `channel.send` | default (5) | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` (Q1) |
| std/channels/webhook.poly:170 | Conversation.send | `channel.send` | 10 | ok, failed, exhausted | none | `PL4003` | decide from the adapter at the end of this step (Q1, section 5) |
| std/channels/whatsapp.poly:170 | Conversation.send | `channel.send` | default (5) | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` (Q1) |
| std/credentials/grant.poly:84 | Grant.revoke | `credential.revoke` | default (5) | none | none | `PL4003` | G4 `idempotent by nature "RFC 7009"` in the library (Q3) |

### `conformance/` (20)

| File:line | Machine.effect | Kind | Attempts | Completions | Today | After | Proposed change |
|---|---|---|---|---|---|---|---|
| conformance/m0/errors/PL6801-workflow-input.poly:43 | Brief.post | `brief.post` | default (5) | ok | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m0/errors/PL6802-workflow-key.poly:43 | Brief.post | `brief.post` | default (5) | ok | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m0/errors/PL6803-workflow-tools.poly:43 | Brief.post | `brief.post` | default (5) | ok | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m0/errors/PL6804-workflow-unchecked.poly:41 | Brief.post | `brief.post` | default (5) | ok | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m2/decisions/router.poly:49 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m4/router.poly:66 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m4/seeded/adjudication/fixed.poly:72 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m4/seeded/adjudication/unfixed.poly:72 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/capabilities.poly:41 | Order.charge | `payment.charge` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/lineage-pay.poly:40 | Order.pay | `lp.pay` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/lineage-timer.poly:35 | Hold.pay | `lt.pay` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/orders.poly:41 | Order.charge | `payment.charge` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/orders.poly:46 | Order.fee | `payment.fee` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/policy-faults.poly:27 | Meter.alarm | `meter.alarm` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/policy-faults.poly:43 | Pump.run | `pump.run` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/refund.poly:59 | Refund.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/shop.poly:25 | Till.charge | `till.charge` | 3 | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m5/trifecta.poly:40 | Agent.post | `http.post` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m6/brief.poly:44 | Brief.post | `brief.post` | default (5) | ok | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| conformance/m6/customer-brief.poly:115 | Brief.post_brief | `post_brief` | 5 | ok, failed, exhausted | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |

### `test/fixtures/` (17)

| File:line | Machine.effect | Kind | Attempts | Completions | Today | After | Proposed change |
|---|---|---|---|---|---|---|---|
| test/fixtures/ex-concierge/refund-order.poly:140 | Desk.refund | `payments.refund` | default (5) | ok, failed | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/ex-concierge/staff-classify.poly:136 | Desk.refund | `payments.refund` | default (5) | ok, failed | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/ex-inbox/cross-account.poly:143 | Todo.createDraft | `gmail.createDraft` | default (5) | ok, failed | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/exact-target/creds-exact.poly:43 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/grant-no-holder/desk.poly:36 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/grant-no-holder/stripe-refund.poly:25 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m7/shop/orders.poly:41 | Order.charge | `payment.charge` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m7/shop/orders.poly:46 | Order.fee | `payment.fee` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m7/workflow-budget/desk.poly:73 | Desk.send | `desk.send` | 3 | ok, failed | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m9/concierge-refund.poly:83 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m9/credentials.poly:43 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m9/pd6.poly:24 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/m9/stripe-refund.poly:26 | Desk.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/review-m4/incompletion.poly:66 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/review-m4/pathout.poly:66 | Ticket.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/stale-approval/refunds.poly:30 | Order.refund | `payments.refund` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |
| test/fixtures/std/credentials/grant.poly:84 | Grant.revoke | `credential.revoke` | default (5) | none | none | `PL4003` | `retry { attempts 1 }` unless the file is about retry (Q14) |

## 3. Effects with an egress label and no class (PS23.6, `PL6304`)

| File:line | Machine.effect | Kind | Labels | Proposed change |
|---|---|---|---|---|
| examples/harness/harness.poly:225 | Turn.fetch | `tool.fetch` | egress:external, write:store | an explicit class |
| conformance/m0/errors/PL1701-not-prefix-closed.poly:9 | M.charge | `pay.charge` | egress:external | an explicit class |
| conformance/m0/errors/PL6101-completion-without-handler.poly:9 | M.charge | `pay.charge` | egress:external | an explicit class |
| conformance/m0/errors/PL6830-envelope-not-from-source.poly:47 | Replier.draft | `mail.draft` | egress:external | an explicit class |
| conformance/m1/effects.poly:59 | Account.receipt | `mail.receipt` | egress:external | an explicit class |
| conformance/m1/effects.poly:63 | Account.notice | `mail.notice` | egress:external | an explicit class |
| conformance/m2/completions.poly:16 | M.Ship | `Ship` | egress:external | an explicit class |
| conformance/m2/decisions/router.poly:54 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| conformance/m2/seeded/path-property/fixed.poly:13 | Cart.charge | `payment.charge` | egress:external | an explicit class |
| conformance/m2/seeded/path-property/unfixed.poly:13 | Cart.charge | `payment.charge` | egress:external | an explicit class |
| conformance/m4/router.poly:71 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| conformance/m4/seeded/adjudication/fixed.poly:77 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| conformance/m4/seeded/adjudication/unfixed.poly:77 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| conformance/m8/enums/chat.poly:32 | Chat.post | `chat.post` | egress:external | an explicit class |
| conformance/m8/never/chat-confirmed.poly:36 | Chat.send | `chat.send` | egress:external | an explicit class |
| conformance/m8/never/chat-ruled-out.poly:40 | Chat.send | `chat.send` | egress:external | an explicit class |
| conformance/m8/never/window.poly:47 | Chat.send | `chat.send` | egress:external | an explicit class |
| test/fixtures/channel-completions/std/channels-test.poly:83 | Conversation.send | `channel.send` | egress:external | an explicit class |
| test/fixtures/envelope/mail-reply-held.poly:88 | Replier.draft | `mail.draft` | egress:external | an explicit class |
| test/fixtures/envelope/mail-reply.poly:81 | Replier.draft | `mail.draft` | egress:external | an explicit class |
| test/fixtures/envelope-fault/reply.poly:80 | Replier.draft | `mail.draft` | egress:external | an explicit class |
| test/fixtures/examples-policy/held.poly:89 | Replier.draft | `mail.draft` | egress:external | an explicit class |
| test/fixtures/items-read/refund-error-duplicate-one.poly:77 | Desk.refund | `support.refund` | egress:external | an explicit class |
| test/fixtures/items-read/refund-error-no-param.poly:36 | Desk.refund | `support.refund` | egress:external | an explicit class |
| test/fixtures/items-read/refund-error-non-items.poly:36 | Desk.refund | `support.refund` | egress:external | an explicit class |
| test/fixtures/items-read/refund-unguarded.poly:79 | Desk.refund | `support.refund` | egress:external | an explicit class |
| test/fixtures/items-read/refund.poly:80 | Desk.refund | `support.refund` | egress:external | an explicit class |
| test/fixtures/m10/concierge-memory.poly:78 | Desk.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/m10/concierge-verdict.poly:104 | Desk.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/m10/relay.poly:25 | Relay.send | `relay.send` | egress:external | an explicit class |
| test/fixtures/m10/review-message.poly:89 | Relay.post | `support.post` | egress:external | an explicit class |
| test/fixtures/m10/review-staff-forward.poly:87 | Desk.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/m10/review-timer.poly:84 | Desk.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/m9/chat-ruled-out-plain.poly:38 | Chat.send | `chat.send` | egress:external | an explicit class |
| test/fixtures/one-value-principal/std-before/channels-test.poly:79 | Conversation.send | `channel.send` | egress:external | an explicit class |
| test/fixtures/rejected-completion/machine-form-guard.poly:18 | Asker.fetch | `ml.fetch` | egress:external | an explicit class |
| test/fixtures/rejected-completion/machine-form-nested.poly:23 | Asker.fetch | `ml.fetch` | egress:external | an explicit class |
| test/fixtures/rejected-completion/machine-form.poly:17 | Asker.fetch | `ml.fetch` | egress:external | an explicit class |
| test/fixtures/rejected-completion/machine-live.poly:17 | Asker.fetch | `ml.fetch` | egress:external | an explicit class |
| test/fixtures/rejected-completion/std/channels-test.poly:83 | Conversation.send | `channel.send` | egress:external | an explicit class |
| test/fixtures/replay-count/concierge-count.poly:83 | Desk.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/review-m1/checker-effrec.poly:12 | M.Notify | `Notify` | egress:external | an explicit class |
| test/fixtures/review-m1/lower-kindtimer2.poly:19 | Acct.tick | `cancelTimer` | egress:external | an explicit class |
| test/fixtures/review-m1/lower-man1.poly:35 | Acct.ping | `net.ping` | egress:external | an explicit class |
| test/fixtures/review-m1/lower-man2.poly:35 | Acct.ping | `net.ping` | egress:external | an explicit class |
| test/fixtures/review-m1/lower-man3.poly:26 | Acct.ping | `net.ping` | egress:external | an explicit class |
| test/fixtures/review-m1/pipeline-stale-no-path.poly:57 | Account.receipt | `mail.receipt` | egress:external | an explicit class |
| test/fixtures/review-m1/pipeline-stale-no-path.poly:61 | Account.notice | `mail.notice` | egress:external | an explicit class |
| test/fixtures/review-m2/b1-record-reply.poly:16 | M.fetch | `x.fetch` | egress:external | an explicit class |
| test/fixtures/review-m4/incompletion.poly:71 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/review-m4/pathout.poly:71 | Ticket.reply | `support.reply` | egress:external | an explicit class |
| test/fixtures/review-m8a/cancelled.poly:28 | Alarm.bell | `alarm.bell` | egress:external | an explicit class |
| test/fixtures/review-m8a/samekind.poly:14 | M.alert | `ops.page` | egress:external | an explicit class |
| test/fixtures/review-m8a/samekind.poly:18 | M.notify | `ops.page` | egress:external | an explicit class |
| test/fixtures/review-m8a/shadow.poly:19 | M.post | `s.post` | egress:external | an explicit class |
| test/fixtures/review-m8a/shared.poly:12 | Shop.charge | `shop.charge` | egress:external | an explicit class |
| test/fixtures/review-m8a/shared.poly:17 | Shop.receipt | `shop.receipt` | egress:external | an explicit class |
| test/fixtures/source-keys/mail-draft.poly:77 | Drafter.send | `mail.send` | egress:external | an explicit class |
| test/fixtures/std/channels-test.poly:74 | Conversation.send | `channel.send` | egress:external | an explicit class |
| test/fixtures/strict-default/reply-principal.poly:16 | M.fetch | `x.fetch` | egress:external | an explicit class |
| test/fixtures/thread-principal/std/channels-test.poly:79 | Conversation.send | `channel.send` | egress:external | an explicit class |

## 4. Programs, the standard library they pull in, and what changes

A program is a source that is not a policy file and declares a module. The standard-library files are the ones `uses.ts` adds: a channel of kind `k` adds `std/channels/k.poly`, a credential adds `std/credentials/grant.poly`, a route or budget adds `std/routing/routing.poly`, and an explicit `use std.…` is listed as written. "Own" is the number of its own irreversible effects on a bound of 2 or more; "Pulled in" is the standard-library irreversible effects on a bound of 2 or more that it adds. A program with either is `FINDINGS` (`PL4003`) until migrated, whatever its expected line says.

| Program | Expected line | Own | Pulled in | Pulls in from |
|---|---|---|---|---|
| examples/concierge/concierge.poly | CLEAN | 1 | 3 | `std/channels/whatsapp.poly`, `std/channels/slack.poly`, `std/credentials/grant.poly` |
| examples/harness/harness.poly | CLEAN | 0 (+1 classless) | 0 |  |
| examples/inbox/inbox.poly | CLEAN | 0 | 1 | `std/credentials/grant.poly` |
| examples/oms/oms.poly | CLEAN | 1 | 0 |  |
| examples/orders/orders.poly | FINDING PL3102 PL4001 PL4002 | 1 | 0 |  |
| conformance/m0/errors/PL1701-not-prefix-closed.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m0/errors/PL6101-completion-without-handler.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m0/errors/PL6801-workflow-input.poly | (none) | 1 | 0 |  |
| conformance/m0/errors/PL6802-workflow-key.poly | (none) | 1 | 0 |  |
| conformance/m0/errors/PL6803-workflow-tools.poly | (none) | 1 | 0 |  |
| conformance/m0/errors/PL6804-workflow-unchecked.poly | (none) | 1 | 0 |  |
| conformance/m0/errors/PL6830-envelope-not-from-source.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m1/effects.poly | (none) | 0 (+2 classless) | 0 |  |
| conformance/m2/completions.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m2/decisions/router.poly | (none) | 1 (+1 classless) | 0 |  |
| conformance/m2/seeded/path-property/fixed.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m2/seeded/path-property/unfixed.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m4/router.poly | (none) | 1 (+1 classless) | 0 |  |
| conformance/m4/seeded/adjudication/fixed.poly | (none) | 1 (+1 classless) | 0 |  |
| conformance/m4/seeded/adjudication/unfixed.poly | (none) | 1 (+1 classless) | 0 |  |
| conformance/m5/capabilities.poly | (none) | 1 | 0 |  |
| conformance/m5/lineage-pay.poly | (none) | 1 | 0 |  |
| conformance/m5/lineage-timer.poly | (none) | 1 | 0 |  |
| conformance/m5/orders.poly | (none) | 2 | 0 |  |
| conformance/m5/policy-faults.poly | (none) | 2 | 0 |  |
| conformance/m5/refund.poly | (none) | 1 | 0 |  |
| conformance/m5/shop.poly | (none) | 1 | 0 |  |
| conformance/m5/trifecta.poly | (none) | 1 | 0 |  |
| conformance/m6/brief.poly | (none) | 1 | 0 |  |
| conformance/m6/customer-brief.poly | (none) | 1 | 0 |  |
| conformance/m8/concierge/concierge.poly | (none) | 0 | 3 | `std/channels/whatsapp.poly`, `std/channels/sms.poly`, `std/channels/slack.poly` |
| conformance/m8/enums/chat.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m8/never/chat-confirmed.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m8/never/chat-ruled-out.poly | (none) | 0 (+1 classless) | 0 |  |
| conformance/m8/never/window.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/channel-completions/std/channels-test.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/envelope/mail-reply-held.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/envelope/mail-reply.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/envelope-fault/reply.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/ex-concierge/refund-order.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/ex-concierge/staff-classify.poly | (none) | 1 | 2 | `std/channels/slack.poly`, `std/credentials/grant.poly` |
| test/fixtures/ex-inbox/cross-account.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/exact-target/creds-exact.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/examples-policy/held.poly | CLEAN | 0 (+1 classless) | 0 |  |
| test/fixtures/grant-no-holder/desk.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/grant-no-holder/stripe-refund.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/items-read/refund-error-duplicate-one.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/items-read/refund-error-no-param.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/items-read/refund-error-non-items.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/items-read/refund-unguarded.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/items-read/refund.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/concierge-memory.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/concierge-verdict.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/relay.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/review-message.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/review-staff-forward.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/review-timer.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m10/sms-help.poly | (none) | 0 | 1 | `std/channels/sms.poly` |
| test/fixtures/m7/shop/orders.poly | (none) | 2 | 0 |  |
| test/fixtures/m7/workflow-budget/desk.poly | (none) | 1 | 0 |  |
| test/fixtures/m9/chat-ruled-out-plain.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/m9/concierge-refund.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/m9/credentials.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/m9/pd6.poly | (none) | 1 | 0 |  |
| test/fixtures/m9/stripe-refund.poly | (none) | 1 | 1 | `std/credentials/grant.poly` |
| test/fixtures/m9/text-desk.poly | (none) | 0 | 1 | `std/channels/sms.poly` |
| test/fixtures/one-value-principal/std-before/channels-test.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/rejected-completion/machine-form-guard.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/rejected-completion/machine-form-nested.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/rejected-completion/machine-form.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/rejected-completion/machine-live.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/rejected-completion/std/channels-test.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/replay-count/concierge-count.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/checker-effrec.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/lower-kindtimer2.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/lower-man1.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/lower-man2.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/lower-man3.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m1/pipeline-stale-no-path.poly | (none) | 0 (+2 classless) | 0 |  |
| test/fixtures/review-m2/b1-record-reply.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m4/incompletion.poly | (none) | 1 (+1 classless) | 0 |  |
| test/fixtures/review-m4/pathout.poly | (none) | 1 (+1 classless) | 0 |  |
| test/fixtures/review-m8a/cancelled.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m8a/samekind.poly | (none) | 0 (+2 classless) | 0 |  |
| test/fixtures/review-m8a/shadow.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/review-m8a/shared.poly | (none) | 0 (+2 classless) | 0 |  |
| test/fixtures/source-credential/desk.poly | (none) | 0 | 1 | `std/credentials/grant.poly` |
| test/fixtures/source-credential-fault/search.poly | (none) | 0 | 1 | `std/credentials/grant.poly` |
| test/fixtures/source-credential-owners/inbox.poly | (none) | 0 | 1 | `std/credentials/grant.poly` |
| test/fixtures/source-keys/mail-draft.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/stale-approval/refunds.poly | (none) | 1 | 0 |  |
| test/fixtures/std/channels-test.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/std/credentials/grant.poly | (none) | 1 | 0 |  |
| test/fixtures/strict-default/reply-principal.poly | (none) | 0 (+1 classless) | 0 |  |
| test/fixtures/thread-principal/desk.poly | (none) | 0 | 1 | `std/channels/whatsapp.poly` |
| test/fixtures/thread-principal/std/channels-test.poly | (none) | 0 (+1 classless) | 0 |  |

96 programs change their verdict or report under the rule as written, before any migration.

A program with a pulled-in effect is fixed by changing the library once (Step 6 starts there), not file by file; its own effects are the per-file work. The programs that pull in only a library effect need no edit after the library is migrated.

## 5. Embedded and inline sources

| File | Lines naming an irreversible class | Kind |
|---|---|---|
| conformance/m2/embed/orders.ts | 45 | embedded TypeScript source |
| test/effects.test.mjs | 68, 111, 183, 240 | inline source or fixture of a test |
| test/policy-channel.test.mjs | 51 | inline source or fixture of a test |
| test/policy-front.test.mjs | 201 | inline source or fixture of a test |
| test/policy-lineage.test.mjs | 105, 141 | inline source or fixture of a test |
| test/try.test.mjs | 51 | inline source or fixture of a test |

An inline source that expects an exact code list changes with its reason in the commit. A line that names the class in a policy event (not a source the checker reads) needs no change; Step 3 settles each.

## 6. Policy files that name the class (no change expected)

- conformance/m5/autonomy.policy.poly
- conformance/m5/halt.policy.poly
- conformance/m5/lineage-pay.policy.poly
- conformance/m5/lineage-timer.policy.poly
- conformance/m5/orders-rules.policy.poly
- conformance/m5/orders.policy.poly
- conformance/m5/trifecta.policy.poly
- test/fixtures/m9/pd6.policy.poly

## 7. The webhook channel (Q1: "decide from the adapter in Step 2")

`std/channels/webhook.poly` declares attempts 10 (base and timeout in the file). The decision from the adapter is in section 8 of this file, written after reading `packages/poly-io`.

---

*Sections 1 to 7 above are generated by the script. Sections 8 to 10 and the conclusion are written by hand after reading the output and `packages/poly-io`.*

## 8. The webhook channel: decided from the adapter

`std/channels/webhook.poly` declares `retry { attempts 10, base 5s, timeout 15s }` and `exhausted -> Undelivered()`. The adapter (`packages/poly-io/src/adapters/webhook.ts`) does send a stable id on every attempt: `webhook-id` is `msg_` followed by a hash of the intent's idempotency key, so a receiver that follows the Standard Webhooks protocol can deduplicate on it.

**Decision: `retry { attempts 1 }`, like the other four sends (G1).** Two reasons.

1. Whether a receiver deduplicates on `webhook-id` is the receiver's, and Q1 says to make no claim about any provider's idempotency. A keyed declaration would be K17 for an endpoint that poly knows nothing about.
2. PT33.4 attaches the key in a capability that a handler calls. This send is not a handler: it is the adapter, run by the runtime, and it derives its id from a hash. Declaring `idempotent header "webhook-id"` would say the header carries the intent id, which it does not, and the rule's mechanism (the capability) would not be the thing that sets it.

The cost is that a webhook delivery that fails ambiguously is no longer tried up to 10 times, and the conversation sees `Undelivered`. The stable id is recorded here as a fact for a later release that extends PT33.4 to adapter sends.

## 9. What the scan shows that the spec did not say

1. **The class floor is far larger than the spec said.** `proposals/demo-refund.md` section 2.5 said the floor changes one line of the harness. The scan finds 61 effects with an `egress` label and no class: 1 in `examples/` (the harness's `fetch`), 16 in `conformance/` and 44 in `test/fixtures/`, in 57 programs. Of these, 51 are programs with no irreversible effect of their own. They are mail, chat and refund sends of fixtures that exist to test something else (envelopes, memory, replay, rejected completions). Each needs one explicit class line, `none` or the class the effect really has, in the same family commits as the retry edits. This is the largest part of the Step 6 bulk edit by count of files, and it is the owner's to approve from this list (Q14).
2. **96 programs change.** Section 4 lists them: `examples/` 5, `conformance/` 30, `test/fixtures/` 61. Most change by a class line or by a library effect they pull in, and the library edit (Step 6 starts there) removes the second kind.
3. **A teaching variant changes its expected line.** `examples/orders/orders.poly` expects `FINDING PL3102 PL4001 PL4002` and has `charge` on 3 attempts, so it gains `PL4003`. Either its expected line gains the code, or `charge` is migrated so that its teaching purpose is unchanged. The owner chooses.
4. **The libraries pulled in.** Every program with a channel of kind `whatsapp`, `slack`, `sms` or `email` pulls in an irreversible send; every program with a credential pulls in `credential.revoke`. After the library is migrated (Q1, Q3), the concierge needs one edit of its own (`refund`) and the inbox none.
5. **The counts agree with the record.** 30 irreversible effects in `examples/`, `conformance/` and `std/`, 25 on the default once the inbox is counted as `decisions-m7.md` counted it, before its fix.
6. **The generated `test/fixtures/std/**` files are copies of the library.** They follow the library, and a change to the library must reach them or the tests that pin them will diverge; Step 6 lists them with the library family.
7. **Limits of the scan.** It reads text, not the parser. A construct it cannot read would be missing from the tables, not wrong in them. Step 3's tests are the check on the list: a program the rule changes that is not here is a failing test, not a silent pass. The tests of section 5 (inline sources) are listed by the line that names the class; the scan does not know which of them parse as programs.

## 10. What I need from the owner before Step 3

- Review this file and the commits of Step 1.
- Rule on the class floor's size (point 1): accept the roughly 60 one-line class edits as part of Step 6 as planned, or narrow the floor (for example to effects with a credential, or to effects whose kind or name suggests a write). I recommend accepting: a narrower floor is a rule an agent can sidestep by naming, which is what the floor is for.
- Rule on point 3 (the orders teaching variant).
- Confirm the webhook decision (section 8).

No test is written until both are reviewed.

## Conclusion

The rule reaches further than the spec said, mostly through the class floor: 61 effects in 57 programs need a class stated, on top of 30 irreversible effects of which 25 sit on the default retry. The counts agree with the record. The library carries the largest single share of the retry work (the four sends, the webhook and `credential.revoke`), and migrating it first removes the pulled-in findings from 18 programs: the concierge, the inbox, `conformance/m8/concierge` and 15 fixtures. The webhook is decided at most once, because the adapter's stable id is not a claim poly can make about a receiver. What is left for the owner is the size of the class floor and one teaching variant.
