# WhatsApp refund support agent

Customers message your WhatsApp Business number. The agent finds their orders in
`orders.json`, quotes a refund, and once they reply **YES** it issues the refund
through Stripe.

Node 24 runs the TypeScript directly, and nothing needs installing at runtime.

## Starting it

1. **Configure.** Copy `.env.example` to `.env` and fill in:

   | Variable | Where it comes from |
   | --- | --- |
   | `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (`sk_test_…` while testing) |
   | `WHATSAPP_ACCESS_TOKEN` | Meta app → WhatsApp → API Setup (use a System User token in production) |
   | `WHATSAPP_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup → *Phone number ID* |
   | `WHATSAPP_VERIFY_TOKEN` | Any random string you choose |
   | `WHATSAPP_APP_SECRET` | Meta app → App settings → Basic → *App secret* |

   Optional: `PORT` (3000), `ORDERS_PATH` (`orders.json`), `LEDGER_PATH`
   (`refunds.json`), `REFUND_WINDOW_DAYS` (30), `GRAPH_API_VERSION` (`v21.0`).

2. **Run.**

   ```sh
   npm start
   ```

   The webhook listens on `http://localhost:3000/webhook`.

3. **Expose the port and register the webhook.** Meta has to reach the port over
   HTTPS, for example through a tunnel:

   ```sh
   ngrok http 3000
   ```

   In the Meta app, go to WhatsApp → Configuration → Webhook. Set the callback URL
   to `https://<tunnel-host>/webhook` and the verify token to your
   `WHATSAPP_VERIFY_TOKEN`, then subscribe to the **messages** field.

## Talking to it

| Customer sends | Agent does |
| --- | --- |
| `hi` | Shows help and lists that customer's orders |
| `refund ORD-1001` | Quotes a refund of everything not yet refunded on the order |
| `refund ORD-1001 CUPS-4` | Quotes a refund for just those items |
| `YES` / `NO` | Confirms or cancels the quote (quotes expire after 10 minutes) |

## Safety rules

- **Customers can only reach their own orders.** An order's `customer` field has
  to match the sender's WhatsApp number (digits only). The agent gives the same
  reply for an order that doesn't exist and one that belongs to someone else.
- **No refund without an explicit YES**, and the amount is re-checked when the
  customer confirms.
- **No double refunds.** Each refund is recorded in `refunds.json`, and
  amounts are capped at what is left on the order. Messages are handled one at
  a time, and each Stripe call carries a deterministic `Idempotency-Key`, so a
  retry after a timeout or crash returns the original refund instead of
  creating a second one.
- **Refund window.** Orders older than `REFUND_WINDOW_DAYS` are declined and
  sent to human support.
- **Webhook authenticity.** Every POST must carry a valid
  `X-Hub-Signature-256` HMAC made with your app secret; anything else gets a
  401. Redelivered message IDs are ignored.

The agent follows fixed rules rather than using an LLM, so what it does with
money is predictable and testable.

## Tests

```sh
npm test
```

The tests use fake Stripe and WhatsApp clients and make no network calls.
`npm install && npm run typecheck` type-checks the project with `tsc`.

## Notes

- The charge IDs in the sample `orders.json` (`ch_demo_…`) don't exist in
  Stripe, so a live refund against them will be rejected. The customer then
  gets an apology and can retry. Use real test-mode charges (or
  PaymentIntent-backed charges) to try it end to end.
- `refunds.json` only knows about refunds made by this agent. Stripe still
  rejects refunds that would go over the charged amount, even ones made
  elsewhere.
