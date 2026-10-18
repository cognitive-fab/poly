# WhatsApp refund support agent

Customers message your WhatsApp Business number. The agent looks up the orders placed from their number in
`orders.json`, offers a refund for the whole order or for specific items, and once the customer replies **YES**,
issues the refund through Stripe against the order's original charge. Replies go back through the WhatsApp Cloud API.

There are no runtime dependencies. Node 24 runs the TypeScript sources directly.

## Start it

```sh
npm install

export STRIPE_SECRET_KEY=sk_test_...          # Stripe secret key (live keys also need ALLOW_LIVE_REFUNDS=1)
export WHATSAPP_ACCESS_TOKEN=EAAG...          # Cloud API access token
export WHATSAPP_PHONE_NUMBER_ID=1234567890    # the business phone number ID that sends replies
export WHATSAPP_APP_SECRET=...                # Meta app secret, used to verify webhook signatures
export WHATSAPP_VERIFY_TOKEN=any-string-you-choose

npm start            # listens on http://localhost:3000/webhook
```

Optional settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Local port for the webhook |
| `ORDERS_FILE` | `orders.json` | Order data |
| `STATE_FILE` | `state.json` | Refund ledger, pending confirmations, and seen message IDs |
| `REFUND_WINDOW_DAYS` | `30` | Orders older than this are referred to a human instead |
| `ALLOW_LIVE_REFUNDS` | unset | Must be `1` to start with an `sk_live_` key |
| `STRIPE_API_BASE`, `WHATSAPP_API_BASE` | Stripe / Graph v23.0 | Override API endpoints, e.g. for a mock |

Then, in the Meta developer console (WhatsApp → Configuration), set the callback URL to the public HTTPS address
that forwards to this port (for example `ngrok http 3000` → `https://<id>.ngrok.app/webhook`), enter the same
verify token, and subscribe to the **messages** field.

## Conversation

```
Customer: hi
Agent:    Hi Ada! I can help with refunds. Your orders:
          • ORD-1001 — $100.00, placed 2026-09-30: BLENDER-1 ($60.00), CUPS-4 ($40.00)
          ...
Customer: refund ORD-1001 BLENDER-1
Agent:    I can refund $60.00 for BLENDER-1 from ORD-1001 to your original payment method. Reply YES to confirm or NO to cancel.
Customer: yes
Agent:    Done! Your refund of $60.00 for ORD-1001 has been issued (ref re_...).
```

## Safeguards

- **Ownership.** A sender only sees and refunds orders whose `customer` matches their WhatsApp number. Unknown
  orders and other people's orders get the same "not found" answer.
- **Explicit confirmation.** Each refund is quoted first and needs a YES within 15 minutes.
- **No double refunds.** `state.json` keeps a ledger, so an item is refunded at most once and an order never
  beyond its `total`. Each Stripe request carries an `Idempotency-Key`. Webhook redeliveries are dropped by message ID,
  and messages are handled one at a time.
- **Unknown outcomes.** If Stripe times out or returns a 5xx error, the agent retries with the same idempotency key.
  If that still fails, it keeps the items reserved, retries again at startup and every 5 minutes, and messages the
  customer once the outcome is known. If Stripe rejects the refund (4xx), nothing is reserved and the problem is logged
  to stdout for staff.
- **Authenticity.** Every webhook POST must carry a valid `X-Hub-Signature-256`. Anything else gets a 401.

The agent is deliberately rule-based rather than LLM-driven, so it behaves predictably when moving money. Refunds it
can't handle (outside the window, or rejected by Stripe) are logged to stdout for follow-up. Hook those logs into your
helpdesk.

## Tests

```sh
npm test          # node --test: agent rules, plus end-to-end webhook → Stripe → WhatsApp against local fake APIs
npm run typecheck
```
