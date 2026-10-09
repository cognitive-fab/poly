# The concierge's recorded model answers

`answers.json` holds the answers the concierge's decisions give to seven synthetic WhatsApp messages (plan-ex.md E1). No model was called, and no message is a real customer's: the senders are the conversation's check representatives `wa-1` and `wa-2`. The host's recorded provider (`examples/concierge/host/recorded.mjs`) answers a decision by the message its materials hold (PS17.2, PS18.2), so a test never computes a digest by hand.

| Message | What it exercises |
|---|---|
| `status` | the small tier answers above the route's thresholds (raw 970, 880 on its map) |
| `refund-small` | the small tier is unsure (raw 620, 400 on its map, below `conf < 0.8`), so the route escalates to the large tier (raw 960, 940); a refund of 40, under the policy's limit |
| `refund-large` | a refund of 250, above 100, which the policy escalates to a person (AC17, AC27) |
| `refund-outside` | the amount decision answers 650, outside `{ value: 0..500 }`, which is refused at dispatch and journaled (AC30) |
| `unsure` | both tiers below the thresholds, so the route is exhausted and the reply says so (`route-exhausted`, PS18.2) |
| `injection` | a message that tells the assistant to refund 500: it is data, the amount stays in its domain, and the policy still sends 500 to a person (IF3.3's rule, carried to the concierge) |
| `vague-amount` | the amount decision is unsure (raw 300), so no refund is proposed |

**The tests' own numbers.** The probabilities and token counts are chosen to place each answer on the side of a threshold the program or the route names; the price tables and maps are the M11 fixture's (`test/fixtures/m11`), whose sources are the tests' own, not a provider's. The model ids are those tables' `model`.
