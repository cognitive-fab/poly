# WhatsApp refund support agent

Customers message your WhatsApp Business number. The agent looks up their orders in
`orders.json`, and issues refunds through Stripe after the customer confirms.

## Requirements

- Node.js 24+ (runs the TypeScript directly, no build step)
- A Meta app with the WhatsApp Cloud API set up (phone number ID, access token, app secret)
- A Stripe secret key. A [restricted key](https://docs.stripe.com/keys#limit-access) with only **Refunds: write** is enough.

## Start it

```sh
npm install
cp .env.example .env      # then fill in the values
npm start                 # listens on http://localhost:3000/webhook
```

You can also skip `.env` and set the same variables in the environment.

| Variable | Required | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Stripe secret or restricted key |
| `WHATSAPP_ACCESS_TOKEN` | yes | Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The sending phone number's ID |
| `WHATSAPP_APP_SECRET` | yes | App secret, used to verify `X-Hub-Signature-256` on webhooks |
| `WHATSAPP_VERIFY_TOKEN` | yes | A string you choose, used for Meta's webhook verification handshake |
| `PORT` | no (3000) | Local port the webhook server listens on |
| `REFUND_WINDOW_DAYS` | no (30) | Days after `placed` during which refunds are allowed |
| `ORDERS_FILE` | no (`orders.json`) | Order data. It's re-read on every message, so edits apply without a restart |
| `STATE_FILE` | no (`data/state.json`) | Where issued refunds, pending confirmations and seen message IDs are stored |
| `GRAPH_API_VERSION` | no (`v21.0`) | Graph API version used to send replies |

### Connect the WhatsApp webhook

Meta needs a public HTTPS URL. For local testing, put a tunnel in front of the port
(for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`). Then, in
the Meta app dashboard under **WhatsApp → Configuration**:

1. Callback URL: `https://<your-tunnel>/webhook`
2. Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
3. Subscribe to the **messages** field.

`GET /healthz` returns `ok` if you want a liveness check.

## What customers can do

| Message | Result |
|---|---|
| `orders` | Lists the orders placed from their number, with refund status |
| `refund ORD-1001` | Offers to refund everything on the order that hasn't been refunded yet |
| `refund ORD-1001 BLENDER-1` | Offers to refund just those items (you can list more than one SKU) |
| `refund` | Works if they have exactly one refundable order; otherwise asks which one |
| `yes` / `no` | Confirms or cancels the offer. Offers expire after 15 minutes |

## Safety rules (enforced in code)

- **Identity:** a customer is identified by the WhatsApp number the message came from, and
  only sees and refunds orders whose `customer` matches that number. If they ask about
  someone else's order, the reply is the same "not found" message as for an order that
  doesn't exist.
- **Explicit confirmation:** nothing goes to Stripe until the customer replies YES to an offer
  that states the exact amount.
- **No over-refunding:** refunded items are tracked per order. A full refund returns only
  what's left of `total`. Item refunds use the item prices and are capped at what's left.
  Everything is checked again when the customer confirms.
- **No double refunds:** every refund goes out with a Stripe `Idempotency-Key`. Messages are
  handled one at a time, and redelivered webhook messages are dropped by message ID. If
  Stripe times out or returns 5xx/429, the offer stays open and a YES retries with the same
  key. Permanent Stripe errors, or refunds that come back `failed`/`canceled`, are logged
  and the customer is told a person will follow up.
- **Authentic webhooks:** POSTs with a missing or invalid `X-Hub-Signature-256` get a 401.
- **Refund window:** set with `REFUND_WINDOW_DAYS`. The day the order was placed counts as day 0.

Issued refunds go to `STATE_FILE`, and the server logs one JSON line per event
(`refund_issued`, `refund_error`, …) to stdout.

## Development

```sh
npm test            # node --test: agent logic, webhook server, Stripe/WhatsApp clients
npx tsc -p .        # type-check
```

The tests use fake Stripe and WhatsApp clients, so they make no network calls.
