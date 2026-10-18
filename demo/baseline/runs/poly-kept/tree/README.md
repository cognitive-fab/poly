# Support agent: refunds over WhatsApp

Customers message your WhatsApp Business number. The agent looks up their order in `orders.json`, asks them to confirm the amount, refunds it through Stripe and tells them when it is done.

```
customer: refund ORD-1001 cups
agent:    You asked for a refund of $40.00 for CUPS-4 from order ORD-1001. Reply YES to confirm or NO to cancel.
customer: yes
agent:    Done: $40.00 for CUPS-4 from order ORD-1001 has been refunded to your original payment method. …
```

## Start it

Requires Node 24.

```sh
npm install
npm run poly check src/support.poly     # optional: the check also runs at every start

export STRIPE_SECRET_KEY=sk_test_…           # Stripe secret or restricted key (refunds: write)
export WHATSAPP_TOKEN=…                      # Cloud API access token (system user token)
export WHATSAPP_PHONE_NUMBER_ID=…            # the sending number's id, from the WhatsApp > API setup page
export WHATSAPP_APP_SECRET=…                 # the Meta app's secret, to check X-Hub-Signature-256
export WHATSAPP_VERIFY_TOKEN=any-long-random-string   # you choose it; enter the same one in the webhook settings
export ADMIN_TOKEN=another-random-string     # optional: enables POST /admin/resolve

node src/main.js
# support agent listening on http://127.0.0.1:3000/webhook
```

Optional variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | the local port webhooks arrive on |
| `HOST` | `127.0.0.1` | the interface to listen on |
| `ORDERS_FILE` | `./orders.json` | the orders, read once at start |
| `STORE` | `.poly/run/store.sqlite` | the durable store: tickets, the outbox of effects, the ledger |
| `REFUND_WINDOW_DAYS` | `30` | how long after `placed` an order can be refunded |

**Connect WhatsApp.** The agent listens on loopback only, so Meta reaches it through a tunnel such as `cloudflared tunnel --url http://127.0.0.1:3000` or `ngrok http 3000`. In the Meta app go to **WhatsApp > Configuration > Webhook**, set the callback URL to `https://<tunnel>/webhook` and the verify token to `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field. Webhooks without a valid signature are refused with 401.

At startup, `src/runtime.js` checks `src/support.poly`, lints the effect handlers and signs a certificate with a key generated for that process (it is never written to disk). The runtime then loads only that certified build. A program that does not check CLEAN does not start.

## What customers can say

| Message | What happens |
|---|---|
| `refund ORD-1001` | asks to confirm a refund of everything in the order not yet refunded |
| `refund ORD-1001 CUPS-4` (or `cups`) | asks to confirm a refund of that one item |
| `yes` / `yes ORD-1001` | confirms the waiting request; the refund is issued |
| `no` | cancels the waiting request |
| anything else | help, listing the sender's own orders |

Orders are matched to the sender's WhatsApp number (`customer` in `orders.json`). Another customer's order is answered as unknown.

## How it is built

The stateful core is written in poly, in **`src/support.poly`**:

- **`Ticket`**, one per order: `Idle → Confirming → Refunding → Idle / Closed`, plus `Review`. It records which items are refunded. `poly check` proves, over every reachable state:
  - an item is never refunded twice (the `never no-double-refund-*` rules);
  - money moves only after the customer confirms;
  - a refund is never taken back;
  - a closed ticket has every item refunded;
  - no reachable state is stuck.
- **`stripe.refund`** is `irreversible` and is retried up to 3 times. Each attempt carries the same `Idempotency-Key`, set by the runtime, so Stripe refunds at most once. If Stripe refuses (a 4xx), the customer is told and may ask again. If every attempt ends without an answer, the ticket goes to **`Review`** and a person decides (see below). It is never retried blind.
- **`Notice`**, one per inbound message that changes no order (help, or why a request was refused). It replies at most once, so a webhook that Meta delivers twice gets one answer.

Beside it, in plain JavaScript:

| File | Role |
|---|---|
| `src/effects.js` | the effect handlers: the Stripe refund call and the WhatsApp sends. They run under capabilities limited to the URLs, secrets and tables the effects declare, and admission lints them. |
| `src/agent.js` | parses messages, finds orders, feeds the machines, and turns a rejected step into its notice |
| `src/whatsapp.js` | the webhook handshake, the signature check and message extraction |
| `src/server.js` | the HTTP server and the transports (fetch, secrets, tables) |
| `src/runtime.js` | admission and load |
| `src/main.js` | configuration from the environment |

### Refunds under review

If Stripe never answers, the agent cannot know whether the refund exists. Look the charge up in the Stripe dashboard (refunds carry `metadata[order]`), then record what you found:

```sh
curl -X POST http://127.0.0.1:3000/admin/resolve \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"order":"ORD-1001","done":true}'     # done: false if no refund exists; the customer may then ask again
```

The customer is told either way. This endpoint issues no refund itself.

## Tests

```sh
npm test
```

- `test/agent.test.js` runs the admitted program end to end over HTTP, with signed webhooks and a recording fake of Stripe and the Graph API. It covers whole and per-item refunds, confirmation and cancellation, another customer's order, duplicate webhooks, Stripe refusals and outages (the retry keeps the same key), the refund window, review and resolution, and a restart on the same store.
- `test/program.test.js` checks `support.poly` and three mutants. The checker must catch each one: a double refund, a whole-order refund over an item already refunded, and money moved without confirmation.
- `test/host.test.js` covers parsing, signatures and the reply texts.

## Limits

- An order can have at most 4 items, the domain `support.poly` is checked over. Larger orders are answered "our team will help you".
- `orders.json` is read at start; restart to pick up new orders.
- Refunds go back to the order's `charge`: a `ch_…` charge or a `pi_…` payment intent.
- Run one process per store. The runtime locks the store file.
- Messages are understood by keywords, not by a language model.
