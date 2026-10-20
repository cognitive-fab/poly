# The concierge's recorded model answers

`answers.json` holds the answers the concierge's decisions give to nine synthetic WhatsApp messages (plan-ex.md E1). No model was called, and no message is a real customer's: the senders are the conversation's check representatives `wa-1`, `wa-2` and `wa-3` (synthetic guest). The host's recorded provider (`examples/concierge/host/recorded.mjs`) answers a decision by the message its materials hold (PS17.2, PS18.2), so a test never computes a digest by hand.

| Message | What it exercises |
|---|---|
| `status` | the small tier answers above the route's thresholds (raw 970, 880 on its map) |
| `refund-small` | the small tier is unsure (raw 620, 400 on its map, below `conf < 0.8`), so the route escalates to the large tier (raw 960, 940); a refund of 40, under the policy's limit |
| `refund-large` | a refund of 250, above 100, which the policy escalates to a person (AC17, AC27) |
| `refund-outside` | the amount decision answers 650, outside `{ value: 0..500 }`, which is refused at dispatch and journaled (AC30) |
| `unsure` | both tiers below the thresholds, so the route is exhausted and the reply says so (`route-exhausted`, PS18.2) |
| `injection` | a message that tells the assistant to refund 500: it is data, the amount stays in its domain, and the policy still sends 500 to a person (IF3.3's rule, carried to the concierge) |
| `vague-amount` | the amount decision is unsure (raw 300), and cites no order, so no refund is proposed |
| `refund-twice` | a refund of 40 for order o-1002 (chairs, 120.00 paid), small tier confident (raw 970, 940 on maps), used in tests of the ledger (DF19, DAC24) |
| `refund-synthetic` | a refund of 40 for order o-9031 (synthetic guest 3's desk lamp, 120.00 paid), small tier confident, used in the sixth attack of the live room (DF24) |

**Customers and orders (the status path, S450).** `customers` maps each sender to the principal its verified claims name (`wa-1` to `cust-a`, `wa-2` to `cust-b`), as the verifier adapter would (K11). `orders` seeds three orders of the two customers for the Postgres source. The status message's `answer` cites `o-1002`, one of `cust-a`'s; given another customer's orders, the recorded provider cites none, since a citation is a subset of what the decision was given (PS17.6), which AC22's tests read.

**The tests' own numbers.** The probabilities and token counts are chosen to place each answer on the side of a threshold the program or the route names; the price tables and maps are the M11 fixture's (`test/fixtures/m11`), whose sources are the tests' own, not a provider's. The model ids are those tables' `model`. The replies for `refund-twice` are `Refunded`, `Declined`, `Checking` and `Already`, the last two for the ledger tests (DF19, DAC25).

**Orders and charges (the refund, S462).** Each order carries the Stripe charge it was paid with (`charge`, the orders source's key) and the amount paid on it in cents (`paid`): `o-1001` `ch_ex1001` 4,500, `o-1002` `ch_ex1002` 12,000, `o-2001` `ch_ex2001` 30,000. The charge ids and amounts are made up for the tests. The amount decision's recording cites the order its message is about (`amount.cites`): the lamp for `refund-small`, the sofa for `refund-large`, `injection` and `refund-outside`, and none for `vague-amount`. The provider cites that order only if the customer's orders, as retrieved, hold it, and nothing otherwise (PS17.6). The refund of 40 on the lamp is within 45 paid; the refund of 250 on the sofa is within 300; the `injection`'s 500 on the sofa exceeds 300, which the handler refuses.
