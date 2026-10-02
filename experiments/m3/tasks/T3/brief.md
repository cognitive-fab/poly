# Card payments

A payment service authorises card payments, captures them, and refunds them. Payments are named by the caller with a string id. Amounts are whole units. Each request to the card provider is an effect, and the provider's answer arrives later as its completion, through the effect port. The news that the provider did not answer in time arrives as a command.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. Any command on a payment id that was never authorised is refused.

- `authorize(payment, amount)`: creates the payment for `amount` (1 or 2 units) as **authorizing**, and sends the provider one authorisation request: the effect `card.authorize` with data `{ amount }`. Refused if `amount` is not 1 or 2, or if a payment with that id exists.
- `timedOut(payment)`: the provider did not answer in time. An authorizing payment sends the provider a new authorisation request, another `card.authorize` effect, unless 3 requests were already sent: then it becomes **failed**. Refused for a payment that is not authorizing. The earlier requests stay pending: the provider may still answer them.
- `capture(payment, amount)`: takes `amount` (1 or 2 units) of an authorized payment, at most the amount authorised. The payment becomes **captured**. Refused otherwise.
- `void(payment)`: an authorized payment that was not captured becomes **voided**, and the hold on the card is released. Refused otherwise.
- `refund(payment, amount)`: returns `amount` (1 or 2 units) of a captured payment, as long as the total refunded stays at most the amount captured. When everything captured has been refunded, the payment becomes **refunded**; otherwise it stays captured. Refused otherwise.

## The provider's answers

An authorisation request is completed through the effect port, by `completeEffect(id, outcome)` on the id `pendingEffects()` lists for it, with `from` the payment id. When it completes `ok`, the provider approved: an authorizing payment becomes **authorized**, holding its amount on the card. When it completes `failed`, the provider declined: an authorizing payment becomes **declined**. The first answer decides; an answer that finds the payment no longer authorizing changes nothing. A completed effect is no longer pending.

## Query

`payment(payment)` returns `{ status, authorized, captured, refunded, requests }` for a payment that exists, and `null` otherwise:

- `status`: one of `"authorizing"`, `"authorized"`, `"declined"`, `"failed"`, `"captured"`, `"voided"`, `"refunded"`;
- `authorized`: the amount asked for, from the start;
- `captured` and `refunded`: the amounts captured and refunded so far;
- `requests`: how many authorisation requests were sent to the provider.

## The interface

Implement `host.ts`. Its default export creates a fresh system, with no payments and no effect pending.

## Conclusion

Money moves only as the brief allows: nothing is captured beyond what was authorised, nothing is refunded beyond what was captured, a voided payment captured nothing, and a payment sends at most 3 authorisation requests.
